/**
 * Existing Artwork → Print Ready Phase 1: the conservative repairability
 * classifier.
 *
 * Pure — it reads an `ArtworkAnalysis` and returns a verdict. It never
 * touches pixels, never calls a provider, and never phrases anything for a
 * customer.
 *
 * The bias is deliberate and one-directional: when the deterministic evidence
 * is ambiguous, prefer `NEEDS_REVIEW` over acting. The customer's uploaded
 * artwork is pixel-authoritative; a conservative refusal costs a conversation,
 * while an over-confident mask destroys work we cannot recreate.
 */

import type {
  ArtworkAnalysis,
  BackgroundTreatment,
  RepairabilityAssessment,
  RepairabilityClassification,
  RepairabilityReasonCode,
} from "./contracts";
import {
  MAX_MEANINGFUL_MASK_FRACTION,
  MAX_SAFE_EDGE_STANDARD_DEVIATION,
  MIN_EDGE_DOMINANT_COVERAGE,
  MIN_MEANINGFUL_MASK_FRACTION,
} from "./image-analysis";

/**
 * Precedence, highest first. Each rule is a statement about the EVIDENCE, not
 * a preference:
 *
 *   1. Nothing visible at all              → NOT_REPAIRABLE
 *   2. Already usably transparent          → treatment "already_transparent"
 *   3. Border is not one background        → NEEDS_REVIEW
 *   4. A fill would remove ~everything     → NEEDS_REVIEW
 *   5. A fill would remove ~nothing        → NEEDS_REVIEW
 *   6. Otherwise                           → treatment "remove_exterior"
 *
 * Then, and only then, resolution is applied: any artwork that is otherwise
 * fine but carries too few real pixels for its placement target escalates to
 * `REQUIRES_ENHANCEMENT`. That escalation never changes the BACKGROUND
 * treatment — background preparation and enhancement are independent
 * problems, and Phase 1 can honestly solve the first while only naming the
 * second (Phase 2 owns enhancement).
 */
export function classifyRepairability(
  analysis: ArtworkAnalysis,
): RepairabilityAssessment {
  const reasons: RepairabilityReasonCode[] = [];

  if (analysis.fullyTransparent || !analysis.artworkBounds) {
    return {
      classification: "NOT_REPAIRABLE",
      backgroundTreatment: "none",
      canPrepareAutomatically: false,
      enhancementRequired: false,
      reasons: ["no_visible_artwork"],
    };
  }

  const enhancementRequired =
    analysis.pixelSufficiency !== null && !analysis.pixelSufficiency.sufficient;

  const { treatment, treatmentReasons } = resolveBackgroundTreatment(analysis);
  reasons.push(...treatmentReasons);

  if (treatment === "manual_review") {
    if (enhancementRequired) reasons.push("insufficient_pixels_for_target");
    return {
      classification: "NEEDS_REVIEW",
      backgroundTreatment: "manual_review",
      canPrepareAutomatically: false,
      enhancementRequired,
      reasons,
    };
  }

  if (enhancementRequired) reasons.push("insufficient_pixels_for_target");

  const classification: RepairabilityClassification = enhancementRequired
    ? "REQUIRES_ENHANCEMENT"
    : treatment === "already_transparent"
      ? "PRINT_READY_ALREADY"
      : "REPAIRABLE_AUTOMATICALLY";

  return {
    classification,
    backgroundTreatment: treatment,
    canPrepareAutomatically: true,
    enhancementRequired,
    reasons,
  };
}

function resolveBackgroundTreatment(analysis: ArtworkAnalysis): {
  treatment: BackgroundTreatment;
  treatmentReasons: RepairabilityReasonCode[];
} {
  // A meaningfully transparent upload is already isolated. Running a removal
  // pass over it could only take away pixels the customer chose to keep.
  if (isAlreadyUsablyTransparent(analysis)) {
    return {
      treatment: "already_transparent",
      treatmentReasons: ["already_transparent"],
    };
  }

  if (
    analysis.edge.maxChannelStandardDeviation > MAX_SAFE_EDGE_STANDARD_DEVIATION ||
    analysis.edge.dominantColorCoverage < MIN_EDGE_DOMINANT_COVERAGE
  ) {
    return {
      treatment: "manual_review",
      treatmentReasons: ["complex_exterior_background"],
    };
  }

  if (analysis.exteriorMaskFraction > MAX_MEANINGFUL_MASK_FRACTION) {
    return {
      treatment: "manual_review",
      treatmentReasons: ["mask_would_remove_almost_everything"],
    };
  }

  if (analysis.exteriorMaskFraction < MIN_MEANINGFUL_MASK_FRACTION) {
    return {
      treatment: "manual_review",
      treatmentReasons: ["mask_would_remove_almost_nothing"],
    };
  }

  if (!analysis.backgroundIsEdgeConnected) {
    return {
      treatment: "manual_review",
      treatmentReasons: ["background_not_edge_connected"],
    };
  }

  return {
    treatment: "remove_exterior",
    treatmentReasons: ["uniform_exterior_background"],
  };
}

