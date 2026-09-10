/**
 * Universal Raster Reconstruction Phase R3B: canonical Artwork Fidelity
 * Contract identity — the future reconstruction-binding key, mirroring
 * `sign-preparation/sign-plan-identity.ts`'s `computeSignPlanKey` pattern
 * exactly (Phase R3A's own established precedent for this kind of durable,
 * recompute-and-compare authority key).
 *
 * Identity covers exactly the PRODUCTION-SIGNIFICANT confirmed facts: which
 * source, what exact wording, which protected marks, and the measured
 * content geometry. It deliberately EXCLUDES `status`, `id`, `projectId`,
 * timestamps, and `proposedFacts` — two contracts confirming byte-identical
 * authority over the same source are the same contract for reconstruction
 * purposes, and non-authoritative machine proposals never participate in an
 * authority key by construction (Phase R3A Step 6/Step 10).
 *
 * `stableStringify` is a small, deliberately LOCAL copy of
 * `sign-plan-identity.ts`'s own function rather than a cross-capability
 * import — a shared capability must not depend on a downstream, Signs-owned
 * module for a generic, self-contained utility; duplicating ~12 lines here
 * is cheaper than an upstream dependency in the wrong direction (mirrors
 * this codebase's own precedent of duplicating small governed constants —
 * e.g. `RECONSTRUCTION_SCALE_CEILING` — rather than importing across a
 * capability boundary that should not exist).
 */

import { createHash } from "node:crypto";

import type { ArtworkFidelityContract, ProtectedMarkType } from "@/lib/domain/types";

export const ARTWORK_FIDELITY_CONTRACT_SCHEMA_VERSION = "artwork-fidelity-contract:v1";

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/** Deterministic JSON: object keys sorted recursively, arrays kept in order. */
function stableStringify(value: Json): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  const body = keys
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key]!)}`)
    .join(",");
  return `{${body}}`;
}

export type ArtworkFidelityContractIdentityInput = Pick<
  ArtworkFidelityContract,
  | "sourceAssetId"
  | "sourceSha256"
  | "confirmedWording"
  | "confirmedMarks"
  | "sourceContentBoundingBoxAspectRatio"
>;

/**
 * Precision floor for the bounding-box aspect ratio's participation in the
 * key — matching `computeSignPlanKey`'s own `toFixed(2)` numeric-stability
 * pattern for `orderedWidthIn`/`orderedHeightIn`. A measurement re-run
 * against the identical source can differ in the umpteenth decimal purely
 * from floating-point arithmetic order; rounding first means that noise
 * never produces a spurious key change.
 */
const ASPECT_RATIO_KEY_PRECISION = 4;

function canonicalMarks(marks: ProtectedMarkType[] | null): Json {
  if (!marks) return null;
  // Sorted (never the confirmation order) — Step 6/Step 12: "stable across
  // non-semantic field ordering." Which two marks are confirmed is the
  // fact; the order they happened to be checked in is not.
  return [...marks].sort();
}

function canonicalWording(wording: string[] | null): Json {
  if (!wording) return null;
  // Sorted, but NEVER case-folded or trimmed here — this is identity, not
  // display. A stored string's exact characters already came from
  // `confirmedWording`, which is never normalized (Step 11); sorting only
  // reorders whole strings, it does not touch their content.
  return [...wording].sort();
}

/**
 * `null` when no meaningful identity exists yet (deliberately never called
 * on a `"proposed"` contract by `ArtworkFidelityCapability` — a proposed
 * contract has no confirmed authority to key at all; see
 * `ArtworkFidelityContract.contractKey`'s own doc comment).
 */
export function deriveArtworkFidelityContractKey(
  input: ArtworkFidelityContractIdentityInput,
): string {
  const payload: Json = {
    schemaVersion: ARTWORK_FIDELITY_CONTRACT_SCHEMA_VERSION,
    sourceAssetId: input.sourceAssetId,
    sourceSha256: input.sourceSha256,
    confirmedWording: canonicalWording(input.confirmedWording),
    confirmedMarks: canonicalMarks(input.confirmedMarks),
    sourceContentBoundingBoxAspectRatio:
      input.sourceContentBoundingBoxAspectRatio === null
        ? null
        : Number(input.sourceContentBoundingBoxAspectRatio.toFixed(ASPECT_RATIO_KEY_PRECISION)),
  };
  const digest = createHash("sha256").update(stableStringify(payload)).digest("hex");
  return `${ARTWORK_FIDELITY_CONTRACT_SCHEMA_VERSION}:${digest}`;
}
