import type { ProjectRepository } from "@/lib/db/repository";
import { toDesignBriefSnapshotContent } from "@/lib/domain/brief-snapshot";
import {
  isLegacyScriptedPhase,
  nextPhaseAfterUserReply,
  promptForPhase,
} from "@/lib/domain/conversation";
import type {
  ConversationPhase,
  InterviewStateData,
  ProjectSnapshot,
  TShirtDesignBrief,
} from "@/lib/domain/types";
import type { BriefEvaluationCapability } from "@/capabilities/brief-evaluation";
import type { ConceptGenerationCapability } from "@/capabilities/concept-generation";
import type { ConversationUnderstandingCapability } from "@/capabilities/conversation-understanding";
import type { DesignBriefCapability } from "@/capabilities/design-brief";
import type { DesignIntelligenceCapability } from "@/capabilities/design-intelligence";
import type { DesignSummaryCapability } from "@/capabilities/design-summary";
import type { IntentExtractionCapability } from "@/capabilities/intent-extraction";
import type { InterviewIntelligenceCapability } from "@/capabilities/interview-intelligence";
import type { RevisionIntelligenceCapability } from "@/capabilities/revision-intelligence";
import { ALL_SECTIONS_IN_POLICY_ORDER } from "@/capabilities/shared/interview-coverage-policy";
import {
  acknowledgeResolvedFields,
  acknowledgeRevision,
  conceptRegenerationPrompt,
  describeUndo,
  designerDecisionMessage,
  shortAcknowledgement,
} from "@/capabilities/shared/question-phrasing";
import { traceConversationUnderstanding } from "@/lib/debug/conversation-understanding-trace";
import type {
  BriefSectionKey,
  DesignSummaryView,
  IntelligenceAssessment,
  InterviewAct,
  RevisionImpact,
} from "@/capabilities/shared/contracts";

/** Sprint 2L Phase 1B (Goal 12): "continue" removed — see schema.ts. */
export type DesignBriefDecisionAction = "approve" | "edit";

export interface ConversationCapabilityDeps {
  repo: ProjectRepository;
  intentExtraction: IntentExtractionCapability;
  /**
   * Sprint 2L Phase 1: best-effort semantic interpretation of the customer's
   * message, consumed by `intentExtraction.extract` as an optional hint —
   * see `reconcile-understanding.ts` for precedence. Never mutates the
   * brief itself.
   */
  conversationUnderstanding: ConversationUnderstandingCapability;
  designBrief: DesignBriefCapability;
  briefEvaluation: BriefEvaluationCapability;
  designIntelligence: DesignIntelligenceCapability;
  interviewIntelligence: InterviewIntelligenceCapability;
  revisionIntelligence: RevisionIntelligenceCapability;
  designSummary: DesignSummaryCapability;
  conceptGeneration: ConceptGenerationCapability;
}

/** Phases where free-text chat input is not the expected interaction. */
const CHAT_BLOCKED_PHASES: ConversationPhase[] = [
  "generating",
  "skip_references",
  "concepts_ready",
  "awaiting_summary_confirmation",
  "brief_approved",
];

/** Phases reachable only after at least one approved brief version exists. */
const POST_APPROVAL_PHASES: ConversationPhase[] = [
  "brief_approved",
  "generating",
  "concepts_ready",
  "ask_revisions",
  "revision_received",
];

/** Post-concept revision loop — customer describing changes to an already-approved brief. */
const REVISION_REQUEST_PHASES: ConversationPhase[] = [
  "ask_revisions",
  "revision_received",
];

const KNOWN_SECTIONS = new Set<string>(ALL_SECTIONS_IN_POLICY_ORDER);

/**
 * Sprint 2G Part 3: deterministic natural-language triggers. None of these
 * gate interpretation of the *next* reply the way Sprint 2G Part 2's
 * `awaitingConceptRegenerationConfirmation` did — every reply is always
 * just itself. "If the customer ignores it, continue normally."
 */
const UNDO_PATTERN =
  /^(?:undo|revert)\b|undo (?:that|it|the last (?:change|revision|edit)|shirt color|wording|graphics|colors?|style|placement)|go back to (?:the )?previous(?: version)?/i;
const REGENERATE_REQUEST_PATTERN =
  /\b(regenerate|update the concepts|new concepts|updated concepts|refresh the concepts|generate updated concepts)\b/i;
const KEEP_CONCEPTS_PATTERN =
  /\bkeep (?:the )?(?:current|existing) concepts\b|\bleave (?:them|the concepts)(?: as (?:is|they are))?\b/i;

