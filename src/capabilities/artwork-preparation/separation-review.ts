/**
 * Intelligent Separation Phase 9: the pure decision boundary over a
 * `RegionMap` + `SeparationDecisionSet`.
 *
 * Mirrors `repairability.ts`'s and `production-source-strategy.ts`'s shape
 * deliberately: a pure function that reads measured/persisted facts and
 * returns a verdict, never a repository, never a provider, never a clock.
 */

import type {
  RegionDecision,
  RegionMap,
  SeparationDecisionSet,
  SeparationReviewState,
  SeparationReviewView,
  SubmitRegionDecisionsRequest,
} from "./region-separation-contracts";

/**
 * True when a persisted decision set no longer describes the CURRENT region
 * map — a different source, a different algorithm version, or a region set
 * that changed materially (Goal 3/12). A stale set is never applied; the
 * caller must re-review from a fresh `computeRegionMap`.
 *
 * Phase 23: deliberately does NOT check `proposalHash` — the proposal axis
 * has its own, simpler staleness rule (`isProposalStale` below), because
 * unlike a region id, there is no "disjoint, unrecoverable" failure mode for
 * a single unified proposal: a stale proposal always safely resets to its
 * own default (`"pending"`, which retains everything), never to
 * `cannot_safely_automate`.
 */
export function isDecisionSetStale(regionMap: RegionMap, decisionSet: SeparationDecisionSet | null): boolean {
  if (!decisionSet) return false;
  return (
    decisionSet.sourceAssetSha256 !== regionMap.sourceAssetSha256 ||
    decisionSet.regionMapHash !== regionMap.regionMapHash ||
    decisionSet.algorithmVersion !== regionMap.algorithmVersion
  );
}

/**
 * Phase 23: true when the persisted `proposalDecision`/`proposalPreserveOps`
 * were decided against a DIFFERENT proposal than the one `regionMap`
 * currently describes (Phase 22B Issue 1's collision-resistant
 * `proposalHash`, Section 10's fail-closed requirement). Always safely
 * recoverable — a stale proposal decision is simply treated as `"pending"`
 * by every reader (`effectiveProposalDecision` below), never remapped onto
 * the new proposal's pixels.
 */
export function isProposalStale(regionMap: RegionMap, decisionSet: SeparationDecisionSet | null): boolean {
  if (!decisionSet) return false;
  if (!regionMap.inBoundsProposal) return false;
  if (decisionSet.proposalHash === null) return false; // never decided yet — nothing to be stale
  return decisionSet.proposalHash !== regionMap.inBoundsProposal.proposalHash;
}

/**
 * The proposal decision to actually TRUST for authority/display purposes —
 * `"pending"` whenever there is no proposal, no decision has been recorded,
 * or the recorded one is stale (Phase 23's fail-closed rule: drift always
 * resolves toward the safe default, never toward carrying forward a
 * decision made against different pixels).
 */
export function effectiveProposalDecision(
  regionMap: RegionMap,
  decisionSet: SeparationDecisionSet | null,
): SeparationDecisionSet["proposalDecision"] | null {
  if (!regionMap.inBoundsProposal) return null;
  if (!decisionSet || isProposalStale(regionMap, decisionSet)) return "pending";
  return decisionSet.proposalDecision;
}

/**
 * Phase 23 / Phase 22B Issue 2's resolution: THE FINAL-APPROVAL GATE,
 * intentionally separate from `assessSeparationReviewState`'s enum below.
 *
 * Consequential-region completeness is NOT part of this gate — an undecided
 * isolated region already retains its pixels exactly as an explicit "ink" or
 * "uncertain" decision would (see `buildSeparationMaster`), so requiring an
 * answer for every one of them before approval was a workflow gate with no
 * pixel-safety justification, not a destructive-authority rule. Removing it
 * is what makes "Inspect individual areas" genuinely optional rather than a
 * disguised requirement.
 */
export function isReadyForFinalApproval(regionMap: RegionMap, decisionSet: SeparationDecisionSet | null): boolean {
  if (isDecisionSetStale(regionMap, decisionSet)) return false;
  if (regionMap.inBoundsProposal) {
    const decision = effectiveProposalDecision(regionMap, decisionSet);
    if (decision === "pending" || decision === null) return false;
  }
  return true;
}

