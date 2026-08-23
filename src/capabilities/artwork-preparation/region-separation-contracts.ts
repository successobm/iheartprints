/**
 * Intelligent Separation Phase 9: provider-neutral contracts for
 * OPERATOR-CONFIRMED garment-independent separation.
 *
 * Nothing in here is customer-facing copy — that discipline lives with the
 * rest of this capability's contracts (see `contracts.ts`'s header). Every
 * field here is internal diagnostics or durable authority.
 *
 * THE CENTRAL RULE, established across Phases 5-8 and enforced by
 * construction here: deterministic code owns every pixel decision. A
 * `RegionDecision` records WHO decided (`source`) and WHAT they decided
 * (`intent`), but only an `operator` decision may ever become authoritative
 * over production pixels. A `semantic_suggestion` is data to show a human,
 * never a thing that changes alpha on its own (Phase 8 proved why: 25-50%
 * intentional-ink false-removal, uncalibrated confidence, `uncertain` never
 * once used across 28 model calls).
 */

import type { PrintPlacement } from "@/lib/domain/types";

/**
 * What a region's pixels should become in the transparent master.
 *
 * Deliberately the SAME three-way vocabulary Phase 6/7/8 already validated
 * empirically — not renamed for this phase, because the evidence behind it
 * (what a deterministic rule can and cannot know, what a model got wrong)
 * was gathered against exactly these three words.
 */
export type RegionIntent = "substrate" | "ink" | "uncertain";

/**
 * WHO produced a `RegionIntent`. Never used to imply trust levels beyond
 * "operator wins" — `assessSeparationReviewState` reads this field to enforce
 * that only `operator` decisions can close out a region.
 */
export type RegionDecisionSource = "operator" | "semantic_suggestion" | "deterministic";

/**
 * The bounded set of states this workflow can honestly be in. Five, not
 * three and not eight — chosen to name exactly the decision points Goal 9
 * asked for, no more:
 *
 *   review_not_required     no consequential region exists; the existing
 *                            Existing Artwork workflow is unaffected
 *   review_required          consequential regions exist and at least one is
 *                            undecided or marked uncertain
 *   review_in_progress        some, but not all, consequential regions decided
 *   review_complete           every consequential region has an OPERATOR
 *                            decision of "substrate" or "ink" — eligible for
 *                            final approval, not yet approved
 *   cannot_safely_automate    the persisted decision set no longer matches
 *                            the current region map (stale source or
 *                            algorithm) badly enough that no region id can
 *                            be carried forward, or the hard pixel-authority
 *                            post-check itself failed (see
 *                            `SeparationPostCheck.passed` — true by
 *                            construction, verified rather than assumed)
 *
 * Note what is NOT a `cannot_safely_automate` condition: an orphaned-light-
 * ink warning from `runSeparationPostChecks`. Phase 6 proved a semantically
 * CORRECT decision can still orphan real pixels, and this workflow's premise
 * is that an operator, shown that fact plainly, may knowingly accept it. The
 * warning surfaces in `SeparationReviewView.postCheck` and in the final
 * review step; it never blocks by itself.
 */
export type SeparationReviewState =
  | "review_not_required"
  | "review_required"
  | "review_in_progress"
  | "review_complete"
  | "cannot_safely_automate";

