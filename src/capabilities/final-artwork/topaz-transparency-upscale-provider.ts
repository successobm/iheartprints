/**
 * Sprint 2M Phase 2E: the first real production reconstruction provider
 * behind `FinalArtworkProvider` — Topaz Labs' "Transparency Upscale" model,
 * proven in the Sprint 2M Phase 2D controlled bake-off (see
 * `research/phase-2d-bakeoff/BAKEOFF_REPORT.md`). This is a production
 * adapter, not the research harness — it does not import or extend
 * `research/phase-2d-bakeoff/run-bakeoff.mjs`; that file is research-only
 * reference material.
 *
 * Contract, never violated:
 *   - Topaz is a RECONSTRUCTION step. It is never allowed to reinterpret,
 *     redesign, regenerate, or "improve creatively" the approved artwork —
 *     `crop_to_fill=false`, PNG output, and a fixed proportional upscale are
 *     the only request parameters this adapter ever sends.
 *   - `preservesApprovedContent` is always reported `false` (see
 *     `FinalArtworkProviderOutput`'s doc) — even though the Phase 2D
 *     bake-off found Transparency Upscale visually faithful on tested
 *     samples, this adapter never lets that evidence substitute for
 *     independent production verification of the actual reconstructed
 *     output (Goal 7).
 *   - `resolutionProvenance` is always `"reconstructed"` — never `"native"`
 *     (these are not the untouched source pixels) and never
 *     `"interpolated_upscale"` (this is genuine provider super-resolution,
 *     not local geometric resampling).
 *
 * Paid-call idempotency (Goal 3): a NEW paid submission only ever happens
 * when `input.existingProviderRequest` is absent or belongs to a different
 * provider. The instant a new submission succeeds, `onProviderRequestSubmitted`
 * is awaited BEFORE any polling begins, so the caller can durably persist
 * the request id first. Resuming an existing request never re-submits.
 */

import { PNG } from "pngjs";

import { withRetry } from "@/capabilities/shared/retry";
import { ProviderError, isRetryableProviderError } from "@/capabilities/providers/provider-error";

import { resolveWidthConstrainedSizing } from "@/capabilities/shared/print-placement-dimensions";

import { trimToAlphaBounds, type AlphaTrimOptions } from "./alpha-trim";
import {
  encodeProductionPng,
  normalizeProductionRaster,
  type ProductionSizingRequest,
} from "./production-normalization";
import type { RgbaImage } from "./raster-transform";
import type {
  FinalArtworkProvider,
  FinalArtworkProviderInput,
  FinalArtworkProviderOutput,
} from "./provider";

const TOPAZ_API_BASE = "https://api.topazlabs.com/image/v1";
const TOPAZ_MODEL = "Transparency Upscale";
const TRANSFORMATION_METHOD = "topaz_transparency_upscale_v1";

/**
 * Print'em All Phase 0: how much MORE than the bare production requirement to
 * ask the provider for.
 *
 * Not a fudge factor — it pays for one specific, measured effect. The scale is
 * derived from the SOURCE's alpha bounding box, but the box that actually
 * matters is the one measured on the RECONSTRUCTED raster, and the two are
 * never exactly proportional: reconstruction softens edges, so re-applying the
 * alpha threshold afterwards moves the bounds by a pixel or two in either
 * direction. The live Print'em All file drifted +0.13% (562px x 4 predicted
 * 2248, measured 2251) — harmless in that direction, fatal in the other, since
 * landing even one pixel short puts `reconstruction_sufficiency` back into
 * failure and the credit is already spent.
 *
 * `alpha-trim`'s safety margin usually absorbs this, but not always: artwork
 * whose bounds already touch all four source edges gets `appliedMarginPx: 0`
 * (`alreadyTightToSourceEdges`), leaving exactly zero headroom. This constant
 * is what covers that case.
 *
 * 2% against a 0.5% `CONTENT_SCALE_TOLERANCE` is the smallest margin that
 * still clears the drift with room to spare. It is deliberately NOT large:
 * over-requesting costs provider time and produces pixels production then
 * throws away.
 */
