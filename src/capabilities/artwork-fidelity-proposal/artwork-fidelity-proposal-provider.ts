/**
 * Universal Raster Reconstruction Phase R4A: the pluggable multimodal
 * proposal-extraction boundary — a narrow port mirroring
 * `SignPreservationSemanticProvider`/`ConceptEvaluationProvider`'s own
 * shape (`providerKey` + one async method + provider-neutral request/result).
 * Implementations own 100% of their own prompt dialect, request shape, and
 * response parsing internally — the capability layer never sees
 * provider-specific request/response shapes, only this contract.
 */

import type { ArtworkFidelityProposalResult } from "./contracts";

export interface ArtworkFidelityProposalImageInput {
  bytes: Buffer;
  /** e.g. "image/png" — validated by the caller before this is ever constructed. */
  contentType: string;
}

export interface ArtworkFidelityProposalProvider {
  readonly providerKey: string;
  propose(
    input: ArtworkFidelityProposalImageInput,
  ): Promise<ArtworkFidelityProposalResult>;
}
