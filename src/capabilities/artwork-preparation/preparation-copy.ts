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
 * Terminal copy after the customer approves the prepared artwork.
 *
 * Approval means background cleanup was accepted — never that enhancement,
 * 300 DPI production, print validation, or delivery already ran. Those are
 * Phase 2's steps, and this language stays honest about the boundary:
 *
 *     PREPARED ARTWORK  !=  PRINT-READY ARTWORK
 *     PREPARED APPROVAL !=  PRINT_READY
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

/**
 * Existing Artwork → Print Ready Phase 2: the continuation affordance shown
 * once the prepared artwork is approved.
 *
 * Constrained by the same rule as everything else in this module — the only
 * technical figure allowed through is INCHES, because how large the design
 * prints is a real customer decision. DPI is the one deliberate exception the
 * Constitution's §6.6 carve-out already covers elsewhere (`PrintReadySizeCard`
 * states it as a guarantee, never as a setting), so it is stated there rather
 * than restated here. No pixel counts, no provider names, no "upscale",
 * "reconstruct", "Topaz", "validation profile", or job status ever appears.
 */
export interface PrintReadyPreparationCopy {
  headline: string;
  /** One sentence about what happens next. Always present. */
  message: string;
  /** Only present when the artwork genuinely needs enhancing first — stated as a fact about this file, never as a warning. */
  enhancementMessage: string | null;
  actionLabel: string;
}

export function describePrintReadyPreparation(
  enhancementNeeded: boolean,
): PrintReadyPreparationCopy {
  return {
    headline: "Ready for print preparation",
    message:
      "Next we'll produce the final print-ready file at the size below.",
    enhancementMessage: enhancementNeeded
      ? "Your artwork needs to be enhanced for this print size. We'll take care of that — your design, wording, and colours stay exactly as they are."
      : null,
    actionLabel: "Prepare Print-Ready Artwork",
  };
}

/**
 * Existing Artwork → Print Ready Phase 1.2–1.7: the guided background
 * cleanup surface, in customer language.
 *
 * Nothing here names a cavity, a connected component, a wall ratio, a flood
 * fill, or an alpha value. The customer is told what they can see ("some
 * background is still showing") and what to do about it.
 *
 * Phase 1.3: a click only PREVIEWS. Removal happens only after an explicit
 * confirmation.
 *
 * Phase 1.4: cleanup happens in a LARGE focused workspace opened by
 * "Clean Up Background", not by silently clicking the small compare tile.
 *
 * Phase 1.7: Magic Select exposes a customer-controlled "Tolerance" label —
 * that word is the plain name for how broadly similar colour is included.
 * It is not the automatic background-detection threshold, and we still never
 * mention RGB, Chebyshev, flood fill, or connectivity.
 */
export const GUIDED_CLEANUP_COPY = {
  /** Sits under the prepared preview whenever cleanup is available. */
  invitation:
    "Still see some background? Use Clean Up Background to remove any areas we missed.",
  /** Opens the large interactive cleanup workspace. */
  enterActionLabel: "Clean Up Background",
  /** Closes the workspace and returns to compare. Does NOT approve. */
  exitActionLabel: "Done",
  /** Inside the workspace while nothing is pending confirmation. */
  activeHint:
    "Click any area that should be see-through. We'll show you exactly what will be removed before anything changes.",
  /** After an eligible area is selected, before confirmation. */
  confirmPrompt: "Remove this area?",
  confirmActionLabel: "Remove This Area",
  cancelActionLabel: "Cancel",
  undoActionLabel: "Undo Last Removal",
  /** Distinguishes read-only Enlarge from interactive cleanup. */
  viewOnlyHint: "View only — nothing can be changed here.",
  workspaceTitle: "Clean up background",
  fitActionLabel: "Fit",
  zoomInActionLabel: "Zoom In",
  zoomOutActionLabel: "Zoom Out",
  /**
   * Phase 1.6B. Clicking is the point of this surface, so panning has to be
   * asked for — and a gesture the customer has to hold a key for is one they
   * have to be told about. Plain language: no talk of modifiers or gestures.
   */
  panHint: "Hold Space and drag to move around while zoomed in.",
  /** Phase 1.7 UX: Ctrl/Cmd + wheel zooms; plain wheel still scrolls. */
  wheelZoomHint: "Ctrl + scroll to zoom.",
  /** Phase 1.7 — tool switcher. */
  toolGroupLabel: "Cleanup Tool",
  selectAreaToolLabel: "Select Area",
  magicSelectToolLabel: "Magic Select",
  magicSelectHint: "Click a color you want to remove.",
  magicSelectConfirmPrompt: "Remove this selection?",
  magicSelectConfirmActionLabel: "Remove Selection",
  toleranceLabel: "Tolerance",
  toleranceHelp: "More / less similar color",
  selectedPixelsLabel: (count: number) =>
    `Selected ${count.toLocaleString("en-US")} pixel${count === 1 ? "" : "s"}`,
} as const;

/**
 * What to say after one preview or confirmation. The refusal cases are
 * deliberately warm and deliberately vague about mechanism: the customer does
 * not need to know that their click landed outside an enclosed candidate
 * region, only that we left their artwork alone — which is the reassuring
 * half of the answer anyway.
 */
export type GuidedCleanupOutcomeCode =
  | "preview"
  | "removed"
  | "already_removed"
  | "not_background"
  | "outside_image"
  | "nothing_to_undo"
  | "undone"
  | "stale_preview";

export function describeGuidedCleanupOutcome(
  outcome: GuidedCleanupOutcomeCode,
  options?: { selectedPixelCount?: number; tool?: "region" | "magic_select" },
): string {
  switch (outcome) {
    case "preview":
      if (options?.tool === "magic_select") {
        const count = options.selectedPixelCount;
        if (typeof count === "number" && count > 0) {
          return `${GUIDED_CLEANUP_COPY.selectedPixelsLabel(count)}. ${GUIDED_CLEANUP_COPY.magicSelectConfirmPrompt}`;
        }
        return GUIDED_CLEANUP_COPY.magicSelectConfirmPrompt;
      }
      return GUIDED_CLEANUP_COPY.confirmPrompt;
    case "removed":
      return "Removed. If that wasn't right, undo it.";
    case "already_removed":
      return "That area is already see-through.";
    case "not_background":
      // The single most important sentence in this flow: the customer clicked
      // their own artwork and we declined. Says what we did NOT do, because
      // that is the reassurance they need.
      return "That area looks like part of the artwork, so we left it unchanged.";
    case "outside_image":
      return "That click landed outside your artwork.";
    case "nothing_to_undo":
      return "There's nothing to undo yet.";
    case "undone":
      return "Put back.";
    case "stale_preview":
      return "The artwork changed since that preview. Please select the area again.";
  }
}

/**
 * Existing Artwork → Print Ready Phase 2: the honest "something went wrong"
 * state. Never says the file is ready, never blames the customer, and never
 * suggests their artwork is lost — the original upload and the prepared
 * version both survive any finalization failure.
 */
export const PRINT_READY_NEEDS_ATTENTION_MESSAGE =
  "Your artwork needs attention before we can finish the print-ready file. Your uploaded artwork and the prepared version are both safe — you can try again, and we'll take another look.";

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