/**
 * THE STATE MACHINE (Goal 9). Pure: same region map + same decision set
 * always yields the same state.
 *
 * Phase 23: `review_complete` now means "ready for final approval" per
 * `isReadyForFinalApproval` above — driven by the proposal decision when a
 * proposal exists, NOT by every consequential region having an explicit
 * decision (Phase 22B Issue 2). `review_not_required` now also requires the
 * absence of an in-bounds proposal, not just zero consequential regions —
 * artwork with a proposal but zero isolated regions still needs an operator
 * to see and decide it.
 */
export function assessSeparationReviewState(
  regionMap: RegionMap,
  decisionSet: SeparationDecisionSet | null,
): SeparationReviewState {
  const hasConsequentialRegions = regionMap.consequentialRegions.length > 0;
  const hasProposal = regionMap.inBoundsProposal !== null;
  if (!hasConsequentialRegions && !hasProposal) return "review_not_required";

  if (isDecisionSetStale(regionMap, decisionSet)) {
    // A stale set with SOME overlapping region ids is still recoverable by
    // re-deciding; a completely disjoint set (every id gone) cannot be
    // carried forward at all and the caller must start over. (Proposal
    // staleness alone never causes this — see `isProposalStale`'s doc.)
    const overlap = decisionSet
      ? decisionSet.decisions.some((d) =>
          regionMap.consequentialRegions.some((r) => r.regionId === d.regionId),
        )
      : true;
    return overlap ? "review_required" : "cannot_safely_automate";
  }

  if (decisionSet?.approvedAt) {
    // Approval only ever happens once `isReadyForFinalApproval` held —
    // re-verified here rather than trusted, in case something changed
    // without clearing approvedAt (defence in depth; the capability layer is
    // the one that actually clears it).
    return isReadyForFinalApproval(regionMap, decisionSet) ? "review_complete" : "review_required";
  }

  if (isReadyForFinalApproval(regionMap, decisionSet)) return "review_complete";

  // Not yet ready. "In progress" is informational only (Phase 23): does the
  // operator have SOME recorded activity, on either axis?
  const proposalTouched = hasProposal && effectiveProposalDecision(regionMap, decisionSet) !== "pending";
  const anyRegionDecided = hasConsequentialRegions
    ? regionMap.consequentialRegions.some((region) =>
        decisionSet?.decisions.some((d) => d.regionId === region.regionId && d.source === "operator"),
      )
    : false;
  if (proposalTouched || anyRegionDecided) return "review_in_progress";
  return "review_required";
}

/** Every consequential region has an OPERATOR decision of "substrate" or "ink" — never "uncertain", never a bare suggestion. */
export function isDecisionSetComplete(regionMap: RegionMap, decisionSet: SeparationDecisionSet | null): boolean {
  if (!decisionSet) return regionMap.consequentialRegions.length === 0;
  const byId = new Map(decisionSet.decisions.map((d) => [d.regionId, d]));
  return regionMap.consequentialRegions.every((r) => {
    const d = byId.get(r.regionId);
    return d !== undefined && d.source === "operator" && d.intent !== "uncertain";
  });
}

export function pendingRegionIds(regionMap: RegionMap, decisionSet: SeparationDecisionSet | null): number[] {
  const byId = new Map((decisionSet?.decisions ?? []).map((d) => [d.regionId, d]));
  return regionMap.consequentialRegions
    .filter((r) => {
      const d = byId.get(r.regionId);
      return !d || d.source !== "operator" || d.intent === "uncertain";
    })
    .map((r) => r.regionId);
}

/**
 * Validates an incoming decision-write request against the CURRENT region
 * map (Goal 22). Fails closed: any unknown region id, illegal intent, or
 * stale hash rejects the WHOLE request rather than applying the valid part
 * of it — a partially-applied write is exactly the ambiguous state this
 * workflow exists to avoid.
 */