const RECONSTRUCTION_HEADROOM = 1.02;
/** Defensive bounds around the reconstruction request — never a real limit observed from Topaz, just a sane guard against a corrupt/huge source producing a runaway request. */
const MIN_RECONSTRUCTION_DIM_PX = 256;
const MAX_RECONSTRUCTION_DIM_PX = 8192;

const DEFAULT_SUBMIT_TIMEOUT_MS = 30_000;
/** Phase 2D observed 69.5s–128.0s for Transparency Upscale; generous margin above the worst case. */
const DEFAULT_POLL_TIMEOUT_MS = 6 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 3_000;
const DEFAULT_MAX_POLL_ATTEMPTS_FOR_RETRY = 3;

export interface TopazTransparencyUpscaleProviderConfig {
  apiKey: string;
  /** Injectable for tests — defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Injectable for tests — defaults to a real timer. */
  sleepImpl?: (ms: number) => Promise<void>;
  submitTimeoutMs?: number;
  pollTimeoutMs?: number;
  pollIntervalMs?: number;
}

interface TopazStatusPayload {
  status?: unknown;
}

/** What one reconstruction submission should ask the provider for. */
export interface ReconstructionRequest {
  /** Provider `output_width` — the whole source canvas at `scale`. */
  widthPx: number;
  /** Provider `output_height`. */
  heightPx: number;
  /** The ONE uniform factor applied to both axes. Never per-axis. */
  scale: number;
  /** The production plate this request exists to satisfy, in pixels. */
  targetWidthPx: number;
  targetHeightPx: number;
  /** Visible (alpha-bound) artwork the reconstruction is expected to carry. */
  projectedVisibleWidthPx: number;
  projectedVisibleHeightPx: number;
  /** True when `MAX_RECONSTRUCTION_DIM_PX` pulled the scale below what production asked for. */
  clampedByMaxDimension: boolean;
}

export type ResolveReconstructionOutcome =
  | { status: "resolved"; request: ReconstructionRequest }
  /** Nothing to reconstruct. Truthful verdict, never a crash — mirrors `trimToAlphaBounds`. */
  | { status: "no_visible_artwork"; reason: string }
  /**
   * The proportional maximum cannot carry this source to the production
   * target. Known BEFORE dispatch, so the credit is never spent on a request
   * whose output we already know production would reject.
   */
  | { status: "insufficient_reconstruction"; reason: string };

/**
 * Print'em All Phase 0 — THE RECONSTRUCTION SIZE DECISION, extracted as a pure
 * function so it is testable without a network, a provider, or a credit.
 *
 * WHAT REPLACED WHAT. The adapter used to ask for `sourceCanvas x 4`, a
 * constant inherited from the Phase 2D bake-off (whose square 1024px sources
 * happened to need exactly 4x). That number knew nothing about the production
 * requirement, so it was right only by coincidence. The live Print'em All file
 * needed 5.60x, received 4x, and produced a plate that
 * `reconstruction_sufficiency` correctly refused — after the credit was spent.
 *
 * THE FORMULA:
 *
 *     target        = resolveWidthConstrainedSizing(sizing, trimmed source)
 *     scale         = max(target.widthPx  / alphaBBox.width,
 *                         target.heightPx / alphaBBox.height) x HEADROOM
 *     request       = round(sourceCanvas x scale)          // both axes, one scale
 *
 * THE DENOMINATOR IS THE ALPHA BOUNDING BOX, and that is the load-bearing
 * detail. Dividing by the trimmed size instead would silently under-request:
 * the trimmed size already contains the source's own safety margin, but that
 * margin is re-applied at a FIXED 12px after reconstruction rather than being
 * scaled with it. On the live file, dividing by trimmed (586px) yields 5.375x
 * → 3045px of trimmed reconstruction against a 3150px plate — short, and short
 * in exactly the way this change exists to eliminate. Dividing by the bbox
 * (562px) yields 5.605x → 3174px. Padding is not resolution, here as
 * everywhere else in this pipeline.
 *
 * `max(width, height)` because either axis can bind: a plate constrained by
 * `maxHeightIn` needs its HEIGHT satisfied, and honouring width alone would
 * under-reconstruct it.
 *
 * Never returns a scale below 1 — asking a paid reconstruction provider to
 * make an image SMALLER is a local resample wearing a bill.
 *
 * Pure: no I/O, no provider, no clock.
 */
