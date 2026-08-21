/**
 * Live Acceptance Cleanup (Issue 5): the customer-facing view of the
 * production size their artwork will be prepared at, BEFORE they commit to
 * finalizing it.
 *
 * The Constitution (§6.4 / Goal 8 in AGENTS.md) says production settings stay
 * hidden from ordinary customers "unless a meaningful customer decision
 * requires a plain-language explanation". Physical print size is exactly that
 * exception: how large the design prints on the garment is a customer
 * decision, not a technical setting, and they cannot make it after the plate
 * has been produced. Resolution stays a fact we state, never a knob — the
 * customer chooses inches; 300 DPI is guaranteed at whatever they choose.
 *
 * Every number here is derived from the single placement policy table
 * (`print-placement-dimensions.ts`) so no UI component hardcodes an inch
 * figure — the same rule that keeps `10.5` out of the finalization worker.
 *
 * Pure — no repository, no capability, no I/O.
 */

import type { GarmentSizeClass, PrintPlacement } from "@/lib/domain/types";

import {
  PRODUCTION_SIZE_CONFIRMATION_REQUIRED_MESSAGE,
  resolveProductionSizeConfirmation,
  sizingPolicyForConfirmedSize,
  type ConfirmedProductionSize,
} from "./confirmed-production-size";
import {
  GARMENT_SIZE_CLASS_LABELS,
  GARMENT_SIZE_CLASSES,
  recommendProductionBox,
  sizingPolicyForProductionBox,
  type ProductionBox,
} from "./garment-production-sizing";
import {
  PRINT_PLACEMENT_SIZING_POLICY,
  resolveProductionWidth,
  resolveWidthConstrainedSizing,
  sizingPolicyForPlacement,
} from "./print-placement-dimensions";

export interface PrintReadyWidthOption {
  widthIn: number;
  /** Customer-facing label, e.g. `10.5" Standard`. */
  label: string;
  /** The placement default — the one a customer who says nothing receives. */
  isStandard: boolean;
  /** Currently in effect for this project. */
  isSelected: boolean;
}

export interface PrintReadySizeView {
  /** The production print width, in inches — the customer's choice, or the placement default. */
  widthIn: number;
  /**
   * Height, in inches, derived from the selected artwork's own aspect ratio.
   * `null` when no artwork dimensions are known yet — stated as unknown
   * rather than guessed, since a fabricated height is a promise about the
   * finished plate we cannot keep.
   */
  heightIn: number | null;
  /** Guaranteed production resolution at the chosen width. */
  dpi: number;
  /** Plain-language placement, e.g. "Full Front". `null` when not yet known. */
  placementLabel: string | null;
  /** False once the customer has chosen a width of their own. */
  isDefaultWidth: boolean;
  minWidthIn: number;
  maxWidthIn: number;
  /** A small set of ready-made choices, so no component invents inch figures. */
  widthOptions: PrintReadyWidthOption[];
  /** Short reassurance for the common case, e.g. "This is a standard adult full-front print size." */
  note: string | null;
  /**
   * Print'em All Phase 1 — THE RECOMMENDATION, stated as a recommendation.
   *
   * `null` when this product has no authoritative box for the project's
   * (garment class, placement) yet, which is the honest state for youth,
   * ladies, plus, and custom garments today. A `null` here is what tells the
   * UI to ask for a size instead of offering one.
   */
  recommendation: PrintReadyRecommendationView | null;
  /**
   * Print'em All Phase 1 — THE CONFIRMATION, stated separately from the size.
   *
   * The whole reason this field exists apart from `widthIn`: a number on
   * screen proves nothing about whether a human approved it, and the surface
   * that spends money needs to know the difference.
   */
  confirmed: boolean;
  /** ISO timestamp of the confirmation, when there is one. */
  confirmedAt: string | null;
  /**
   * Why production cannot start yet, already phrased for a human, or `null`
   * when it can. Provider-free: nothing here names a vendor, a credit, an
   * upscale, or a reconstruction.
   */
  blockingMessage: string | null;
  /**
   * The garment sizing contexts a recommendation can be derived for, already
   * labelled. Server-derived like every other figure here, so no component
   * carries the vocabulary — or, worse, a second copy of the labels.
   */
  garmentSizeOptions: GarmentSizeOption[];
  /**
   * True when this (garment class, placement) has no authoritative
   * recommendation, so the size can only come from a human typing one.
   *
   * The honest state for `custom`: suggesting a box for a garment we were
   * explicitly told this vocabulary does not describe would be a guess, and a
   * shipped guess is indistinguishable from a real production decision the
   * moment somebody confirms it.
   */
  requiresExplicitWidth: boolean;
}

export interface GarmentSizeOption {
  value: GarmentSizeClass;
  /** Customer-facing label, e.g. "2XL–4XL / Larger Garment". Never the enum. */
  label: string;
  /** True when this is the project's stated class. Nothing is selected until someone chooses. */
  isSelected: boolean;
}

