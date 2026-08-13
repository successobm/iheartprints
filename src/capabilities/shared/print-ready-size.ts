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

import type { PrintPlacement } from "@/lib/domain/types";

import {
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
  /** `TShirtDesignBrief.intendedPrintWidthIn` — the persisted production intent. */
  intendedPrintWidthIn: number | null;
  /** Pixel dimensions of the selected concept's artwork, when known. */
  artworkWidthPx: number | null;
  artworkHeightPx: number | null;
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

  return {
    widthIn: resolved.widthIn,
    heightIn,
    dpi: policy.targetPpi,
    placementLabel: PLACEMENT_LABELS[input.printPlacement],
    isDefaultWidth: resolved.isDefault,
    minWidthIn: resolved.minWidthIn,
    maxWidthIn: resolved.maxWidthIn,
    widthOptions: buildWidthOptions(resolved.defaultWidthIn, resolved),
    note: STANDARD_ADULT_PLACEMENTS.includes(input.printPlacement)
      ? `This is a standard adult ${PLACEMENT_LABELS[input.printPlacement].toLowerCase()} print size.`
      : null,
  };
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