export function resolveReconstructionRequest(
  source: RgbaImage,
  sizing: ProductionSizingRequest,
  options: AlphaTrimOptions = {},
): ResolveReconstructionOutcome {
  const trim = trimToAlphaBounds(source, options);
  if (trim.status === "no_visible_artwork") {
    return { status: "no_visible_artwork", reason: trim.reason };
  }

  // The SAME resolver normalization will run after reconstruction. Aspect
  // ratio survives a proportional upscale, so resolving it from the source's
  // own trimmed geometry predicts the post-reconstruction answer — including
  // whether `maxHeightIn` binds.
  const target = resolveWidthConstrainedSizing(
    sizing,
    trim.metadata.trimmedWidthPx,
    trim.metadata.trimmedHeightPx,
  );

  const bbox = trim.metadata.alphaBBox;
  const required = Math.max(
    target.widthPx / bbox.width,
    target.heightPx / bbox.height,
  );
  let scale = Math.max(1, required * RECONSTRUCTION_HEADROOM);

  // --- Proportional bounds. ONE factor, applied to both axes, always.
  //
  // The pre-Phase-0 code clamped each axis independently, which silently
  // DISTORTED any non-square request that reached the ceiling on one axis
  // only: a 3000x1500 source asking for 12000x6000 became 8192x6000, turning a
  // 2.00 aspect ratio into 1.37. `preserved_source_geometry` would have caught
  // it and failed the plate — after the credit was spent. Raising the
  // requested scale makes that ceiling far easier to reach, so the clamp has
  // to become proportional in the same change that raises the scale.
  let clampedByMaxDimension = false;
  const floorFactor = Math.max(
    MIN_RECONSTRUCTION_DIM_PX / (source.width * scale),
    MIN_RECONSTRUCTION_DIM_PX / (source.height * scale),
  );
  if (floorFactor > 1) scale *= floorFactor;

  const ceilingFactor = Math.max(
    (source.width * scale) / MAX_RECONSTRUCTION_DIM_PX,
    (source.height * scale) / MAX_RECONSTRUCTION_DIM_PX,
  );
  if (ceilingFactor > 1) {
    // The ceiling outranks the floor: a source whose aspect ratio cannot fit
    // between them at all must not be silently stretched to satisfy both.
    clampedByMaxDimension = true;
    scale /= ceilingFactor;
  }

  const widthPx = Math.max(1, Math.round(source.width * scale));
  const heightPx = Math.max(1, Math.round(source.height * scale));
  const projectedVisibleWidthPx = bbox.width * scale;
  const projectedVisibleHeightPx = bbox.height * scale;

  // Only reachable via the ceiling: without it, `scale >= required` holds by
  // construction and the projection always covers the target.
  if (
    clampedByMaxDimension &&
    (projectedVisibleWidthPx < target.widthPx ||
      projectedVisibleHeightPx < target.heightPx)
  ) {
    return {
      status: "insufficient_reconstruction",
      reason:
        `This artwork cannot be reconstructed to the ${target.widthPx}x${target.heightPx}px this production size requires: ` +
        `its visible artwork is ${bbox.width}x${bbox.height}px, and the largest proportional reconstruction available ` +
        `(${widthPx}x${heightPx}px) would carry only ${Math.round(projectedVisibleWidthPx)}x${Math.round(projectedVisibleHeightPx)}px of it.`,
    };
  }

  return {
    status: "resolved",
    request: {
      widthPx,
      heightPx,
      scale,
      targetWidthPx: target.widthPx,
      targetHeightPx: target.heightPx,
      projectedVisibleWidthPx,
      projectedVisibleHeightPx,
      clampedByMaxDimension,
    },
  };
}