/**
 * Owns conversation lifecycle, messages, state, and orchestration.
 * Must NOT own brief mutation logic, generation internals, or product rules.
 *
 * Sprint 2D: the interview no longer generates concepts on its own — it
 * hands off to a Design Summary confirmation gate; only an explicit
 * customer Approve decision may trigger concept generation.
 *
 * Sprint 2F: pre-approval turns run through an adaptive pipeline
 * (Intent Extraction → Design Brief → Brief Evaluation → Design
 * Intelligence → Interview Intelligence → best next act) instead of a
 * fixed phase ladder. The old ladder is preserved verbatim for historical
 * projects still mid-flow in an `ask_*` phase.
 *
 * Sprint 2G Part 2: the post-concept revision loop is adaptive too —
 * Revision Intelligence scopes what actually needs re-evaluating and
 * whether existing concepts are now stale.
 *
 * Sprint 2G Part 3: that intelligence becomes visible and actionable —
 * updated-field transitions and deferred decisions ride along with the
 * Design Summary; a "Designer Decision" note accompanies any explicit
 * deferral; concept staleness is a persistent, non-interrupting action
 * (`regenerateConcepts`) rather than a one-shot yes/no gate; and one level
 * of undo (`undoLastChange`) is available for the most recently accepted
 * revision.
 */
export interface ConversationCapability {
  start(): Promise<ProjectSnapshot>;
  get(designId: string): Promise<ProjectSnapshot | null>;
  handleUserMessage(
    designId: string,
    content: string,
  ): Promise<ProjectSnapshot>;
  selectConcept(
    designId: string,
    artworkVersionId: string,
  ): Promise<ProjectSnapshot>;
  /** Approve / Edit / Continue in response to a presented Design Summary. */
  submitDesignBriefDecision(
    designId: string,
    action: DesignBriefDecisionAction,
  ): Promise<ProjectSnapshot>;
  /** Explicit action behind the persistent "Generate Updated Concepts" control. */
  regenerateConcepts(designId: string): Promise<ProjectSnapshot>;
  /** Explicit action behind an "Undo" control — undoes the most recent accepted revision, if any. */
  undoLastChange(designId: string): Promise<ProjectSnapshot>;
}

