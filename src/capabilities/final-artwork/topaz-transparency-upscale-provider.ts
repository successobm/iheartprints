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
import {
  ProviderError,
  classifyFetchRejectionDispatch,
  isRetryableProviderError,
} from "@/capabilities/providers/provider-error";

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
  FinalArtworkProviderIntermediateReconstruction,
  FinalArtworkProviderOutput,
  FinalArtworkProviderResumeContext,
} from "./provider";
import type {
  SignReconstructionProvider,
  SignReconstructionProviderInput,
  SignReconstructionProviderOutput,
} from "./sign-reconstruction-provider";

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
export const RECONSTRUCTION_HEADROOM = 1.02;
/**
 * Defensive bounds around the reconstruction request — never a real limit
 * observed from Topaz, just a sane guard against a corrupt/huge source
 * producing a runaway request. Exported (Signs Phase S3A): a rigid-sign
 * reconstruction dispatches an exact, already-computed pixel target rather
 * than routing through `resolveReconstructionRequest`'s own floor/ceiling
 * arithmetic, so the caller re-applies these same absolute bounds itself
 * before ever calling `produceSignReconstruction`.
 */
export const MIN_RECONSTRUCTION_DIM_PX = 256;
export const MAX_RECONSTRUCTION_DIM_PX = 8192;

/**
 * Print'em All Phase 0 (live acceptance) — Topaz Transparency Upscale's REAL
 * effective ceiling, established by a controlled live order rather than by
 * documentation.
 *
 * WHAT THE LIVE RUN PROVED. FinalArtworkJob
 * `36df2fa0-92c3-4ff6-ad35-9ac9a1fc96f1` submitted a 584x640 source asking for
 * 3353x3675 (5.742x — exactly what a 10.5in @ 300 PPI plate required). Topaz
 * accepted the request with a 2xx, ran for ~219s, reported `Completed`, and
 * returned a valid PNG of **2336x2560** — precisely 4.000x on both axes. The
 * requested `output_width`/`output_height` were neither honoured nor rejected.
 *
 * THE DANGEROUS PART IS THE SILENCE. Topaz does not fail a >4x request; it
 * clamps to 4x and BILLS for it. So the only place this can be caught without
 * spending money is here, before dispatch — the returned-dimension guard in
 * `produce()` catches it correctly but always one credit too late.
 *
 * This is therefore a hard ceiling on the SCALE FACTOR, not on pixel count:
 * 3353x3675 is far below `MAX_RECONSTRUCTION_DIM_PX`, which is exactly why
 * that existing guard did not save the live order. Both ceilings are kept —
 * they bound different things, and either can bind first.
 *
 * A need above this ceiling is not "ask anyway and see": it resolves to
 * `insufficient_reconstruction` and never leaves this process.
 */
export const PROVIDER_MAX_RECONSTRUCTION_SCALE = 4;

const DEFAULT_SUBMIT_TIMEOUT_MS = 30_000;
/** Phase 2D observed 69.5s–128.0s for Transparency Upscale; generous margin above the worst case. */
const DEFAULT_POLL_TIMEOUT_MS = 6 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 3_000;
const DEFAULT_MAX_POLL_ATTEMPTS_FOR_RETRY = 3;
/**
 * "Fix Topaz Resume/Download Failure" — how long a single readback of the
 * already-completed output may take before it is treated as hung rather
 * than merely slow. Generous: a large reconstructed PNG over a slow
 * connection should still finish well inside this, and this timeout exists
 * to catch a genuine hang, not to race a normal download.
 */
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 2 * 60 * 1000;
/**
 * "Fix Topaz Resume/Download Failure" — how many times `download()` (the
 * ENTIRE metadata-fetch + bytes-fetch cycle, always re-fetching a fresh
 * result URL by `processId`) may be retried within ONE `produce()` call
 * before propagating failure up to a full job-level retry. Mirrors
 * `DEFAULT_MAX_POLL_ATTEMPTS_FOR_RETRY`'s existing bound for the identical
 * reason: bounded resilience against a transient blip, never an unbounded
 * loop, and never a resubmission — see `isRetryableProviderError`, reused
 * unchanged.
 */
const DEFAULT_DOWNLOAD_ATTEMPTS = 3;

/**
 * S3A security patch (S3B.1 correction) — the provider-result download
 * boundary. The provider returns a URL for the reconstructed raster in its
 * own JSON response; that URL is fetched with no host this codebase has
 * ever had a basis to pin down (see `download()`'s own doc comment), so the
 * response body is capped rather than trusted-then-checked.
 *
 * DELIBERATELY NOT `MAX_UPLOAD_BYTES` (`artwork-preparation/upload-limits.ts`).
 * S3A originally reused that customer-upload limit here, reasoning it was
 * "the same order of magnitude" as any raster this platform handles — S3B's
 * first real live Ruth acceptance run proved that reasoning wrong: a
 * genuine, successfully-completed Topaz reconstruction of the real
 * 1024x1536 source (2448x3672 requested) reported a PNG of 36,324,544 bytes
 * (~34.6 MB), which the reused 25 MB customer-upload cap rejected outright
 * — a real, already-paid-for result the platform could not read back. A
 * PROVIDER RECONSTRUCTION OUTPUT and a CUSTOMER UPLOAD are different
 * concerns with different honest bounds: an upload is whatever a customer's
 * own file happens to be; a reconstruction output is a provider-generated
 * raster that can legitimately be uncompressed/large at 2-4x source
 * dimensions. Coupling the two meant a legitimate provider success could be
 * indistinguishable, from this cap's perspective, from an attack — that
 * coupling is the bug this correction removes. `MAX_UPLOAD_BYTES` itself is
 * UNCHANGED and ungoverned by this constant now.
 *
 * 64 MiB gives comfortable headroom above the observed 36,324,544-byte real
 * result (≈1.85x) without being unbounded — still a hard, enforced ceiling,
 * still capped while reading (never a full `arrayBuffer()` first, see
 * `readResponseBodyWithSizeCap`), just sized for what a provider
 * reconstruction actually produces rather than for what a customer uploads.
 */
export const MAX_PROVIDER_RESULT_DOWNLOAD_BYTES = 64 * 1024 * 1024; // 64 MiB = 67,108,864 bytes

/** The 8-byte PNG signature (RFC 2083 §3.1) — the unconditional decision of whether downloaded bytes are an admitted raster, independent of any Content-Type header. */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function bufferStartsWithPngSignature(buffer: Buffer): boolean {
  return buffer.length >= PNG_SIGNATURE.length && buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE);
}

/**
 * Reads `response`'s body incrementally, aborting via `onExceeded` (which
 * MUST abort the same `AbortSignal` the fetch itself was issued with) the
 * instant the running total exceeds `maxBytes` — an oversized response is
 * never fully buffered into memory first. Falls back to a single bounded
 * `arrayBuffer()` read only when the runtime does not expose a streamable
 * body (a rare `fetch` implementation detail this codebase has already
 * seen matter for test doubles), re-checking the cap immediately after.
 */