export interface PrintReadyRecommendationView {
  /** e.g. "Adult standard · Full Back". */
  recommendedFor: string;
  /** The recommended area, in inches. */
  boxWidthIn: number;
  boxHeightIn: number;
  /**
   * What the artwork will ACTUALLY print at inside that area, contained
   * proportionally — e.g. a 10.5x10.5 recommendation printing a wide design
   * at 10.5x9.1. `null` until the artwork's proportions are known, because a
   * fabricated figure here is a promise about the finished plate.
   */
  artworkWidthIn: number | null;
  artworkHeightIn: number | null;
  /** True when the garment class was assumed rather than stated. */
  assumedGarmentSizeClass: boolean;
  /**
   * True when this recommendation — the whole BOX, not just its width — is
   * already what the project has confirmed.
   *
   * Width alone is not enough to answer this. Confirming "10.5 inches wide"
   * and confirming "the 10.5 x 10.5 box" are different decisions that
   * produce different plates for anything that is not landscape: a 2:3
   * portrait contains to 7.0 x 10.5 inside the box, but runs to 10.5 x 15.75
   * (clipped by the technical height limit to 9.33 x 14) from a bare width.
   * Treating the first as the second would hide the "Use recommended size"
   * control from someone who has not actually taken it.
   */
  isConfirmed: boolean;
}

/** How far the smaller/larger ready-made options sit from the standard width. */
const OPTION_STEP_IN = 1.5;

const PLACEMENT_LABELS: Record<PrintPlacement, string> = {
  full_front: "Full Front",
  full_back: "Full Back",
  left_chest: "Left Chest",
  sleeve: "Sleeve",
};

const STANDARD_ADULT_PLACEMENTS: readonly PrintPlacement[] = [
  "full_front",
  "full_back",
];

export interface DescribePrintReadySizeInput {
  printPlacement: PrintPlacement | null;
  /** `TShirtDesignBrief.intendedPrintWidthIn` — the persisted WORKING intent, never authority. */
  intendedPrintWidthIn: number | null;
  /** Pixel dimensions of the selected concept's artwork, when known. */
  artworkWidthPx: number | null;
  artworkHeightPx: number | null;
  /** Print'em All Phase 1: the garment context the recommendation is derived for. */
  garmentSizeClass?: GarmentSizeClass | null;
  /** Print'em All Phase 1: the persisted confirmation — the only production authority. */
  productionSizeConfirmedAt?: string | null;
  productionSizeConfirmedWidthIn?: number | null;
  productionSizeConfirmedMaxHeightIn?: number | null;
}

/**
 * Builds the pre-finalization size view. Returns `null` when print placement
 * is not yet known — there is no honest production size to state without it,
 * and the finalization pipeline refuses for the same reason.
 */
export function describePrintReadySize(
  input: DescribePrintReadySizeInput,
): PrintReadySizeView | null {
  const resolved = resolveProductionWidth(
    input.printPlacement,
    input.intendedPrintWidthIn,
  );
  const policy = sizingPolicyForPlacement(
    input.printPlacement,
    input.intendedPrintWidthIn,
  );
  if (!resolved || !policy || !input.printPlacement) return null;

  // Derived from the SAME function the production transform uses, so the
  // figure shown before finalizing and the plate produced afterwards can
  // never come from two different pieces of arithmetic.
  const heightIn =
    input.artworkWidthPx && input.artworkHeightPx
      ? roundInches(
          resolveWidthConstrainedSizing(
            policy,
            input.artworkWidthPx,
            input.artworkHeightPx,
          ).heightIn,
        )
      : null;

  const confirmation = resolveProductionSizeConfirmation({
    printPlacement: input.printPlacement,
    productionSizeConfirmedAt: input.productionSizeConfirmedAt ?? null,
    productionSizeConfirmedWidthIn: input.productionSizeConfirmedWidthIn ?? null,
    productionSizeConfirmedMaxHeightIn:
      input.productionSizeConfirmedMaxHeightIn ?? null,
  });

  // The size ACTUALLY shown is the confirmed one when there is one, so the
  // figure on screen and the figure production will use are the same value
  // rather than two views of the brief that can disagree.
  const confirmedPolicy = confirmation.confirmed
    ? sizingPolicyForConfirmedSize(input.printPlacement, confirmation.size)
    : null;
  const displayHeightIn = confirmedPolicy
    ? containedHeightIn(confirmedPolicy, input)
    : heightIn;

  const recommendation = recommendProductionBox({
    placement: input.printPlacement,
    garmentSizeClass: input.garmentSizeClass ?? null,
  });

  return {
    widthIn: confirmation.confirmed ? confirmation.size.widthIn : resolved.widthIn,
    heightIn: displayHeightIn,
    dpi: policy.targetPpi,
    placementLabel: PLACEMENT_LABELS[input.printPlacement],
    isDefaultWidth: resolved.isDefault,
    minWidthIn: resolved.minWidthIn,
    maxWidthIn: resolved.maxWidthIn,
    widthOptions: buildWidthOptions(resolved.defaultWidthIn, resolved),
    note:
      recommendation?.garmentSizeClass === "adult_standard" &&
      STANDARD_ADULT_PLACEMENTS.includes(input.printPlacement)
        ? `This is a standard adult ${PLACEMENT_LABELS[input.printPlacement].toLowerCase()} print size.`
        : null,
    recommendation:
      recommendation && recommendation.box
        ? describeRecommendation(
            input,
            recommendation.box,
            recommendation.garmentSizeClass,
            recommendation.assumedGarmentSizeClass,
            confirmation.confirmed ? confirmation.size : null,
          )
        : null,
    confirmed: confirmation.confirmed,
    confirmedAt: confirmation.confirmed ? confirmation.size.confirmedAt : null,
    blockingMessage: confirmation.confirmed
      ? null
      : PRODUCTION_SIZE_CONFIRMATION_REQUIRED_MESSAGE,
    garmentSizeOptions: GARMENT_SIZE_CLASSES.map((value) => ({
      value,
      label: GARMENT_SIZE_CLASS_LABELS[value],
      // An UNSTATED class selects nothing, even though the recommendation is
      // computed as though it were standard adult. Highlighting a chip nobody
      // pressed would turn an assumption into an apparent choice, which is
      // the same confusion between "defaulted" and "decided" that this whole
      // pass exists to remove.
      isSelected: input.garmentSizeClass === value,
    })),
    requiresExplicitWidth: !recommendation?.box,
  };
}

