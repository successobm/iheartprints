import type { PrintPlacement } from "@/lib/domain/types";

/**
 * Sprint 2M Phase 1: deterministic target physical print dimensions per
 * apparel placement. Lives in `shared/` — like `product-rule-packs.ts` and
 * `interview-coverage-policy.ts` — so it is a single, reusable source of
 * placement-driven print-size knowledge rather than something
 * `PrintValidationCapability` invents privately. `ProductIntelligenceCapability`
 * does not currently reason about physical dimensions (only word count /
 * graphic density), so nothing here duplicates an existing rule; if a future
 * sprint teaches Product Intelligence about physical size, it should read
 * from this same table instead of a second copy (Goal 8: "do not duplicate
 * placement rules").
 *
 * These are internal production figures — never shown to a customer as
 * "12x14 inches" or similar. A customer-facing surface would phrase this as
 * "How large should this print on the back?" (Goal 4), not expose the
 * number directly.
 *
 * Deliberately conservative, common-case defaults for a standard adult
 * garment. Not a substitute for an eventual customer-specified physical
 * size — see ARCHITECTURE.md's Print Validation section for the known gap
 * (`TShirtDesignBrief.intendedPrintWidthIn` exists but is never populated by
 * the interview and is not carried into `DesignBriefSnapshotContent`).
 */
export interface PlacementTargetDimensions {
  widthIn: number;
  heightIn: number;
}

export const PRINT_PLACEMENT_TARGET_DIMENSIONS_IN: Record<
  PrintPlacement,
  PlacementTargetDimensions
> = {
  // Sprint 2M Phase 1 Goal 14 Scenario A uses this exact figure — a
  // standard full-size adult front/back print.
  full_front: { widthIn: 12, heightIn: 14 },
  full_back: { widthIn: 12, heightIn: 14 },
  left_chest: { widthIn: 4, heightIn: 4 },
  sleeve: { widthIn: 3, heightIn: 3 },
};

export function targetDimensionsForPlacement(
  placement: PrintPlacement | null,
): PlacementTargetDimensions | null {
  return placement ? PRINT_PLACEMENT_TARGET_DIMENSIONS_IN[placement] : null;
}
