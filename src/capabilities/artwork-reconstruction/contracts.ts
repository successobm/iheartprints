/**
 * Phase R5 (Confirmed-Authority Raster Reconstruction v1): the shared,
 * provider-neutral shape a `RasterReconstructionProvider` consumes and
 * produces. Mirrors `FinalArtworkProviderInput`/`FinalArtworkProviderOutput`'s
 * own "domain code never knows if the implementation is local or
 * provider-hosted" boundary (`@/capabilities/final-artwork/provider.ts`),
 * applied to GENERATIVE reconstruction instead of Class-A/Class-B
 * enlargement.
 *
 * This capability must know nothing about DTF, Signs, physical print size,
 * QR, bleed, sign composition, Print Ready, or fulfillment — see
 * `RasterReconstructionCapability`'s own doc comment. Nothing in this file
 * imports from `final-artwork`, `sign-preparation`, or `print-validation`.
 */

import type { ProtectedMarkType } from "@/lib/domain/types";

/**
 * Derived ONCE, at the capability boundary, from a CONFIRMED
 * `ArtworkFidelityContract`'s own structured fields — never a raw prompt
 * string, and never persisted as durable authority itself (the confirmed
 * contract remains the sole authority; this is a disposable projection of
 * it). See `deriveReconstructionInstruction`.
 */
export interface RasterReconstructionInstruction {
  /** Exact strings that must appear, verbatim — capitalization and punctuation are part of the fact, never normalized here. */
  requiredWording: string[];
  /** The exact confirmed protected marks that must appear, verbatim. */
  requiredMarks: ProtectedMarkType[];
  /** `true` only when the confirmed contract explicitly recorded "no protected marks present" (an empty `confirmedMarks` array is a fact, not an absence of one) — lets the provider be told "there is no mark to preserve," never invent one. */
  explicitlyNoMarks: boolean;
  /** Deterministic machine evidence (never customer-confirmed) — `null` when never measured. */
  sourceContentAspectRatio: number | null;
}

export interface RasterReconstructionRequest {
  sourceBytes: Buffer;
  sourceContentType: string;
  /**
   * Whether the source asset itself already carries meaningful
   * transparency. This capability does not own background-removal
   * routing (Section 11 of the R5 task) — it only avoids INVENTING
   * transparency a fully opaque source never had, and avoids discarding
   * transparency a source already has.
   */
  sourceHasTransparency: boolean;
  instruction: RasterReconstructionInstruction;
}

export interface RasterReconstructionResult {
  bytes: Buffer;
  /** The provider's own, RAW (un-normalized) output dimensions — see `content-bounds-normalization.ts` for the separate content-bounds pass. */
  widthPx: number;
  heightPx: number;
  /** The provider's own request/response id, for support diagnosis only — never customer-facing. */
  providerRequestId: string | null;
  /**
   * Sanitized, non-secret provenance only — model, size, quality, attempt.
   * NEVER the provider's echoed/revised prompt text, never raw request/
   * response bodies, never customer-provided wording (Section 25 of the R5
   * task).
   */
  metadata: Record<string, unknown>;
}