/** Where a consequential region sits in source pixel coordinates. `right`/`bottom` exclusive, matching `ArtworkBounds`. */
export interface RegionBounds {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * ONE consequential dark/background-coloured interior region, as extracted
 * by `computeRegionMap`. Materiality only — never a semantic claim. See
 * `region-separation.ts`'s doc comment for exactly what "consequential"
 * means and why the threshold is not claimed as validated.
 */
export interface ConsequentialRegion {
  /**
   * Stable for a fixed (sourceAssetSha256, algorithmVersion) pair — the
   * connected-component scan order is deterministic over identical input
   * bytes and identical code. Never stable across a source or algorithm
   * change; see `RegionMap.regionMapHash` for the guard.
   */
  regionId: number;
  pixelCount: number;
  /** `pixelCount` as a percentage of the artwork's own visible (ink) bounds — never the canvas. */
  pctOfArtworkBounds: number;
  bounds: RegionBounds;
}

/**
 * THE STABLE IDENTITY a `SeparationDecisionSet` is pinned against (Goal 3).
 *
 * Deliberately does not embed the full per-pixel label array — hashing the
 * consequential-region summary is enough to detect anything that could
 * change a decision's meaning (a region gaining/losing pixels, appearing, or
 * disappearing), while staying cheap enough to recompute on every read. A
 * change confined to a NON-consequential region never changes this hash,
 * which is safe: non-consequential regions never carry a decision.
 */
export interface RegionMap {
  algorithmVersion: string;
  /** SHA-256 of the immutable original asset this map was computed from. */
  sourceAssetSha256: string;
  /** Hash of (algorithmVersion + silhouetteRadius + sorted consequential regions). The staleness key. */
  regionMapHash: string;
  silhouetteRadius: number;
  artworkBounds: RegionBounds;
  consequentialRegions: ConsequentialRegion[];
  /** Every interior region found, consequential or not — diagnostic only. */
  totalRegionCount: number;
}

/** An AI suggestion, if one exists. Never authoritative — see the module doc comment. */
export interface RegionSuggestion {
  intent: RegionIntent;
  confidence: number;
  reason: string;
  /** Which model produced this, for audit — never used to weight trust. */
  model: string;
}

/** One region's recorded decision. */
export interface RegionDecision {
  regionId: number;
  intent: RegionIntent;
  source: RegionDecisionSource;
  decidedAt: string;
  suggestion?: RegionSuggestion | null;
}

/**
 * THE DURABLE, PINNED DECISION SET. Persisted verbatim on
 * `ArtworkPreparation.separation` (additive JSON — see Goal 25's audit in
 * `artwork-preparation-capability.ts`).
 *
 * `approvedAt` is the ONLY field that makes this authoritative over
 * production pixels — see `approveSeparationMaster`. Everything before that
 * is a draft an operator can still revise.
 */
export interface SeparationDecisionSet {
  sourceAssetSha256: string;
  regionMapHash: string;
  algorithmVersion: string;
  decisions: RegionDecision[];
  /** `null` until the operator's explicit final approval (Goal 18). Cleared by any decision change after approval (Goal 12/N). */
  approvedAt: string | null;
  /**
   * The asset id `approveSeparationMaster` produced and pointed
   * `preparation.preparedAssetId` at. Read back against the LIVE
   * `preparedAssetId` to detect the case a plain boolean would miss: an
   * operator approves this master, then later a different action (the
   * standard one-click prepare, a fresh separation approval) repoints
   * `preparedAssetId` elsewhere. `approvedAt` alone would still read
   * non-null and lie; comparing this field to the live value is what makes
   * `isProductionAuthoritative` correct rather than merely "was once true".
   */
  approvedAssetId: string | null;
  /**
   * Recorded so a later post-check regression (a fixed bug, a stricter
   * check) can be told apart from a decision that was always risky. Never
   * read to decide anything — diagnostic only.
   */
  postCheckAtApproval: SeparationPostCheck | null;
}

/** The result of the deterministic safety checks run before approval may proceed. */
export interface SeparationPostCheck {
  /** Pixels of ink whose only apparent visual support was removed as substrate. See `region-separation.ts`. */
  orphanedLightInkPixels: number;
  /** True only when every retained pixel's RGB is byte-identical to the original — always true by construction; asserted, not assumed. */
  rgbPreserved: boolean;
  /** True only when no retained pixel's alpha exceeds the original's — always true by construction. */
  noAlphaRaised: boolean;
  passed: boolean;
  reasons: string[];
}

/** What the review UI/route needs in one shape. */
export interface SeparationReviewView {
  state: SeparationReviewState;
  regionMap: RegionMap;
  decisions: RegionDecision[];
  /** Regions still needing an operator decision (undecided, or currently "uncertain"). */
  pendingRegionIds: number[];
  postCheck: SeparationPostCheck | null;
  approvedAt: string | null;
  /** True once `approveSeparationMaster` has made this master the project's `preparedAssetId`. */
  isProductionAuthoritative: boolean;
}

/** Never accepted from a client — documents the shape a write request is validated against. */
export interface SubmitRegionDecisionInput {
  regionId: number;
  intent: RegionIntent;
}

export interface SubmitRegionDecisionsRequest {
  /** The client's belief about which source/map it is deciding against — checked, never trusted blindly (Goal 22). */
  sourceAssetSha256: string;
  regionMapHash: string;
  decisions: SubmitRegionDecisionInput[];
}

/** Re-exported so callers don't need a second import for a type this module's functions consume. */
export type { PrintPlacement };
