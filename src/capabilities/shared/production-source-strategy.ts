/**
 * Intelligent Separation Phase 1 — THE PRODUCTION SOURCE AUTHORITY.
 *
 * The one question this module answers: *which representation of the
 * customer's artwork is a production plate allowed to descend from, and what
 * measured evidence says so?*
 *
 * WHY THIS IS NOT `ProductionTreatment`
 *
 * `production-treatment.ts` answers "which apparel-raster REPRESENTATION are
 * we printing?" — continuous tone, or a generated dot lattice. This module
 * answers a strictly orthogonal question: "which SOURCE are we printing FROM?"
 *
 * Collapsing the two would destroy lineage. `halftone_dtf` today implies
 * "screened from the approved prepared transparent asset" only by convention,
 * and the moment a second source representation exists that convention becomes
 * a silent, unprovable assumption baked into an enum value. A plate must be
 * able to state its source independently of its treatment, because the two
 * carry different risks and different approvals:
 *
 *     treatment  = what the ink does          (geometry, LPI, tone)
 *     source     = what we decided to trust   (which pixels are artwork)
 *
 * WHAT IS ACTUALLY WIRED TODAY
 *
 * Nothing. This is a SEAM, deliberately unconsumed. `final-artwork-worker`
 * resolves its source from `preparation.preparedAssetId` and explicitly
 * refuses to finalize from the immutable original, and this module does not
 * change that. It exists so that a later deterministic, semantic, or operator
 * engine has a contract to satisfy — and a set of invariants it cannot talk
 * its way around — rather than a pipeline to rewrite.
 *
 * Pure — no repository, no capability, no provider, no I/O, no clock.
 */

/**
 * WHICH SOURCE REPRESENTATION a production plate descends from.
 *
 * Deliberately NOT named for the mechanism that produced it. "Background
 * removal" and "garment-aware separation" are both *deterministic pixel
 * operations today*, and a future semantic or vector engine may produce a
 * source under either heading. The domain cares which artwork authority was
 * trusted, never which vendor or model computed it.
 */
export type ProductionSourceStrategy =
  /**
   * A: the approved prepared transparent asset produced by exterior
   * background isolation. The ONLY strategy any production path uses today.
   */
  | "prepared_background_removed"
  /**
   * B: a transparent representation derived from the IMMUTABLE ORIGINAL by
   * treating confirmed-garment-coloured regions as substrate rather than ink.
   *
   * EXPERIMENTAL. Never automatically selectable — see
   * `automationMayProceed`. No plate produced this way may be described as
   * print-ready before a physical press test.
   */
  | "original_preserving_separation"
  /**
   * C: a separation an operator supplied or corrected by hand. The escape
   * hatch that exists so "we cannot decide this automatically" has a
   * destination other than refusing the customer.
   */
  | "manual_intervention";

export const PRODUCTION_SOURCE_STRATEGIES: readonly ProductionSourceStrategy[] = [
  "prepared_background_removed",
  "original_preserving_separation",
  "manual_intervention",
] as const;

/** The only strategy any production path may reach without explicit new authority. */
export const DEFAULT_PRODUCTION_SOURCE_STRATEGY: ProductionSourceStrategy =
  "prepared_background_removed";

export function isProductionSourceStrategy(
  value: unknown,
): value is ProductionSourceStrategy {
  return (
    typeof value === "string" &&
    (PRODUCTION_SOURCE_STRATEGIES as readonly string[]).includes(value)
  );
}

/**
 * How the source asset was derived from the original. Recorded separately
 * from the strategy so that a future engine swap (deterministic knockout →
 * semantic segmentation) is visible in provenance rather than hidden behind
 * an unchanged strategy name.
 */
export type ProductionSourceDerivation =
  | "deterministic_background_removal"
  | "deterministic_garment_substrate_separation"
  | "operator_supplied";

/**
 * THE LINEAGE RECORD. A plate must be able to answer "what did you trust?"
 * without anyone inferring it from a treatment key or an asset's position in
 * a table.
 *
 * `originAssetId` is ALWAYS the immutable customer upload, on every strategy
 * including operator-supplied ones. A separation that cannot name the original
 * it came from is not a separation, it is a second upload.
 */
export interface ProductionSourceLineage {
  strategy: ProductionSourceStrategy;
  /** The immutable customer upload. Never a derived asset, on any strategy. */
  originAssetId: string;
  /** The asset the production provider actually consumed. */
  sourceAssetId: string;
  derivation: ProductionSourceDerivation;
}

/**
 * True when the lineage describes a plate made from something other than the
 * customer's own uploaded pixels — i.e. any derived representation. Kept as a
 * predicate rather than a boolean field so it cannot be recorded incorrectly.
 */