export function validateSubmitRegionDecisions(
  regionMap: RegionMap,
  request: SubmitRegionDecisionsRequest,
): { ok: true } | { ok: false; reason: string } {
  if (request.sourceAssetSha256 !== regionMap.sourceAssetSha256) {
    return { ok: false, reason: "The artwork has changed since this review was loaded. Reload before deciding." };
  }
  if (request.regionMapHash !== regionMap.regionMapHash) {
    return { ok: false, reason: "The region analysis has changed since this review was loaded. Reload before deciding." };
  }
  if (!Array.isArray(request.decisions) || request.decisions.length === 0) {
    return { ok: false, reason: "No decisions were submitted." };
  }
  const validIds = new Set(regionMap.consequentialRegions.map((r) => r.regionId));
  const seen = new Set<number>();
  for (const d of request.decisions) {
    if (typeof d.regionId !== "number" || !validIds.has(d.regionId)) {
      return { ok: false, reason: `Region ${d.regionId} is not a known consequential region.` };
    }
    if (seen.has(d.regionId)) {
      return { ok: false, reason: `Region ${d.regionId} was submitted more than once.` };
    }
    seen.add(d.regionId);
    if (d.intent !== "substrate" && d.intent !== "ink" && d.intent !== "uncertain") {
      return { ok: false, reason: `"${String(d.intent)}" is not a supported decision.` };
    }
  }
  return { ok: true };
}

/**
 * Merges a validated write into the persisted decision set (or creates one).
 * Any decision CHANGE clears `approvedAt` (Goal 12/N) — an approved master
 * is authoritative only for the exact decisions it was built from.
 */
export function mergeRegionDecisions(
  regionMap: RegionMap,
  existing: SeparationDecisionSet | null,
  request: SubmitRegionDecisionsRequest,
  now: string,
): SeparationDecisionSet {
  const priorByRegion = new Map((existing?.decisions ?? []).map((d) => [d.regionId, d]));
  let changed = false;
  for (const d of request.decisions) {
    const prior = priorByRegion.get(d.regionId);
    if (!prior || prior.intent !== d.intent || prior.source !== "operator") changed = true;
    priorByRegion.set(d.regionId, {
      regionId: d.regionId,
      intent: d.intent,
      source: "operator",
      decidedAt: now,
      suggestion: prior?.suggestion ?? null,
    });
  }
  const decisions: RegionDecision[] = [...priorByRegion.values()].sort((a, b) => a.regionId - b.regionId);
  return {
    sourceAssetSha256: regionMap.sourceAssetSha256,
    regionMapHash: regionMap.regionMapHash,
    algorithmVersion: regionMap.algorithmVersion,
    decisions,
    // Phase 23: a region-decision write never itself touches the proposal
    // axis — carried through unchanged, exactly like every other untouched
    // field here.
    proposalDecision: existing?.proposalDecision ?? "pending",
    proposalDecisionAt: existing?.proposalDecisionAt ?? null,
    proposalHash: existing?.proposalHash ?? null,
    proposalPreserveOps: existing?.proposalPreserveOps ?? [],
    approvedAt: changed ? null : (existing?.approvedAt ?? null),
    approvedAssetId: changed ? null : (existing?.approvedAssetId ?? null),
    postCheckAtApproval: changed ? null : (existing?.postCheckAtApproval ?? null),
  };
}

/**
 * Validates an incoming PROPOSAL-decision write (Goal 22's discipline
 * applied to the new axis). Fails closed on any hash mismatch, unknown
 * decision value, or malformed tap coordinates — a partially-applied write
 * is exactly the ambiguous state this workflow exists to avoid, same as the
 * region path above.
 */
export function validateSubmitProposalDecision(
  regionMap: RegionMap,
  request: {
    sourceAssetSha256: string;
    proposalHash: string;
    decision: SeparationDecisionSet["proposalDecision"];
    addPreserveTaps?: ReadonlyArray<{ rawTapX: number; rawTapY: number }>;
    removePreserveOperationIds?: readonly string[];
  },
): { ok: true } | { ok: false; reason: string } {
  if (!regionMap.inBoundsProposal) {
    return { ok: false, reason: "This artwork has no proposed removal to decide." };
  }
  if (request.sourceAssetSha256 !== regionMap.sourceAssetSha256) {
    return { ok: false, reason: "The artwork has changed since this review was loaded. Reload before deciding." };
  }
  if (request.proposalHash !== regionMap.inBoundsProposal.proposalHash) {
    return { ok: false, reason: "The proposed removal has changed since this review was loaded. Reload before deciding." };
  }
  if (
    request.decision !== "pending" &&
    request.decision !== "remove_with_exceptions" &&
    request.decision !== "preserve_all"
  ) {
    return { ok: false, reason: `"${String(request.decision)}" is not a supported proposal decision.` };
  }
  for (const tap of request.addPreserveTaps ?? []) {
    if (typeof tap.rawTapX !== "number" || typeof tap.rawTapY !== "number" || !Number.isFinite(tap.rawTapX) || !Number.isFinite(tap.rawTapY)) {
      return { ok: false, reason: "A preserve tap had invalid coordinates." };
    }
  }
  return { ok: true };
}

