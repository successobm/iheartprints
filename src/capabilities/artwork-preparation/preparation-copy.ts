/**
 * Existing Artwork → Print Ready Phase 1: the ONE place internal analysis
 * becomes language a customer reads.
 *
 * Constitution §6.6 (Hide Technical Complexity) is the whole point of this
 * module existing separately from `image-analysis.ts`/`repairability.ts`.
 * Nothing here may mention flood fill, tolerance, sigma, masks, alpha
 * channels, pixel counts, DPI, providers, or storage. Those all exist — in
 * `ArtworkPreparation.analysis`, as internal diagnostics — and they stay
 * there.
 *
 * The one number this module is allowed to speak in is INCHES, because the
 * customer already thinks about their shirt in inches and it is a decision
 * they may legitimately want to make.
 */

import { printPlacementLabel } from "@/lib/domain/print-placement";
import type {
  ArtworkAnalysis,
  RepairabilityAssessment,
} from "./contracts";

/**
 * Everything the preparation UI renders, already phrased. The client
 * component picks fields to display; it never derives copy from analysis
 * numbers itself, so this is a genuine choke point rather than a convention.
 */
export interface ArtworkPreparationCustomerView {
  /** One plain sentence about the background. Always present. */
  backgroundMessage: string;
  /** One plain sentence about print size, or `null` when nothing honest can be said yet. */
  resolutionMessage: string | null;
  /** True when we can offer the "Prepare Background" action at all. */
  canPrepare: boolean;
  /** Label for the preparation action, when offered. */
  prepareActionLabel: string | null;
  /**
   * True when the customer will need enhancement before FINAL production.
   * Stated as a fact about a later step, never as a claim that it happened.
   */
  enhancementNeeded: boolean;
}

export function describeArtworkForCustomer(
  analysis: ArtworkAnalysis,
  assessment: RepairabilityAssessment,
): ArtworkPreparationCustomerView {
  return {
    backgroundMessage: backgroundMessageFor(assessment),
    resolutionMessage: resolutionMessageFor(analysis, assessment),
    canPrepare: assessment.canPrepareAutomatically,
    prepareActionLabel: prepareActionLabelFor(assessment),
    enhancementNeeded: assessment.enhancementRequired,
  };
}

/**
 * Phase 1 terminal copy after the customer approves the prepared artwork.
 *
 * Approval means background cleanup was accepted — never that enhancement,
 * 300 DPI production, print validation, or delivery already ran. Phase 2
 * owns those steps; this language must stay honest until they exist.
 */
export interface ApprovedPreparationCopy {
  headline: string;
  summary: string;
  nextStepMessage: string;
}

export function describeApprovedPreparation(
  enhancementNeeded: boolean,
): ApprovedPreparationCopy {
  return {
    headline: "Background preparation complete",
    summary:
      "We've removed the background and preserved your artwork.",
    nextStepMessage: enhancementNeeded
      ? "This artwork still needs to be enhanced before we can create the final print-ready file."
      : "This prepared artwork is ready for final print preparation.",
  };
}

function backgroundMessageFor(assessment: RepairabilityAssessment): string {
  switch (assessment.backgroundTreatment) {
    case "already_transparent":
      return "Your artwork already has a clear background, so there's nothing to remove.";
    case "remove_exterior":
      return "Your artwork has a solid background that can be removed automatically.";
    case "manual_review":
      return "Your background is complex, so we need a different removal method. A designer will take a look before we go any further.";
    case "none":
      return "We couldn't find any artwork in that image. Please upload the design you'd like printed.";
  }
}

function prepareActionLabelFor(
  assessment: RepairabilityAssessment,
): string | null {
  if (!assessment.canPrepareAutomatically) return null;
  return assessment.backgroundTreatment === "already_transparent"
    ? "Prepare My Artwork"
    : "Remove the Background";
}

/**
 * Print-size copy. Deliberately silent when there is no placement yet — an
 * invented target would be a fabricated requirement, and Phase 1 never states
 * a readiness it has not measured (Constitution §15).
 */
function resolutionMessageFor(
  analysis: ArtworkAnalysis,
  assessment: RepairabilityAssessment,
): string | null {
  const sufficiency = analysis.pixelSufficiency;
  if (!sufficiency) return null;

  const placement = printPlacementLabel(sufficiency.placement) ?? "your shirt";
  const size = formatInches(sufficiency.targetWidthIn);

  if (!assessment.enhancementRequired) {
    return `Your artwork has enough detail to print ${size} wide on the ${placement}.`;
  }

  return `Your artwork is smaller than the recommended print resolution for a ${size}-wide print on the ${placement}. We'll need to enhance it before creating the final print-ready file.`;
}

function formatInches(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  return `${rounded}"`;
}