async function readResponseBodyWithSizeCap(
  response: Response,
  maxBytes: number,
  onExceeded: () => void,
): Promise<Buffer> {
  if (!response.body || typeof response.body.getReader !== "function") {
    const arrayBuffer = await response.arrayBuffer();
    if (arrayBuffer.byteLength > maxBytes) {
      onExceeded();
      throw new Error(`response body of ${arrayBuffer.byteLength} bytes exceeds the ${maxBytes}-byte cap`);
    }
    return Buffer.from(arrayBuffer);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      onExceeded();
      await reader.cancel().catch(() => {
        /* best-effort — the response is being rejected regardless */
      });
      throw new Error(`response body exceeded the ${maxBytes}-byte cap`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export interface TopazTransparencyUpscaleProviderConfig {
  apiKey: string;
  /** Injectable for tests — defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Injectable for tests — defaults to a real timer. */
  sleepImpl?: (ms: number) => Promise<void>;
  submitTimeoutMs?: number;
  pollTimeoutMs?: number;
  pollIntervalMs?: number;
  downloadTimeoutMs?: number;
  downloadAttempts?: number;
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
  /**
   * True when `PROVIDER_MAX_RECONSTRUCTION_SCALE` — Topaz's proven 4x
   * effective ceiling — pulled the scale below what production asked for.
   * Distinct from `clampedByMaxDimension`: that one bounds absolute pixels,
   * this one bounds the magnification factor, and the live failure hit only
   * this one.
   */
  clampedByProviderMaxScale: boolean;
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
 *     scale         = min(scale, PROVIDER_MAX_RECONSTRUCTION_SCALE)  // 4x, proven live
 *     request       = round(sourceCanvas x scale)          // both axes, one scale
 *
 * THE CEILING IS NOT A SECOND-BEST REQUEST. When the need exceeds 4x, this
 * function does not quietly ask for 4x and hope: it checks whether the clamped
 * projection still covers the plate, and returns `insufficient_reconstruction`
 * when it does not. Asking for 4x anyway would produce a plate that
 * `reconstruction_sufficiency` refuses — the live failure, minus the honesty
 * of having refused it for free.
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
  let clampedByProviderMaxScale = false;
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

  // Print'em All Phase 0 (live acceptance): the provider's own proven 4x
  // ceiling. Applied AFTER the absolute-pixel ceiling and after the floor,
  // because it outranks both — a request above it is not merely large, it is
  // one the provider will silently refuse to honour while still billing for
  // it (see `PROVIDER_MAX_RECONSTRUCTION_SCALE`). One uniform factor, so both
  // axes land at or under 4x source by construction.
  if (scale > PROVIDER_MAX_RECONSTRUCTION_SCALE) {
    clampedByProviderMaxScale = true;
    scale = PROVIDER_MAX_RECONSTRUCTION_SCALE;
  }

  const widthPx = Math.max(1, Math.round(source.width * scale));
  const heightPx = Math.max(1, Math.round(source.height * scale));
  const projectedVisibleWidthPx = bbox.width * scale;
  const projectedVisibleHeightPx = bbox.height * scale;

  // Only reachable via a ceiling: without one, `scale >= required` holds by
  // construction and the projection always covers the target.
  //
  // This is the ONLY thing standing between a >4x need and a wasted credit.
  // Reaching a ceiling is not itself a failure — a clamped request whose
  // projection still covers the plate is fine — but a clamped request that
  // falls short is a request whose output production would reject, and it is
  // refused here rather than billed and then refused by
  // `reconstruction_sufficiency`.
  if (
    (clampedByMaxDimension || clampedByProviderMaxScale) &&
    (projectedVisibleWidthPx < target.widthPx ||
      projectedVisibleHeightPx < target.heightPx)
  ) {
    return {
      status: "insufficient_reconstruction",
      reason:
        `This artwork cannot be reconstructed to the ${target.widthPx}x${target.heightPx}px this production size requires: ` +
        `its visible artwork is ${bbox.width}x${bbox.height}px, and the largest proportional reconstruction available ` +
        `(${widthPx}x${heightPx}px${clampedByProviderMaxScale ? `, the ${PROVIDER_MAX_RECONSTRUCTION_SCALE}x maximum this reconstruction provider can actually deliver` : ""}) ` +
        `would carry only ${Math.round(projectedVisibleWidthPx)}x${Math.round(projectedVisibleHeightPx)}px of it.`,
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
      clampedByProviderMaxScale,
    },
  };
}

/**
 * Phase 28V — the maximum TOTAL reconstruction scale (source canvas → final
 * reconstructed raster, across up to two chained Topaz passes) V1 will
 * attempt for a Standard Raster job whose single-pass need exceeds
 * `PROVIDER_MAX_RECONSTRUCTION_SCALE`.
 *
 * NOT the theoretical 4x * 4x = 16x a naive two-pass ceiling might assume.
 * Two independent reasons keep this conservative:
 *
 *   - QUALITY. Each Topaz pass is genuine provider super-resolution, not a
 *     lossless operation — chaining two full 4x passes would mean roughly
 *     15/16ths of the final pixel grid is provider-synthesized detail with
 *     no real source pixel behind it. This ceiling only ever asks the
 *     total chain for up to 2x MORE than a single pass already covers, so
 *     pass 2's own required scale (computed fresh against pass 1's REAL
 *     output — see `TopazTransparencyUpscaleProvider`'s two-pass path)
 *     stays comfortably below its own 4x ceiling too, which is what keeps
 *     a two-pass result reading as "one confident reconstruction" rather
 *     than two compounded guesses.
 *   - PROVEN NEED, NOT A ROUND NUMBER. The real production case this phase
 *     exists for (a 562x486 visible source needing 3150x2736, ≈5.63x total)
 *     needs less than 6x. 8x leaves comfortable headroom above that real,
 *     evidenced number without reaching for the unproven 16x theoretical
 *     maximum — and `MAX_RECONSTRUCTION_DIM_PX` (unchanged) still bounds
 *     pass 2's absolute pixel count regardless of this nominal ceiling.
 *
 * A request whose single-pass need exceeds this is refused pre-dispatch —
 * honest, zero-cost, and never silently escalated to a third pass (V1
 * maximum: two Topaz submissions per job, full stop — Section 4).
 */
export const MAX_TWO_PASS_RECONSTRUCTION_SCALE = 8;

/**
 * Phase 28V — pass 1's request when a two-pass reconstruction is needed:
 * simply "the most this provider will honestly deliver in one paid call",
 * independent of the ultimate production target. Pass 2, run against pass
 * 1's ACTUAL returned raster (never this function's prediction of it — see
 * `planStandardRasterReconstruction`'s doc), is what closes the gap to the
 * real target. Mirrors `resolveReconstructionRequest`'s own floor/ceiling
 * clamp against `MIN_RECONSTRUCTION_DIM_PX`/`MAX_RECONSTRUCTION_DIM_PX`,
 * minus the target-driven arithmetic that function layers on top — pass 1
 * never "falls short" on its own terms, because it never claims to reach
 * the final target by itself.
 */
export function resolveMaximalSinglePassRequest(source: {
  width: number;
  height: number;
}): { widthPx: number; heightPx: number; scale: number } {
  let scale = PROVIDER_MAX_RECONSTRUCTION_SCALE;
  const floorFactor = Math.max(
    MIN_RECONSTRUCTION_DIM_PX / (source.width * scale),
    MIN_RECONSTRUCTION_DIM_PX / (source.height * scale),
  );
  if (floorFactor > 1) scale *= floorFactor;
  const ceilingFactor = Math.max(
    (source.width * scale) / MAX_RECONSTRUCTION_DIM_PX,
    (source.height * scale) / MAX_RECONSTRUCTION_DIM_PX,
  );
  if (ceilingFactor > 1) scale /= ceilingFactor;
  return {
    widthPx: Math.max(1, Math.round(source.width * scale)),
    heightPx: Math.max(1, Math.round(source.height * scale)),
    scale,
  };
}

export type StandardRasterReconstructionPlan =
  /** Unchanged Phase 28R behavior — the caller runs `resolveReconstructionRequest` normally. */
  | { kind: "single_pass" }
  | { kind: "two_pass"; pass1: { widthPx: number; heightPx: number; scale: number } }
  /** Even a bounded two-pass chain cannot honestly satisfy this request. Refused pre-dispatch, zero cost. */
  | { kind: "insufficient"; reason: string }
  | { kind: "no_visible_artwork"; reason: string };

/**
 * Phase 28V — THE ROUTING DECISION, extracted as a pure function so it is
 * testable without a network, a provider, or a credit — mirrors
 * `resolveReconstructionRequest`'s own reasoning exactly, deliberately
 * duplicated rather than refactored out of it: `resolveReconstructionRequest`
 * is Phase 28R's proven, unmodified contract, and this function exists
 * purely to decide WHICH contract applies (single-pass, as before; two-pass,
 * new; or an honest refusal) before any reconstruction actually runs. Never
 * changes what a single-pass request looks like or how it is validated.
 */
export function planStandardRasterReconstruction(
  source: RgbaImage,
  sizing: ProductionSizingRequest,
  options: AlphaTrimOptions = {},
): StandardRasterReconstructionPlan {
  const trim = trimToAlphaBounds(source, options);
  if (trim.status === "no_visible_artwork") {
    return { kind: "no_visible_artwork", reason: trim.reason };
  }

  const target = resolveWidthConstrainedSizing(
    sizing,
    trim.metadata.trimmedWidthPx,
    trim.metadata.trimmedHeightPx,
  );
  const bbox = trim.metadata.alphaBBox;
  const requiredScale = Math.max(
    1,
    Math.max(target.widthPx / bbox.width, target.heightPx / bbox.height) * RECONSTRUCTION_HEADROOM,
  );

  if (requiredScale <= PROVIDER_MAX_RECONSTRUCTION_SCALE) {
    return { kind: "single_pass" };
  }
  if (requiredScale > MAX_TWO_PASS_RECONSTRUCTION_SCALE) {
    return {
      kind: "insufficient",
      reason:
        `This artwork cannot be reconstructed to the ${target.widthPx}x${target.heightPx}px this production size requires: ` +
        `its visible artwork is ${bbox.width}x${bbox.height}px, which needs approximately ${requiredScale.toFixed(2)}x total ` +
        `reconstruction — beyond the ${MAX_TWO_PASS_RECONSTRUCTION_SCALE}x maximum this reconstruction provider can safely ` +
        `deliver across up to two chained reconstruction passes.`,
    };
  }
  return { kind: "two_pass", pass1: resolveMaximalSinglePassRequest(source) };
}

/**
 * Phase 28R — how far a genuinely proportional reconstruction may drift from
 * the source canvas's own aspect ratio before it stops looking like one.
 *
 * `resolveReconstructionRequest` always derives its request from ONE uniform
 * `scale` applied to both of the source canvas's axes (never per-axis), so
 * the REQUESTED dimensions are always exactly proportional to the source —
 * and the two REAL Topaz responses observed so far (the `36df2fa0-...`
 * incident and the `01a049d2-...` Phase 28Q/R case) were too: both returned
 * exactly 4.000x of the source canvas on both axes, preserving its aspect
 * ratio exactly. 1% is generous room above the sub-pixel rounding
 * `Math.round(source.width * scale)` / `Math.round(source.height * scale)`
 * can introduce, while still rejecting a genuinely distorted or
 * wrong-aspect response by a wide margin (see test F: a response that
 * exceeds both requested axes but with the wrong aspect ratio entirely).
 */
const RECONSTRUCTION_ASPECT_TOLERANCE = 0.01;

export interface ReconstructedGeometryCheckInput {
  sourceWidthPx: number;
  sourceHeightPx: number;
  targetWidthPx: number;
  targetHeightPx: number;
  actualWidthPx: number;
  actualHeightPx: number;
}

export type ReconstructedGeometryCheck =
  | { valid: true }
  | { valid: false; reason: string };

/**
 * Phase 28R — THE CORRECTED PROVIDER RESPONSE CONTRACT.
 *
 * Extracted as its own pure function (mirrors `resolveReconstructionRequest`)
 * for the same reason: testable without a network, a provider, a PNG decode,
 * or a credit.
 *
 * WHAT THIS REPLACES. `produce()` used to require
 * `reconstructed.width === targetReconstructedWidth &&
 * reconstructed.height === targetReconstructedHeight` — exact equality.
 * Phase 28Q proved that requirement false on two REAL Topaz responses: both
 * the historical `36df2fa0-...` incident and the real
 * `01a049d2-90ea-7cfa-88b4-ad1067497820` car-show request returned exactly
 * 4.000x of the SOURCE CANVAS rather than the requested dimensions — in the
 * car-show case, MORE resolution than production needed (4096x6144 delivered
 * against a 2192x3288 request, itself only 2.14x — well inside the 4x
 * ceiling). Rejecting that as `malformed_response` discarded a real,
 * structurally valid, already-paid-for reconstruction.
 *
 * THE PROVIDER'S JOB IS SUFFICIENCY, NOT EXACT SIZING. Precise production
 * dimensions are `normalizeProductionRaster`'s job, downstream of this check
 * — it downsamples whatever sufficient raster this function accepts to the
 * exact confirmed physical size. This function's only job is deciding
 * whether the raw provider response is honest, undistorted, and carries
 * enough real reconstructed pixels to make that downsample legitimate.
 *
 * TWO INDEPENDENT FAILURE MODES, NOT ONE NUMERIC COMPARISON:
 *
 *   1. INSUFFICIENT — either axis falls short of what was requested. A
 *      response smaller than what production asked for can never be trusted
 *      to carry enough real detail, regardless of aspect ratio. Fails
 *      closed, exactly as before.
 *
 *   2. WRONG GEOMETRY — both axes meet or exceed the request, but the
 *      returned aspect ratio does not match the source canvas's own
 *      (outside `RECONSTRUCTION_ASPECT_TOLERANCE`). A response that is
 *      merely LARGE is not automatically a valid proportional
 *      reconstruction — a distorted, stretched, or wrongly-cropped response
 *      could technically exceed both requested dimensions while
 *      misrepresenting the artwork's actual proportions, and must still be
 *      rejected. This is the check Phase 28Q's own "naive >= only" caution
 *      exists to prevent skipping.
 *
 * An oversized response that passes BOTH checks — meets or exceeds the
 * request AND preserves the source's aspect ratio — is exactly what a
 * uniform-scale provider honestly returning "more than you asked for" looks
 * like, and is accepted.
 */
export function validateReconstructedGeometry(
  input: ReconstructedGeometryCheckInput,
): ReconstructedGeometryCheck {
  const { sourceWidthPx, sourceHeightPx, targetWidthPx, targetHeightPx, actualWidthPx, actualHeightPx } = input;

  if (actualWidthPx < targetWidthPx || actualHeightPx < targetHeightPx) {
    return {
      valid: false,
      reason:
        `The production reconstruction provider returned insufficient dimensions ` +
        `(${actualWidthPx}x${actualHeightPx}, needed at least ${targetWidthPx}x${targetHeightPx}).`,
    };
  }

  const sourceAspect = sourceWidthPx / sourceHeightPx;
  const actualAspect = actualWidthPx / actualHeightPx;
  const relativeAspectDifference = Math.abs(actualAspect - sourceAspect) / sourceAspect;
  if (relativeAspectDifference > RECONSTRUCTION_ASPECT_TOLERANCE) {
    return {
      valid: false,
      reason:
        `The production reconstruction provider returned a raster (${actualWidthPx}x${actualHeightPx}) ` +
        `whose proportions do not match the source artwork's (${sourceWidthPx}x${sourceHeightPx}) — ` +
        `this is not a valid proportional reconstruction.`,
    };
  }

  return { valid: true };
}

export class TopazTransparencyUpscaleProvider
  implements FinalArtworkProvider, SignReconstructionProvider
{
  readonly providerKey = "topaz_transparency_upscale";

  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleepImpl: (ms: number) => Promise<void>;
  private readonly submitTimeoutMs: number;
  private readonly pollTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly downloadTimeoutMs: number;
  private readonly downloadAttempts: number;

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
    this.downloadTimeoutMs = config.downloadTimeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS;
    this.downloadAttempts = config.downloadAttempts ?? DEFAULT_DOWNLOAD_ATTEMPTS;
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

    // Phase 28V: decide ROUTING before any reconstruction runs — an
    // impossible or two-pass-eligible request costs nothing to detect. A
    // job already mid-two-pass (an intermediate reconstruction exists from
    // a prior attempt) always takes the two-pass path regardless of what
    // this fresh plan would say, since pass 1 is already paid for and done.
    const plan: StandardRasterReconstructionPlan = input.existingIntermediateReconstruction
      ? { kind: "two_pass", pass1: resolveMaximalSinglePassRequest(source) }
      : planStandardRasterReconstruction(
          { width: source.width, height: source.height, data: source.data },
          input.sizing,
        );

    if (plan.kind === "no_visible_artwork" || plan.kind === "insufficient") {
      // `invalid_request` + `not_dispatched`: the platform asked for
      // something this provider cannot honestly deliver, and nothing left
      // this process. Never retried (`isRetryableProviderError` excludes
      // it) because a retry of an impossible request is still impossible,
      // and never billed.
      throw new ProviderError("invalid_request", plan.reason, "not_dispatched");
    }

    if (plan.kind === "single_pass") {
      return this.produceSinglePass(input, source);
    }
    return this.produceTwoPass(input, source, plan.pass1);
  }

  /**
   * Signs Phase S3A: a single, bounded reconstruction pass to an exact,
   * already-computed pixel target — no alpha-trim, no `PlacementSizingPolicy`
   * arithmetic, no post-reconstruction normalization/encode, and no two-pass
   * chaining (a sign's ceiling is the single-pass 4x ceiling, full stop; see
   * `SIGN_RECONSTRUCTION_SCALE_CEILING`).
   *
   * Reuses `runReconstructionPass` UNMODIFIED — the exact same submit/
   * resume, persist-before-poll, poll, download, and pre-dispatch
   * `assertWithinProviderScaleCeiling` guard the apparel path relies on for
   * paid-call idempotency and cost control. This is the ONLY new dispatch
   * surface S3A adds; nothing here opens a second HTTP polling loop or a
   * second billing decision.
   */
  async produceSignReconstruction(
    input: SignReconstructionProviderInput,
  ): Promise<SignReconstructionProviderOutput> {
    if (input.sourceContentType !== "image/png") {
      throw new Error(
        `TopazTransparencyUpscaleProvider only supports image/png source assets for sign reconstruction (got "${input.sourceContentType}").`,
      );
    }
    let source: PNG;
    try {
      source = PNG.sync.read(input.sourceBytes);
    } catch (error) {
      throw new Error(
        `Sign reconstruction source bytes could not be decoded as a PNG: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    const { processId, png: reconstructed } = await this.runReconstructionPass(
      input.sourceBytes,
      { widthPx: input.requestedWidthPx, heightPx: input.requestedHeightPx },
      source.width,
      source.height,
      input.existingProviderRequest ?? null,
      input.onProviderRequestSubmitted,
    );

    // Same sufficiency + proportional-geometry contract the apparel path
    // uses (Phase 28R) — a sign reconstruction has no downstream
    // `normalizeProductionRaster` downsample to absorb an oversized-but-
    // proportional response, so S2's deterministic continuation instead
    // relies on the plan's own `output_geometry_mismatch` check to catch
    // anything this does not.
    const geometryCheck = validateReconstructedGeometry({
      sourceWidthPx: source.width,
      sourceHeightPx: source.height,
      targetWidthPx: input.requestedWidthPx,
      targetHeightPx: input.requestedHeightPx,
      actualWidthPx: reconstructed.width,
      actualHeightPx: reconstructed.height,
    });
    if (!geometryCheck.valid) {
      throw new ProviderError("malformed_response", geometryCheck.reason);
    }

    return {
      bytes: PNG.sync.write(reconstructed),
      widthPx: reconstructed.width,
      heightPx: reconstructed.height,
      providerRequestId: processId,
    };
  }

  /** Phase 28R's exact, unmodified single-pass contract — see `resolveReconstructionRequest`. */
  private async produceSinglePass(
    input: FinalArtworkProviderInput,
    source: PNG,
  ): Promise<FinalArtworkProviderOutput> {
    // Print'em All Phase 0: sized from what production actually requires, not
    // from a constant. Resolved BEFORE the resume/submit branch below so an
    // impossible request costs nothing — see `resolveReconstructionRequest`.
    const resolved = resolveReconstructionRequest(
      { width: source.width, height: source.height, data: source.data },
      input.sizing,
    );
    if (resolved.status !== "resolved") {
      throw new ProviderError("invalid_request", resolved.reason, "not_dispatched");
    }
    const targetReconstructedWidth = resolved.request.widthPx;
    const targetReconstructedHeight = resolved.request.heightPx;

    const { processId, png: reconstructed } = await this.runReconstructionPass(
      input.sourceBytes,
      { widthPx: targetReconstructedWidth, heightPx: targetReconstructedHeight },
      source.width,
      source.height,
      input.existingProviderRequest ?? null,
      input.onProviderRequestSubmitted,
    );

    // Phase 28R: sufficiency + geometry, not exact equality — see
    // `validateReconstructedGeometry`'s doc comment for the real Topaz
    // responses that proved exact equality wrong. Still fails closed
    // (`malformed_response`, same classification as before) for a
    // genuinely undersized or wrongly-shaped response.
    const geometryCheck = validateReconstructedGeometry({
      sourceWidthPx: source.width,
      sourceHeightPx: source.height,
      targetWidthPx: targetReconstructedWidth,
      targetHeightPx: targetReconstructedHeight,
      actualWidthPx: reconstructed.width,
      actualHeightPx: reconstructed.height,
    });
    if (!geometryCheck.valid) {
      throw new ProviderError("malformed_response", geometryCheck.reason);
    }

    return this.finalizeFromReconstructed(reconstructed, input.sizing, {
      processId,
      nativeWidthPx: source.width,
      nativeHeightPx: source.height,
    });
  }

  /**
   * Phase 28V — a controlled, bounded two-pass reconstruction for a request
   * whose total need exceeds `PROVIDER_MAX_RECONSTRUCTION_SCALE` but not
   * `MAX_TWO_PASS_RECONSTRUCTION_SCALE`.
   *
   * PASS 1 asks for "the most this provider will honestly deliver" (never
   * refused for being insufficient on its own — pass 2 exists to close the
   * gap). Once pass 1's ACTUAL bytes are known (never a prediction of
   * them), PASS 2 is nothing more than an ordinary, unmodified
   * `resolveReconstructionRequest` call against THOSE bytes as the new
   * "source" — the exact same Phase 28R contract a ≤4x job already uses,
   * just run a second time against a different source. This is what lets
   * pass 2 inherit every one of Phase 28R's protections (sufficiency +
   * aspect-ratio tolerance) automatically, with zero new sizing arithmetic.
   *
   * Idempotency (Section 8): pass 1 is resumed/submitted using the SAME
   * `existingProviderRequest`/`onProviderRequestSubmitted` contract a
   * single-pass job uses. `existingIntermediateReconstruction`, when
   * present, means pass 1 already durably completed on a prior attempt —
   * it is never resubmitted, and any `existingProviderRequest` in that case
   * is understood to belong to PASS 2 (the caller — the worker — guarantees
   * this by construction: it only ever populates `existingProviderRequest`
   * for pass 2 once pass 1's durable result already exists).
   */
  private async produceTwoPass(
    input: FinalArtworkProviderInput,
    source: PNG,
    pass1Request: { widthPx: number; heightPx: number },
  ): Promise<FinalArtworkProviderOutput> {
    const existingIntermediate = input.existingIntermediateReconstruction ?? null;

    let pass1Png: PNG;
    let pass1ProcessId: string;

    if (existingIntermediate) {
      try {
        pass1Png = PNG.sync.read(existingIntermediate.bytes);
      } catch (error) {
        throw new ProviderError(
          "malformed_response",
          `The persisted first-pass reconstruction could not be decoded as a PNG: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      pass1ProcessId = existingIntermediate.providerRequestId;
    } else {
      const { processId, png } = await this.runReconstructionPass(
        input.sourceBytes,
        pass1Request,
        source.width,
        source.height,
        input.existingProviderRequest ?? null,
        input.onProviderRequestSubmitted,
      );

      const pass1GeometryCheck = validateReconstructedGeometry({
        sourceWidthPx: source.width,
        sourceHeightPx: source.height,
        targetWidthPx: pass1Request.widthPx,
        targetHeightPx: pass1Request.heightPx,
        actualWidthPx: png.width,
        actualHeightPx: png.height,
      });
      if (!pass1GeometryCheck.valid) {
        throw new ProviderError("malformed_response", `First reconstruction pass: ${pass1GeometryCheck.reason}`);
      }

      pass1Png = png;
      pass1ProcessId = processId;
    }

    const pass1Image: RgbaImage = {
      width: pass1Png.width,
      height: pass1Png.height,
      data: pass1Png.data,
    };

    // Section 3/19: pass 2's request is derived from pass 1's REAL output,
    // reusing Phase 28R's own single-pass function unmodified. Computed
    // BEFORE persisting an intermediate below so the "pass 1 alone already
    // sufficient" case never pays for storing an intermediate nobody will
    // ever read back.
    const pass2Plan = resolveReconstructionRequest(pass1Image, input.sizing);
    if (pass2Plan.status !== "resolved") {
      // Section 4: no third pass — even a second pass cannot honestly
      // satisfy this request. An honest terminal verdict, never billed
      // again beyond the two calls already made/resumed.
      throw new ProviderError(
        "invalid_request",
        `Even a second reconstruction pass is not enough: ${pass2Plan.reason}`,
        "not_dispatched",
      );
    }

    if (pass2Plan.request.scale <= 1) {
      // Section 3/19: pass 1 alone already meets or exceeds the target —
      // `resolveReconstructionRequest`'s own floor (`Math.max(1, ...)`)
      // returning exactly 1 means zero further magnification is needed.
      // Do not submit a pass 2 that would buy nothing, and do not persist
      // an intermediate for a pass 1 that is itself becoming the final
      // reconstruction stage.
      return this.finalizeFromReconstructed(pass1Png, input.sizing, {
        processId: pass1ProcessId,
        nativeWidthPx: source.width,
        nativeHeightPx: source.height,
      });
    }

    // Section 8/9: pass 2 is genuinely going to be attempted — persist
    // pass 1's validated output NOW, before pass 2 is submitted, unless it
    // is already durably persisted from a prior attempt. Mirrors
    // `onProviderRequestSubmitted`'s own persist-before-continuing
    // ordering: a crash any time after this resolves never re-spends pass
    // 1's paid credit.
    if (!existingIntermediate) {
      const intermediate: FinalArtworkProviderIntermediateReconstruction = {
        bytes: PNG.sync.write(pass1Png),
        widthPx: pass1Png.width,
        heightPx: pass1Png.height,
        providerRequestId: pass1ProcessId,
      };
      await input.onIntermediateReconstructionProduced?.(intermediate);
    }

    // Only when pass 1 already durably existed (this attempt never
    // submitted it) can `existingProviderRequest` legitimately refer to
    // pass 2 — see this method's doc comment.
    const pass2ExistingProviderRequest: FinalArtworkProviderResumeContext | null =
      existingIntermediate ? (input.existingProviderRequest ?? null) : null;

    const { processId: pass2ProcessId, png: pass2Png } = await this.runReconstructionPass(
      PNG.sync.write(pass1Png),
      { widthPx: pass2Plan.request.widthPx, heightPx: pass2Plan.request.heightPx },
      pass1Png.width,
      pass1Png.height,
      pass2ExistingProviderRequest,
      input.onProviderRequestSubmitted,
    );

    const pass2GeometryCheck = validateReconstructedGeometry({
      sourceWidthPx: pass1Png.width,
      sourceHeightPx: pass1Png.height,
      targetWidthPx: pass2Plan.request.widthPx,
      targetHeightPx: pass2Plan.request.heightPx,
      actualWidthPx: pass2Png.width,
      actualHeightPx: pass2Png.height,
    });
    if (!pass2GeometryCheck.valid) {
      throw new ProviderError("malformed_response", `Second reconstruction pass: ${pass2GeometryCheck.reason}`);
    }

    return this.finalizeFromReconstructed(pass2Png, input.sizing, {
      processId: pass2ProcessId,
      nativeWidthPx: source.width,
      nativeHeightPx: source.height,
    });
  }

  /** Goal 3: resume, never resubmit, when a matching in-flight/completed paid request already exists for this exact job. */
  private async submitOrResumePass(
    sourceBytes: Buffer,
    request: { widthPx: number; heightPx: number },
    sourceWidth: number,
    sourceHeight: number,
    existingProviderRequest: FinalArtworkProviderResumeContext | null,
    onProviderRequestSubmitted: ((providerRequestId: string) => Promise<void>) | undefined,
  ): Promise<string> {
    const resumable =
      existingProviderRequest?.providerKey === this.providerKey ? existingProviderRequest : null;
    if (resumable) return resumable.providerRequestId;

    // Print'em All Phase 0 (live acceptance): the last gate before money is
    // spent. The caller's plan already bounds the scale, so this can only
    // fire if that planning is later changed in a way that reintroduces the
    // live billing defect — which is precisely why it guards the dispatch
    // boundary rather than trusting a caller. Charging for a request the
    // provider will silently clamp is the one failure mode this adapter
    // must never repeat.
    assertWithinProviderScaleCeiling(sourceWidth, sourceHeight, request.widthPx, request.heightPx);
    const processId = await this.submit(sourceBytes, request.widthPx, request.heightPx);
    // Persisted BEFORE polling begins — the entire point of this hook
    // (Goal 3): a crash during the ~70-130s poll never causes a second
    // paid submission on retry.
    await onProviderRequestSubmitted?.(processId);
    return processId;
  }

  /** Submit-or-resume, then poll to completion and download — one full reconstruction pass, decoded. */
  private async runReconstructionPass(
    sourceBytes: Buffer,
    request: { widthPx: number; heightPx: number },
    sourceWidth: number,
    sourceHeight: number,
    existingProviderRequest: FinalArtworkProviderResumeContext | null,
    onProviderRequestSubmitted: ((providerRequestId: string) => Promise<void>) | undefined,
  ): Promise<{ processId: string; png: PNG }> {
    const processId = await this.submitOrResumePass(
      sourceBytes,
      request,
      sourceWidth,
      sourceHeight,
      existingProviderRequest,
      onProviderRequestSubmitted,
    );
    await this.pollUntilDone(processId);
    // "Fix Topaz Resume/Download Failure": bounded, LOCAL retry of the
    // readback step only — `download()` always re-fetches a FRESH result
    // URL from `/download/{processId}` on every call (never reuses a
    // previously-returned signed URL across attempts), so each retry here
    // genuinely obtains current download metadata rather than repeating a
    // stale one. Never resubmits anything: `processId` is fixed for the
    // lifetime of this call, `submitOrResumePass` already ran exactly once
    // above, and nothing below this point can reach it again. Only the
    // classifications `isRetryableProviderError` already recognizes as safe
    // (`network`/`rate_limited`/`unavailable`, and only when provably
    // `not_dispatched` — true by construction for every failure `download()`
    // itself can raise, since reading back an already-produced result is
    // never itself a billable dispatch) are retried; a `malformed_response`
    // (e.g. the provider reporting the result is no longer available) or a
    // `timeout` propagates immediately, unretried, exactly as `pollUntilDone`
    // already treats them.
    const bytes = await withRetry(() => this.download(processId), {
      attempts: this.downloadAttempts,
      isRetryable: isRetryableProviderError,
      delayMs: (attempt) => 500 * attempt,
      sleep: this.sleepImpl,
    });
    let png: PNG;
    try {
      png = PNG.sync.read(bytes);
    } catch (error) {
      throw new ProviderError(
        "malformed_response",
        `The production reconstruction provider returned bytes that could not be decoded as a PNG: ${
          error instanceof Error ? error.message : String(error)
        }`,
        undefined,
        "download",
      );
    }
    return { processId, png };
  }

  /**
   * Goal 5: reconstruction and deterministic production sizing are two
   * distinct steps. The reconstructed bytes are never the print deliverable
   * by themselves — Print-Ready Normalization Phase 1 runs them through the
   * exact same shared local transform `LocalRasterInterpolationProvider`
   * uses (alpha trim → safety margin → physical-width sizing →
   * proportional resample), never a further Topaz call merely to reach the
   * production size. Normalizing from THIS reconstructed raster (the
   * highest-quality raster available in this finalization run — the last
   * pass actually used, whether pass 1 or pass 2) is what keeps the
   * deliverable from being a crop of an already-padded plate.
   */
  private finalizeFromReconstructed(
    reconstructed: PNG,
    sizing: FinalArtworkProviderInput["sizing"],
    provenance: { processId: string; nativeWidthPx: number; nativeHeightPx: number },
  ): FinalArtworkProviderOutput {
    const normalized = normalizeProductionRaster(
      { width: reconstructed.width, height: reconstructed.height, data: reconstructed.data },
      sizing,
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
      nativeWidthPx: provenance.nativeWidthPx,
      nativeHeightPx: provenance.nativeHeightPx,
      reconstructedWidthPx: reconstructed.width,
      reconstructedHeightPx: reconstructed.height,
      resolutionProvenance: "reconstructed",
      transformationMethod: TRANSFORMATION_METHOD,
      // Goal 7: never inherited — production verification always re-runs
      // independently against this reconstructed output.
      preservesApprovedContent: false,
      providerRequestId: provenance.processId,
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
          undefined,
          "submit",
        );
      }
      // This IS the one call in this file that is a paid dispatch, so a
      // `fetch` rejection here is not uniformly "nothing was sent" — the
      // stack must classify HONESTLY, not conservatively-by-default.
      // `classifyFetchRejectionDispatch` already draws that exact line (the
      // same shared classifier `stripe-checkout-provider.ts` and both OpenAI
      // adapters use): only a cause code that could ONLY occur before any
      // bytes reached a remote peer — DNS failure, refused/unreachable
      // connection, or (Signs Phase S4.2C.8) a TCP connect timeout that
      // never finished establishing — comes back `not_dispatched`; every
      // other cause, including anything unrecognized, stays the
      // conservative `dispatched_ambiguous` it always was. Previously this
      // threw with `dispatch` left `undefined`, which falls back to the
      // generic per-classification default (`dispatched_ambiguous` for
      // every `"network"` failure) regardless of the actual cause code —
      // silently discarding the provably-safe cases the shared classifier
      // already knows how to recognize.
      throw new ProviderError(
        "network",
        `The production reconstruction provider could not be reached (${describeFetchFailure(error)}).`,
        classifyFetchRejectionDispatch(error),
        "submit",
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
        undefined,
        "submit",
      );
    }

    const processId = readProcessId(payload);
    if (!processId) {
      throw new ProviderError(
        "malformed_response",
        "The production reconstruction provider's submission response did not include a request id.",
        undefined,
        "submit",
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
          undefined,
          "poll",
        );
      }
      await this.sleepImpl(this.pollIntervalMs);
    }
    throw new ProviderError(
      "timeout",
      "The production reconstruction provider did not complete within the allotted time.",
      undefined,
      "poll",
    );
  }

  private async fetchStatus(processId: string): Promise<string> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${TOPAZ_API_BASE}/status/${processId}`, {
        headers: { "X-API-Key": this.apiKey },
      });
    } catch (error) {
      // "Fix Topaz Resume/Download Failure": a status check is NEVER itself
      // a billable dispatch — it only reads back the state of an already
      // (or not-yet) submitted paid request — so, unlike `submit()`'s own
      // network catch, this is honestly `not_dispatched` regardless of what
      // the underlying transport failure was. Without this explicit
      // override, `isRetryableProviderError` silently could never retry a
      // network hiccup here (its default for an unspecified `network`
      // failure is the conservative `dispatched_ambiguous`, correct for a
      // PAID call but wrong for this one) — making the `withRetry` wrapper
      // around this call in `pollUntilDone` a no-op for the exact class of
      // failure it exists to absorb.
      throw new ProviderError(
        "network",
        `The production reconstruction provider's status endpoint could not be reached (${describeFetchFailure(error)}).`,
        "not_dispatched",
        "poll",
      );
    }

    classifyPollResponse(response.status, "poll");

    let payload: TopazStatusPayload;
    try {
      payload = (await response.json()) as TopazStatusPayload;
    } catch {
      throw new ProviderError(
        "malformed_response",
        "The production reconstruction provider returned an unreadable status response.",
        undefined,
        "poll",
      );
    }
    return typeof payload.status === "string" ? payload.status : "";
  }

  /**
   * Reads back the CURRENT result for an already-completed (or in-progress)
   * process id — never a paid dispatch. Always fetches a FRESH result URL
   * from `/download/{processId}` on every call rather than trusting one
   * returned by a prior call (Goal: a caller retrying this — see
   * `runReconstructionPass`'s bounded `withRetry` wrapper — never risks
   * reusing an expired signed URL, because it never reuses one at all).
   *
   * S3A security patch: the SECOND fetch below — to `url`, a value taken
   * directly from the provider's own JSON response, never a value this
   * process chose — is the actual untrusted-destination boundary. Every
   * check from here to the end of this method exists because a paid
   * reconstruction may already have happened by the time this runs (Goal
   * G below), so a rejection here must NEVER look like "the request never
   * happened": it stays classified exactly as the pre-existing content-type
   * mismatch check always was (`malformed_response`, which
   * `ProviderError`'s own `defaultDispatchState` reads as
   * `dispatched_billed`) — never `provider_job_failed`, the one
   * classification that clears a job's persisted `providerRequestId` and
   * permits a fresh paid resubmission.
   */
  private async download(processId: string): Promise<Buffer> {
    let metaResponse: Response;
    try {
      metaResponse = await this.fetchImpl(`${TOPAZ_API_BASE}/download/${processId}`, {
        headers: { "X-API-Key": this.apiKey },
      });
    } catch (error) {
      // Same reasoning as `fetchStatus`'s catch above: reading back result
      // metadata is never itself billable, so this is honestly
      // `not_dispatched` — never `dispatched_ambiguous` by default.
      throw new ProviderError(
        "network",
        `The production reconstruction provider's download endpoint could not be reached (${describeFetchFailure(error)}).`,
        "not_dispatched",
        "download",
      );
    }
    classifyPollResponse(metaResponse.status, "download");

    let meta: { url?: unknown; download_url?: unknown };
    try {
      meta = (await metaResponse.json()) as { url?: unknown; download_url?: unknown };
    } catch {
      throw new ProviderError(
        "malformed_response",
        "The production reconstruction provider returned an unreadable download response.",
        undefined,
        "download",
      );
    }
    const url = typeof meta.url === "string" ? meta.url : typeof meta.download_url === "string" ? meta.download_url : null;
    if (!url) {
      throw new ProviderError(
        "malformed_response",
        "The production reconstruction provider's download response did not include a URL.",
        undefined,
        "download",
      );
    }

    // --- A. URL SCHEME ---------------------------------------------------
    // No documented, fixture-established, or previously-observed Topaz
    // result-download HOST exists anywhere in this repository (checked:
    // API docs excerpts, the Phase 2D bake-off report/script, both live
    // incident write-ups) — `url`/`download_url` is a signed, provider-
    // generated link whose host this codebase has never had a basis to
    // pin down, so no host allowlist is asserted here (inventing one would
    // be a guess, not a control). Scheme is not a guess: every legitimate
    // provider result link is HTTPS, and requiring it closes off
    // `http:`/`file:`/`data:`/`ftp:`/every other scheme outright, before
    // this process ever dispatches a second network request.
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      throw new ProviderError(
        "malformed_response",
        "The production reconstruction provider's download URL could not be parsed.",
        undefined,
        "download",
      );
    }
    if (parsedUrl.protocol !== "https:") {
      throw new ProviderError(
        "malformed_response",
        `The production reconstruction provider's download URL used a disallowed scheme ("${parsedUrl.protocol}") — only https is accepted.`,
        undefined,
        "download",
      );
    }

    // "Fix Topaz Resume/Download Failure": `submit()` bounds its own
    // request with a timeout; this fetch — which can transfer a large PNG
    // — previously had none at all, so a genuine hang surfaced (after
    // whatever the runtime's own, unconfigured default eventually did)
    // as the same generic, undiagnosable "could not be fetched" as every
    // other transport failure. An explicit, bounded, DISTINCTLY classified
    // timeout makes a hang legible without changing what a fast failure
    // (DNS, refused connection, reset) reports. Unchanged/unweakened by
    // the S3A security patch — the same controller now also bounds the
    // size-capped body read below, never just the header fetch.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.downloadTimeoutMs);
    let abortedForSize = false;
    let imageResponse: Response;
    try {
      // --- C. REDIRECTS ---------------------------------------------------
      // No allowlisted host exists to validate a redirect DESTINATION
      // against (see the scheme note above), so the only honest policy is
      // to never follow one at all: `redirect: "manual"` returns the raw
      // 3xx response (verified against this runtime's actual `fetch`
      // behavior) rather than transparently chasing it to an
      // attacker-influenceable destination.
      imageResponse = await this.fetchImpl(url, { signal: controller.signal, redirect: "manual" });
    } catch (error) {
      if (isAbortError(error)) {
        throw new ProviderError(
          "timeout",
          "The production reconstruction provider's downloaded artwork did not finish transferring in time.",
          "not_dispatched",
          "download",
        );
      }
      // Never the URL itself (it is a signed, single-purpose result link) —
      // only the error's own name/code, e.g. "ENOTFOUND", "ECONNRESET",
      // enough to tell DNS/TLS/reset/refused apart on the NEXT occurrence
      // without ever logging a secret or a fetchable link.
      throw new ProviderError(
        "network",
        `The production reconstruction provider's downloaded artwork could not be fetched (${describeFetchFailure(error)}).`,
        "not_dispatched",
        "download",
      );
    } finally {
      clearTimeout(timeout);
    }
    if (imageResponse.status >= 300 && imageResponse.status < 400) {
      throw new ProviderError(
        "malformed_response",
        `The production reconstruction provider's downloaded artwork redirected (${imageResponse.status}) — redirects are not followed.`,
        undefined,
        "download",
      );
    }
    if (!imageResponse.ok) {
      throw new ProviderError(
        "network",
        `The production reconstruction provider's downloaded artwork request failed (${imageResponse.status}${describeHttpStatusHint(imageResponse.status)}).`,
        "not_dispatched",
        "download",
      );
    }
    // --- E. CONTENT TYPE --------------------------------------------------
    // A missing header never by itself establishes trust — it only skips
    // THIS check; the magic-byte check a few lines below is unconditional
    // and is what actually decides whether the bytes are an admitted
    // raster, regardless of what (if anything) this header claims.
    const contentType = imageResponse.headers.get("content-type") ?? "";
    if (contentType && !contentType.includes("png") && !contentType.includes("octet-stream")) {
      throw new ProviderError(
        "malformed_response",
        `The production reconstruction provider's downloaded artwork had an unexpected content type (${contentType}).`,
        undefined,
        "download",
      );
    }

    // --- D. RESPONSE SIZE ---------------------------------------------------
    // A dedicated provider-result cap (S3B.1) — see `MAX_PROVIDER_RESULT_DOWNLOAD_BYTES`'s
    // own doc comment for why this is deliberately NOT the customer-upload
    // limit. Enforced while READING the response, not after a full
    // `arrayBuffer()` — an oversized body is never fully buffered into
    // memory first.
    const declaredLength = imageResponse.headers.get("content-length");
    if (declaredLength) {
      const declared = Number(declaredLength);
      if (Number.isFinite(declared) && declared > MAX_PROVIDER_RESULT_DOWNLOAD_BYTES) {
        throw new ProviderError(
          "malformed_response",
          `The production reconstruction provider's downloaded artwork declared ${declared} bytes, exceeding the ${MAX_PROVIDER_RESULT_DOWNLOAD_BYTES}-byte limit.`,
          undefined,
          "download",
        );
      }
    }
    let buffer: Buffer;
    try {
      buffer = await readResponseBodyWithSizeCap(
        imageResponse,
        MAX_PROVIDER_RESULT_DOWNLOAD_BYTES,
        () => {
          abortedForSize = true;
          controller.abort();
        },
      );
    } catch (error) {
      if (abortedForSize) {
        throw new ProviderError(
          "malformed_response",
          `The production reconstruction provider's downloaded artwork exceeded the ${MAX_PROVIDER_RESULT_DOWNLOAD_BYTES}-byte limit.`,
          undefined,
          "download",
        );
      }
      if (isAbortError(error)) {
        throw new ProviderError(
          "timeout",
          "The production reconstruction provider's downloaded artwork did not finish transferring in time.",
          "not_dispatched",
          "download",
        );
      }
      throw new ProviderError(
        "network",
        `The production reconstruction provider's downloaded artwork could not be read (${describeFetchFailure(error)}).`,
        "not_dispatched",
        "download",
      );
    }
    if (buffer.length === 0) {
      throw new ProviderError(
        "malformed_response",
        "The production reconstruction provider's downloaded artwork was empty.",
        undefined,
        "download",
      );
    }
    // --- E (continued). MAGIC-BYTE VALIDATION ------------------------------
    // Unconditional — runs regardless of what the content-type header
    // said or omitted. This is the actual trust decision; the header
    // above is only ever a fast-path hint.
    if (!bufferStartsWithPngSignature(buffer)) {
      throw new ProviderError(
        "malformed_response",
        "The production reconstruction provider's downloaded artwork is not a valid PNG image.",
        undefined,
        "download",
      );
    }
    return buffer;
  }
}

