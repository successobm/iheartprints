import type { TShirtDesignBrief } from "@/lib/domain/types";
import type { ProductIntelligenceCapability } from "@/capabilities/product-intelligence";
import { suggestContrastingColor } from "@/capabilities/shared/color-families";
import { contradictionMessage } from "@/capabilities/shared/question-phrasing";
import type {
  BriefConflict,
  BriefEvaluation,
  DesignRecommendation,
  IntelligenceAssessment,
  RecommendationAction,
  RevisionImpact,
  SectionConfidence,
  SectionEvaluation,
} from "@/capabilities/shared/contracts";

/**
 * Design Intelligence (Sprint 2E: consumes BriefEvaluation instead of
 * recomputing it; Sprint 2F: turns non-blocking contradictions into real,
 * thin recommendation objects; Sprint 2G Part 2: consumes RevisionImpact to
 * run only the affected Product Intelligence rule packs).
 *
 * Focuses on what remains its job after Sprint 2E moved objective
 * evaluation out: design quality, production reasoning, and preparing
 * recommendation objects. Still never asks questions and never generates
 * concepts — Interview Intelligence decides whether/when to surface a
 * recommendation as an "advise" act.
 */
export interface DesignIntelligenceCapability {
  /**
   * Evaluate the working brief. Never asks questions. Never generates
   * concepts. Takes the raw brief only for production-intelligence
   * reasoning (garment, placement, method) — completeness/confidence/
   * ambiguity/contradictions come from the supplied BriefEvaluation.
   *
   * `impact`, when supplied, scopes Product Intelligence to only the rule
   * packs `impact.affectedRulePacks` names — "do not recompute everything,
   * only evaluate affected reasoning." Omitted (e.g. no prior brief to
   * diff against yet) means every rule pack runs, which is also correct:
   * BriefEvaluation itself is always fully recomputed regardless — it is
   * cheap and needs the whole brief to determine section resolution
   * either way, so selective evaluation applies only to Product
   * Intelligence's rule packs, per this sprint's Rule Pack Runner.
   */
  assess(
    brief: TShirtDesignBrief,
    evaluation: BriefEvaluation,
    impact?: RevisionImpact,
  ): IntelligenceAssessment;
}

export function createDesignIntelligenceCapability(
  productIntelligence: ProductIntelligenceCapability,
): DesignIntelligenceCapability {
  return {
    assess(brief, evaluation, impact) {
      const productionFindings = productIntelligence.evaluateBrief(
        brief,
        impact?.affectedRulePacks,
      );
      const productionRecommendations: DesignRecommendation[] = productionFindings.map(
        (finding) => ({
          id: `production:${finding.code}`,
          kind: "production" as const,
          message: finding.plainLanguage,
          // DesignRecommendation only distinguishes info/warning — both
          // ProductionFinding's "warning" and "blocking" map to "warning"
          // here (still soft, dismissible advice; see this capability's
          // module doc). "info" findings stay "info" and are never
          // surfaced as an Interview Intelligence "advise" act.
          severity: finding.severity === "info" ? "info" : "warning",
          followUpSection: followUpSectionForProductionCode(finding.code),
          actions: finding.severity === "info" ? undefined : GENERIC_ACTIONS,
        }),
      );

      // Blocking contradictions become an Interview Intelligence "clarify"
      // act directly from `evaluation.contradictions` — surfacing them here
      // too would be a second, redundant channel for the same issue.
      const contradictionRecommendations: DesignRecommendation[] = evaluation.contradictions
        .filter((conflict) => conflict.severity !== "blocking")
        .map((conflict) => ({
          id: `contradiction:${conflict.code ?? conflict.sections.join(",")}`,
          kind: recommendationKindForCode(conflict.code),
          message: contradictionMessage(conflict),
          severity: "warning" as const,
          followUpSection: conflict.sections[0],
          actions: actionsForConflict(conflict, brief),
        }));

      return {
        sections: toSectionEvaluations(evaluation),
        ambiguities: evaluation.ambiguities,
        conflicts: evaluation.contradictions,
        recommendations: [...productionRecommendations, ...contradictionRecommendations],
        readiness: evaluation.approvalReadiness.ready
          ? "ready_to_request_approval"
          : evaluation.summaryReadiness.ready
            ? "ready_to_summarize"
            : "continue_interview",
        overallConfidence: numericToSectionConfidence(evaluation.overall.confidence),
      };
    },
  };
}

function followUpSectionForProductionCode(
  code: string,
): DesignRecommendation["followUpSection"] {
  switch (code) {
    case "small_placement_long_wording":
    case "full_placement_wall_of_text":
      return "requiredWording";
    case "small_placement_dense_graphics":
      return "graphics";
    default:
      return undefined;
  }
}

/**
 * Sprint 2G Part 3: recommendation cards always offer a safe, non-presumptuous
 * way out — "customers remain in control." Both a plain "keep" and an
 * explicit "dismiss" are offered since they read differently to a customer
 * (one affirms the current choice, the other just moves on) even though
 * this system currently treats them the same way once clicked.
 */
const DISMISS_ACTION: RecommendationAction = {
  label: "Dismiss",
  kind: "dismiss",
  replyText: "No changes for now, keep going.",
};
const KEEP_ACTION: RecommendationAction = {
  label: "Keep as-is",
  kind: "keep",
  replyText: "Keep it as-is for now.",
};
const GENERIC_ACTIONS: RecommendationAction[] = [KEEP_ACTION, DISMISS_ACTION];

function actionsForConflict(
  conflict: BriefConflict,
  brief: TShirtDesignBrief,
): RecommendationAction[] {
  if (conflict.code === "color_clash" && brief.shirtColor) {
    const current = brief.shirtColor;
    const suggested = suggestContrastingColor(current);
    return [
      {
        label: `Use ${capitalize(suggested)}`,
        kind: "apply",
        replyText: `Use ${suggested} instead of ${current} for the design colors.`,
      },
      {
        label: `Keep ${capitalize(current)}`,
        kind: "keep",
        replyText: `Keep it as ${current} — that's fine.`,
      },
      DISMISS_ACTION,
    ];
  }
  return GENERIC_ACTIONS;
}

function capitalize(value: string): string {
  return value.length > 0 ? value[0]!.toUpperCase() + value.slice(1) : value;
}

function recommendationKindForCode(code?: string): DesignRecommendation["kind"] {
  switch (code) {
    case "color_clash":
      return "color";
    case "minimalist_wording_clash":
      return "typography";
    case "minimalist_graphics_clash":
      return "layout";
    default:
      return "general";
  }
}

function toSectionEvaluations(evaluation: BriefEvaluation): SectionEvaluation[] {
  return evaluation.sections.map((section) => ({
    section: section.section,
    present: section.known,
    confidence: numericToSectionConfidence(section.confidence),
  }));
}

/**
 * Buckets BriefEvaluation's 0-100 numeric confidence into the coarser
 * SectionConfidence enum other capabilities already expect. "confirmed" is
 * reserved for post-approval confirmation elsewhere and is never produced
 * here.
 */
function numericToSectionConfidence(confidence: number): SectionConfidence {
  if (confidence <= 0) return "none";
  if (confidence < 50) return "low";
  if (confidence < 80) return "medium";
  return "high";
}
