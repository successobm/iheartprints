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
 */
function isAlreadyUsablyTransparent(analysis: ArtworkAnalysis): boolean {
  return (
    analysis.hasTransparency &&
    analysis.edge.transparentFraction >= MIN_EDGE_DOMINANT_COVERAGE
  );
}
