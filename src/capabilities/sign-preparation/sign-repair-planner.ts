/**
 * Signs Phase S1: the repair PLANNER. Formulates — and never executes — the
 * least-destructive ordered operations that would make the supplied artwork
 * printable at the ordered substrate size (Constitution §16A.3).
 *
 * The decision hierarchy, least destructive first:
 *
 *   1. nothing / proportional resampling only
 *   2. deterministic uniform-background extension (auto only on affirmative
 *      per-edge evidence)
 *   3. bounded provider reconstruction (refused pre-plan when even the
 *      admitted ceiling cannot reach the blocking minimum)
 *   4. anything touching content — approved_crop, seams over foreground,
 *      opacity decisions — is review or human territory, never automatic.
 *
 * Risk discipline: AUTO_SAFE requires proof; uncertainty NEVER downgrades
 * to safe. Fill/crop is never selected automatically (any non-zero crop may
 * remove meaningful content until a human approves an exact preview).
 */

import type {
  SignDefect,
  SignEdge,
  SignEdgeEvidence,
  SignInspectionReport,
  SignPlanningResult,
  SignProductionSpec,
  SignRepairPlan,
  SignRepairStep,
  SignRiskClass,
} from "./contracts";
import { SIGN_REPAIR_PLAN_SCHEMA_VERSION } from "./contracts";
import { diagnoseInspection } from "./sign-diagnosis";
import { computeSignPlanKey } from "./sign-plan-identity";
import {
  containPlacement,
  SIGN_ASPECT_TOLERANCE,
  SIGN_PPI_TOLERANCE,
} from "./sign-inspection";
import type { SignResolutionPolicy } from "./resolution-policy";
import {
  SIGN_RECONSTRUCTION_HEADROOM,
  SIGN_RECONSTRUCTION_SCALE_CEILING,
} from "./resolution-policy";

export interface SignPlanningInput {
  spec: SignProductionSpec;
  policy: SignResolutionPolicy;
  inspection: SignInspectionReport;
  sourceAssetId: string;
  sourceSha256: string;
}

const RISK_ORDER: Record<SignRiskClass, number> = {
  auto_safe: 0,
  review_required: 1,
  blocked: 2,
};

function maxRisk(a: SignRiskClass, b: SignRiskClass): SignRiskClass {
  return RISK_ORDER[a] >= RISK_ORDER[b] ? a : b;
}

function edgeByName(
  edges: SignEdgeEvidence[],
  edge: SignEdge,
): SignEdgeEvidence {
  const found = edges.find((item) => item.edge === edge);
  if (!found) throw new Error(`missing edge evidence for ${edge}`);
  return found;
}

/**
 * Formulates the V1 plan. Precondition: `input.spec` is a CONFIRMED spec and
 * `input.inspection` was produced under it (ordered/contain/resolution
 * non-null) — the capability enforces fail-closed spec resolution before
 * ever calling this.
 */
