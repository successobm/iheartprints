import type { GarmentSizeClass, PrintPlacement } from "@/lib/domain/types";

import type { PlacementSizingPolicy } from "./print-placement-dimensions";

/**
 * Print'em All Phase 1 — THE RECOMMENDATION AUTHORITY.
 *
 * One server-side place that answers "how large should this print, on this
 * placement, for this class of garment?" — and exactly one thing it is not
 * allowed to be: the answer to "how large WILL this print?".
 *
 * WHY THIS MODULE EXISTS
 *
 * `print-placement-dimensions.ts` previously carried a single `targetWidthIn`
 * / `defaultWidthIn` of 10.5in for `full_front` and `full_back`, and every
 * consumer read it as though it were universal truth. It is not. 10.5in is
 * the standard ADULT recommendation. A youth tee, a small ladies cut, and a
 * 4XL are all real Print'em All production work, and none of them is served
 * by one number.
 *
 * Three different concepts were collapsed into that one value, and this
 * module exists to pull the first of them out:
 *
 *   A. RECOMMENDED PRODUCTION BOX — this module. A suggestion, derived from
 *      garment size class + placement. Never spend authority.
 *   B. CONFIRMED PRODUCTION SIZE — `confirmed-production-size.ts`. What a
 *      human explicitly approved. The ONLY production authority.
 *   C. TECHNICAL / PRODUCT LIMIT — `print-placement-dimensions.ts`'s
 *      `PlacementTechnicalLimit`. An independent guardrail bounding what may
 *      be confirmed at all, deliberately much wider than any recommendation
 *      so an explicit oversize request is honored rather than silently pulled
 *      back to "standard".
 *
 * A RECOMMENDATION IS A BOX, NOT A WIDTH
 *
 * `full_front` / `full_back` recommendations are areas the artwork is
 * CONTAINED within, proportionally. A 10.5x10.5 recommendation prints a
 * square design at 10.5x10.5, a 3:2 landscape at 10.5x7.0, and a 2:3
 * portrait at 7.0x10.5. Artwork is never stretched, never cropped to fill,
 * and a portrait design is never forced to 10.5in wide. The containment
 * arithmetic is NOT reimplemented here — it is `resolveWidthConstrainedSizing`,
 * the same function the production transform uses, driven through
 * `sizingPolicyForProductionBox`.
 *
 * WHAT THIS MODULE IS NOT
 *
 * Not a SKU catalogue, not an apparel inventory, not a manufacturer sizing
 * database, and not a garment-commerce surface. iHeartPrints sells artwork,
 * not garments (Constitution: apparel DESIGN). The only reason garment sizing
 * appears at all is that a print box recommendation is meaningless without
 * knowing roughly what it is being printed on.
 *
 * Pure — no repository, no capability, no I/O, no clock.
 */

/**
 * A recommended containing box, in physical inches.
 *
 * Both axes are BOUNDS on the artwork, never a canvas to pad out to and
 * never a shape to distort into.
 */
export interface ProductionBox {
  maxWidthIn: number;
  maxHeightIn: number;
}

/**
 * Left chest and sleeve, shared by every named garment class.
 *
 * These placements are sized by the PRINT, not by the garment: a left-chest
 * logo is a left-chest logo at 4in whether it sits on a youth tee or a 4XL,
 * and scaling it with the garment class would put a 12in "left chest" print
 * on a 2XL — which is a full front, not a left chest. Spread into each row
 * rather than special-cased at lookup time, so the table stays a plain
 * (class x placement) grid that reads exactly as it behaves.
 *
 * `custom` deliberately does NOT spread this in; see its own note.
 */
const ACCENT_PLACEMENT_RECOMMENDATIONS = {
  left_chest: { maxWidthIn: 4, maxHeightIn: 4 },
  sleeve: { maxWidthIn: 3, maxHeightIn: 3 },
} as const satisfies Partial<Record<PrintPlacement, ProductionBox>>;

