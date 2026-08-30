/**
 * Signs Phase S3A: a mocked/fake `SignReconstructionProvider` test double —
 * no network access, ever. Exists purely to prove the worker's own dispatch,
 * idempotency, recovery, and result-validation behavior WITHOUT spending a
 * real Topaz credit (S3A's hard paid-call safety rule).
 *
 * `dispatchCount`/`resumeCount` are the explicit counters S3A's test
 * requirements ask for: a fresh paid submission increments `dispatchCount`
 * exactly once; a resumed (never resubmitted) request increments
 * `resumeCount` instead. A test asserting "at most one billable dispatch"
 * asserts `dispatchCount === 1` regardless of how many times
 * `processNextJob()` was called to get there.
 */

import { PNG } from "pngjs";

import type {
  FinalArtworkProvider,
  FinalArtworkProviderInput,
  FinalArtworkProviderOutput,
} from "@/capabilities/final-artwork/provider";
import { ProviderError } from "@/capabilities/providers/provider-error";
import type {
  SignReconstructionProvider,
  SignReconstructionProviderInput,
  SignReconstructionProviderOutput,
} from "@/capabilities/final-artwork/sign-reconstruction-provider";

export type FakeSignReconstructionBehavior =
  | { kind: "success" }
  /** Returns a raster smaller than requested/source-proportional — the sufficiency check must refuse it. */
  | { kind: "insufficient_dimensions"; widthPx: number; heightPx: number }
  /** Returns a raster that meets/exceeds the request but with a distorted aspect ratio. */
  | { kind: "wrong_aspect"; widthPx: number; heightPx: number }
  /**
   * Returns a raster that is SUFFICIENT and proportionally correct (passes
   * `validateReconstructedGeometry`) but larger than what was requested —
   * an honest "more than you asked for" response (Phase 28R). Valid on its
   * own, but a plan whose deterministic tail assumes the EXACT requested
   * reconstruction size (fixed-pixel padding offsets) cannot reconcile it,
   * and must refuse via `output_geometry_mismatch` rather than silently
   * producing a plate the plan does not describe.
   */
  | { kind: "oversized_but_valid"; widthPx: number; heightPx: number }
  /** Returns bytes that do not decode as a PNG at all. */
  | { kind: "malformed_bytes" }
  /** Throws the given `ProviderError` (or a default terminal failure) instead of returning. */
  | { kind: "throw"; error?: ProviderError };

const NEAR_BLACK = { r: 6, g: 6, b: 6 };

function makeSolidPng(width: number, height: number): Buffer {
  const png = new PNG({ width, height });
  for (let i = 0; i < width * height; i++) {
    png.data[i * 4] = NEAR_BLACK.r;
    png.data[i * 4 + 1] = NEAR_BLACK.g;
    png.data[i * 4 + 2] = NEAR_BLACK.b;
    png.data[i * 4 + 3] = 255;
  }
  return PNG.sync.write(png);
}

/**
 * Implements BOTH `FinalArtworkProvider` (the apparel worker still requires
 * one structurally injected — `produce()` must never be called by any sign
 * job) and `SignReconstructionProvider` (the S3A dispatch surface this fake
 * actually exercises).
 */
export class FakeSignReconstructionProvider
  implements FinalArtworkProvider, SignReconstructionProvider
{
  readonly providerKey = "fake_sign_reconstruction_v1";

  /** Number of genuinely NEW paid submissions this instance has made. */
  dispatchCount = 0;
  /** Number of times an existing (never resubmitted) request was resumed. */
  resumeCount = 0;

  behavior: FakeSignReconstructionBehavior = { kind: "success" };

  private sequence = 0;

  async produce(_input: FinalArtworkProviderInput): Promise<FinalArtworkProviderOutput> {
    throw new Error(
      "FakeSignReconstructionProvider.produce() must never be called — sign jobs never use FinalArtworkProvider.produce().",
    );
  }

  async produceSignReconstruction(
    input: SignReconstructionProviderInput,
  ): Promise<SignReconstructionProviderOutput> {
    const resuming = input.existingProviderRequest?.providerKey === this.providerKey;
    let providerRequestId: string;
    if (resuming) {
      this.resumeCount += 1;
      providerRequestId = input.existingProviderRequest!.providerRequestId;
    } else {
      this.dispatchCount += 1;
      providerRequestId = `fake-sign-reconstruction-${++this.sequence}`;
      await input.onProviderRequestSubmitted?.(providerRequestId);
    }

    const behavior = this.behavior;
    if (behavior.kind === "throw") {
      throw (
        behavior.error ??
        new ProviderError(
          "provider_job_failed",
          "The fake reconstruction provider reported this request as terminally failed.",
        )
      );
    }
    if (behavior.kind === "malformed_bytes") {
      return {
        bytes: Buffer.from("not a png"),
        widthPx: input.requestedWidthPx,
        heightPx: input.requestedHeightPx,
        providerRequestId,
      };
    }
    if (
      behavior.kind === "insufficient_dimensions" ||
      behavior.kind === "wrong_aspect" ||
      behavior.kind === "oversized_but_valid"
    ) {
      return {
        bytes: makeSolidPng(behavior.widthPx, behavior.heightPx),
        widthPx: behavior.widthPx,
        heightPx: behavior.heightPx,
        providerRequestId,
      };
    }
    return {
      bytes: makeSolidPng(input.requestedWidthPx, input.requestedHeightPx),
      widthPx: input.requestedWidthPx,
      heightPx: input.requestedHeightPx,
      providerRequestId,
    };
  }
}
