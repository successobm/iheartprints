/**
 * Phase 2C / 2C.3A — Automatic concept replacement policy.
 *
 * Pure decision rules, deliberately separated from the worker that spends
 * money against them. Nothing here does I/O, and nothing here counts spend:
 * the budget is durable (`paid_image_intents`), never an in-memory tally.
 *
 * Phase 2C.3A authority correction:
 *   Inferred `printPaletteEnforcement === "hard"` is prompt emphasis /
 *   contrast guidance. It is NOT, by itself, authority to purchase another
 *   image. Automatic paid replacement requires an EXPLICIT customer /
 *   production ink restriction PLUS deterministic evidence the concept
 *   violated that restriction.
 */

import {
  deriveExplicitInkRestriction,
  type ExplicitInkRestriction,
} from "@/capabilities/prompt-translation/explicit-ink-restriction";
import type {
  ConceptEvaluation,
  DesignBriefSnapshotContent,
  PrintPaletteCompliance,
} from "@/lib/domain/types";

export type { ExplicitInkRestriction };
export { deriveExplicitInkRestriction };

/**
 * Must stay aligned with Phase 2B (`print-palette-compliance.ts`) —
 * authority changes; thresholds do not. Duplicated here so this policy
 * module does not import concept-evaluation.
 */
const PHASE_2B_FAIL_GARMENT_MATCHING = 0.35;
const PHASE_2B_FAIL_LOW_COVERAGE = 0.4;

type BriefForInkRestriction = Pick<
  DesignBriefSnapshotContent,
  "additionalInstructions" | "exclusions" | "designDescription"
>;

/**
 * Whether a deterministic FAIL is evidence that an EXPLICIT ink restriction
 * was violated. Reuses Phase 2B metrics/reasons — does not invent a new
 * vision system and does not loosen thresholds.
 *
 * Advisory garment-matching / palette-dominance FAILs without a matching
 * restriction are NOT violations for spend purposes.
 */
export function violatesExplicitInkRestriction(
  compliance: PrintPaletteCompliance | null | undefined,
  restriction: ExplicitInkRestriction,
): boolean {
  if (!compliance || compliance.status !== "fail") return false;

  const reasons = new Set(compliance.reasons);
  const metrics = compliance.metrics;
  const darkInkFraction = Math.max(
    metrics.nearBlackPixelFraction ?? 0,
    metrics.darkPixelFraction ?? 0,
  );
  const garmentMatch = metrics.garmentMatchingFraction ?? 0;
  const coverage = metrics.paletteCoverageFraction ?? 1;

  if (restriction.kind === "no_black_ink") {
    // Substantial black/dark printed ink, or the calibrated garment-matching
    // hard-fail reasons when those encode dark fills on a dark garment.
    return (
      darkInkFraction >= PHASE_2B_FAIL_GARMENT_MATCHING ||
      garmentMatch >= PHASE_2B_FAIL_GARMENT_MATCHING ||
      reasons.has("excessive_garment_matching_ink")
    );
  }

  // white_ink_only — non-white / dark fills dominating, or calibrated
  // hard-palette coverage / garment-matching hard-fail reasons.
  return (
    darkInkFraction >= PHASE_2B_FAIL_GARMENT_MATCHING ||
    garmentMatch >= PHASE_2B_FAIL_GARMENT_MATCHING ||
    coverage < PHASE_2B_FAIL_LOW_COVERAGE ||
    reasons.has("excessive_garment_matching_ink") ||
    reasons.has("hard_palette_not_dominant")
  );
}

/**
 * The one and only automatic-replacement trigger after Phase 2C.3A.
 *
 * BOTH must hold:
 *   A. the brief contains an EXPLICIT literal ink restriction
 *      (`deriveExplicitInkRestriction`), and
 *   B. the Phase 2B deterministic validator returned `"fail"` with evidence
 *      that violates that restriction.
 *
 * Explicitly NOT triggers (even when inferred enforcement is `"hard"`):
 *
 *   - garment-matching ink alone
 *   - imperfect preferred-palette dominance alone
 *   - preferredColors / shirtColor / subject color words without restrictive language
 *   - `"warn"` / `"not_applicable"` / soft enforcement / absent verdict
 *   - vision / subjective colour scores
 *
 * Reading the restriction from the brief (not from compliance.enforcement)
 * is intentional: spend authority is about what the customer said, not about
 * how strongly Prompt Translation emphasized contrast to the model.
 */
export function isAutomaticInkRestrictionReplacementEligible(
  evaluation: ConceptEvaluation | null | undefined,
  brief: BriefForInkRestriction,
): boolean {
  const restriction = deriveExplicitInkRestriction(brief);
  if (!restriction) return false;
  return violatesExplicitInkRestriction(
    evaluation?.printPaletteCompliance,
    restriction,
  );
}

/**
 * @deprecated Phase 2C.3A — use `isAutomaticInkRestrictionReplacementEligible`.
 * Kept as a thin wrapper name for call-site clarity during the transition;
 * inferred hard + FAIL is no longer sufficient.
 */
export function isHardPrintPaletteFailure(
  evaluation: ConceptEvaluation | null | undefined,
  brief?: BriefForInkRestriction,
): boolean {
  if (!brief) return false;
  return isAutomaticInkRestrictionReplacementEligible(evaluation, brief);
}

/**
 * What to do with a generated REPLACEMENT, once it has been evaluated by the
 * normal (deterministic + vision) pipeline.
 *
 *   "accept"            the replacement is customer-visible as evaluated.
 *   "accept_unverified" the replacement is customer-visible, but its
 *                       evaluation status is downgraded to `needs_review` —
 *                       nothing downstream may treat it as verified-compliant.
 *   "reject"            the replacement is NOT shown, and no further
 *                       generation is attempted for this direction.
 */
export type ReplacementAcceptance =
  | "accept"
  | "accept_unverified"
  | "reject";

/**
 * Replacement acceptance policy (Phase 2C.3A).
 *
 * Withholding after a paid replacement is reserved for an EXPLICIT ink
 * restriction that the replacement still violates. Advisory palette FAIL
 * (garment-matching / imperfect coverage without that restriction) must
 * not withhold — the customer judges the design.
 *
 *   PASS / WARN         accept.
 *   FAIL + restriction violated   reject (withhold; no second attempt).
 *   FAIL without restriction evidence   accept (advisory).
 *   NOT_APPLICABLE / missing      accept_unverified.
 */
export function classifyReplacementAcceptance(
  compliance: PrintPaletteCompliance | null | undefined,
  restriction: ExplicitInkRestriction | null = null,
): ReplacementAcceptance {
  if (!compliance) return "accept_unverified";
  switch (compliance.status) {
    case "pass":
    case "warn":
      return "accept";
    case "fail":
      if (restriction && violatesExplicitInkRestriction(compliance, restriction)) {
        return "reject";
      }
      return "accept";
    case "not_applicable":
      return "accept_unverified";
  }
}

/**
 * Why a direction that failed an explicit ink restriction ended up without
 * a replacement. Every value is observable in the logs — a customer who
 * receives fewer than three concepts must always be explainable from the
 * server record alone.
 */
export type ReplacementSkipReason =
  /** The job's durable paid-intent budget refused a further logical intent. */
  | "paid_budget_exhausted"
  /** The replacement image itself could not be produced (provider/storage). */
  | "replacement_generation_failed"
  /** The replacement was produced and still violated the explicit restriction. */
  | "replacement_failed_validation"
  /** The adapter exposes no per-direction paid unit to replace. */
  | "no_per_direction_paid_unit";
