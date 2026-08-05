import {
  nextPhaseAfterUserReply,
  promptForPhase,
} from "@/lib/domain/conversation";
import type { ConversationPhase } from "@/lib/domain/types";
import type {
  BriefEvaluation,
  IntelligenceAssessment,
  InterviewAct,
} from "@/capabilities/shared/contracts";

export interface InterviewIntelligenceInput {
  phase: ConversationPhase;
  /**
   * Sprint 2E: Interview Intelligence no longer inspects the Design Brief
   * directly for completeness — it consumes Brief Evaluation and Design
   * Intelligence instead. Neither input drives branching yet; this sprint
   * only redirects the dependency. Adaptive interviewing (asking "what is
   * the highest-value next conversational action based on the evaluation?")
   * is scoped to a future sprint.
   */
  evaluation: BriefEvaluation;
  assessment: IntelligenceAssessment;
}

/**
 * Selects the next conversational act.
 * Consumes Brief Evaluation and Design Intelligence; produces conversation
 * actions. Does not mutate briefs or generate concepts itself.
 */
export interface InterviewIntelligenceCapability {
  selectNextAct(input: InterviewIntelligenceInput): InterviewAct;
}

/**
 * Sprint 1 bridge: linear phase machine for the four scripted questions.
 *
 * Sprint 2D change: when the scripted interview reaches its end (after
 * ask_text), this returns a `summarize` act instead of triggering concept
 * generation. ConversationCapability is responsible for asking
 * DesignSummaryCapability to build and present the actual summary — this
 * capability only decides *when* to summarize, never *what* the summary says.
 *
 * Sprint 2E: behavior is intentionally unchanged — still driven by `phase`
 * alone. `evaluation` and `assessment` are threaded through so the
 * dependency exists ahead of adaptive interviewing, not used for branching.
 */
export function createInterviewIntelligenceCapability(): InterviewIntelligenceCapability {
  return {
    selectNextAct({ phase }) {
      if (phase === "ask_text") {
        return {
          type: "summarize",
          nextPhase: "awaiting_summary_confirmation",
        };
      }

      const nextPhase = nextPhaseAfterUserReply(phase);
      if (!nextPhase) {
        return { type: "await_customer" };
      }

      return {
        type: "ask",
        nextPhase,
        message: promptForPhase(nextPhase) ?? undefined,
      };
    },
  };
}
