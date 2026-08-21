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
 * Print-Ready Normalization Phase 1: this module now owns the *sizing
 * strategy*, not merely a pair of numbers. The production deliverable is
 * sized by physical print WIDTH with the artwork's own aspect ratio deciding
 * height (`"width_constrained_preserve_aspect"`) — never forced into a fixed
 * rectangular canvas with transparent padding, which is what the Print-Ready
 * Production Output Audit found on the live 3600x4200 plate (visible artwork
 * only ~2662x2861 of it). The production artwork itself defines the canvas.
 *
 * `maxHeightIn` is a garment-printability BOUND, never a canvas: it only
 * ever kicks in for an extremely tall/narrow artwork that could not
 * physically fit the placement at full target width, and when it does the
 * width is reduced proportionally (still never stretched, never cropped,
 * never padded out).
 *
 * These are internal production figures — never shown to a customer as
 * "10.5 inches" or similar. A customer-facing surface would phrase this as
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

/**
 * The only sizing strategy this product implements today. Named explicitly
 * (rather than left implicit in arithmetic) so a future strategy —
 * height-constrained, area-constrained, customer-specified width — is an
 * added case here rather than a rewrite of the production pipeline.
 */
export type PlacementSizingStrategy = "width_constrained_preserve_aspect";

export interface PlacementSizingPolicy {
  strategy: PlacementSizingStrategy;
  /** The physical print WIDTH production artwork is sized to, in inches. */
  targetWidthIn: number;
  /** Upper bound on printable height for this placement, in inches — a bound on the artwork, never a canvas to pad out to. */
  maxHeightIn: number;
  /** Required effective production resolution, in pixels per inch. Never PNG DPI metadata — see `print-validation/effective-resolution.ts`. */
  targetPpi: number;
  /** Allowed deviation, in inches, when validating a produced plate's physical width against `targetWidthIn`. Never exact float equality. */
  widthToleranceIn: number;
  /**
   * Print'em All Phase 1 — CONCEPT C, THE TECHNICAL / PRODUCT LIMIT.
   *
   * `minWidthIn`/`maxWidthIn` (with `maxHeightIn` above) bound what may be
   * produced on this placement AT ALL. They are a garment-printability fact
   * — a 20-inch print does not fit an adult tee, and a 1-inch full-front
   * print is not a full-front print — so they live here with the rest of the
   * placement policy rather than in a UI component or a route validator.
   *
   * A LIMIT IS NOT A RECOMMENDATION. The band is deliberately much wider
   * than any recommended box (4-14in for front/back against a 10.5in
   * standard adult recommendation) precisely so that a deliberate oversize
   * choice — 12in, 13in, a 4XL back print — is HONORED rather than silently
   * pulled back to "standard". Recommendations live in
   * `garment-production-sizing.ts` and are never read from here.
   */
  minWidthIn: number;
  maxWidthIn: number;
  /**
   * The width a caller receives when nobody has expressed a size.
   *
   * Print'em All Phase 1: kept for the pre-confirmation display path and for
   * every existing caller's behavior, but it is explicitly NOT authority and
   * NOT a recommendation:
   *
   *   - It cannot be spent against. `confirmed-production-size.ts` is the
   *     only thing a paid provider call may be authorized from, and a
   *     default has by definition never been confirmed by anyone.
   *   - It is not garment-aware. The real recommendation comes from
   *     `recommendProductionBox({ placement, garmentSizeClass })`, which
   *     knows that 10.5in is a standard ADULT figure and not universal truth.
   *
   * It survives as the neutral starting point a size-confirmation surface
   * opens on, nothing more.
   */
  defaultWidthIn: number;
}

/**
 * Standard adult apparel policy. `full_front` / `full_back` at 10.5" wide is
 * the Print-Ready Normalization Phase 1 default — a real, printable standard
 * adult front/back print width, replacing the previous fixed 12x14" canvas
 * whose height was never derived from the artwork at all.
 *
 * Print'em All Phase 1: the 10.5in figures here are the STANDARD ADULT case
 * and are mirrored, deliberately, by `PRODUCTION_BOX_RECOMMENDATIONS`'s
 * `adult_standard` row — which is the garment-aware authority every
 * recommendation surface reads. Nothing in this table knows about youth,
 * ladies, or plus-size garments, and nothing should learn: this table's job
 * is the TECHNICAL LIMIT and the sizing STRATEGY, not the suggestion.
 */
export const PRINT_PLACEMENT_SIZING_POLICY: Record<
  PrintPlacement,
  PlacementSizingPolicy