export function lineageIsDerived(lineage: ProductionSourceLineage): boolean {
  return lineage.sourceAssetId !== lineage.originAssetId;
}

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

/**
 * Machine reasons behind an assessment. Never customer-facing strings, and
 * every one corresponds to something MEASURED.
 *
 * Note what is absent, deliberately: there is no reason code asserting that
 * artwork was destroyed, that a region is a logo/ball/badge, or that a
 * separation is press-safe. Pixel evidence cannot establish any of those, and
 * a vocabulary that lets code say them would eventually let code mean them.
 */
export type ProductionSourceReasonCode =
  /** The upload carries no transparency at all — every pixel is opaque. */
  | "source_fully_opaque"
  /** The upload already carried usable transparency; nothing had to be decided. */
  | "source_already_transparent"
  /** Pixels matching the detected background colour also occur inside the design. */
  | "background_colour_used_inside_design"
  /**
   * The region exterior removal took extends into positions the surviving
   * design surrounds on every axis. A TOPOLOGY fact: it says removal reached
   * inside the artwork, NOT that anything meaningful was lost.
   */
  | "exterior_removal_enters_enclosed_design_region"
  /** The confirmed garment colour is within tolerance of the detected background. */
  | "garment_matches_background"
  /** The confirmed garment colour is materially different from the background. */
  | "garment_differs_from_background"
  /** No garment colour is confirmed, so no garment-relative claim can be made. */
  | "garment_colour_unknown"
  /** The deterministic pass reported low confidence in its own background estimate. */
  | "background_estimate_low_confidence"
  /** The background is not reachable from the border, so an exterior fill cannot define it. */
  | "background_not_edge_connected";

/**
 * The two verdicts the evidence can actually support.
 *
 * NOT `safe | ambiguous | unsafe`. Distinguishing "ambiguous" from "unsafe"
 * requires knowing whether removed content MATTERED, and the Phase 0/1
 * measurements established that no available pixel signal separates a
 * correctly-entered letter counter from a destroyed banner fill — both are the
 * same topology. A third value would therefore be a vocabulary for a judgement
 * nothing can make, so there are two.
 */
export type ProductionSourceReadiness = "safe" | "review_required";

/** Everything measured that this decision is allowed to read. */
export interface ProductionSourceEvidence {
  /** MEASURED: every pixel of the upload is opaque. */
  sourceFullyOpaque: boolean;
  /** MEASURED: the upload carries meaningful transparency already. */
  sourceHasTransparency: boolean;
  /** MEASURED: pixels matching the background colour that are NOT border-reachable. */
  disconnectedBackgroundColoredPixels: number;
  /** MEASURED: the exterior fill can actually spread from the border. */
  backgroundIsEdgeConnected: boolean;
  /** MEASURED 0–1: the deterministic pass's confidence in its background estimate. */
  backgroundConfidence: number;
  /**
   * MEASURED 0–1: of the pixels exterior removal took, the fraction sitting
   * in positions the surviving design surrounds on all four scanline
   * directions. `null` when the comparison was not computed.
   */
  exteriorRemovalEnclosureRatio: number | null;
  /**
   * MEASURED: per-channel distance between the confirmed garment colour and
   * the detected background colour. `null` when no garment colour is
   * confirmed — never defaulted to a number, because "unknown" and "far
   * apart" must not read the same.
   */
  garmentToBackgroundChannelDistance: number | null;
}

/**
 * How close the garment must sit to the detected background before the
 * garment can be described as supplying that colour.
 *
 * The SAME per-channel tolerance the background membership test already uses
 * for a settled background (`resolveBackgroundTolerance`'s floor). Reusing it
 * is the point: a garment-substrate claim and a background-membership claim
 * must not be able to disagree about what "the same colour" means.
 */
export const GARMENT_BACKGROUND_MATCH_TOLERANCE = 12;

/** Confidence at or below this makes the background estimate itself reviewable. */
export const MIN_BACKGROUND_CONFIDENCE_FOR_SAFE = 0.9;

export interface ProductionSourceAssessment {
  readiness: ProductionSourceReadiness;
  /** The strategy the evidence supports. Never a strategy this build cannot execute. */
  recommended: ProductionSourceStrategy;
  /**
   * Every strategy a caller may legally select given this evidence. Always
   * contains `recommended`, and always contains
   * `prepared_background_removed` — the existing path is never withdrawn by
   * an assessment, only supplemented.
   */
  allowedStrategies: ProductionSourceStrategy[];
  reasons: ProductionSourceReasonCode[];
  /**
   * Whether a plate may be produced from `recommended` with no human sign-off.
   *
   * FALSE for every strategy except `prepared_background_removed`, and false
   * whenever `readiness` is `review_required`. This is the single flag that
   * stops an experimental separation from becoming production authority by
   * accident, and it is computed here rather than by each caller so there is
   * one place to audit.
   */
  automationMayProceed: boolean;
}