export function createConversationCapability(
  deps: ConversationCapabilityDeps,
): ConversationCapability {
  const {
    repo,
    intentExtraction,
    conversationUnderstanding,
    designBrief,
    briefEvaluation,
    designIntelligence,
    interviewIntelligence,
    revisionIntelligence,
    designSummary,
    conceptGeneration,
  } = deps;

  /**
   * Sprint 2L Phase 1: builds the bounded, provider-neutral interpretation
   * of `reply` in context — never the raw brief, ids, or full history (see
   * `ConversationUnderstandingCapability`'s own bounding/sanitization).
   * Never throws (the capability itself degrades to
   * `EMPTY_UNDERSTANDING_RESULT` on any provider failure — Goal 10).
   */
  async function interpretReply(
    snapshot: ProjectSnapshot,
    brief: TShirtDesignBrief,
    pendingSection: BriefSectionKey | null,
    reply: string,
  ) {
    const evaluation = briefEvaluation.evaluate(brief);
    const knownBrief = designSummary.createSummary(brief, evaluation);
    const unresolvedSections = evaluation.sections
      .filter((s) => s.resolution === "unknown")
      .map((s) => s.section);
    return conversationUnderstanding.interpret({
      message: reply,
      knownBrief,
      unresolvedSections,
      pendingSection,
      recentMessages: snapshot.messages,
    });
  }

  /**
   * Takes the (already-fetched, post-mutation) brief and interview state
   * directly rather than re-reading them — every caller already has both
   * in hand by the time it's ready to summarize, and each avoided read
   * matters here: a full adaptive interview does many more small
   * read-modify-write turns than the old four-question ladder did.
   *
   * `updatedSections` and `previousBrief`, when given, produce
   * `fieldTransitions` (old → new values, Sprint 2G Part 3) attached to
   * the message metadata so the UI can highlight what changed without any
   * internal detail beyond the section keys and their own displayed
   * values. `deferredDecisions` always accompanies the summary as its own
   * section — never blank, never phrased as missing.
   */
  async function presentDesignSummary(
    designId: string,
    brief: TShirtDesignBrief,
    interviewState: InterviewStateData | null,
    options: {
      previousBrief?: TShirtDesignBrief;
      updatedSections?: BriefSectionKey[];
    } = {},
  ): Promise<void> {
    const updatedSections = options.updatedSections ?? [];
    const evaluation = briefEvaluation.evaluate(brief);
    const summary = designSummary.createSummary(brief, evaluation);
    const deferredDecisions = designSummary.listDeferredDecisions(evaluation);
    const content = designSummary.formatForCustomer(summary, deferredDecisions);

    const fieldTransitions = options.previousBrief
      ? buildFieldTransitions(
          designSummary.createSummary(
            options.previousBrief,
            briefEvaluation.evaluate(options.previousBrief),
          ),
          summary,
          updatedSections,
        )
      : {};

    await repo.updateConversationPhase(designId, "awaiting_summary_confirmation");
    if (interviewState) {
      await repo.updateConversationInterviewState(designId, {
        ...interviewState,
        pendingSection: null,
      });
    }
    await repo.addMessage(designId, {
      role: "assistant",
      content,
      metadata: {
        phase: "awaiting_summary_confirmation",
        summary,
        deferredDecisions,
        updatedSections,
        fieldTransitions,
      },
    });
  }

  async function approveAndGenerate(designId: string): Promise<ProjectSnapshot> {
    const version = await designBrief.approveWorkingBrief(designId);

    // Approval is a checkpoint: undo is scoped to "the most recent
    // accepted revision" of the post-approval revision phase, not
    // leftover state from resolving the interview itself (e.g. a final
    // deferral just before summarizing).
    const beforeApproval = await repo.getProject(designId);
    if (beforeApproval?.conversation.interviewState.lastRevision) {
      await repo.updateConversationInterviewState(designId, {
        ...beforeApproval.conversation.interviewState,
        lastRevision: null,
      });
    }

    await repo.updateConversationPhase(designId, "brief_approved");
    await repo.setProjectStatus(designId, "approved");
    await repo.addMessage(designId, {
      role: "assistant",
      content:
        "Thanks — I've approved this design brief and I'm creating three concept directions.",
      metadata: { phase: "brief_approved" },
    });

    return conceptGeneration.generatePlaceholders(designId, version.id);
  }

  /** Re-approves the working brief and regenerates concepts against it. */
  async function performRegeneration(
    designId: string,
    state: InterviewStateData,
  ): Promise<ProjectSnapshot> {
    const version = await designBrief.approveWorkingBrief(designId);
    await repo.updateConversationInterviewState(designId, {
      ...state,
      pendingSection: null,
    });
    return conceptGeneration.regenerateAfterRevision(designId, version.id);
  }

  /** Restores the brief to its state before the most recently accepted revision, if any. */
  async function performUndo(
    designId: string,
    current: ProjectSnapshot,
  ): Promise<ProjectSnapshot> {
    const state = current.conversation.interviewState;

    if (!state.lastRevision) {
      await repo.addMessage(designId, {
        role: "assistant",
        content: "There's nothing to undo right now.",
        metadata: { phase: current.conversation.phase, act: "acknowledge" },
      });
      const snapshot = await repo.getProject(designId);
      if (!snapshot) throw new Error("Project not found");
      return snapshot;
    }

    await designBrief.applyProposal(designId, {
      fields: state.lastRevision.previousBrief,
      source: "intent_extraction",
      rationale: "undo_last_revision",
    });
    await repo.updateConversationInterviewState(designId, {
      ...state,
      lastRevision: null,
    });
    await repo.addMessage(designId, {
      role: "assistant",
      content: describeUndo(state.lastRevision.changedSections),
      metadata: {
        phase: current.conversation.phase,
        act: "acknowledge",
        undone: true,
      },
    });

    const snapshot = await repo.getProject(designId);
    if (!snapshot) throw new Error("Project not found");
    return snapshot;
  }

  /**
   * Sprint 1/2D behavior, byte-for-byte: one field per fixed phase. Only
   * reachable for a historical project already sitting in an `ask_*` phase.
   */
  async function handleLegacyReply(
    designId: string,
    phase: ConversationPhase,
    trimmed: string,
  ): Promise<ProjectSnapshot> {
    const current = await repo.getProject(designId);
    if (!current) throw new Error("Project not found");

    const extraction = intentExtraction.extract({
      brief: current.brief,
      phase,
      reply: trimmed,
    });
    for (const proposal of extraction.proposals) {
      await designBrief.applyProposal(designId, proposal);
    }

    const nextPhase = nextPhaseAfterUserReply(phase);
    if (!nextPhase) {
      const snapshot = await repo.getProject(designId);
      if (!snapshot) throw new Error("Project not found");
      return snapshot;
    }

    if (nextPhase === "ask_design") {
      await repo.setProjectStatus(designId, "intake");
    }

    if (nextPhase === "awaiting_summary_confirmation") {
      const freshBrief = await designBrief.getWorkingBrief(designId);
      await presentDesignSummary(
        designId,
        freshBrief,
        current.conversation.interviewState,
      );
      const snapshot = await repo.getProject(designId);
      if (!snapshot) throw new Error("Project not found");
      return snapshot;
    }

    await repo.updateConversationPhase(designId, nextPhase);
    const message = promptForPhase(nextPhase);
    if (message) {
      await repo.addMessage(designId, {
        role: "assistant",
        content: message,
        metadata: { phase: nextPhase },
      });
    }

    const snapshot = await repo.getProject(designId);
    if (!snapshot) throw new Error("Project not found");
    return snapshot;
  }

  /**
   * Sprint 2F: Intent Extraction → Design Brief → Brief Evaluation →
   * Design Intelligence → Interview Intelligence → best next act. Used for
   * every new project's pre-approval turn, and for Edit/Continue replies.
   *
   * Sprint 2G Part 2: also computes Revision Impact every turn so
   * Design/Product Intelligence only re-run what the reply actually
   * touched. Sprint 2G Part 3: records a one-level undo snapshot before
   * any accepted change, and flags an explicit deferral with a "Designer
   * Decision" note.
   */
  async function handleAdaptiveReply(
    designId: string,
    phase: ConversationPhase,
    trimmed: string,
  ): Promise<ProjectSnapshot> {
    const current = await repo.getProject(designId);
    if (!current) throw new Error("Project not found");

    const state = current.conversation.interviewState;
    const pendingSection = narrowSection(state.pendingSection);

    if (UNDO_PATTERN.test(trimmed)) {
      return performUndo(designId, current);
    }

    const understanding = await interpretReply(current, current.brief, pendingSection, trimmed);
    const extraction = intentExtraction.extract({
      brief: current.brief,
      phase,
      reply: trimmed,
      pendingSection,
      understanding,
    });
    for (const proposal of extraction.proposals) {
      await designBrief.applyProposal(designId, proposal);
    }

    const workingBrief = await designBrief.getWorkingBrief(designId);
    const impact = revisionIntelligence.analyze(current.brief, workingBrief);
    const evaluation = briefEvaluation.evaluate(workingBrief);
    const assessment = designIntelligence.assess(workingBrief, evaluation, impact);
    const deferredDecision = computeDeferredDecision(current.brief, workingBrief);

    traceConversationUnderstanding({
      stage: "brief_updated",
      resolvedSections: evaluation.sections
        .filter((s) => s.resolution === "provided" || s.resolution === "deferred_to_designer")
        .map((s) => s.section),
    });

    const act = interviewIntelligence.selectNextAct({
      evaluation,
      assessment,
      context: {
        pendingSection,
        askCounts: state.askCounts,
        dismissedAdvisories: state.dismissedAdvisories,
      },
    });

    traceConversationUnderstanding({
      stage: "next_act",
      actType: act.type,
      section: actSection(act) ?? null,
      pendingSection,
    });

    const stateWithUndo: InterviewStateData = impact.isNoOp
      ? state
      : {
          ...state,
          lastRevision: {
            previousBrief: toDesignBriefSnapshotContent(current.brief),
            changedSections: impact.changedSections,
          },
        };

    if (act.type === "summarize") {
      await presentDesignSummary(designId, workingBrief, stateWithUndo, {
        previousBrief: current.brief,
        updatedSections: impact.changedSections,
      });
      const snapshot = await repo.getProject(designId);
      if (!snapshot) throw new Error("Project not found");
      return snapshot;
    }

    const nextState = applyActToInterviewState(stateWithUndo, act);
    await repo.updateConversationPhase(designId, "interviewing");
    await repo.updateConversationInterviewState(designId, nextState);

    if (act.type !== "await_customer") {
      const summaryForAck = designSummary.createSummary(workingBrief, evaluation);
      await repo.addMessage(designId, {
        role: "assistant",
        content: withResolvedAcknowledgement(
          act,
          impact.changedSections,
          summaryForAck,
          naturalizeQuestion(act, summaryForAck),
        ),
        metadata: {
          phase: "interviewing",
          act: act.type,
          section: actSection(act),
          ...(deferredDecision ? { deferredDecision } : {}),
          ...(act.type === "advise"
            ? { actions: findRecommendationActions(assessment, act.findingId) }
            : {}),
        },
      });
    }

    const snapshot = await repo.getProject(designId);
    if (!snapshot) throw new Error("Project not found");
    return snapshot;
  }

  /**
   * Sprint 2G Part 2: adaptive post-concept revision handling. Never
   * restarts the interview and never re-asks an already-answered question
   * unless this revision itself invalidated it.
   *
   * Sprint 2G Part 3: concept regeneration is no longer a one-shot yes/no
   * gate on the *next* reply — "regenerate"/"keep current" are recognized
   * whenever concepts actually need it, on any turn, and an ignored prompt
   * never blocks or repeats. One level of undo is available here too.
   */
  async function handleRevisionReply(
    designId: string,
    phase: ConversationPhase,
    trimmed: string,
  ): Promise<ProjectSnapshot> {
    const current = await repo.getProject(designId);
    if (!current) throw new Error("Project not found");

    const state = current.conversation.interviewState;
    await repo.setProjectStatus(designId, "revision_requested");

    if (UNDO_PATTERN.test(trimmed)) {
      return performUndo(designId, current);
    }

    const conceptStatus = conceptGeneration.describeConceptStatus(
      current.brief,
      current.artworkVersions,
      current.designBriefVersions,
    );
    if (conceptStatus.status === "needs_update") {
      if (REGENERATE_REQUEST_PATTERN.test(trimmed)) {
        return performRegeneration(designId, state);
      }
      if (KEEP_CONCEPTS_PATTERN.test(trimmed)) {
        await repo.addMessage(designId, {
          role: "assistant",
          content:
            "No problem — I'll leave the current concepts as they are. Anything else you'd like to change?",
          metadata: { phase: "revision_received", act: "acknowledge" },
        });
        const snapshot = await repo.getProject(designId);
        if (!snapshot) throw new Error("Project not found");
        return snapshot;
      }
    }

    const previousBrief = current.brief;
    const pendingSection = narrowSection(state.pendingSection);

    const understanding = await interpretReply(current, previousBrief, pendingSection, trimmed);
    const extraction = intentExtraction.extract({
      brief: previousBrief,
      phase,
      reply: trimmed,
      pendingSection,
      understanding,
    });
    for (const proposal of extraction.proposals) {
      await designBrief.applyProposal(designId, proposal);
    }

    const updatedBrief = await designBrief.getWorkingBrief(designId);
    const impact = revisionIntelligence.analyze(previousBrief, updatedBrief);
    const deferredDecision = computeDeferredDecision(previousBrief, updatedBrief);

    if (impact.isNoOp) {
      // Nothing structured changed — unstructured feedback was already
      // preserved as a note by extraction. Stay in the loop.
      await repo.updateConversationPhase(designId, "revision_received");
      await repo.addMessage(designId, {
        role: "assistant",
        content:
          "Got it — I've noted that. Anything else you would like to adjust?",
        metadata: {
          phase: "revision_received",
          ...(deferredDecision ? { deferredDecision } : {}),
        },
      });
      const snapshot = await repo.getProject(designId);
      if (!snapshot) throw new Error("Project not found");
      return snapshot;
    }

    const stateWithUndo: InterviewStateData = {
      ...state,
      lastRevision: {
        previousBrief: toDesignBriefSnapshotContent(previousBrief),
        changedSections: impact.changedSections,
      },
    };

    const evaluation = briefEvaluation.evaluate(updatedBrief);
    const assessment = designIntelligence.assess(updatedBrief, evaluation, impact);
    const act = interviewIntelligence.selectRevisionAct({
      evaluation,
      assessment,
      impact,
      context: {
        pendingSection,
        askCounts: state.askCounts,
        dismissedAdvisories: state.dismissedAdvisories,
      },
    });

    if (act.type === "clarify" || act.type === "advise") {
      const nextState = applyActToInterviewState(stateWithUndo, act);
      await repo.updateConversationPhase(designId, "revision_received");
      await repo.updateConversationInterviewState(designId, nextState);
      await repo.addMessage(designId, {
        role: "assistant",
        content: act.message,
        metadata: {
          phase: "revision_received",
          act: act.type,
          section: actSection(act),
          ...(deferredDecision ? { deferredDecision } : {}),
          ...(act.type === "advise"
            ? { actions: findRecommendationActions(assessment, act.findingId) }
            : {}),
        },
      });
      const snapshot = await repo.getProject(designId);
      if (!snapshot) throw new Error("Project not found");
      return snapshot;
    }

    // The revision was unambiguous and raised nothing new — continue
    // naturally. Only mention regenerating concepts if some already exist
    // and this change would actually make them stale; the persistent
    // concept-status action (not this message) is what actually lets the
    // customer act on it whenever they're ready.
    const hasExistingConcepts = current.artworkVersions.length > 0;
    const shouldMentionRegeneration =
      impact.needsConceptRegeneration && hasExistingConcepts;

    await repo.updateConversationPhase(designId, "revision_received");
    await repo.updateConversationInterviewState(designId, {
      ...stateWithUndo,
      pendingSection: null,
    });
    await repo.addMessage(designId, {
      role: "assistant",
      content: shouldMentionRegeneration
        ? `${acknowledgeRevision(impact.changedSections)} ${conceptRegenerationPrompt()}`
        : acknowledgeRevision(impact.changedSections),
      metadata: {
        phase: "revision_received",
        act: "acknowledge",
        updatedSections: impact.changedSections,
        ...(deferredDecision ? { deferredDecision } : {}),
      },
    });

    const snapshot = await repo.getProject(designId);
    if (!snapshot) throw new Error("Project not found");
    return snapshot;
  }

  return {
    start() {
      return repo.createProject();
    },

    get(designId) {
      return repo.getProject(designId);
    },

    async handleUserMessage(designId, content) {
      const trimmed = content.trim();
      if (!trimmed) throw new Error("Message cannot be empty");

      const current = await repo.getProject(designId);
      if (!current) throw new Error("Project not found");

      const phase = current.conversation.phase;

      if (CHAT_BLOCKED_PHASES.includes(phase)) {
        throw new Error("Please wait for the current step to finish");
      }

      await repo.addMessage(designId, {
        role: "user",
        content: trimmed,
        metadata: { phase },
      });

      if (isLegacyScriptedPhase(phase)) {
        return handleLegacyReply(designId, phase, trimmed);
      }
      if (REVISION_REQUEST_PHASES.includes(phase)) {
        return handleRevisionReply(designId, phase, trimmed);
      }
      return handleAdaptiveReply(designId, phase, trimmed);
    },

    async selectConcept(designId, artworkVersionId) {
      const current = await repo.getProject(designId);
      if (!current) throw new Error("Project not found");

      if (current.conversation.phase !== "concepts_ready") {
        throw new Error("Concepts are not ready for selection");
      }

      const exists = current.artworkVersions.some(
        (version) => version.id === artworkVersionId,
      );
      if (!exists) throw new Error("Concept not found");

      await repo.selectArtworkVersion(designId, artworkVersionId);
      await repo.updateConversationPhase(designId, "ask_revisions");
      await repo.addMessage(designId, {
        role: "assistant",
        content: "What changes would you like to make to this concept?",
        metadata: { phase: "ask_revisions" },
      });

      const snapshot = await repo.getProject(designId);
      if (!snapshot) throw new Error("Project not found");
      return snapshot;
    },

    async submitDesignBriefDecision(designId, action) {
      const current = await repo.getProject(designId);
      if (!current) throw new Error("Project not found");
      const phase = current.conversation.phase;

      if (action === "approve") {
        if (phase === "awaiting_summary_confirmation") {
          return approveAndGenerate(designId);
        }

        // Idempotent retry: approval (and generation) already happened for
        // this brief content — return the current state rather than
        // re-running generation and duplicating concepts.
        if (POST_APPROVAL_PHASES.includes(phase)) {
          const latest = await designBrief.getLatestApprovedVersion(designId);
          if (latest) {
            const snapshot = await repo.getProject(designId);
            if (!snapshot) throw new Error("Project not found");
            return snapshot;
          }
        }

        throw new Error("Design summary is not ready for approval");
      }

      if (phase !== "awaiting_summary_confirmation") {
        throw new Error(
          `Cannot ${action} the design brief from the current step`,
        );
      }

      // "edit" is the only remaining non-approve action (Sprint 2L Phase
      // 1B, Goal 12 — "continue" removed as redundant; see schema.ts).
      await repo.updateConversationPhase(designId, "edit_requested");
      await repo.addMessage(designId, {
        role: "assistant",
        content: "What would you like to change or add?",
        metadata: { phase: "edit_requested" },
      });

      const snapshot = await repo.getProject(designId);
      if (!snapshot) throw new Error("Project not found");
      return snapshot;
    },

    async regenerateConcepts(designId) {
      const current = await repo.getProject(designId);
      if (!current) throw new Error("Project not found");
      if (current.designBriefVersions.length === 0) {
        throw new Error(
          "Cannot generate concepts without an approved design brief",
        );
      }
      return performRegeneration(designId, current.conversation.interviewState);
    },

    async undoLastChange(designId) {
      const current = await repo.getProject(designId);
      if (!current) throw new Error("Project not found");
      return performUndo(designId, current);
    },
  };
}

