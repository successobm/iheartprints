/**
 * TEST-ONLY SUPPORT (Fix Separation Review -> Edit Artwork Authority
 * Handoff): independently reconstructs "the raw separation master this
 * project's PREPARED review currently shows" from a project's OWN persisted
 * state, so tests can assert the correction workspace's actual base against
 * it without assuming the fix under test is correct.
 *
 * Deliberately calls the SAME pure functions
 * (`computeRegionMap`/`buildSeparationMaster`) production code calls — never
 * a re-implementation of the algorithm — but through an INDEPENDENT call
 * site, mirroring exactly what
 * `/api/projects/[projectId]/artwork-preparation/separation/image` (mode
 * `master`) does inline for the identical reason: proving two independent
 * callers of the same deterministic functions agree, rather than testing
 * `artwork-preparation-capability.ts`'s own internal helper against itself.
 *
 * Never imports anything from `artwork-preparation-capability.ts`.
 */
import { createHash } from "node:crypto";

import { decodePngUpload } from "./image-decode";
import { buildSeparationMaster, computeRegionMap, type ProposalAuthority } from "./region-separation";
import type { SeparationDecisionSet } from "./region-separation-contracts";
import { effectiveProposalDecision } from "./separation-review";
import type { ArtworkAnalysis } from "./contracts";

interface PreparationLike {
  analysis: unknown;
  separation: unknown;
}

interface RepoLike {
  getArtworkPreparation(projectId: string): Promise<PreparationLike | null>;
}

/**
 * Builds the master exactly as the review screen's `mode=master` would
 * render it right now, from `originalBytes` and this project's CURRENTLY
 * persisted `preparation.analysis`/`preparation.separation`. Callers should
 * re-invoke this after any action that could change region decisions
 * (`submitRegionDecisions`, `submitProposalDecision`) — it is never cached
 * and always reflects the live persisted state, same as production.
 */
export async function buildIndependentSeparationMaster(
  repo: RepoLike,
  projectId: string,
  originalBytes: Buffer,
) {
  const preparation = await repo.getArtworkPreparation(projectId);
  if (!preparation) throw new Error(`No artwork preparation found for project ${projectId}`);

  const original = decodePngUpload(originalBytes).image;
  const sourceAssetSha256 = createHash("sha256").update(originalBytes).digest("hex");
  const analysis = preparation.analysis as ArtworkAnalysis;
  const computation = computeRegionMap(
    original,
    sourceAssetSha256,
    analysis.estimatedBackgroundColor,
    analysis.backgroundTolerance,
  );

  const decisionSet = preparation.separation ? (preparation.separation as SeparationDecisionSet) : null;
  const decisions = decisionSet?.decisions ?? [];
  const decision = effectiveProposalDecision(computation.regionMap, decisionSet) ?? "pending";
  const preserveOperations =
    decisionSet && decisionSet.proposalHash === (computation.regionMap.inBoundsProposal?.proposalHash ?? null)
      ? decisionSet.proposalPreserveOps
      : [];
  const proposalAuthority: ProposalAuthority = { decision, preserveOperations };

  return buildSeparationMaster(original, computation, decisions, proposalAuthority);
}
