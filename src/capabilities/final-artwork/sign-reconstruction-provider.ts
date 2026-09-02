/**
 * Signs Phase S3A: the bounded-reconstruction boundary a rigid-sign
 * `reconstruct_resolution` step dispatches against.
 *
 * Deliberately NOT `FinalArtworkProvider.produce()` — that contract is
 * shaped around apparel's own post-reconstruction pipeline (alpha-trim
 * bounding box, `PlacementSizingPolicy` width-in/PPI sizing, safety margin,
 * `normalizeProductionRaster`/`encodeProductionPng`), none of which applies
 * to a rigid sign: a sign plan already computed its own exact
 * `requestedWidthPx`/`requestedHeightPx` (Signs own reconstruction intent —
 * see `sign-preparation/sign-repair-planner.ts`), the source carries no
 * alpha to trim, and the deterministic S2 remainder of the plan — not this
 * provider — owns what happens to the reconstructed raster next.
 *
 * What a sign reconstruction genuinely SHARES with the apparel path — the
 * paid-request resume contract (`existingProviderRequest`/
 * `onProviderRequestSubmitted`), the proven scale ceiling, submit/poll/
 * download, and result-geometry validation — is reused unmodified via
 * `TopazTransparencyUpscaleProvider.produceSignReconstruction`, a second
 * public method on the SAME class/instance/HTTP-polling machinery
 * `produce()` already uses, never a second Topaz client or a parallel
 * billing subsystem.
 */

import type { FinalArtworkProviderResumeContext } from "./provider";

export interface SignReconstructionProviderInput {
  /** The exact bytes the reconstruction step's intent was formulated against — already sha256/dimension-verified by the caller. */
  sourceBytes: Buffer;
  sourceContentType: string;
  /** The persisted `reconstruct_resolution` step's own target — never re-derived here. */
  requestedWidthPx: number;
  requestedHeightPx: number;
  /**
   * A prior in-flight or completed paid-request identity recorded for this
   * exact `FinalArtworkJob`, if any — mirrors
   * `FinalArtworkProviderInput.existingProviderRequest` exactly, reusing the
   * identical resume contract.
   */
  existingProviderRequest?: FinalArtworkProviderResumeContext | null;
  /**
   * Called once, synchronously, the instant a NEW paid submission is
   * accepted — before any polling begins. Mirrors
   * `FinalArtworkProviderInput.onProviderRequestSubmitted` exactly.
   */
  onProviderRequestSubmitted?: (providerRequestId: string) => Promise<void>;
}

export interface SignReconstructionProviderOutput {
  /** Raw reconstructed PNG bytes — no apparel normalization/alpha-trim/encode applied. */
  bytes: Buffer;
  widthPx: number;
  heightPx: number;
  /** The paid provider's own request identifier — internal-only, never customer-facing. */
  providerRequestId: string;
}

/**
 * A provider capable of a bounded, exact-pixel-target reconstruction for
 * rigid signs. Signs own reconstruction intent (required geometry, sign PPI
 * policy, `RepairPlan` parameters); a provider implementing this owns only
 * bounded execution of that intent.
 */
export interface SignReconstructionProvider {
  readonly providerKey: string;
  produceSignReconstruction(
    input: SignReconstructionProviderInput,
  ): Promise<SignReconstructionProviderOutput>;
}

/** True iff `provider` also implements `SignReconstructionProvider` — the configured production provider (Topaz) does; a local-only/dev provider does not. */
export function hasSignReconstructionCapability<T extends { providerKey: string }>(
  provider: T,
): provider is T & SignReconstructionProvider {
  return typeof (provider as Partial<SignReconstructionProvider>).produceSignReconstruction === "function";
}

/**
 * Exhausted Provider Result Recovery Phase: input for `resumeSignReconstruction`
 * below. `existingProviderRequest` is REQUIRED — unlike
 * `SignReconstructionProviderInput`'s own optional field of the same name —
 * because this contract has no fresh-submission fallback to fall back TO.
 * `sourceBytes` is deliberately absent: nothing in a resume-only poll/
 * download/decode ever needs the original source image, and omitting the
 * field is one more thing that makes a fresh dispatch structurally
 * unreachable from this call shape, not merely unused.
 */
export interface SignReconstructionResumeInput {
  existingProviderRequest: FinalArtworkProviderResumeContext;
  requestedWidthPx: number;
  requestedHeightPx: number;
  sourceWidthPx: number;
  sourceHeightPx: number;
}

/**
 * Exhausted Provider Result Recovery Phase: a provider capability that can
 * ONLY resume/poll/download an ALREADY-SUBMITTED paid request — never
 * submit a new one. For use exclusively by the exhausted-job existing-
 * result recovery path (`FinalArtworkWorkerCapability.recoverExhaustedSignProviderResult`),
 * never by the normal resume-or-submit reconstruction path.
 *
 * A provider implementing this must make fresh submission STRUCTURALLY
 * impossible from within `resumeSignReconstruction` itself — never merely
 * "won't submit because the request happens to be present" (which the
 * existing `produceSignReconstruction`/`existingProviderRequest` contract
 * already offers, and which this interface deliberately does NOT reuse):
 * this method's own implementation must have no code path that reaches its
 * paid-submission method at all, regardless of what it's called with.
 */
export interface SignReconstructionResumeProvider {
  readonly providerKey: string;
  resumeSignReconstruction(
    input: SignReconstructionResumeInput,
  ): Promise<SignReconstructionProviderOutput>;
}

/** True iff `provider` also implements `SignReconstructionResumeProvider` — the configured production provider (Topaz) does; a local-only/dev/fake provider does not unless it deliberately opts in. */
export function hasSignReconstructionResumeCapability<T extends { providerKey: string }>(
  provider: T,
): provider is T & SignReconstructionResumeProvider {
  return typeof (provider as Partial<SignReconstructionResumeProvider>).resumeSignReconstruction === "function";
}