/**
 * The recommendation table.
 *
 * `null` is a first-class, deliberate value: "this product has no
 * authoritative recommendation for this combination yet". It is NOT a bug,
 * NOT a TODO to be filled with a plausible-looking number, and NOT something
 * a caller may silently substitute another class's box for.
 *
 * WHERE THESE NUMBERS COME FROM
 *
 * The full-front / full-back figures are INITIAL PRINT'EM ALL OPERATOR
 * PRODUCTION RECOMMENDATIONS, supplied by the operator as product authority.
 * They are expected to EVOLVE from real production evidence — a garment that
 * consistently comes back looking oversized, a class the shop finds it prints
 * differently in practice — and revising them is a data change to this table
 * and nothing else. Nothing downstream hard-codes an inch figure.
 *
 * The 10.5in adult_standard, 4in left_chest, and 3in sleeve values are not
 * new: they are the existing Print-Ready Normalization Phase 1 figures, moved
 * here rather than re-derived. A test asserts adult_standard still agrees
 * with `PRINT_PLACEMENT_SIZING_POLICY` so the two cannot drift apart.
 *
 * A RECOMMENDATION IS NOT A MAXIMUM. Every figure below sits well inside the
 * placement's technical band (4-14in on a full front / full back), and the
 * operator may deliberately confirm a different width in either direction —
 * 13in on a 12in adult_plus recommendation, 8.5in on a 9in womens_small one.
 * Nothing clamps an explicit choice back toward these values.
 *
 * WHY `custom` IS STILL `null`
 *
 * `custom` is not a garment. It means the operator is sizing to something
 * this vocabulary does not name, so any box we suggested would be a guess at
 * a garment we were explicitly told we do not know — and a shipped guess
 * becomes indistinguishable from a real production decision the moment
 * somebody confirms it. That row stays `null` permanently, and the surface
 * asks for a width instead.
 */
export const PRODUCTION_BOX_RECOMMENDATIONS: Record<
  GarmentSizeClass,
  Record<PrintPlacement, ProductionBox | null>
> = {
  /** Youth / smaller garments: an 8.5in front/back box. */
  youth: {
    full_front: { maxWidthIn: 8.5, maxHeightIn: 8.5 },
    full_back: { maxWidthIn: 8.5, maxHeightIn: 8.5 },
    ...ACCENT_PLACEMENT_RECOMMENDATIONS,
  },
  /** Ladies / smaller cuts: a 9in front/back box. */
  womens_small: {
    full_front: { maxWidthIn: 9, maxHeightIn: 9 },
    full_back: { maxWidthIn: 9, maxHeightIn: 9 },
    ...ACCENT_PLACEMENT_RECOMMENDATIONS,
  },
  /**
   * Standard adult: the 10.5in front/back box carried over unchanged from
   * Print-Ready Normalization Phase 1, and still the class an unstated
   * garment is ASSUMED to be for suggestion purposes.
   *
   * Height equals width here (and in every front/back row) because a
   * recommendation is an AREA — the artwork's own proportions decide how much
   * of it is used. See `sizingPolicyForProductionBox`.
   */
  adult_standard: {
    full_front: { maxWidthIn: 10.5, maxHeightIn: 10.5 },
    full_back: { maxWidthIn: 10.5, maxHeightIn: 10.5 },
    ...ACCENT_PLACEMENT_RECOMMENDATIONS,
  },
  /**
   * 2XL-4XL and larger garments: Phase 28I correction.
   *
   * This class used to recommend a 12x12 SQUARE box — strictly bigger than
   * `adult_standard`'s in both dimensions, on the theory that a larger
   * garment should get a larger print. That is not iHeartPrints' economical
   * DTF production model: the standard portrait production envelope is
   * 10.5in wide x 12in tall (~126 sq in) regardless of garment size, and a
   * larger garment does not by itself justify exceeding it. This box now
   * shares `adult_standard`'s 10.5in WIDTH ceiling while keeping the taller
   * 12in HEIGHT ceiling a larger garment can still make good use of for a
   * portrait design — it can never again recommend MORE width than
   * `adult_standard`, only proportionally more height for artwork whose own
   * aspect ratio wants it.
   *
   * 10.5x12 is still a RECOMMENDATION, not a ceiling. The full front / full
   * back technical band runs to 14in, so an operator who deliberately wants
   * 13in on a 4XL back still gets 13in — see `normalizeConfirmableWidth`,
   * which honors anything inside the band and REFUSES (never clamps)
   * anything outside it.
   */
  adult_plus: {
    full_front: { maxWidthIn: 10.5, maxHeightIn: 12 },
    full_back: { maxWidthIn: 10.5, maxHeightIn: 12 },
    ...ACCENT_PLACEMENT_RECOMMENDATIONS,
  },
  /**
   * Never carries a recommendation, by definition and permanently — including
   * for left chest and sleeve. `custom` means "we were told this vocabulary
   * does not describe the garment", and that is as true of an accent print as
   * of a front print.
   */
  custom: {
    full_front: null,
    full_back: null,
    left_chest: null,
    sleeve: null,
  },
};

