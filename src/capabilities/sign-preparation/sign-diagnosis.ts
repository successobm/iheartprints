/**
 * Signs Phase S1: DIAGNOSIS — explicit, bounded-vocabulary defects derived
 * from the inspection OBSERVATIONS. Conclusions live here as data, never
 * buried in UI prose.
 *
 * Severity semantics (deliberately about AUTOMATIC repair, not aesthetics):
 *
 *   blocking — planning itself must refuse (missing consent, no applicable
 *              policy, a need outside the admitted reconstruction bounds).
 *   review   — a plan can exist, but a human must judge before execution.
 *   info     — an observation the plan repairs automatically, kept explicit
 *              so the record explains WHY each repair step exists.
 */

import type {
  SignDefect,
  SignInspectionReport,
  SignSpecResolution,
} from "./contracts";

export function diagnoseSpecResolution(
  resolution: SignSpecResolution,
): SignDefect[] {
  if (resolution.status === "confirmed") return [];
  const defects: SignDefect[] = [];
  for (const missing of resolution.missing) {
    switch (missing) {
      case "ordered_width":
        defects.push({
          code: "missing_confirmed_width",
          severity: "blocking",
          detail:
            "No valid human-confirmed ordered width exists. Width is never defaulted or inferred (Constitution §16A.2).",
        });
        break;
      case "ordered_height":
        defects.push({
          code: "missing_confirmed_height",
          severity: "blocking",
          detail:
            "No valid human-confirmed ordered height exists. Height is never defaulted or inferred (Constitution §16A.2).",
        });
        break;
      case "confirmation":
        defects.push({
          code: "missing_spec_confirmation",
          severity: "blocking",
          detail:
            "The ordered size was never explicitly confirmed by a human. A default is not a decision.",
        });
        break;
      case "resolution_policy":
        defects.push({
          code: "unsupported_input",
          severity: "blocking",
          detail:
            "No readable rigid-sign resolution policy governs this order; refusing rather than borrowing a figure nobody decided.",
        });
        break;
    }
  }
  return defects;
}

/** Observation-level defects for an inspection performed under a confirmed spec. */
export function diagnoseInspection(
  inspection: SignInspectionReport,
): SignDefect[] {
  const defects: SignDefect[] = [];

  if (inspection.aspectMismatch === true) {
    defects.push({
      code: "aspect_ratio_mismatch",
      severity: "info",
      detail:
        `Source aspect ${inspection.source.aspectRatio.toFixed(4)} vs ordered ` +
        `${inspection.ordered!.aspectRatio.toFixed(4)} ` +
        `(delta ${(inspection.aspectDeltaRatio! * 100).toFixed(2)}%). ` +
        "Stretching is prohibited; geometry repair is required.",
    });
  }

  const res = inspection.resolution;
  if (res) {
    if (res.status === "below_minimum") {
      defects.push({
        code: "resolution_below_minimum",
        severity: "info",
        detail:
          `Truthful effective resolution ${res.containEffectivePpi.toFixed(1)} PPI at the ` +
          `contain placement is below the ${res.minPpi} PPI blocking minimum ` +
          `(target ${res.targetPpi}). Reconstruction is required before production.`,
      });
    } else if (res.status === "below_target") {
      defects.push({
        code: "resolution_below_target",
        severity: "info",
        detail:
          `Truthful effective resolution ${res.containEffectivePpi.toFixed(1)} PPI is below the ` +
          `${res.targetPpi} PPI target (minimum ${res.minPpi}).`,
      });
    }
  }

  if (inspection.transparency.hasAlphaPixels) {
    defects.push({
      code: "transparency_present",
      severity: "review",
      detail:
        `Source carries transparency (${(inspection.transparency.transparentPixelFraction * 100).toFixed(3)}% ` +
        "of pixels below full opacity). Rigid-sign production intent is opaque (§16A.2); " +
        "what the transparent regions should become is a human decision, never a silent flatten.",
    });
  }

  const fill = inspection.placements.fill;
  if (fill && fill.meaningfulContentMayBeAffected) {
    defects.push({
      code: "meaningful_crop_required",
      severity: "info",
      detail:
        `The fill alternative would cut ` +
        `${fill.cropSourcePx.horizontal || fill.cropSourcePx.vertical} source px ` +
        `(${fill.affectedEdges.join("/")}). Never automatic: any non-zero crop is treated as ` +
        "potentially meaningful until a human approves an exact preview.",
    });
  }

  return defects;
}
