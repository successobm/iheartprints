import type { PrintPlacement } from "./types";

/** Shared plain-language labels so evaluation, summary, and question text agree. */
export const PRINT_PLACEMENT_LABELS: Record<PrintPlacement, string> = {
  full_front: "full front",
  full_back: "full back",
  left_chest: "left chest",
  sleeve: "sleeve",
};

export function printPlacementLabel(
  placement: PrintPlacement | null,
): string | null {
  return placement ? PRINT_PLACEMENT_LABELS[placement] : null;
}