/**
 * The class a recommendation is derived for when the brief never stated one.
 *
 * This is an ASSUMPTION and is reported as one (`assumedGarmentSizeClass`),
 * never as a fact about the garment. It is safe precisely because a
 * recommendation cannot authorize anything: the operator still has to confirm
 * a physical size before a cent is spent, and the surface that asks them to
 * confirm names the class the suggestion came from.
 */
export const ASSUMED_GARMENT_SIZE_CLASS: GarmentSizeClass = "adult_standard";

/**
 * What a customer or operator actually reads.
 *
 * Plain garment language, never the enum. `womens_small` in particular is
 * shown as "Women's / Smaller Garment" — a GARMENT CUT the person picked, not
 * an inference about who is wearing it. The system never derives any of these
 * from anything; one of them is chosen, explicitly, or none is.
 *
 * Used both by the picker and by the "Recommended for:" line, deliberately:
 * two label sets for one concept is how they end up disagreeing on screen.
 */
export const GARMENT_SIZE_CLASS_LABELS: Record<GarmentSizeClass, string> = {
  youth: "Youth",
  womens_small: "Women's / Smaller Garment",
  adult_standard: "Standard Adult",
  adult_plus: "2XL–4XL / Larger Garment",
  custom: "Custom Size",
};

/**
 * Re-exported from the domain, which owns the vocabulary so `lib/db` can
 * narrow its own rows without importing a capability. `readGarmentSizeClass`
 * reads anything unrecognized back as `null` (= never stated), which
 * downgrades to "assume standard adult and ask for confirmation" — the same
 * place an unspecified project lands, and never a silently different
 * recommendation.
 */
export { GARMENT_SIZE_CLASSES, readGarmentSizeClass } from "@/lib/domain/types";

export interface RecommendProductionBoxInput {
  placement: PrintPlacement | null;
  /** `null` = never stated. Resolves to `ASSUMED_GARMENT_SIZE_CLASS`, reported as assumed. */
  garmentSizeClass: GarmentSizeClass | null;
}

export interface ProductionBoxRecommendation {
  placement: PrintPlacement;
  /** The class the recommendation was actually derived for. */
  garmentSizeClass: GarmentSizeClass;
  /** True when `garmentSizeClass` was assumed rather than stated on the brief. */
  assumedGarmentSizeClass: boolean;
  /**
   * The recommended containing box, or `null` when this product has no
   * authoritative recommendation for this (class, placement) yet — in which
   * case the operator must state the size explicitly.
   */
  box: ProductionBox | null;
  /** Stable, non-customer-facing id for the rule that produced this, e.g. `adult_standard:full_back`. */
  recommendationKey: string;
  /** Internal rationale, for observability and job diagnostics. Never customer-facing copy. */
  rationale: string;
  /**
   * ALWAYS `true`. A field rather than an implicit property because it is the
   * whole point of this module: a recommendation, including a perfectly good
   * one, is never production authority and never spend authority. Nothing may
   * derive `false` from anything.
   */
  requiresExplicitConfirmation: true;
}

/**
 * The single recommendation entry point. Every UI and every server consumer
 * calls this — no component, route, or capability re-derives a box.
 *
 * Returns `null` only when placement is unknown, because there is no honest
 * recommendation to make without it (the production pipeline refuses for the
 * same reason).
 */
export function recommendProductionBox(
  input: RecommendProductionBoxInput,
): ProductionBoxRecommendation | null {
  const { placement } = input;
  if (!placement) return null;

  const assumed = input.garmentSizeClass === null;
  const garmentSizeClass = input.garmentSizeClass ?? ASSUMED_GARMENT_SIZE_CLASS;
  const box = PRODUCTION_BOX_RECOMMENDATIONS[garmentSizeClass][placement];

  return {
    placement,
    garmentSizeClass,
    assumedGarmentSizeClass: assumed,
    box,
    recommendationKey: `${garmentSizeClass}:${placement}`,
    rationale: box
      ? `Recommended ${box.maxWidthIn}x${box.maxHeightIn}in containing box for a ${garmentSizeClass} garment at ${placement}${
          assumed ? " (garment size class assumed — never stated on this project)" : ""
        }. Recommendation only; production size is whatever a human confirms.`
      : `No authoritative production box is configured for a ${garmentSizeClass} garment at ${placement}. The physical size must be stated explicitly by the operator.`,
    requiresExplicitConfirmation: true,
  };
}

