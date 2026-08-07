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

import {
  hasAnyTransparentPixel,
  resampleContainWithTransparentPadding,
} from "./raster-transform";
import type {
  FinalArtworkProvider,
  FinalArtworkProviderInput,
  FinalArtworkProviderOutput,
} from "./provider";

const TOPAZ_API_BASE = "https://api.topazlabs.com/image/v1";
const TOPAZ_MODEL = "Transparency Upscale";
const TRANSFORMATION_METHOD = "topaz_transparency_upscale_v1";

/**
 * The tested Phase 2D configuration — a proportional 4x reconstruction
 * (1024x1024 → 4096x4096 for the bake-off's square sources). Applied to
 * both axes independently so a non-square source is upscaled
 * proportionally rather than forced into a square frame (never stretches,
 * never crops — Goal 5).
 */
const RECONSTRUCTION_SCALE = 4;
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

    const targetReconstructedWidth = clamp(
      Math.round(source.width * RECONSTRUCTION_SCALE),
      MIN_RECONSTRUCTION_DIM_PX,
      MAX_RECONSTRUCTION_DIM_PX,
    );
    const targetReconstructedHeight = clamp(
      Math.round(source.height * RECONSTRUCTION_SCALE),
      MIN_RECONSTRUCTION_DIM_PX,
      MAX_RECONSTRUCTION_DIM_PX,
    );

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

    // Goal 5: reconstruction and deterministic production-canvas sizing are
    // two distinct steps. The reconstructed bytes are never the final print
    // canvas by themselves — this reuses the exact same local, deterministic
    // "contain + transparent pad" transform `LocalRasterInterpolationProvider`
    // uses, never a second Topaz call merely to reach the production canvas.
    const fit = resampleContainWithTransparentPadding(
      { width: reconstructed.width, height: reconstructed.height, data: reconstructed.data },
      input.targetWidthPx,
      input.targetHeightPx,
      input.marginFraction,
    );
    const output = new PNG({ width: fit.image.width, height: fit.image.height });
    fit.image.data.copy(output.data);
    const bytes = PNG.sync.write(output);

    return {
      bytes,
      contentType: "image/png",
      widthPx: fit.image.width,
      heightPx: fit.image.height,
      hasTransparency: hasAnyTransparentPixel(fit.image),
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

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
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