/**
 * Sprint 2L Phase 1 (Goal 13), refined Sprint 2L Phase 1A, refined again
 * Sprint 2L Phase 1B (Goal 7): when this turn resolved one or more brief
 * sections before asking/clarifying the next one, lead with a short,
 * deterministic acknowledgement instead of asking as if nothing had been
 * said. The acknowledgement's *shape* now depends on how much actually
 * happened this turn:
 *
 *   - A single low-salience field answer ("black" → product color) gets a
 *     short, natural confirmation (`shortAcknowledgement` — "Black
 *     works.") — the full "Got it — I have Black as the shirt color."
 *     treatment reads as database-mutation reporting when it repeats
 *     every single turn (the live acceptance test's core complaint).
 *   - A multi-field turn (a rich customer message resolved several things
 *     at once) still earns the fuller `acknowledgeResolvedFields`
 *     synthesis — demonstrating real understanding of a complex message
 *     is exactly when that detail is worth showing.
 *
 * `acknowledgeResolvedFields` only ever names a section that both changed
 * this turn AND has a real, resolved value in `summary` (the Design
 * Summary of the post-patch brief) — a field a provider proposed but that
 * reconciliation rejected (failed grounding, ambiguous confidence,
 * unsupported section, ...) never appears here, because it was never
 * applied and therefore never changed the brief. Falls back to the terser
 * `acknowledgeRevision` only when nothing changed has a displayable value
 * (e.g. the sole change was a deferral) — that generic phrasing remains
 * truthful in that case. Never applied to "advise" acts (an advisory
 * already has its own framing) or when nothing changed this turn.
 */
