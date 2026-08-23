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

import { assessProductionSourceStrategy } from "@/capabilities/shared/production-source-strategy";
import { channelDistanceBetweenColors } from "./pixel-metrics";
import type {
  ArtworkAnalysis,
  RepairabilityAssessment,
  RgbColor,
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
    // NOT "and preserved your artwork". Background isolation removes pixels
    // that are the background's colour AND connected to the image border; it
    // has no way to tell such a pixel apart from a design element drawn in
    // that same colour and touching the background. On the audited bowling
    // logo the black keylines around the lettering went with the background,
    // because at the pixel level they ARE the background. A categorical
    // preservation promise is one this pipeline cannot keep, so it isn't made.
    summary: "We've removed the background from the artwork you uploaded.",
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
 * Existing Artwork → Print Ready: pre-upload quality guidance on the
 * upload step. Sets expectations without making the customer responsible
 * for doing our job, and without claiming perfect background removal.
 *
 * Presentation copy only — it does not change file acceptance or
 * preparation behaviour. Transparent artwork is ideal; a solid white
 * background is the next-best starting point, never a requirement.
 */
export const UPLOAD_QUALITY_GUIDANCE_COPY = {
  headline: "For the best results",
  recommendation:
    "Upload a high-resolution image with a transparent or solid white background whenever possible.",
  limitation:
    "Images with coloured, dark, textured, or complex backgrounds may leave small traces around the edges of your design after background removal.",
  reassurance:
    "Don't worry — iHeartPrints will automatically clean and prepare your artwork as much as possible. You'll be able to review it before creating your print-ready file.",
  bestPractices:
    "Best: Transparent PNG or white background · High resolution · Clear, sharp edges",
} as const;

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

/**
 * Existing Artwork → Print Ready: what the customer is told about a PREPARED
 * asset, before they approve it.
 *
 * ## Why this is not one fixed sentence
 *
 * Background isolation removes pixels that match the detected background
 * colour and are reachable from the image border. When a design is drawn in
 * that same colour and touches the background — black keylines on a black
 * plate — those pixels are, at the pixel level, indistinguishable from the
 * background, and they go with it. That is a real limitation of the removal
 * semantics, not a bug in them, and the copy has to be honest about it
 * without frightening a customer whose artwork came out fine.
 *
 * ## The evidence, and its exact strength
 *
 * `interiorBackgroundColoredPixelsPreserved` counts visible pixels that match
 * the background colour and SURVIVED, because no border-connected path
 * reached them. It is already recorded by `isolateBackground` for every
 * preparation; nothing here re-measures the image, and no removal decision
 * changes.
 *
 * Above zero, that count is proof of ONE thing: the design contains content
 * painted in the background's own colour. It is NOT proof that anything was
 * wrongly removed — the pipeline cannot know that. But it is exactly the
 * precondition for the failure mode, so it is the honest trigger for a
 * REVIEW PROMPT and nothing stronger. Measured across the fixture set it
 * separates cleanly: zero for plain light/dark backgrounds, non-zero for the
 * bowling logo, the finger-hole ball and the intentional drop shadow.
 *
 * Advisory only. It never blocks approval, never rejects artwork, and never
 * claims damage occurred.
 */
export interface PreparedArtworkReviewCopy {
  headline: string;
  guidance: string;
  /**
   * True when the design provably contains content in the background's own
   * colour, so same-colour connections may have been removed with it.
   *
   * Kept as its own field, computed exactly as it always was, for backward
   * display compatibility — `reviewRequired` below is the field anything new
   * should read.
   */
  sharesBackgroundColor: boolean;
  /**
   * Intelligent Separation Phase 2: whether measured evidence
   * (`assessProductionSourceStrategy`) supports approving this preparation
   * without further look, or asks for one. Never "unsafe" — see that
   * module's doc comment for why only these two values are supportable.
   *
   * Falls back to `sharesBackgroundColor` when no source evidence was
   * supplied (the bare pure-function call with no second argument) — the
   * same conservative behaviour this function always had.
   */
  reviewRequired: boolean;
  /**
   * Whether the confirmed garment colour sits within the same tolerance of
   * the detected background that background membership itself uses
   * (`GARMENT_BACKGROUND_MATCH_TOLERANCE`). `null` when no garment colour is
   * confirmed or it could not be parsed — never guessed.
   *
   * A colour fact only. It says the garment MAY already supply that colour
   * on press; it never says a separation is safe, press-proven, or that any
   * treatment should change.
   */
  garmentMayMatchBackground: boolean | null;
}

/** The subset of the preparation record this decision reads. */
export interface PreparedArtworkReviewEvidence {
  interiorBackgroundColoredPixelsPreserved?: unknown;
  /**
   * Intelligent Separation Phase 2 (`enclosure-evidence.ts`). Absent on any
   * preparation made before this phase — MUST be read as "not measured",
   * never coerced to `0`. See `readEnclosureRatio` below.
   */
  exteriorRemovalEnclosureRatio?: unknown;
}

/**
 * The deterministic analysis fields the source-strategy assessment reads.
 * Always available on `ArtworkPreparation.analysis` — for every preparation,
 * old or new — which is what lets a record from before this phase still
 * drive a real (non-"safe-by-absence") assessment; see Phase 2's Goal 15.
 */
export interface PreparedArtworkReviewSourceEvidence {
  fullyOpaque: boolean;
  hasTransparency: boolean;
  disconnectedBackgroundColoredPixels: number;
  backgroundIsEdgeConnected: boolean;
  backgroundConfidence: number;
  estimatedBackgroundColor: RgbColor;
}

export interface PreparedArtworkReviewContext {
  sourceEvidence: PreparedArtworkReviewSourceEvidence;
  /** The customer's confirmed garment colour, resolved to RGB. `null` when unset or unparseable. */
  garmentRgb: RgbColor | null;
}

/** Reads the new evidence defensively: absent/malformed is "not measured", never "measured zero". */
function readEnclosureRatio(
  record: PreparedArtworkReviewEvidence | null | undefined,
): number | null {
  const value = record?.exteriorRemovalEnclosureRatio;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function legacySharesBackgroundColor(
  record: PreparedArtworkReviewEvidence | null | undefined,
): boolean {
  const preserved = record?.interiorBackgroundColoredPixelsPreserved;
  return typeof preserved === "number" && Number.isFinite(preserved) && preserved > 0;
}

const NEUTRAL_REVIEW_COPY = {
  headline: "Background prepared",
  guidance: "Review the artwork below before continuing.",
} as const;

/**
 * `describePreparedArtworkReview` takes a SECOND, OPTIONAL argument
 * (`context`). Without it — the bare pure-function call this module has
 * always supported — behaviour is unchanged from before Phase 2:
 * `sharesBackgroundColor` alone decides the copy, and `reviewRequired`
 * mirrors it.
 *
 * With `context` (what the real preparation capability always supplies,
 * because `analysis` exists on every preparation regardless of age), the
 * decision is upgraded to the Phase 1 pure assessor fed with real measured
 * evidence, and the guidance becomes garment-conditional — see Goal 6.
 */
export function describePreparedArtworkReview(
  record: PreparedArtworkReviewEvidence | null | undefined,
  context?: PreparedArtworkReviewContext,
): PreparedArtworkReviewCopy {
  const sharesBackgroundColor = legacySharesBackgroundColor(record);

  if (!context) {
    return {
      ...(sharesBackgroundColor
        ? {
            headline: "Background prepared — review recommended",
            guidance:
              "Some of your design uses the same colour as the background. Check the prepared artwork on Gray, White, and Black before continuing.",
          }
        : NEUTRAL_REVIEW_COPY),
      sharesBackgroundColor,
      reviewRequired: sharesBackgroundColor,
      garmentMayMatchBackground: null,
    };
  }

  const { sourceEvidence, garmentRgb } = context;
  const garmentToBackgroundChannelDistance =
    garmentRgb === null
      ? null
      : channelDistanceBetweenColors(garmentRgb, sourceEvidence.estimatedBackgroundColor);

  const assessment = assessProductionSourceStrategy({
    sourceFullyOpaque: sourceEvidence.fullyOpaque,
    sourceHasTransparency: sourceEvidence.hasTransparency,
    disconnectedBackgroundColoredPixels: sourceEvidence.disconnectedBackgroundColoredPixels,
    backgroundIsEdgeConnected: sourceEvidence.backgroundIsEdgeConnected,
    backgroundConfidence: sourceEvidence.backgroundConfidence,
    exteriorRemovalEnclosureRatio: readEnclosureRatio(record),
    garmentToBackgroundChannelDistance,
  });

  const reviewRequired = assessment.readiness === "review_required";
  const garmentMayMatchBackground =
    garmentToBackgroundChannelDistance === null
      ? null
      : assessment.reasons.includes("garment_matches_background");

  if (!reviewRequired) {
    return {
      ...NEUTRAL_REVIEW_COPY,
      sharesBackgroundColor,
      reviewRequired,
      garmentMayMatchBackground,
    };
  }

  // Same headline and the same three preview surfaces named either way — the
  // distinction Goals 6/7/8 ask for is in what the removed colour MEANS on
  // this garment, never in whether to go look. Three variants, not two: an
  // UNKNOWN garment relationship must not read as though a mismatch was
  // actually established — that would be inferring a colour we were never
  // given (Phase 3 Goal 8).
  const headline = "Background prepared — review recommended";
  const guidance =
    garmentMayMatchBackground === true
      ? "Some of your design uses the same colour as the background. On this garment colour, those areas may already be supplied by the shirt itself — check the prepared artwork on Gray, White, and Black before continuing."
      : garmentMayMatchBackground === false
        ? "Some removed background-coloured areas also run through the design. On this garment, those areas may show up as missing fill or detail — check the prepared artwork on Gray, White, and Black before continuing."
        : "Some removed background-coloured areas also run through the design. Review the prepared artwork carefully on Gray, White, and Black before continuing.";

  return {
    headline,
    guidance,
    sharesBackgroundColor,
    reviewRequired,
    garmentMayMatchBackground,
  };
}