/**
 * "Already transparent" means the transparency is doing real work — the
 * border is genuinely open, not merely that a stray anti-aliased pixel
 * somewhere is at alpha 254.
 *
 * DTF Background-Removal Status Contradiction Phase (live acceptance
 * defect): a border crossing `MIN_EDGE_DOMINANT_COVERAGE` is NECESSARY but
 * not SUFFICIENT. A thin transparent margin (or rounded corners, or partial
 * prior removal) can satisfy that threshold while a substantial, still-
 * OPAQUE, edge-connected background — the same uniform colour the border's
 * own dominant colour identifies — remains elsewhere on the canvas (e.g. a
 * solid-colour block sitting behind the design). `exteriorMaskOpaqueFraction`
 * is exactly this artwork's own removable-background computation
 * (`background-isolation.ts`'s `computeExteriorMask`, the SAME flood fill
 * `remove_exterior` below already trusts), restricted to pixels that are
 * genuinely still visible. Requiring it to be negligible — the identical
 * `MIN_MEANINGFUL_MASK_FRACTION` bar that already decides whether an
 * exterior fill counts as "a background" at all, never a new threshold —
 * is what keeps this classification from claiming "nothing to remove" while
 * a real, unremoved background is still sitting on the canvas: exactly the
 * artwork the separation-review pass (`region-separation.ts`) independently
 * proves still needs a removal decision. A `false` result here falls
 * through to the SAME `remove_exterior`/`manual_review` branches every
 * other background already goes through — no new state, no new message.
 *
 * DTF Background-Removal Second-Path Contradiction Phase (live acceptance
 * defect, discovered continuing local acceptance testing): the check above
 * only catches a residual opaque background that is directly reachable BY
 * A FLOOD FILL FROM THE BORDER. It cannot see an opaque background block
 * sitting INSIDE a fully transparent margin — never touching the border at
 * all — which is exactly the shape a real customer upload produced:
 * `edge.transparentFraction === 1` (the canvas edge is completely open) and
 * `exteriorMaskOpaqueFraction === 0` (nothing opaque is border-reachable),
 * yet `region-separation.ts`'s own, separate, more thorough analysis
 * (`computeRegionMap` + `assessSeparationReviewState`, the SAME authority
 * `SeparationReviewPanel`'s "Check what will be removed" screen is driven
 * by) found a 654,954-pixel in-bounds proposal and five consequential
 * regions — a real, substantial candidate this check alone was blind to.
 * `regionSeparationReviewRequired` is that authority's own verdict,
 * computed once in `analyzeArtwork` and reused here rather than a second,
 * possibly-disagreeing implementation — required to be EXPLICITLY `false`
 * (never merely falsy) for exactly the same reason `exteriorMaskOpaqueFraction`
 * is: two independent screens must never be able to reach two different
 * answers to "is there anything left to remove" for the identical artwork.
 *
 * The `=== false` (rather than `!analysis.regionSeparationReviewRequired`)
 * is deliberate, not stylistic: this field is boolean, so `!undefined` is
 * `true` — the SAME as `!false` — meaning a naive negation would silently
 * treat a persisted analysis row from before this field existed exactly
 * like a fresh row that positively confirmed nothing needs review. A
 * missing field is not a confirmed answer; conservatively requiring an
 * EXPLICIT `false` means every legacy row fails toward the same
 * `remove_exterior`/`manual_review` fallback every other undecided
 * background already goes through, with no migration, no version field,
 * and no recompute-on-read required.
 */
function isAlreadyUsablyTransparent(analysis: ArtworkAnalysis): boolean {
  return (
    analysis.hasTransparency &&
    analysis.edge.transparentFraction >= MIN_EDGE_DOMINANT_COVERAGE &&
    analysis.exteriorMaskOpaqueFraction < MIN_MEANINGFUL_MASK_FRACTION &&
    analysis.regionSeparationReviewRequired === false
  );
}