/**
 * Refuses, without dispatching, any request that exceeds the provider's proven
 * `PROVIDER_MAX_RECONSTRUCTION_SCALE` on either axis.
 *
 * `invalid_request` + `not_dispatched` deliberately: nothing left this
 * process, nothing was billed, and `isRetryableProviderError` excludes it so
 * no transport retry can turn one refusal into repeated paid attempts.
 */
function assertWithinProviderScaleCeiling(
  sourceWidth: number,
  sourceHeight: number,
  requestedWidth: number,
  requestedHeight: number,
): void {
  const maxWidth = sourceWidth * PROVIDER_MAX_RECONSTRUCTION_SCALE;
  const maxHeight = sourceHeight * PROVIDER_MAX_RECONSTRUCTION_SCALE;
  // Rounding to whole pixels can land a hair above an exact 4x multiple; the
  // tolerance admits that and nothing wider.
  if (requestedWidth <= maxWidth + 1 && requestedHeight <= maxHeight + 1) return;
  throw new ProviderError(
    "invalid_request",
    `A ${requestedWidth}x${requestedHeight} reconstruction of a ${sourceWidth}x${sourceHeight} source exceeds the ` +
      `${PROVIDER_MAX_RECONSTRUCTION_SCALE}x maximum this reconstruction provider can deliver — it would be silently ` +
      `reduced to ${Math.round(maxWidth)}x${Math.round(maxHeight)} and billed anyway.`,
    "not_dispatched",
  );
}