function withResolvedAcknowledgement(
  act: InterviewAct,
  changedSections: BriefSectionKey[],
  summary: DesignSummaryView,
  /** Already-naturalized question text for "ask" acts (see `naturalizeQuestion`) — falls back to `act.message` for every other act type. */
  questionMessage: string,
): string {
  if (act.type !== "ask" && act.type !== "clarify") {
    // Only "advise" reaches here in practice (the caller already returned
    // early for "summarize" and skips "await_customer" entirely) — the
    // `"message" in act` guard keeps this exhaustive/type-safe without a
    // cast rather than assuming that.
    return "message" in act ? act.message : "";
  }
  if (changedSections.length === 0) return questionMessage;

  if (changedSections.length === 1) {
    const [section] = changedSections;
    const value = (summary[section as keyof DesignSummaryView] as string | undefined) ?? null;
    return `${shortAcknowledgement(section, value)} ${questionMessage}`;
  }

  const ack =
    acknowledgeResolvedFields(summary, changedSections) ?? acknowledgeRevision(changedSections);
  return `${ack} ${questionMessage}`;
}

/**
 * Sprint 2L Phase 1B (Goal 9), corrected Sprint 2L Phase 1C: a light,
 * deterministic naturalization of the next question using only
 * already-CONFIRMED brief values — never a new LLM call, never an
 * invented fact. Scoped to the two questions a live acceptance test
 * called out as reading generically once real context is already known
 * ("What color garment..." → "What color T-shirts...", "Tell me about
 * the design..." → "What direction do you want for the My 3 Sons
 * design?"). Every other question keeps its existing, already-tested
 * phrasing untouched. `InterviewIntelligenceCapability` itself stays
 * brief-unaware (capability-boundaries.ts forbids it inspecting the
 * brief) — this naturalization happens here, in Conversation
 * orchestration, which already has full brief access for other reasons
 * (building the acknowledgement, the understanding request).
 *
 * Sprint 2L Phase 1C fix: takes the already-computed `DesignSummaryView`
 * (the same `summaryForAck` the acknowledgement uses), never the raw
 * `TShirtDesignBrief`. A live acceptance test found that a raw brief field
 * can hold a value `BriefEvaluation` has already rejected as malformed
 * (e.g. a punctuation-free run-on sentence a deterministic extractor
 * greedily over-captured into `exactText`) — quality-rejected, so it
 * correctly stays `"unknown"` for readiness purposes and never reaches
 * the customer-facing Design Summary, but the *raw field* is never
 * cleared, only its evaluation status is. Reading the raw field here
 * bypassed that quality gate entirely and leaked the rejected value
 * straight into a customer-facing question
 * ("What direction do you want for the My 3 Sons help me create a
 * design for team t-shirts design?"). `DesignSummaryView` is exactly the
 * quality-gated projection — a field only appears in it when
 * `BriefEvaluation` has already confirmed `resolution === "provided"` —
 * so this naturalization can never surface a value the customer wouldn't
 * also see reflected in the Design Summary itself.
 */