> = {
  full_front: {
    strategy: "width_constrained_preserve_aspect",
    targetWidthIn: 10.5,
    maxHeightIn: 14,
    targetPpi: 300,
    widthToleranceIn: 0.05,
    defaultWidthIn: 10.5,
    minWidthIn: 4,
    maxWidthIn: 14,
  },
  full_back: {
    strategy: "width_constrained_preserve_aspect",
    targetWidthIn: 10.5,
    maxHeightIn: 14,
    targetPpi: 300,
    widthToleranceIn: 0.05,
    defaultWidthIn: 10.5,
    minWidthIn: 4,
    maxWidthIn: 14,
  },
  left_chest: {
    strategy: "width_constrained_preserve_aspect",
    targetWidthIn: 4,
    maxHeightIn: 4,
    targetPpi: 300,
    widthToleranceIn: 0.05,
    defaultWidthIn: 4,
    minWidthIn: 2,
    maxWidthIn: 5,
  },
  sleeve: {
    strategy: "width_constrained_preserve_aspect",
    targetWidthIn: 3,
    maxHeightIn: 3,
    targetPpi: 300,
    widthToleranceIn: 0.05,
    defaultWidthIn: 3,
    minWidthIn: 1.5,
    maxWidthIn: 4,
  },
};

/**
 * Live Acceptance Cleanup (Issue 5): the placement's sizing policy, with the
 * customer's chosen production width applied when they made a choice.
 *
 * `requestedWidthIn` is the AUTHORITATIVE production intent
 * (`TShirtDesignBrief.intendedPrintWidthIn`) — never a pixel dimension, never
 * inferred from whatever the generator happened to produce. `null`/omitted
 * keeps the placement default, so every existing caller and every project
 * that never expressed a size behaves exactly as before.
 *
 * An out-of-band value is CLAMPED into the printable band rather than
 * rejected or honored: a request outside it cannot be printed on this
 * placement, and silently producing a plate at an unprintable size would be
 * the dishonest option. `resolveProductionWidth` is what callers use when
 * they need to tell the customer that happened.
 */
export function sizingPolicyForPlacement(
  placement: PrintPlacement | null,
  requestedWidthIn: number | null = null,
): PlacementSizingPolicy | null {
  if (!placement) return null;
  const policy = PRINT_PLACEMENT_SIZING_POLICY[placement];
  const resolved = resolveProductionWidth(placement, requestedWidthIn);
  if (!resolved || resolved.widthIn === policy.targetWidthIn) return policy;
  return { ...policy, targetWidthIn: resolved.widthIn };
}

/**
 * How a requested production width resolves against a placement's printable
 * band, including whether it had to be clamped — the one place that decision
 * is made, so a customer-facing confirmation and the production pipeline can
 * never disagree about the size that was actually chosen.
 */
export interface ResolvedProductionWidth {
  /** The width production will actually use, in inches. */
  widthIn: number;
  /** True when the request fell outside the printable band and was pulled into it. */
  clamped: boolean;
  /** True when this is the placement default rather than a customer choice. */
  isDefault: boolean;
  minWidthIn: number;
  maxWidthIn: number;
  defaultWidthIn: number;
}

export function resolveProductionWidth(
  placement: PrintPlacement | null,
  requestedWidthIn: number | null,
): ResolvedProductionWidth | null {
  if (!placement) return null;
  const policy = PRINT_PLACEMENT_SIZING_POLICY[placement];
  const band = {
    minWidthIn: policy.minWidthIn,
    maxWidthIn: policy.maxWidthIn,
    defaultWidthIn: policy.defaultWidthIn,
  };

  if (
    requestedWidthIn === null ||
    !Number.isFinite(requestedWidthIn) ||
    requestedWidthIn <= 0
  ) {
    return { widthIn: policy.defaultWidthIn, clamped: false, isDefault: true, ...band };
  }

  const clampedWidth = Math.min(
    policy.maxWidthIn,
    Math.max(policy.minWidthIn, requestedWidthIn),
  );
  const widthIn = roundToQuarterInch(clampedWidth);

  return {
    widthIn,
    clamped: Math.abs(clampedWidth - requestedWidthIn) > 1e-9,
    isDefault: false,
    ...band,
  };
}

/**
 * The placement's printable ENVELOPE — the largest area artwork may occupy,
 * derived from the same single policy table. Used for placement-level
 * sufficiency intelligence about a not-yet-normalized concept (provisional
 * Print Validation); it is explicitly NOT the shape of the production
 * deliverable, whose height comes from the artwork's own aspect ratio (see
 * `resolveWidthConstrainedSizing`).
 */