function classifySubmitResponse(status: number): void {
  if (status === 401 || status === 403) {
    throw new ProviderError(
      "auth",
      "The production reconstruction provider rejected the configured credentials.",
      undefined,
      "submit",
    );
  }
  if (status === 412) {
    throw new ProviderError(
      "insufficient_credits",
      "The production reconstruction provider reported the account cannot afford this request.",
      undefined,
      "submit",
    );
  }
  if (status === 429) {
    throw new ProviderError(
      "rate_limited",
      "The production reconstruction provider is rate-limiting requests right now.",
      undefined,
      "submit",
    );
  }
  if (status >= 500) {
    // Deliberately NOT overriding dispatch here: this is the PAID
    // submission call, and a 5xx genuinely cannot prove whether the
    // provider accepted (and started billing) the request before failing —
    // stays at its conservative default (`dispatched_ambiguous`), unlike
    // `classifyPollResponse`'s identical-looking branch below.
    throw new ProviderError(
      "unavailable",
      "The production reconstruction provider is temporarily unavailable.",
      undefined,
      "submit",
    );
  }
  if (status < 200 || status >= 300) {
    throw new ProviderError(
      "malformed_response",
      `The production reconstruction provider returned an unexpected submission status (${status}).`,
      undefined,
      "submit",
    );
  }
}