/**
 * Turns a recommended (or confirmed) BOX into a sizing policy the existing
 * production geometry can consume — and nothing more.
 *
 * This is the whole of "contain, never distort": `resolveWidthConstrainedSizing`
 * already sizes artwork to `targetWidthIn` by its own aspect ratio and pulls
 * BOTH axes down proportionally when `maxHeightIn` would be exceeded. Point
 * those two fields at a box and the result is proportional containment within
 * that box. There is deliberately no second geometry engine here.
 *
 * `boxHeightIn` of `null` means "no box height bound" — height then follows
 * the artwork's aspect ratio, bounded only by the placement's technical
 * limit, which is the correct reading of an operator who stated a width
 * alone.
 */
export function sizingPolicyForProductionBox(
  base: PlacementSizingPolicy,
  boxWidthIn: number,
  boxHeightIn: number | null,
): PlacementSizingPolicy {
  return {
    ...base,
    targetWidthIn: boxWidthIn,
    maxHeightIn: boxHeightIn ?? base.maxHeightIn,
  };
}

/**
 * Phase 28S — ORIENTATION-AWARE PRODUCTION SIZING.
 *
 * THE REGRESSION THIS RESTORES/COMPLETES. Every recommendation box above is
 * a fixed rectangle keyed only by (garment class, placement) — it has never
 * once looked at the artwork's own shape. For a LANDSCAPE design that is
 * harmless: `resolveWidthConstrainedSizing` sizes to the box's WIDTH and the
 * proportional height always lands under the box's own height (a 3:2
 * landscape in a 10.5x10.5 box lands at 10.5x7.0 — see this module's own
 * doc comment above). For a PORTRAIT design it is not harmless: the SAME
 * 10.5x10.5 box for a 2:3 portrait contains it to 7.0x10.5 — correctly
 * proportional, but capped at a height (10.5) that was only ever meant to
 * describe a SQUARE recommendation area, not a technical ceiling. The real
 * `adult_standard` car-show job (Phase 28Q/28R/28S) is exactly this: a
 * portrait design constrained to 6.96x10.5 when the placement's own
 * TECHNICAL limit (`PRINT_PLACEMENT_SIZING_POLICY.full_front.maxHeightIn`,
 * 14in) has real room the flat box never offered it.
 *
 * `adult_plus` already carries a partial, deliberate version of this fix
 * (Phase 28I: `{maxWidthIn: 10.5, maxHeightIn: 12}`, wider than a square but
 * still short of the 14in technical ceiling, "for a portrait design [to]
 * still make good use of") — proof this problem was recognized once before,
 * for one class, and never generalized. This phase generalizes the
 * MECHANISM without touching `adult_plus`'s own already-considered 12in
 * choice, or `youth`/`womens_small`'s boxes, which this phase does not
 * audit with enough evidence to change (see the Phase 28S report).
 *
 * THE FIX IS NOT A NEW GEOMETRY ENGINE. `orientedProductionBox` below
 * changes WHICH NUMBER gets used as `boxHeightIn` in
 * `sizingPolicyForProductionBox` — nothing about containment, aspect-ratio
 * preservation, or the width/height trade-off in `resolveWidthConstrainedSizing`
 * changes at all. For landscape and square/near-square artwork the box is
 * returned completely unchanged (byte-identical to today's behavior). For
 * portrait artwork, the box's height ceiling is raised to the PLACEMENT's
 * own existing technical limit (`placementMaxHeightIn` — already a real,
 * long-established number, never invented here) — letting height become the
 * genuinely dominant axis and width fall out proportionally, exactly as
 * Section 6 of the Phase 28S mission describes.
 *
 * WHY NO SEPARATE "~1 SQUARE FOOT" CLAMP. A portrait design's width falls
 * as its height rises (fixed aspect ratio), so raising only the height
 * ceiling self-limits area for any real portrait shape — the real car-show
 * case lands at 9.28x14 ≈ 130 sq in, comfortably under the ~144 sq in (1 sq
 * ft) guardrail Eric describes as a sanity principle, not a command. A
 * design just barely classified portait (see `NEAR_SQUARE_ASPECT_TOLERANCE`)
 * could land somewhat over 144 sq in — an accepted, disclosed edge case
 * (see the Phase 28S report) rather than something a second clamp should
 * paper over: any clamp tight enough to force every portrait under exactly
 * 144 sq in would have to shrink BOTH axes and abandon "use the appropriate
 * full-front portrait height", which Section 7 explicitly forbids
 * ("Do NOT force every artwork to exactly 144 sq in").
 */
