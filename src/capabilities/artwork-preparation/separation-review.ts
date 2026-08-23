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
 * THE STATE MACHINE (Goal 9). Pure: same region map + same decision set
 * always yields the same state.
 */
export function assessSeparationReviewState(
  regionMap: RegionMap,
  decisionSet: SeparationDecisionSet | null,
): SeparationReviewState {
  if (regionMap.consequentialRegions.length === 0) return "review_not_required";

  if (isDecisionSetStale(regionMap, decisionSet)) {
    // A stale set with SOME overlapping region ids is still recoverable by
    // re-deciding; a completely disjoint set (every id gone) cannot be
    // carried forward at all and the caller must start over.
    const overlap = decisionSet
      ? decisionSet.decisions.some((d) =>
          regionMap.consequentialRegions.some((r) => r.regionId === d.regionId),
        )
      : true;
    return overlap ? "review_required" : "cannot_safely_automate";
  }

  if (decisionSet?.approvedAt) {
    // Approval only ever happens once every consequential region carries an
    // operator decision — re-verified here rather than trusted, in case a
    // decision was somehow changed without clearing approvedAt (defence in
    // depth; the capability layer is the one that actually clears it).
    const complete = isDecisionSetComplete(regionMap, decisionSet);
    return complete ? "review_complete" : "review_required";
  }

  const decided = decisionSet?.decisions ?? [];
  const decidedIds = new Map(decided.map((d) => [d.regionId, d]));

  let anyDecided = false;
  let allDecidedAndCertain = true;
  for (const region of regionMap.consequentialRegions) {
    const d = decidedIds.get(region.regionId);
    if (!d || d.source !== "operator") {
      allDecidedAndCertain = false;
      continue;
    }
    anyDecided = true;
    if (d.intent === "uncertain") allDecidedAndCertain = false;
  }

  if (allDecidedAndCertain) return "review_complete";
  if (anyDecided) return "review_in_progress";
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
  };
}
