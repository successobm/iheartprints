import type { TShirtDesignBrief } from "@/lib/domain/types";
import type { ProductIntelligenceCapability } from "@/capabilities/product-intelligence";
import type {
  BriefEvaluation,
  IntelligenceAssessment,
  SectionConfidence,
  SectionEvaluation,
} from "@/capabilities/shared/contracts";

/**
 * Design Intelligence (Sprint 2E).
 *
 * Sprint 2E moved objective evaluation (known/missing/ambiguity/
 * contradictions/confidence) out of this capability and into
 * BriefEvaluationCapability. Design Intelligence now consumes that
 * evaluation rather than recomputing it, and focuses on what remains its
 * job: design quality, production reasoning, and recommendation objects.
 * It still never asks questions and never generates concepts.
 */
export interface DesignIntelligenceCapability {
  /**
   * Evaluate the working brief. Never asks questions. Never generates concepts.
   * Takes the raw brief only for production-intelligence reasoning
   * (garment, placement, method) — completeness/confidence/ambiguity come
   * from the supplied BriefEvaluation, not recomputed here.
   */
  assess(
    brief: TShirtDesignBrief,
    evaluation: BriefEvaluation,
  ): IntelligenceAssessment;
}

/**
 * Sprint 2C produced a neutral assessment so the call path exists. Sprint 2E
 * makes it a thin consumer of BriefEvaluation: readiness still ignores the
 * evaluation for now (Interview Intelligence still follows the Sprint 1
 * linear script) — that wiring is scoped to a future sprint.
 */
export function createDesignIntelligenceCapability(
  productIntelligence: ProductIntelligenceCapability,
): DesignIntelligenceCapability {
  return {
    assess(brief, evaluation) {
      const productionFindings = productIntelligence.evaluateBrief(brief);

      return {
        sections: toSectionEvaluations(evaluation),
        ambiguities: evaluation.ambiguities,
        conflicts: evaluation.contradictions,
        recommendations: productionFindings.map((finding) => ({
          kind: "production" as const,
          message: finding.plainLanguage,
          severity: finding.severity === "blocking" ? "warning" : "info",
        })),
        // Sprint 1/2D do not gate on readiness — keep continue_interview
        // always. evaluation.summaryReadiness / approvalReadiness carry the
        // real signal for a future adaptive-interview sprint.
        readiness: "continue_interview",
        overallConfidence: numericToSectionConfidence(evaluation.overall.confidence),
      };
    },
  };
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
