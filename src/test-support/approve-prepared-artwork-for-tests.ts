import type { ArtworkPreparationCapability } from "@/capabilities/artwork-preparation";

/**
 * Intelligent Separation Phase 10: the SAME "approve" act a test performed
 * before consequential-region review existed, updated for the world where it
 * can.
 *
 * `approvePreparedArtwork` now refuses when the artwork's region map has
 * consequential regions still needing a decision — see
 * `artwork-preparation-capability.ts`, `approvePreparedArtwork`. That refusal
 * is the fix for the exact failure this whole feature exists to prevent: a
 * bowling-style fixture whose legitimate black ink touches a black
 * background must not reach an approved, production-authoritative asset
 * without an operator confirming which regions are shirt and which are ink.
 *
 * Tests written before that gate existed call `approvePreparedArtwork`
 * directly on bowling-style fixtures expecting it to just work. This helper
 * is the same call, except it first walks the review an operator now has to
 * complete: every consequential region gets marked "ink" (the correct,
 * design-preserving choice for these fixtures' interior line work) before
 * approving through `approveSeparationMaster`. For artwork with no
 * consequential regions it is exactly `approvePreparedArtwork` — no added
 * step, no behaviour change.
 *
 * Test support only. Never imported by application code.
 */
export async function approvePreparedArtworkForTests(
  capability: ArtworkPreparationCapability,
  projectId: string,
) {
  const review = await capability.getSeparationReview(projectId);
  if (review.state === "review_not_required") {
    return capability.approvePreparedArtwork(projectId);
  }

  await capability.submitRegionDecisions(projectId, {
    sourceAssetSha256: review.regionMap.sourceAssetSha256,
    regionMapHash: review.regionMap.regionMapHash,
    decisions: review.regionMap.consequentialRegions.map((region) => ({
      regionId: region.regionId,
      intent: "ink" as const,
    })),
  });
  await capability.approveSeparationMaster(projectId);

  const preparation = await capability.getPreparation(projectId);
  if (!preparation) {
    throw new Error(`Project ${projectId} has no preparation after approval`);
  }
  return preparation;
}