/**
 * Shared by `fetchStatus` (poll) and `download`'s metadata call — NEITHER
 * is ever itself a billable dispatch, which is what justifies overriding
 * `unavailable`'s dispatch to `not_dispatched` here (unlike
 * `classifySubmitResponse`'s own 5xx branch, which must stay ambiguous: it
 * guards the actual paid call). `stage` labels the resulting `ProviderError`
 * for observability only — never changes classification or dispatch.
 */
function classifyPollResponse(status: number, stage: "poll" | "download"): void {
  if (status === 401 || status === 403) {
    throw new ProviderError(
      "auth",
      "The production reconstruction provider rejected the configured credentials.",
      undefined,
      stage,
    );
  }
  if (status === 429) {
    throw new ProviderError(
      "rate_limited",
      "The production reconstruction provider is rate-limiting requests right now.",
      undefined,
      stage,
    );
  }
  if (status === 404 || status === 410) {
    // "Fix Topaz Resume/Download Failure" Phase 3: a distinct, honest
    // verdict for "the provider no longer has this" — never itself a
    // reason to submit a fresh paid request (nothing here or in any caller
    // does that automatically; see this file's and the worker's own
    // resume-never-resubmit contract). `malformed_response`'s own default
    // dispatch (`dispatched_billed`) is exactly right: the ORIGINAL
    // submission most likely already completed and was billed, even though
    // its result can no longer be retrieved.
    throw new ProviderError(
      "malformed_response",
      `The production reconstruction provider reports this request is no longer available (status ${status}) — ` +
        `it may have expired, or already been retrieved and cleared on the provider's side.`,
      undefined,
      stage,
    );
  }
  if (status >= 500) {
    throw new ProviderError(
      "unavailable",
      "The production reconstruction provider is temporarily unavailable.",
      "not_dispatched",
      stage,
    );
  }
  if (status < 200 || status >= 300) {
    throw new ProviderError(
      "malformed_response",
      `The production reconstruction provider returned an unexpected status (${status}).`,
      undefined,
      stage,
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

/**
 * "Fix Topaz Resume/Download Failure" Phase 1/4: a SANITIZED, low-level
 * description of why a `fetch` call itself threw — the error's `name` plus,
 * when present, undici's own `error.cause.code` (e.g. `"ENOTFOUND"`,
 * `"ECONNREFUSED"`, `"ECONNRESET"`, `"CERT_HAS_EXPIRED"`). This is exactly
 * what distinguishes DNS failure / connection refusal / TLS problem / reset
 * from one another in a log or persisted `lastError` — the ONE thing the
 * previous blanket `catch { throw ProviderError("network", "...could not be
 * fetched.") }` discarded, making every transport failure look identical.
 * Never includes the request URL, any header, or any credential — only the
 * JS error's own identity.
 */
function describeFetchFailure(error: unknown): string {
  if (!(error instanceof Error)) return "unknown error";
  const cause = (error as { cause?: unknown }).cause;
  const code =
    cause && typeof cause === "object" && "code" in cause && typeof (cause as { code: unknown }).code === "string"
      ? (cause as { code: string }).code
      : null;
  return code ? `${error.name}: ${code}` : error.name || "unknown error";
}

/** A short, sanitized, human-readable hint for a handful of HTTP statuses that commonly mean something specific for a signed download link — never more than that status's own well-known meaning. */
function describeHttpStatusHint(status: number): string {
  if (status === 401 || status === 403) {
    return " — the signed download link may have expired or been rejected";
  }
  if (status === 404 || status === 410) {
    return " — the reconstructed output may no longer be available from the provider";
  }
  return "";
}
