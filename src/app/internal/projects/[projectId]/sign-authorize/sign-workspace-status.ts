/**
 * Production Workspace Phase (Section L/K): pure derivation behind the
 * compact production-status bar and the on-canvas TOP/RIGHT/BOTTOM/LEFT
 * chips. Reads only fields the server (or a correction preview) already
 * computed — `sign-fit-to-production.ts` is the sole authority for what
 * PASS/FAIL/UNKNOWN and `requiredProtectedInsetPx` mean; this module never
 * re-measures anything, it only shapes already-computed evidence for
 * display. Pulled out as DOM-free functions for the same reason
 * `sign-canvas-zoom.ts` was: directly testable without a browser.
 */

import type { SignEdge } from "@/capabilities/sign-preparation";

const ALL_EDGES: readonly SignEdge[] = ["top", "right", "bottom", "left"];

export interface EdgeStatusInput {
  edge: SignEdge;
  protectedResult: "pass" | "fail" | "unknown";
  edgeIntentPresent: boolean;
}

export interface EdgeChip {
  edge: SignEdge;
  label: string;
  pass: boolean;
  edgeIntent: boolean;
}

/**
 * One chip per edge, always in TOP/RIGHT/BOTTOM/LEFT order regardless of the
 * source array's order, and always present (an edge missing from `edges` —
 * e.g. a validation report persisted before this evidence field existed —
 * renders as "—", never silently dropped, so the operator always sees four
 * chips).
 */
export function deriveEdgeChips(edges: readonly EdgeStatusInput[]): EdgeChip[] {
  const byEdge = new Map(edges.map((e) => [e.edge, e]));
  return ALL_EDGES.map((edge) => {
    const e = byEdge.get(edge);
    return {
      edge,
      label: e ? e.protectedResult.toUpperCase() : "—",
      pass: e?.protectedResult === "pass",
      edgeIntent: e?.edgeIntentPresent ?? false,
    };
  });
}

/**
 * The single headline FIT word for the compact status bar. Mirrors the same
 * `protected_content_safe_inset` check status every other layer already
 * reads (`status === "pass"` is the only passing value; `"fail"` and
 * `"unknown"` both block production exactly as PrintValidation itself
 * treats them) — never a second, looser definition of "ready."
 */
export function deriveOverallFitLabel(status: string): "READY" | "BLOCKED" {
  return status === "pass" ? "READY" : "BLOCKED";
}

/**
 * A single display PPI from the achieved-PPI-per-axis evidence. Signs are
 * measured on both axes because a corrected/moved candidate can end up
 * slightly non-square in density; the compact bar shows one rounded number
 * (the average) as a headline, while the fuller per-axis figures remain
 * available in the evidence reason text. `null` only when NEITHER axis is
 * known — never invented.
 */
export function computeDisplayPpi(achievedPpiX: number | null, achievedPpiY: number | null): number | null {
  if (achievedPpiX === null && achievedPpiY === null) return null;
  if (achievedPpiX === null) return Math.round(achievedPpiY as number);
  if (achievedPpiY === null) return Math.round(achievedPpiX);
  return Math.round((achievedPpiX + achievedPpiY) / 2);
}