/**
 * THE DECISION. Pure: same evidence in, same assessment out, always.
 *
 * It does not dispatch a provider, read a repository, resolve an asset, touch
 * a clock, or produce a customer sentence. It cannot: those are the ways a
 * decision boundary stops being testable.
 *
 * IT ALSO NEVER RECOMMENDS AN EXPERIMENTAL STRATEGY. Garment-substrate
 * separation is *offered* (it appears in `allowedStrategies`) when the
 * evidence supports it, and never *recommended*, because no plate produced
 * that way has been through a physical press test. Offering and recommending
 * are different acts and this module keeps them different.
 */
export function assessProductionSourceStrategy(
  evidence: ProductionSourceEvidence,
): ProductionSourceAssessment {
  const reasons: ProductionSourceReasonCode[] = [];

  if (evidence.sourceHasTransparency) reasons.push("source_already_transparent");
  if (evidence.sourceFullyOpaque) reasons.push("source_fully_opaque");

  if (evidence.disconnectedBackgroundColoredPixels > 0) {
    reasons.push("background_colour_used_inside_design");
  }
  if (
    evidence.exteriorRemovalEnclosureRatio !== null &&
    evidence.exteriorRemovalEnclosureRatio > 0
  ) {
    reasons.push("exterior_removal_enters_enclosed_design_region");
  }
  if (!evidence.backgroundIsEdgeConnected) {
    reasons.push("background_not_edge_connected");
  }
  if (evidence.backgroundConfidence < MIN_BACKGROUND_CONFIDENCE_FOR_SAFE) {
    reasons.push("background_estimate_low_confidence");
  }

  const garmentDistance = evidence.garmentToBackgroundChannelDistance;
  const garmentMatchesBackground =
    garmentDistance !== null && garmentDistance <= GARMENT_BACKGROUND_MATCH_TOLERANCE;
  if (garmentDistance === null) reasons.push("garment_colour_unknown");
  else if (garmentMatchesBackground) reasons.push("garment_matches_background");
  else reasons.push("garment_differs_from_background");

  // Readiness reads ONLY the signals that describe the existing deterministic
  // separation. The garment reasons are recorded either way because they
  // decide what may be OFFERED, and a garment colour can never make an
  // ordinary preparation less trustworthy than it already was.
  const reviewRequired =
    evidence.disconnectedBackgroundColoredPixels > 0 ||
    (evidence.exteriorRemovalEnclosureRatio !== null &&
      evidence.exteriorRemovalEnclosureRatio > 0) ||
    !evidence.backgroundIsEdgeConnected ||
    evidence.backgroundConfidence < MIN_BACKGROUND_CONFIDENCE_FOR_SAFE;

  const readiness: ProductionSourceReadiness = reviewRequired
    ? "review_required"
    : "safe";

  // Garment-substrate separation is only coherent when the garment actually
  // supplies the background's colour AND there is an opaque background to
  // separate. Offered on that evidence, never on hope.
  const separationIsCoherent = garmentMatchesBackground && evidence.sourceFullyOpaque;

  const allowedStrategies: ProductionSourceStrategy[] = [
    "prepared_background_removed",
  ];
  if (separationIsCoherent) allowedStrategies.push("original_preserving_separation");
  // Always available: an operator must be able to take over any assessment.
  allowedStrategies.push("manual_intervention");

  return {
    readiness,
    // Always the existing, press-proven path. See the doc comment above.
    recommended: DEFAULT_PRODUCTION_SOURCE_STRATEGY,
    allowedStrategies,
    reasons,
    automationMayProceed: readiness === "safe",
  };
}

/**
 * The gate every future caller must pass before treating a source as
 * production authority.
 *
 * Stated as its own function, and not as a boolean somewhere in the
 * assessment, because the answer depends on the strategy actually CHOSEN
 * rather than the one recommended — and "the operator picked the experimental
 * one" is exactly the case a field on the assessment would get wrong.
 */
export function mayProduceWithoutReview(
  assessment: ProductionSourceAssessment,
  chosen: ProductionSourceStrategy,
): boolean {
  if (!assessment.allowedStrategies.includes(chosen)) return false;
  if (chosen !== "prepared_background_removed") return false;
  return assessment.automationMayProceed;
}