function describeRecommendation(
  input: DescribePrintReadySizeInput,
  box: ProductionBox,
  garmentSizeClass: GarmentSizeClass,
  assumedGarmentSizeClass: boolean,
  confirmedSize: ConfirmedProductionSize | null,
): PrintReadyRecommendationView {
  const placement = input.printPlacement!;
  // Contained through the SAME geometry the production transform uses, so
  // "your artwork will print at 10.5 x 9.1" is arithmetic rather than a
  // second estimate that can drift from the plate.
  const boxPolicy = sizingPolicyForProductionBox(
    PRINT_PLACEMENT_SIZING_POLICY[placement],
    box.maxWidthIn,
    box.maxHeightIn,
  );
  const contained =
    input.artworkWidthPx && input.artworkHeightPx
      ? resolveWidthConstrainedSizing(
          boxPolicy,
          input.artworkWidthPx,
          input.artworkHeightPx,
        )
      : null;

  return {
    recommendedFor: `${GARMENT_SIZE_CLASS_LABELS[garmentSizeClass]} · ${PLACEMENT_LABELS[placement]}`,
    boxWidthIn: box.maxWidthIn,
    boxHeightIn: box.maxHeightIn,
    artworkWidthIn: contained ? roundInches(contained.widthIn) : null,
    artworkHeightIn: contained ? roundInches(contained.heightIn) : null,
    assumedGarmentSizeClass,
    isConfirmed:
      confirmedSize !== null &&
      Math.abs(confirmedSize.widthIn - box.maxWidthIn) < 1e-9 &&
      confirmedSize.boxMaxHeightIn !== null &&
      Math.abs(confirmedSize.boxMaxHeightIn - box.maxHeightIn) < 1e-9,
  };
}

/** Contained height for one policy, or `null` when the artwork's proportions are unknown. */
function containedHeightIn(
  policy: Parameters<typeof resolveWidthConstrainedSizing>[0],
  input: DescribePrintReadySizeInput,
): number | null {
  if (!input.artworkWidthPx || !input.artworkHeightPx) return null;
  return roundInches(
    resolveWidthConstrainedSizing(
      policy,
      input.artworkWidthPx,
      input.artworkHeightPx,
    ).heightIn,
  );
}

function buildWidthOptions(
  standardWidthIn: number,
  resolved: { widthIn: number; minWidthIn: number; maxWidthIn: number },
): PrintReadyWidthOption[] {
  const candidates = [
    standardWidthIn - OPTION_STEP_IN,
    standardWidthIn,
    standardWidthIn + OPTION_STEP_IN,
    // A width the customer typed in chat stays visible as a choice even when
    // it isn't one of the three ready-made ones.
    resolved.widthIn,
  ]
    .map((width) =>
      clampToQuarterInch(width, resolved.minWidthIn, resolved.maxWidthIn),
    )
    .sort((a, b) => a - b);

  const seen = new Set<number>();
  const options: PrintReadyWidthOption[] = [];
  for (const widthIn of candidates) {
    if (seen.has(widthIn)) continue;
    seen.add(widthIn);
    const isStandard = widthIn === standardWidthIn;
    options.push({
      widthIn,
      label: `${formatInches(widthIn)}"${isStandard ? " Standard" : ""}`,
      isStandard,
      isSelected: widthIn === resolved.widthIn,
    });
  }
  return options;
}

function clampToQuarterInch(value: number, min: number, max: number): number {
  return Math.round(Math.min(max, Math.max(min, value)) * 4) / 4;
}

function roundInches(value: number): number {
  return Math.round(value * 100) / 100;
}

/** `10.5` → `"10.5"`, `12` → `"12"` — never `"12.00"`. */
export function formatInches(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100);
}