/**
 * Merges a validated proposal-decision write. Any change to `decision` or to
 * the preserve-operation list clears `approvedAt` — Phase 22B Issue 3's
 * explicit requirement that switching EITHER direction between
 * `remove_with_exceptions` and `preserve_all` invalidates prior approval,
 * because both directions genuinely change which pixels the resulting
 * master would contain.
 *
 * Preserve operations are never deleted merely because `decision` is
 * `"preserve_all"` — they remain stored, inactive (Phase 22B Issue 3: kept,
 * not cleared, so switching back to `remove_with_exceptions` reactivates
 * whatever still replays against the current proposal, instead of forcing
 * the operator to redo every tap).
 */
export function mergeProposalDecision(
  regionMap: RegionMap,
  existing: SeparationDecisionSet | null,
  request: {
    decision: SeparationDecisionSet["proposalDecision"];
    addPreserveTaps?: ReadonlyArray<{ rawTapX: number; rawTapY: number }>;
    removePreserveOperationIds?: readonly string[];
  },
  now: string,
  newOperationIds: readonly string[],
  capRuleVersion: string,
  snapRuleVersion: string,
): SeparationDecisionSet {
  const proposalHash = regionMap.inBoundsProposal!.proposalHash;
  const priorDecision = existing?.proposalDecision ?? "pending";
  const priorOps = existing && existing.proposalHash === proposalHash ? existing.proposalPreserveOps : [];

  const removeIds = new Set(request.removePreserveOperationIds ?? []);
  let ops = priorOps.filter((op) => !removeIds.has(op.operationId));

  const addTaps = request.addPreserveTaps ?? [];
  addTaps.forEach((tap, index) => {
    ops = [
      ...ops,
      {
        operationId: newOperationIds[index]!,
        rawTapX: tap.rawTapX,
        rawTapY: tap.rawTapY,
        capRuleVersion,
        snapRuleVersion,
        decidedAt: now,
        source: "operator" as const,
      },
    ];
  });

  const decisionChanged = priorDecision !== request.decision;
  const opsChanged = ops.length !== priorOps.length || removeIds.size > 0 || addTaps.length > 0;
  const changed = decisionChanged || opsChanged || (existing?.proposalHash ?? null) !== proposalHash;

  return {
    sourceAssetSha256: regionMap.sourceAssetSha256,
    regionMapHash: regionMap.regionMapHash,
    algorithmVersion: regionMap.algorithmVersion,
    decisions: existing?.decisions ?? [],
    proposalDecision: request.decision,
    proposalDecisionAt: now,
    proposalHash,
    proposalPreserveOps: ops,
    approvedAt: changed ? null : (existing?.approvedAt ?? null),
    approvedAssetId: changed ? null : (existing?.approvedAssetId ?? null),
    postCheckAtApproval: changed ? null : (existing?.postCheckAtApproval ?? null),
  };
}

export function buildSeparationReviewView(
  regionMap: RegionMap,
  decisionSet: SeparationDecisionSet | null,
  postCheck: SeparationReviewView["postCheck"],
  isProductionAuthoritative: boolean,
): SeparationReviewView {
  return {
    state: assessSeparationReviewState(regionMap, decisionSet),
    regionMap,
    decisions: decisionSet?.decisions ?? [],
    pendingRegionIds: pendingRegionIds(regionMap, decisionSet),
    postCheck,
    approvedAt: decisionSet?.approvedAt ?? null,
    isProductionAuthoritative,
    proposalDecision: effectiveProposalDecision(regionMap, decisionSet),
    // Stale preserve ops are never shown as if they still applied to the
    // current proposal — mirrors `effectiveProposalDecision`'s own
    // fail-closed reset.
    proposalPreserveOps:
      regionMap.inBoundsProposal && decisionSet && !isProposalStale(regionMap, decisionSet)
        ? decisionSet.proposalPreserveOps
        : [],
    readyForFinalApproval: isReadyForFinalApproval(regionMap, decisionSet),
  };
}
