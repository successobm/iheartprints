/**
 * DTF Feature Integrity Phase 1 — THE provisional DTF production profile.
 *
 * ⚠️ PROVISIONAL. THESE VALUES REQUIRE PHYSICAL DTF CALIBRATION. ⚠️
 *
 * Every threshold in this file is a conservative engineering starting point,
 * chosen so the measurement framework introduced in this phase has something
 * to classify against. None of them is:
 *
 *   - validated DTF physics
 *   - derived from a controlled physical print test
 *   - a claim that iHeartPrints (or anyone else) has established a universal
 *     minimum feature size for DTF production
 *
 * A single Roland DTG test print (CMYK, no white underbase, no adhesive
 * powder, no film transfer, no black-shirt integration) cannot establish
 * DTF-specific truth either — it can only exercise this measurement
 * framework's geometry, never calibrate its numbers (see AGENTS.md /
 * ARCHITECTURE.md "DTF Feature Integrity"). These constants are expected to
 * change, and this file exists specifically to make that change a one-file
 * edit rather than an archaeology project through validator internals —
 * every DTF Feature Integrity check in `print-validation-capability.ts`
 * reads its thresholds from here, and nowhere else.
 *
 * WHY THIS FILE HOLDS TIERS, NOT ONE NUMBER PER CATEGORY: a physically tiny
 * feature is not automatically a defect (distressed artwork intentionally
 * contains tiny fragments — Section 5/10 of this phase's plan). Each
 * category therefore has a WARNING floor and a stricter, more conservative
 * BLOCKING floor well below it — detect aggressively, block rarely. See each
 * constant's own comment for why its specific tier was chosen.
 */

export const DTF_FEATURE_INTEGRITY_PROFILE_VERSION = "dtf_feature_integrity_provisional_v1";

export type DtfFeatureIntegrityTier = "pass" | "warning" | "blocking";

// ---------------------------------------------------------------------------
// Positive feature (ink stroke) width
// ---------------------------------------------------------------------------

/**
 * Below this physical stroke width, a positive feature is provisionally
 * BLOCKING. Chosen well below ordinary "fine print" typography (a common
 * print-industry rule of thumb for reliably reproducible fine line work
 * across raster decoration methods generally sits in the 0.75-1mm range;
 * this floor is set lower still, deliberately conservative about blocking —
 * see this file's own doc comment) so that only strokes thin enough to be
 * a near-hairline risk one pixel of ink loss away from disappearing ever
 * reach this tier before physical calibration exists.
 */
export const DTF_POSITIVE_FEATURE_BLOCKING_WIDTH_MM = 0.4;
/** Below this width, a positive feature is provisionally WARNING (worth an operator's attention, not yet refused). */
export const DTF_POSITIVE_FEATURE_WARNING_WIDTH_MM = 1.0;

// ---------------------------------------------------------------------------
// Negative space (gap) width
// ---------------------------------------------------------------------------

/**
 * Below this physical gap width, a negative space (a letter counter, the
 * space between two letters) is provisionally BLOCKING — narrow enough that
 * adhesive powder bridging across the gap during DTF's powder/cure/transfer
 * steps is a real risk of the gap printing solid instead of open.
 */
export const DTF_NEGATIVE_SPACE_BLOCKING_WIDTH_MM = 0.35;
/** Below this width, a negative space is provisionally WARNING. */
export const DTF_NEGATIVE_SPACE_WARNING_WIDTH_MM = 0.8;

// ---------------------------------------------------------------------------
// Isolated component size
// ---------------------------------------------------------------------------

/**
 * Below this equivalent diameter, an isolated printable component is
 * provisionally BLOCKING. Set very small deliberately (Section 5/10):
 * distressed artwork intentionally contains tiny fragments, and this phase
 * must not blindly declare every small piece defective. Only components at
 * genuine risk of being lost entirely during powder application/cure/peel —
 * not merely "small" — belong at this tier before real prints say otherwise.
 */
export const DTF_ISOLATED_COMPONENT_BLOCKING_DIAMETER_MM = 0.6;
/** Below this equivalent diameter, an isolated component is provisionally WARNING. */
export const DTF_ISOLATED_COMPONENT_WARNING_DIAMETER_MM = 1.5;

// ---------------------------------------------------------------------------
// Partial-alpha fine features
// ---------------------------------------------------------------------------

/**
 * Below this equivalent diameter, a partial-alpha (soft/faint) component is
 * provisionally WARNING. Partial-alpha geometry is the LEAST understood
 * category in this phase — a faint distressed fragment's actual printed
 * result depends on ink/powder behavior at partial coverage this framework
 * cannot observe. Deliberately diagnostic-only: see
 * `classifyDtfPartialAlphaFeature`, which never returns `"blocking"`.
 */
export const DTF_PARTIAL_ALPHA_WARNING_DIAMETER_MM = 1.5;

/**
 * Classifies a measured physical width/diameter against a category's
 * provisional blocking/warning floors. `null` (nothing measured — e.g. no
 * component of that kind exists) always passes; a measurement engine that
 * found nothing to flag is not itself a risk.
 */