export class TopazTransparencyUpscaleProvider implements FinalArtworkProvider {
  readonly providerKey = "topaz_transparency_upscale";

  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleepImpl: (ms: number) => Promise<void>;
  private readonly submitTimeoutMs: number;
  private readonly pollTimeoutMs: number;
  private readonly pollIntervalMs: number;

  constructor(config: TopazTransparencyUpscaleProviderConfig) {
    if (!config.apiKey) {
      throw new Error("TopazTransparencyUpscaleProvider requires an API key");
    }
    this.apiKey = config.apiKey;
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.sleepImpl = config.sleepImpl ?? defaultSleep;
    this.submitTimeoutMs = config.submitTimeoutMs ?? DEFAULT_SUBMIT_TIMEOUT_MS;
    this.pollTimeoutMs = config.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
    this.pollIntervalMs = config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  }

  async produce(input: FinalArtworkProviderInput): Promise<FinalArtworkProviderOutput> {
    if (input.sourceContentType !== "image/png") {
      throw new Error(
        `TopazTransparencyUpscaleProvider only supports image/png source assets (got "${input.sourceContentType}").`,
      );
    }

    let source: PNG;
    try {
      source = PNG.sync.read(input.sourceBytes);
    } catch (error) {
      throw new Error(
        `Source asset bytes could not be decoded as a PNG: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    // Print'em All Phase 0: sized from what production actually requires, not
    // from a constant. Resolved BEFORE the resume/submit branch below so an
    // impossible request costs nothing — see `resolveReconstructionRequest`.
    const resolved = resolveReconstructionRequest(
      { width: source.width, height: source.height, data: source.data },
      input.sizing,
    );
    if (resolved.status !== "resolved") {
      // `invalid_request` + `not_dispatched`: the platform asked for something
      // this provider cannot honestly deliver, and nothing left this process.
      // Never retried (`isRetryableProviderError` excludes it) because a retry
      // of an impossible request is still impossible, and never billed.
      throw new ProviderError("invalid_request", resolved.reason, "not_dispatched");
    }
    const targetReconstructedWidth = resolved.request.widthPx;
    const targetReconstructedHeight = resolved.request.heightPx;

    // --- Goal 3: resume, never resubmit, when a matching in-flight/completed
    // paid request already exists for this exact job.
    const resumable =
      input.existingProviderRequest?.providerKey === this.providerKey
        ? input.existingProviderRequest
        : null;

    let processId: string;
    if (resumable) {
      processId = resumable.providerRequestId;
    } else {
      processId = await this.submit(
        input.sourceBytes,
        targetReconstructedWidth,
        targetReconstructedHeight,
      );
      // Persisted BEFORE polling begins — the entire point of this hook
      // (Goal 3): a crash during the ~70-130s poll never causes a second
      // paid submission on retry.
      await input.onProviderRequestSubmitted?.(processId);
    }

    await this.pollUntilDone(processId);
    const reconstructedBytes = await this.download(processId);

    let reconstructed: PNG;
    try {
      reconstructed = PNG.sync.read(reconstructedBytes);
    } catch (error) {
      throw new ProviderError(
        "malformed_response",
        `The production reconstruction provider returned bytes that could not be decoded as a PNG: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    if (
      reconstructed.width !== targetReconstructedWidth ||
      reconstructed.height !== targetReconstructedHeight
    ) {
      throw new ProviderError(
        "malformed_response",
        `The production reconstruction provider returned unexpected dimensions ` +
          `(${reconstructed.width}x${reconstructed.height}, expected ${targetReconstructedWidth}x${targetReconstructedHeight}).`,
      );
    }

    // Goal 5: reconstruction and deterministic production sizing are two
    // distinct steps. The reconstructed bytes are never the print deliverable
    // by themselves — Print-Ready Normalization Phase 1 runs them through the
    // exact same shared local transform `LocalRasterInterpolationProvider`
    // uses (alpha trim → safety margin → physical-width sizing →
    // proportional resample), never a second Topaz call merely to reach the
    // production size. Normalizing from THIS reconstructed raster (the
    // highest-quality raster available in this finalization run) is what keeps
    // the deliverable from being a crop of an already-padded plate.
    const normalized = normalizeProductionRaster(
      { width: reconstructed.width, height: reconstructed.height, data: reconstructed.data },
      input.sizing,
    );
    if (normalized.status === "no_visible_artwork") {
      throw new ProviderError("malformed_response", normalized.reason);
    }
    const encoded = encodeProductionPng(normalized.result);

    return {
      bytes: encoded.bytes,
      contentType: "image/png",
      widthPx: normalized.result.image.width,
      heightPx: normalized.result.image.height,
      hasTransparency: encoded.hasTransparency,
      nativeWidthPx: source.width,
      nativeHeightPx: source.height,
      reconstructedWidthPx: reconstructed.width,
      reconstructedHeightPx: reconstructed.height,
      resolutionProvenance: "reconstructed",
      transformationMethod: TRANSFORMATION_METHOD,
      // Goal 7: never inherited — production verification always re-runs
      // independently against this reconstructed output.
      preservesApprovedContent: false,
      providerRequestId: processId,
      normalization: normalized.result.metadata,
    };
  }

  private async submit(
    sourceBytes: Buffer,
    outputWidth: number,
    outputHeight: number,
  ): Promise<string> {
    const form = new FormData();
    form.append("model", TOPAZ_MODEL);
    form.append("output_width", String(outputWidth));
    form.append("output_height", String(outputHeight));
    form.append("output_format", "png");
    // Never crop approved artwork (Goal 5) — the tested, required setting.
    form.append("crop_to_fill", "false");
    form.append(
      "image",
      new Blob([new Uint8Array(sourceBytes)], { type: "image/png" }),
      "source.png",
    );

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.submitTimeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(`${TOPAZ_API_BASE}/tool/async`, {
        method: "POST",
        headers: { "X-API-Key": this.apiKey },
        body: form,
        signal: controller.signal,
      });
    } catch (error) {
      if (isAbortError(error)) {
        throw new ProviderError(
          "timeout",
          "The production reconstruction provider did not accept the submission in time.",
        );
      }
      throw new ProviderError(
        "network",
        "The production reconstruction provider could not be reached.",
      );
    } finally {
      clearTimeout(timeout);
    }

    classifySubmitResponse(response.status);

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new ProviderError(
        "malformed_response",
        "The production reconstruction provider returned an unreadable submission response.",
      );
    }

    const processId = readProcessId(payload);
    if (!processId) {
      throw new ProviderError(
        "malformed_response",
        "The production reconstruction provider's submission response did not include a request id.",
      );
    }
    return processId;
  }