export function planSignRepair(input: SignPlanningInput): SignPlanningResult {
  const { spec, policy, inspection } = input;
  const defects: SignDefect[] = diagnoseInspection(inspection);
  const reasons: string[] = [];
  const steps: SignRepairStep[] = [];

  const resolution = inspection.resolution;
  const containNow = inspection.placements.contain;
  if (!resolution || !containNow || !inspection.ordered) {
    // Structurally unreachable via the capability; refuse rather than guess.
    defects.push({
      code: "unsupported_input",
      severity: "blocking",
      detail: "Inspection lacks spec-dependent geometry; cannot plan.",
    });
    return { status: "blocked", plan: null, defects };
  }

  // ---------------------------------------------------------------------
  // Optional rotate_90 — only when the direct aspect mismatches but a 90°
  // rotation lands inside tolerance. Lossless, but it changes viewing
  // intent, so it is never automatic.
  // ---------------------------------------------------------------------
  let srcW = inspection.source.widthPx;
  let srcH = inspection.source.heightPx;
  let rotated = false;
  if (
    inspection.aspectMismatch === true &&
    inspection.orientation.rotatedAspectMatches === true
  ) {
    steps.push({
      kind: "rotate_90",
      params: { direction: "cw" },
      risk: "review_required",
      reasons: [
        "A 90° rotation brings the source aspect within tolerance of the ordered aspect, but rotation changes viewing intent — a human must confirm it.",
      ],
    });
    [srcW, srcH] = [srcH, srcW];
    rotated = true;
  }

  const contain = containPlacement(
    srcW,
    srcH,
    spec.orderedWidthIn,
    spec.orderedHeightIn,
  );
  const effectivePpi = contain.effectivePpi;
  const orderedAspect = spec.orderedWidthIn / spec.orderedHeightIn;

  // ---------------------------------------------------------------------
  // Bounded-reconstruction gate (Constitution §16A.3), measured on the
  // planning geometry (post-rotation): if even the admitted ceiling cannot
  // reach the blocking minimum, no admitted repair exists — refuse before
  // formulating anything, and long before any provider could be dispatched
  // (S2's pre-dispatch refusal re-checks the same bound).
  // ---------------------------------------------------------------------
  const maxAchievablePpi = effectivePpi * SIGN_RECONSTRUCTION_SCALE_CEILING;
  if (maxAchievablePpi + SIGN_PPI_TOLERANCE < policy.minPpi) {
    defects.push({
      code: "reconstruction_exceeds_supported_scale",
      severity: "blocking",
      detail:
        `Reaching the ${policy.minPpi} PPI blocking minimum needs ` +
        `${(policy.minPpi / effectivePpi).toFixed(2)}×, beyond the admitted ` +
        `${SIGN_RECONSTRUCTION_SCALE_CEILING}× reconstruction ceiling ` +
        `(maximum achievable ≈ ${maxAchievablePpi.toFixed(1)} PPI). ` +
        "The honest remedies are a smaller ordered size or a better source file.",
    });
    return { status: "blocked", plan: null, defects };
  }

  // ---------------------------------------------------------------------
  // Resolution stage: reconstruct (bounded) when short of target; downsample
  // when meaningfully oversized; otherwise keep native pixels untouched.
  // Enlarged pixels are never claimed as native detail — the plan records
  // the requested scale, and S4/authoritative validation judge provenance.
  // ---------------------------------------------------------------------
  let contentW = srcW;
  let contentH = srcH;
  if (effectivePpi + SIGN_PPI_TOLERANCE >= policy.targetPpi) {
    const targetContentW = Math.round(contain.artworkWidthIn * policy.targetPpi);
    const targetContentH = Math.round(contain.artworkHeightIn * policy.targetPpi);
    if (contentW > Math.round(targetContentW * 1.005)) {
      steps.push({
        kind: "downsample",
        params: { targetWidthPx: targetContentW, targetHeightPx: targetContentH },
        risk: "auto_safe",
        reasons: [
          `Source provides ${effectivePpi.toFixed(1)} PPI, above the ${policy.targetPpi} PPI target; a proportional downsample is deterministic and information-preserving for print.`,
        ],
      });
      contentW = targetContentW;
      contentH = targetContentH;
      reasons.push("Oversized source downsampled to the policy target.");
    } else {
      reasons.push(
        `Source already provides ${effectivePpi.toFixed(1)} PPI at the contain placement — no resolution work needed.`,
      );
    }
  } else {
    const rawScale = policy.targetPpi / effectivePpi;
    let requestedScale = rawScale * SIGN_RECONSTRUCTION_HEADROOM;
    if (requestedScale > SIGN_RECONSTRUCTION_SCALE_CEILING) {
      requestedScale = SIGN_RECONSTRUCTION_SCALE_CEILING;
      reasons.push(
        `The ${policy.targetPpi} PPI target needs ${rawScale.toFixed(2)}×, beyond the admitted ` +
          `${SIGN_RECONSTRUCTION_SCALE_CEILING}× ceiling; planning the maximum admitted reconstruction ` +
          `(blocking minimum ${policy.minPpi} PPI remains reachable).`,
      );
    }
    const requestedWidthPx = Math.round(srcW * requestedScale);
    const requestedHeightPx = Math.round(srcH * requestedScale);
    steps.push({
      kind: "reconstruct_resolution",
      params: { requestedScale, requestedWidthPx, requestedHeightPx },
      risk: "auto_safe",
      reasons: [
        `Truthful effective resolution ${effectivePpi.toFixed(1)} PPI is below the ${policy.targetPpi} PPI target; ` +
          `a bounded provider reconstruction at ${requestedScale.toFixed(4)}× ` +
          `(includes ${SIGN_RECONSTRUCTION_HEADROOM}× headroom) is authorized, cost-controlled, and ` +
          "preservation-verified before any print_ready claim (Constitution §16A.3).",
      ],
    });
    contentW = requestedWidthPx;
    contentH = requestedHeightPx;
  }
  // ---------------------------------------------------------------------
  // Geometry stage: exact-aspect sources need nothing; mismatches are
  // repaired by extending the substrate-defined canvas along the padding
  // axis — reconstruct FIRST, extend SECOND, so the provider only ever sees
  // the customer's pixels and never a synthetic seam.
  // ---------------------------------------------------------------------
  let plateW = contentW;
  let plateH = contentH;
  const aspectMismatchNow =
    Math.abs(srcW / srcH - orderedAspect) / orderedAspect >
    SIGN_ASPECT_TOLERANCE;
  if (aspectMismatchNow) {
    const heightBound = srcW / srcH < orderedAspect;
    let axis: "horizontal" | "vertical";
    let affectedEdges: [SignEdge, SignEdge];
    if (heightBound) {
      plateH = contentH;
      plateW = Math.round(contentH * orderedAspect);
      axis = "horizontal";
      affectedEdges = ["left", "right"];
    } else {
      plateW = contentW;
      plateH = Math.round(contentW / orderedAspect);
      axis = "vertical";
      affectedEdges = ["top", "bottom"];
    }
    const totalPad = axis === "horizontal" ? plateW - contentW : plateH - contentH;
    const leadingPx = Math.floor(totalPad / 2);
    const trailingPx = totalPad - leadingPx;

    const first = edgeByName(inspection.edges, affectedEdges[0]);
    const second = edgeByName(inspection.edges, affectedEdges[1]);
    const bothUniform =
      !rotated &&
      first.classification === "uniform_background" &&
      second.classification === "uniform_background";

    if (bothUniform && first.dominantColor && second.dominantColor) {
      const color = {
        r: Math.round((first.dominantColor.r + second.dominantColor.r) / 2),
        g: Math.round((first.dominantColor.g + second.dominantColor.g) / 2),
        b: Math.round((first.dominantColor.b + second.dominantColor.b) / 2),
      };
      steps.push({
        kind: "extend_uniform_background",
        params: {
          axis,
          leadingPx,
          trailingPx,
          colorR: color.r,
          colorG: color.g,
          colorB: color.b,
        },
        risk: "auto_safe",
        reasons: [
          `Both ${affectedEdges.join("/")} edge bands are affirmatively uniform background ` +
            `(coverage ${first.dominantCoverage.toFixed(4)} / ${second.dominantCoverage.toFixed(4)}); ` +
            "continuing the measured background is deterministic and touches no foreground pixel.",
        ],
      });
    } else {
      const params: Record<string, number | string> = {
        axis,
        leadingPx,
        trailingPx,
      };
      if (first.dominantColor && second.dominantColor) {
        params.colorR = Math.round(
          (first.dominantColor.r + second.dominantColor.r) / 2,
        );
        params.colorG = Math.round(
          (first.dominantColor.g + second.dominantColor.g) / 2,
        );
        params.colorB = Math.round(
          (first.dominantColor.b + second.dominantColor.b) / 2,
        );
      } else {
        params.color = "unconfirmed";
      }
      const seamReasons = affectedEdges
        .map((edge) => {
          const evidence = edgeByName(inspection.edges, edge);
          return `${edge}: ${evidence.classification}`;
        })
        .join("; ");
      steps.push({
        kind: "pad_uniform_background",
        params,
        risk: "review_required",
        reasons: [
          rotated
            ? "Edge evidence was measured pre-rotation; a human must confirm the fill against the rotated artwork."
            : `Extension edges are not provably uniform background (${seamReasons}) — the fill terminates content visibly and a human must approve the seam.`,
        ],
      });
      if (
        !rotated &&
        (first.classification === "foreground_bleed" ||
          second.classification === "foreground_bleed")
      ) {
        defects.push({
          code: "foreground_reaches_extension_edge",
          severity: "review",
          detail:
            `Foreground provably reaches the ${affectedEdges
              .filter(
                (edge) =>
                  edgeByName(inspection.edges, edge).classification ===
                  "foreground_bleed",
              )
              .join(" and ")} edge band(s); extending there creates a visible termination seam.`,
        });
      }
    }
  }

  // ---------------------------------------------------------------------
  // Aggregate risk. Review-severity defects (e.g. transparency_present)
  // escalate the whole plan; uncertainty never downgrades to safe.
  // ---------------------------------------------------------------------
  let overallRisk: SignRiskClass = "auto_safe";
  for (const step of steps) overallRisk = maxRisk(overallRisk, step.risk);
  for (const defect of defects) {
    if (defect.severity === "review") {
      overallRisk = maxRisk(overallRisk, "review_required");
    }
  }
  if (
    overallRisk === "review_required" &&
    !defects.some((defect) => defect.code === "repair_requires_review")
  ) {
    defects.push({
      code: "repair_requires_review",
      severity: "review",
      detail:
        "The formulated plan is mechanically executable but requires human judgment before execution.",
    });
  }

  const expectedEffectivePpi = plateH / spec.orderedHeightIn;

  const planWithoutKey: Omit<SignRepairPlan, "planKey"> = {
    schemaVersion: SIGN_REPAIR_PLAN_SCHEMA_VERSION,
    policyId: policy.id,
    sourceAssetId: input.sourceAssetId,
    sourceSha256: input.sourceSha256,
    sourceWidthPx: inspection.source.widthPx,
    sourceHeightPx: inspection.source.heightPx,
    orderedWidthIn: spec.orderedWidthIn,
    orderedHeightIn: spec.orderedHeightIn,
    steps,
    expectedOutputWidthPx: plateW,
    expectedOutputHeightPx: plateH,
    expectedEffectivePpi,
    overallRisk,
    defects: defects.map((defect) => defect.code),
    reasons,
  };

  const planKey = computeSignPlanKey(planWithoutKey);
  return {
    status: "planned",
    plan: { ...planWithoutKey, planKey },
    defects,
  };
}