export type ArtworkOrientation = "portrait" | "landscape" | "square";

/**
 * Phase 28S: how close to 1:1 an aspect ratio must be to count as
 * "square/near-square" rather than a (weak) portrait or landscape. No prior
 * tolerance existed anywhere in this codebase to restore — orientation was
 * never classified before this phase (`recommendProductionBox` never took
 * artwork dimensions as an input at all). 10% is a smallest-defensible,
 * documented choice: wide enough that a slightly-rectangular badge or logo
 * (a very common real design shape) reads as "square" and keeps today's
 * exact behavior, tight enough that a genuine 2:3 or 3:2 design (ratio
 * 0.667 / 1.5, far outside 0.9-1.111) is unambiguously portrait/landscape.
 */
export const NEAR_SQUARE_ASPECT_TOLERANCE = 0.1;

/**
 * Classifies orientation from the artwork's own VISIBLE bounds — never the
 * transparent canvas. Callers are responsible for supplying visible/alpha
 * bounds (this module stays pure: no repository, no capability, no I/O —
 * see the module doc comment above); passing raw canvas dimensions when
 * transparent padding is not negligible would misclassify a padded portrait
 * canvas as square, which is exactly the failure Section 4 of the Phase 28S
 * mission calls out.
 */
export function classifyArtworkOrientation(
  visibleWidthPx: number,
  visibleHeightPx: number,
): ArtworkOrientation {
  if (visibleWidthPx <= 0 || visibleHeightPx <= 0) {
    throw new Error("Artwork dimensions must be positive to classify orientation.");
  }
  const ratio = visibleWidthPx / visibleHeightPx;
  if (ratio > 1 + NEAR_SQUARE_ASPECT_TOLERANCE) return "landscape";
  if (ratio < 1 - NEAR_SQUARE_ASPECT_TOLERANCE) return "portrait";
  return "square";
}

/**
 * THE SINGLE SIZING AUTHORITY for orientation. Every caller that resolves a
 * recommendation or confirmation box — the customer-facing preview
 * (`print-ready-size.ts`), pixel-sufficiency analysis (`image-analysis.ts`),
 * and recommended-size confirmation (`conversation-capability.ts`) — calls
 * THIS function rather than re-deciding a height ceiling of its own, which
 * is what keeps them from ever independently inventing different
 * dimensions (Phase 28S mission Section 3).
 *
 * Landscape and square/near-square: returned unchanged — today's exact
 * behavior. Portrait: `maxHeightIn` raised to `placementMaxHeightIn` (never
 * lowered — `Math.max` guards against a future box whose height already
 * exceeds the placement limit, which should not be possible today but must
 * never SHRINK a box if it somehow were).
 */
export function orientedProductionBox(
  box: ProductionBox,
  orientation: ArtworkOrientation,
  placementMaxHeightIn: number,
): ProductionBox {
  if (orientation !== "portrait") return box;
  // Phase 28T correction: only a genuinely SQUARE box (width === height) is
  // an undifferentiated "area" recommendation that was never meant to be a
  // portrait ceiling — see this module's own "Height equals width here...
  // because a recommendation is an AREA" doc comment for `adult_standard`/
  // `youth`/`womens_small`. `adult_plus`'s box (10.5x12) is NOT that: Phase
  // 28I already made a deliberate, considered, ASYMMETRIC choice for it
  // ("it can never again recommend MORE width than adult_standard, only
  // proportionally more height... for a portrait design"). Widening it
  // further to the placement's full 14in ceiling — which the original
  // Phase 28S implementation did unconditionally, a real bug this
  // correction fixes — would silently override that already-oriented
  // choice, exactly the "expand adult_plus/youth/womens_small without
  // evidence" the Phase 28T mission explicitly forbids.
  if (box.maxWidthIn !== box.maxHeightIn) return box;
  return {
    maxWidthIn: box.maxWidthIn,
    maxHeightIn: Math.max(box.maxHeightIn, placementMaxHeightIn),
  };
}