export function classifyDtfFeatureWidth(
  widthMm: number | null,
  blockingFloorMm: number,
  warningFloorMm: number,
): DtfFeatureIntegrityTier {
  if (widthMm === null) return "pass";
  if (widthMm < blockingFloorMm) return "blocking";
  if (widthMm < warningFloorMm) return "warning";
  return "pass";
}

// ---------------------------------------------------------------------------
// Phase 2A: structural vs. incidental fragility
// ---------------------------------------------------------------------------

/**
 * Provisional. The fraction of a component's OWN ridge (medial-axis) length
 * that must sit below the blocking/warning floor before that component's
 * fragility is called STRUCTURAL — representative of the whole shape —
 * rather than INCIDENTAL — a small dip (a terminal tip, a thin crack, a
 * decorative flourish) inside an otherwise robust structure.
 *
 * 0.5 (half the structure's own length) is a deliberately conservative
 * majority-rule floor: a component only earns "structurally blocking"
 * classification when the thin geometry is not merely present but
 * DOMINANT. This is a distinct, later-calibrated number from the width
 * floors above — a design decision, not (yet) a measured physical fact —
 * chosen to satisfy Section 9's explicit instruction: "A component should
 * not become BLOCKING merely because it contains one pathological
 * minimum-width point if the overwhelming majority of the component is
 * robust." Requires the same physical DTF calibration as every other
 * number in this file.
 */
export const DTF_STRUCTURAL_BLOCKING_FRACTION = 0.5;
/**
 * The warning-tier counterpart — a much lower bar than the blocking
 * fraction, deliberately, so a structure that is meaningfully (not just
 * majority) thin still reads as "structural" attention rather than being
 * dismissed as one incidental dip. "Detect aggressively" (Section 9) means
 * this number stays low; "block conservatively" is what
 * `DTF_STRUCTURAL_BLOCKING_FRACTION` is for.
 */
export const DTF_STRUCTURAL_WARNING_FRACTION = 0.2;

export type StructuralFragilityKind = "robust" | "incidental" | "structural";

export interface StructuralFragilityResult {
  /** The tier the raw minimum width alone would suggest — unchanged from `classifyDtfFeatureWidth`. */
  minimumTier: DtfFeatureIntegrityTier;
  /**
   * Whether the minimum's severity is representative of the WHOLE structure
   * ("structural") or an isolated dip within an otherwise robust structure
   * ("incidental"). "robust" whenever the minimum itself already passes —
   * there is nothing to classify.
   *
   * IMPORTANT: this is a judgment about GEOMETRY, never about artistic
   * intent. "Incidental" does not mean "unintentional distress"; it means
   * "a small fraction of this structure's own length is this thin," which
   * is exactly as true for a deliberate crack effect as for background-
   * removal noise. This function has no way to tell those apart and does
   * not attempt to (Section 5).
   */
  kind: StructuralFragilityKind;
  /**
   * The tier PrintValidation should actually act on. "structural" keeps
   * `minimumTier` unchanged (a majority-thin structure remains eligible for
   * blocking). "incidental" is downgraded one step — blocking becomes
   * warning — per Section 9's rule that one pathological point must never
   * block a predominantly robust component; a merely-warning minimum stays
   * a warning either way, since incidental was never going to elevate it.
   * "robust" is always `"pass"`.
   */
  effectiveTier: DtfFeatureIntegrityTier;
}

/**
 * Combines a component's minimum width with its OWN fraction-below-floor
 * values (both drawn from the SAME component — see
 * `PositiveFeatureGeometry.worstStructuralComponent`'s doc comment on why
 * that pairing must never be broken) into a structural-vs-incidental
 * verdict.
 */
export function classifyStructuralFragility(
  minWidthMm: number | null,
  fractionBelowBlockingFloor: number,
  fractionBelowWarningFloor: number,
  blockingFloorMm: number,
  warningFloorMm: number,
  structuralBlockingFraction: number = DTF_STRUCTURAL_BLOCKING_FRACTION,
  structuralWarningFraction: number = DTF_STRUCTURAL_WARNING_FRACTION,
): StructuralFragilityResult {
  const minimumTier = classifyDtfFeatureWidth(minWidthMm, blockingFloorMm, warningFloorMm);
  if (minimumTier === "pass") {
    return { minimumTier, kind: "robust", effectiveTier: "pass" };
  }
  const isStructural =
    fractionBelowBlockingFloor >= structuralBlockingFraction ||
    fractionBelowWarningFloor >= structuralWarningFraction;
  if (isStructural) {
    return { minimumTier, kind: "structural", effectiveTier: minimumTier };
  }
  return {
    minimumTier,
    kind: "incidental",
    effectiveTier: minimumTier === "blocking" ? "warning" : minimumTier,
  };
}

/**
 * Partial-alpha classification never reaches `"blocking"` — see this file's
 * doc comment and `DTF_PARTIAL_ALPHA_WARNING_DIAMETER_MM`'s own comment for
 * why this category is deliberately diagnostic-only in Phase 1.
 */
export function classifyDtfPartialAlphaFeature(
  diameterMm: number | null,
): Exclude<DtfFeatureIntegrityTier, "blocking"> {
  if (diameterMm === null) return "pass";
  return diameterMm < DTF_PARTIAL_ALPHA_WARNING_DIAMETER_MM ? "warning" : "pass";
}