  private async pollUntilDone(processId: string): Promise<void> {
    const started = Date.now();
    while (Date.now() - started < this.pollTimeoutMs) {
      const status = await withRetry(() => this.fetchStatus(processId), {
        attempts: DEFAULT_MAX_POLL_ATTEMPTS_FOR_RETRY,
        isRetryable: isRetryableProviderError,
        delayMs: (attempt) => 500 * attempt,
        sleep: this.sleepImpl,
      });

      if (status === "Completed") return;
      if (status === "Failed" || status === "Cancelled") {
        throw new ProviderError(
          "provider_job_failed",
          `The production reconstruction provider reported this request as "${status}".`,
        );
      }
      await this.sleepImpl(this.pollIntervalMs);
    }
    throw new ProviderError(
      "timeout",
      "The production reconstruction provider did not complete within the allotted time.",
    );
  }

  private async fetchStatus(processId: string): Promise<string> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${TOPAZ_API_BASE}/status/${processId}`, {
        headers: { "X-API-Key": this.apiKey },
      });
    } catch {
      throw new ProviderError(
        "network",
        "The production reconstruction provider's status endpoint could not be reached.",
      );
    }

    classifyPollResponse(response.status);

    let payload: TopazStatusPayload;
    try {
      payload = (await response.json()) as TopazStatusPayload;
    } catch {
      throw new ProviderError(
        "malformed_response",
        "The production reconstruction provider returned an unreadable status response.",
      );
    }
    return typeof payload.status === "string" ? payload.status : "";
  }

  private async download(processId: string): Promise<Buffer> {
    let metaResponse: Response;
    try {
      metaResponse = await this.fetchImpl(`${TOPAZ_API_BASE}/download/${processId}`, {
        headers: { "X-API-Key": this.apiKey },
      });
    } catch {
      throw new ProviderError(
        "network",
        "The production reconstruction provider's download endpoint could not be reached.",
      );
    }
    classifyPollResponse(metaResponse.status);

    let meta: { url?: unknown; download_url?: unknown };
    try {
      meta = (await metaResponse.json()) as { url?: unknown; download_url?: unknown };
    } catch {
      throw new ProviderError(
        "malformed_response",
        "The production reconstruction provider returned an unreadable download response.",
      );
    }
    const url = typeof meta.url === "string" ? meta.url : typeof meta.download_url === "string" ? meta.download_url : null;
    if (!url) {
      throw new ProviderError(
        "malformed_response",
        "The production reconstruction provider's download response did not include a URL.",
      );
    }

    let imageResponse: Response;
    try {
      imageResponse = await this.fetchImpl(url);
    } catch {
      throw new ProviderError(
        "network",
        "The production reconstruction provider's downloaded artwork could not be fetched.",
      );
    }
    if (!imageResponse.ok) {
      throw new ProviderError(
        "network",
        `The production reconstruction provider's downloaded artwork request failed (${imageResponse.status}).`,
      );
    }
    const contentType = imageResponse.headers.get("content-type") ?? "";
    if (contentType && !contentType.includes("png") && !contentType.includes("octet-stream")) {
      throw new ProviderError(
        "malformed_response",
        `The production reconstruction provider's downloaded artwork had an unexpected content type (${contentType}).`,
      );
    }

    const arrayBuffer = await imageResponse.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    if (buffer.length === 0) {
      throw new ProviderError(
        "malformed_response",
        "The production reconstruction provider's downloaded artwork was empty.",
      );
    }
    return buffer;
  }
}