/**
 * Print'em All Phase 1 — CONCEPT C, read on its own.
 *
 * The independent guardrail: what this placement can physically produce,
 * with no reference to what we would suggest or what anyone confirmed. A
 * confirmation is validated against THIS, never against a recommendation, so
 * an explicit oversize choice is refused only when it is genuinely
 * unprintable.
 */
export interface PlacementTechnicalLimit {
  minWidthIn: number;
  maxWidthIn: number;
  maxHeightIn: number;
}

export function technicalLimitForPlacement(
  placement: PrintPlacement | null,
): PlacementTechnicalLimit | null {
  if (!placement) return null;
  const policy = PRINT_PLACEMENT_SIZING_POLICY[placement];
  return {
    minWidthIn: policy.minWidthIn,
    maxWidthIn: policy.maxWidthIn,
    maxHeightIn: policy.maxHeightIn,
  };
}

/**
 * Rounds a physical width to the quarter inch — finer than a print shop can
 * meaningfully hold, and it keeps the operator-facing figure readable
 * ("10.5 inches", not "10.4999999 inches").
 *
 * Extracted so `resolveProductionWidth` and the confirmation path round
 * IDENTICALLY: a confirmed width that rounded differently from the width the
 * pipeline resolves would read as a size change and fence its own job out.
 */
export function roundToQuarterInch(widthIn: number): number {
  return Math.round(widthIn * 4) / 4;
}

export function targetDimensionsForPlacement(
  placement: PrintPlacement | null,
  requestedWidthIn: number | null = null,
): PlacementTargetDimensions | null {
  const policy = sizingPolicyForPlacement(placement, requestedWidthIn);
  return policy
    ? { widthIn: policy.targetWidthIn, heightIn: policy.maxHeightIn }
    : null;
}

/**
 * The resolved production size for one specific piece of artwork: pixel
 * geometry AND the physical inches those pixels are intended to print at,
 * always in agreement (`widthPx / targetPpi === widthIn` exactly, by
 * construction). Effective print resolution is therefore never a claim — it
 * is arithmetic on these two fields.
 */
export interface ProductionSizingResolution {
  strategy: PlacementSizingStrategy;
  /** The policy width this resolution was sized from, in inches. */
  targetWidthIn: number;
  targetPpi: number;
  widthPx: number;
  heightPx: number;
  /** Intended physical print size of `widthPx`x`heightPx`, in inches. */
  widthIn: number;
  heightIn: number;
  /**
   * `"width"` for the normal case (the plate is exactly `targetWidthIn`
   * wide). `"max_height"` when an unusually tall/narrow artwork would have
   * exceeded the placement's printable height at full target width, so both
   * axes were reduced proportionally — recorded honestly rather than
   * silently cropping or squashing.
   */
  constrainedBy: "width" | "max_height";
}

/**
 * Derives production pixel dimensions from the trimmed artwork's own aspect
 * ratio and the placement's target physical WIDTH. Pure arithmetic — no
 * fixed canvas, no padding, no distortion: the returned dimensions always
 * carry the source aspect ratio to within one pixel of rounding.
 */
export function resolveWidthConstrainedSizing(
  policy: PlacementSizingPolicy,
  artworkWidthPx: number,
  artworkHeightPx: number,
): ProductionSizingResolution {
  if (artworkWidthPx <= 0 || artworkHeightPx <= 0) {
    throw new Error("Artwork dimensions must be positive to resolve production sizing.");
  }

  const aspect = artworkHeightPx / artworkWidthPx;
  let widthPx = Math.max(1, Math.round(policy.targetWidthIn * policy.targetPpi));
  let heightPx = Math.max(1, Math.round(widthPx * aspect));
  let constrainedBy: "width" | "max_height" = "width";

  const maxHeightPx = Math.max(1, Math.round(policy.maxHeightIn * policy.targetPpi));
  if (heightPx > maxHeightPx) {
    constrainedBy = "max_height";
    heightPx = maxHeightPx;
    widthPx = Math.max(1, Math.round(heightPx / aspect));
  }

  return {
    strategy: policy.strategy,
    targetWidthIn: policy.targetWidthIn,
    targetPpi: policy.targetPpi,
    widthPx,
    heightPx,
    // Physical size is DERIVED from the pixels actually produced, so pixel
    // geometry and the physical production specification can never drift
    // apart by a rounding pixel.
    widthIn: widthPx / policy.targetPpi,
    heightIn: heightPx / policy.targetPpi,
    constrainedBy,
  };
}
