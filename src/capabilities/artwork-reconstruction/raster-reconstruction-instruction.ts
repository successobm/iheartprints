/**
 * Phase R5: the ONE place a confirmed `ArtworkFidelityContract`'s
 * structured facts become a `RasterReconstructionInstruction` — a pure
 * function, no I/O, no provider. See Section 13 of the R5 task: exact
 * wording/marks are sufficient for v1; excluded-region handling and
 * anything richer than aspect ratio are explicitly deferred.
 *
 * The caller (`RasterReconstructionCapability`) is responsible for proving
 * the contract is actually `status === "confirmed"` before calling this —
 * this function trusts the shape it's given and does not re-check status,
 * mirroring `deriveArtworkFidelityContractKey`'s own "pure, trusts its
 * caller for authority checks" precedent.
 */

import type { ArtworkFidelityContract } from "@/lib/domain/types";

import type { RasterReconstructionInstruction } from "./contracts";

export function deriveReconstructionInstruction(
  contract: ArtworkFidelityContract,
): RasterReconstructionInstruction {
  const confirmedMarks = contract.confirmedMarks ?? [];
  return {
    requiredWording: contract.confirmedWording ?? [],
    requiredMarks: confirmedMarks,
    // An empty array is a valid, explicit "confirmed: no marks present"
    // fact — distinct from `null` (never confirmed at all), mirroring
    // `ArtworkFidelityContract.confirmedMarks`'s own doc comment.
    explicitlyNoMarks: contract.confirmedMarks !== null && confirmedMarks.length === 0,
    sourceContentAspectRatio: contract.sourceContentBoundingBoxAspectRatio,
  };
}