function classifySubmitResponse(status: number): void {
  if (status === 401 || status === 403) {
    throw new ProviderError(
      "auth",
      "The production reconstruction provider rejected the configured credentials.",
    );
  }
  if (status === 412) {
    throw new ProviderError(
      "insufficient_credits",
      "The production reconstruction provider reported the account cannot afford this request.",
    );
  }
  if (status === 429) {
    throw new ProviderError(
      "rate_limited",
      "The production reconstruction provider is rate-limiting requests right now.",
    );
  }
  if (status >= 500) {
    throw new ProviderError(
      "unavailable",
      "The production reconstruction provider is temporarily unavailable.",
    );
  }
  if (status < 200 || status >= 300) {
    throw new ProviderError(
      "malformed_response",
      `The production reconstruction provider returned an unexpected submission status (${status}).`,
    );
  }
}

function classifyPollResponse(status: number): void {
  if (status === 401 || status === 403) {
    throw new ProviderError(
      "auth",
      "The production reconstruction provider rejected the configured credentials.",
    );
  }
  if (status === 429) {
    throw new ProviderError(
      "rate_limited",
      "The production reconstruction provider is rate-limiting requests right now.",
    );
  }
  if (status >= 500) {
    throw new ProviderError(
      "unavailable",
      "The production reconstruction provider is temporarily unavailable.",
    );
  }
  if (status < 200 || status >= 300) {
    throw new ProviderError(
      "malformed_response",
      `The production reconstruction provider returned an unexpected status (${status}).`,
    );
  }
}

function readProcessId(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const value = (payload as { process_id?: unknown }).process_id;
  return typeof value === "string" && value.length > 0 ? value : null;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  );
}
