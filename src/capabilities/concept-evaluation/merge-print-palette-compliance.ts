/**
 * Phase 2B — Merge deterministic print-palette compliance into a provider
 * evaluation result WITHOUT changing concept lifecycle.
 *
 * Precedence:
 *   deterministic hard FAIL  →  color_palette criterion forced to failed
 *                               (vision cannot reverse it)
 *   overall status / passed  →  left unchanged in Phase 2B
 *                               (Phase 2C decides rejection / regeneration)
 */

import type { ConceptEvaluation } from "@/lib/domain/types";

import type { ConceptEvaluationResult } from "./contracts";
import type { PrintPaletteComplianceResult } from "./print-palette-compliance";

const DETERMINISTIC_FAIL_WARNING =
  "Deterministic print-palette / garment-contrast check failed; concept retained pending Phase 2C policy.";

export function mergePrintPaletteCompliance(
  result: ConceptEvaluationResult,
  compliance: PrintPaletteComplianceResult,
): ConceptEvaluationResult {
  const criteria = result.criteria.map((c) => {
    if (c.key !== "color_palette") return c;
    if (
      compliance.metrics.enforcement === "hard" &&
      compliance.status === "fail"
    ) {
      return {
        ...c,
        passed: false,
        score: Math.min(c.score ?? 40, 40),
        confidence: Math.max(c.confidence, 90),
        notes: `deterministic_print_palette_fail:${compliance.reasons.join(",")}`,
      };
    }
    if (
      compliance.metrics.enforcement === "hard" &&
      compliance.status === "warn" &&
      c.passed === true
    ) {
      // Vision said OK; keep passed but annotate the deterministic WARN.
      return {
        ...c,
        notes: `deterministic_print_palette_warn:${compliance.reasons.join(",")}${
          c.notes ? `;${c.notes}` : ""
        }`,
      };
    }
    return c;
  });

  const warnings = [...result.warnings];
  if (
    compliance.status === "fail" &&
    compliance.metrics.enforcement === "hard" &&
    !warnings.includes(DETERMINISTIC_FAIL_WARNING)
  ) {
    warnings.push(DETERMINISTIC_FAIL_WARNING);
  }

  return {
    ...result,
    criteria,
    warnings,
    printPaletteCompliance: compliance,
  };
}

/** Persistable evaluation may carry the Phase 2B compliance payload. */
export type ConceptEvaluationWithPaletteCompliance = ConceptEvaluation & {
  printPaletteCompliance?: PrintPaletteComplianceResult | null;
};
