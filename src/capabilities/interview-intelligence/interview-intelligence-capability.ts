import {
  HIGH_VALUE_TIE_BREAK,
  REQUIRED_TIE_BREAK,
} from "@/capabilities/shared/interview-coverage-policy";
import {
  contradictionMessage,
  questionForAmbiguousSection,
  questionForMissingSection,
} from "@/capabilities/shared/question-phrasing";
import type {
  BriefEvaluation,
  BriefSectionEvaluation,
  BriefSectionKey,
  IntelligenceAssessment,
  InterviewAct,
  InterviewContext,
  RevisionImpact,
} from "@/capabilities/shared/contracts";

export interface InterviewIntelligenceInput {
  evaluation: BriefEvaluation;
  assessment: IntelligenceAssessment;
  context: InterviewContext;
}

export interface RevisionActInput {
  evaluation: BriefEvaluation;
  assessment: IntelligenceAssessment;
  impact: RevisionImpact;
  context: InterviewContext;
}

/**
 * Selects the next conversational act (Sprint 2F: the authoritative,
 * adaptive next-act selector — replaces the fixed phase ladder).
 *
 * Consumes `BriefEvaluation` and `IntelligenceAssessment` only. It never
 * inspects the Design Brief directly for completeness, never mutates the
 * brief, and never generates concepts.
 *
 * Deterministic priority order:
 *   1. Blocking contradictions               → clarify
 *   2. Missing required sections              → ask
 *   3. Ambiguous required sections             → clarify
 *   4. High-severity production concerns       → advise  (wiring only —
 *      ProductIntelligence has no rule packs yet, so this never fires today)
 *   5. Missing / ambiguous high-value sections → ask / clarify
 *   6. Remaining non-blocking advisories        → advise
 *   7. Design Summary                          → summarize
 *
 * Optional sections never gate progress and are never proactively asked —
 * "do not let optional polish prevent summary indefinitely."
 */
export interface InterviewIntelligenceCapability {
  selectNextAct(input: InterviewIntelligenceInput): InterviewAct;
  /**
   * Sprint 2G Part 2: a narrower selector for a post-approval revision.
   * Unlike `selectNextAct`, it never asks about a section the revision
   * didn't touch and never summarizes (the approval gate has already
   * passed) — "never restart the interview, never ask questions that have
   * already been answered unless the revision invalidates them." Only
   * reacts to what `impact.changedSections` actually changed:
   *   1. A blocking contradiction touching a changed section → clarify
   *   2. A changed section that's now ambiguous                → clarify
   *   3. A new, undismissed advisory tied to a changed section  → advise
   *   4. Otherwise                                              → await_customer
   *      (the caller acknowledges the change and, if warranted, asks
   *      about concept regeneration — neither is this capability's job)
   */
  selectRevisionAct(input: RevisionActInput): InterviewAct;
}

export function createInterviewIntelligenceCapability(): InterviewIntelligenceCapability {
  return {
    selectNextAct({ evaluation, assessment, context }) {
      const bySection = (key: BriefSectionKey): BriefSectionEvaluation | undefined =>
        evaluation.sections.find((s) => s.section === key);
      const wasAsked = (key: BriefSectionKey) => (context.askCounts[key] ?? 0) > 0;

      const blockingContradiction = evaluation.contradictions.find(
        (c) => c.severity === "blocking",
      );
      if (blockingContradiction) {
        const section = blockingContradiction.sections[0] ?? "product";
        return {
          type: "clarify",
          section,
          message: contradictionMessage(blockingContradiction),
        };
      }

      for (const key of REQUIRED_TIE_BREAK) {
        if (bySection(key)?.resolution === "unknown") {
          return {
            type: "ask",
            section: key,
            message: questionForMissingSection(key, { retry: wasAsked(key) }),
          };
        }
      }

      for (const key of REQUIRED_TIE_BREAK) {
        if (bySection(key)?.ambiguous) {
          return {
            type: "clarify",
            section: key,
            message: questionForAmbiguousSection(key, { retry: wasAsked(key) }),
          };
        }
      }

      const productionAdvisory = assessment.recommendations.find(
        (r) =>
          r.kind === "production" &&
          r.severity === "warning" &&
          !context.dismissedAdvisories.includes(r.id),
      );
      if (productionAdvisory) {
        return {
          type: "advise",
          findingId: productionAdvisory.id,
          message: productionAdvisory.message,
          followUpSection: productionAdvisory.followUpSection,
        };
      }

      for (const key of HIGH_VALUE_TIE_BREAK) {
        if (bySection(key)?.resolution === "unknown") {
          return {
            type: "ask",
            section: key,
            message: questionForMissingSection(key, { retry: wasAsked(key) }),
          };
        }
      }

      for (const key of HIGH_VALUE_TIE_BREAK) {
        if (bySection(key)?.ambiguous) {
          return {
            type: "clarify",
            section: key,
            message: questionForAmbiguousSection(key, { retry: wasAsked(key) }),
          };
        }
      }

      const otherAdvisory = assessment.recommendations.find(
        (r) => r.kind !== "production" && !context.dismissedAdvisories.includes(r.id),
      );
      if (otherAdvisory) {
        return {
          type: "advise",
          findingId: otherAdvisory.id,
          message: otherAdvisory.message,
          followUpSection: otherAdvisory.followUpSection,
        };
      }

      if (evaluation.summaryReadiness.ready) {
        return { type: "summarize" };
      }

      // Defensive fallback — unreachable in practice: the coverage policy
      // always has a required or high-value gap to ask/clarify until
      // summaryReadiness.ready is true.
      return { type: "await_customer" };
    },

    selectRevisionAct({ evaluation, assessment, impact, context }) {
      if (impact.isNoOp) return { type: "await_customer" };

      const changed = new Set(impact.changedSections);
      const bySection = (key: BriefSectionKey): BriefSectionEvaluation | undefined =>
        evaluation.sections.find((s) => s.section === key);

      const blockingContradiction = evaluation.contradictions.find(
        (c) => c.severity === "blocking" && c.sections.some((s) => changed.has(s)),
      );
      if (blockingContradiction) {
        const section =
          blockingContradiction.sections.find((s) => changed.has(s)) ??
          impact.changedSections[0] ??
          "product";
        return {
          type: "clarify",
          section,
          message: contradictionMessage(blockingContradiction),
        };
      }

      for (const section of impact.changedSections) {
        if (bySection(section)?.ambiguous) {
          return {
            type: "clarify",
            section,
            message: questionForAmbiguousSection(section),
          };
        }
      }

      const advisory = assessment.recommendations.find(
        (r) =>
          !context.dismissedAdvisories.includes(r.id) &&
          (!r.followUpSection || changed.has(r.followUpSection)),
      );
      if (advisory) {
        return {
          type: "advise",
          findingId: advisory.id,
          message: advisory.message,
          followUpSection: advisory.followUpSection,
        };
      }

      // The revision was unambiguous and raised nothing new — continue
      // naturally. The caller decides what (if anything) to say next.
      return { type: "await_customer" };
    },
  };
}
