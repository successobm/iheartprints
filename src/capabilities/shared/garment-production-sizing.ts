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