function naturalizeQuestion(act: InterviewAct, summary: DesignSummaryView): string {
  if (act.type !== "ask") return "message" in act ? act.message : "";

  if (act.section === "productColor" && summary.product?.trim()) {
    const product = summary.product.trim();
    const plural = /s$/i.test(product) ? product : `${product}s`;
    return `What color ${plural} will these print on?`;
  }

  if (act.section === "graphics") {
    const subject = summary.requiredWording?.trim();
    // "None" is DesignSummaryView's own sentinel for an explicit,
    // confirmed "no required wording" — never a usable subject phrase.
    const wordingSubject = subject && subject !== "None" ? subject : null;
    const audienceSubject = summary.audience?.trim();
    const finalSubject = wordingSubject || audienceSubject;
    if (finalSubject) return `What direction do you want for the ${finalSubject} design?`;
  }

  return act.message;
}

function narrowSection(pending: string | null): BriefSectionKey | null {
  if (pending && KNOWN_SECTIONS.has(pending)) {
    return pending as BriefSectionKey;
  }
  return null;
}

function applyActToInterviewState(
  state: InterviewStateData,
  act: InterviewAct,
): InterviewStateData {
  if (act.type === "ask" || act.type === "clarify") {
    return {
      ...state,
      pendingSection: act.section,
      askCounts: {
        ...state.askCounts,
        [act.section]: (state.askCounts[act.section] ?? 0) + 1,
      },
    };
  }
  if (act.type === "advise") {
    return {
      ...state,
      pendingSection: act.followUpSection ?? state.pendingSection,
      dismissedAdvisories: [...state.dismissedAdvisories, act.findingId],
    };
  }
  return state; // "await_customer" — defensive fallback, no state change.
}

function actSection(act: InterviewAct): string | undefined {
  if (act.type === "ask" || act.type === "clarify") return act.section;
  if (act.type === "advise") return act.followUpSection;
  return undefined;
}

/**
 * Sprint 2G Part 3: old → new value for every updated, currently-visible
 * field — the raw material for "Black → Navy" styling. A section that
 * changed but isn't shown in the summary (e.g. it's now deferred) has no
 * entry; a section whose displayed value didn't actually change (only
 * bookkeeping did) is also skipped.
 */
function buildFieldTransitions(
  previousSummary: DesignSummaryView,
  newSummary: DesignSummaryView,
  updatedSections: BriefSectionKey[],
): Record<string, { from: string | null; to: string }> {
  const transitions: Record<string, { from: string | null; to: string }> = {};
  for (const section of updatedSections) {
    const key = section as keyof DesignSummaryView;
    const to = newSummary[key];
    if (!to) continue;
    const from = previousSummary[key] ?? null;
    if (from === to) continue;
    transitions[section] = { from, to };
  }
  return transitions;
}

/** The section, if any, the customer just explicitly deferred this turn. */
function computeDeferredDecision(
  previousBrief: TShirtDesignBrief,
  updatedBrief: TShirtDesignBrief,
): { section: BriefSectionKey; message: string } | null {
  const previousSet = new Set(previousBrief.deferredSections);
  const newlyDeferred = updatedBrief.deferredSections.find(
    (section) => !previousSet.has(section),
  );
  if (!newlyDeferred || !KNOWN_SECTIONS.has(newlyDeferred)) return null;
  const section = newlyDeferred as BriefSectionKey;
  return { section, message: designerDecisionMessage(section) };
}

/**
 * Looks up the clickable actions for the recommendation an "advise" act
 * came from, so the recommendation card can render them — `InterviewAct`
 * itself only carries `findingId`/`message`, not the full recommendation.
 */
function findRecommendationActions(
  assessment: IntelligenceAssessment,
  findingId: string,
) {
  return assessment.recommendations.find((r) => r.id === findingId)?.actions ?? [];
}

// Re-exported only so downstream call sites can type revision-derived
// context without importing `@/capabilities/shared/contracts` directly.
export type { RevisionImpact };
