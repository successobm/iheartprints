import type { ProjectRepository } from "@/lib/db/repository";
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
import type { DesignBriefCapability } from "@/capabilities/design-brief";
import type { DesignIntelligenceCapability } from "@/capabilities/design-intelligence";
import type { DesignSummaryCapability } from "@/capabilities/design-summary";
import type { IntentExtractionCapability } from "@/capabilities/intent-extraction";
import type { InterviewIntelligenceCapability } from "@/capabilities/interview-intelligence";
import type { RevisionIntelligenceCapability } from "@/capabilities/revision-intelligence";
import { ALL_SECTIONS_IN_POLICY_ORDER } from "@/capabilities/shared/interview-coverage-policy";
import {
  acknowledgeRevision,
  conceptRegenerationPrompt,
} from "@/capabilities/shared/question-phrasing";
import type {
  BriefSectionKey,
  InterviewAct,
  RevisionImpact,
} from "@/capabilities/shared/contracts";

export type DesignBriefDecisionAction = "approve" | "edit" | "continue";

export interface ConversationCapabilityDeps {
  repo: ProjectRepository;
  intentExtraction: IntentExtractionCapability;
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

const YES_PATTERN =
  /^(?:yes|yeah|yep|yup|sure|please|ok|okay|go ahead|do it|please do|sounds good|let'?s do it|update them|regenerate)\b/i;
const NO_PATTERN =
  /^(?:no|nope|nah|not now|no thanks|leave it|keep (?:the |)(?:current|existing|old)|don'?t)\b/i;

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
 * Sprint 2G Part 2: the post-concept revision loop is adaptive too. A
 * revision reply runs through the same Intent Extraction → Design Brief
 * pipeline, then Revision Intelligence compares the brief before/after to
 * scope what actually needs re-evaluating (Design/Product Intelligence)
 * and whether existing concepts are now stale — never restarting the
 * interview or re-asking already-answered questions.
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
}

export function createConversationCapability(
  deps: ConversationCapabilityDeps,
): ConversationCapability {
  const {
    repo,
    intentExtraction,
    designBrief,
    briefEvaluation,
    designIntelligence,
    interviewIntelligence,
    revisionIntelligence,
    designSummary,
    conceptGeneration,
  } = deps;

  /**
   * Takes the (already-fetched, post-mutation) brief and interview state
   * directly rather than re-reading them — every caller already has both
   * in hand by the time it's ready to summarize, and each avoided read
   * matters here: a full adaptive interview does many more small
   * read-modify-write turns than the old four-question ladder did.
   *
   * `updatedSections`, when given, is attached to the message metadata so
   * the UI can highlight what just changed (Sprint 2G Part 2) — never more
   * than the section keys themselves, no internal impact detail.
   */
  async function presentDesignSummary(
    designId: string,
    brief: TShirtDesignBrief,
    interviewState: InterviewStateData | null,
    updatedSections: BriefSectionKey[] = [],
  ): Promise<void> {
    const evaluation = briefEvaluation.evaluate(brief);
    const summary = designSummary.createSummary(brief, evaluation);
    const content = designSummary.formatForCustomer(summary);

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
        updatedSections,
      },
    });
  }

  async function approveAndGenerate(designId: string): Promise<ProjectSnapshot> {
    const version = await designBrief.approveWorkingBrief(designId);

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
  async function regenerateConcepts(
    designId: string,
    state: InterviewStateData,
  ): Promise<ProjectSnapshot> {
    const version = await designBrief.approveWorkingBrief(designId);
    await repo.updateConversationInterviewState(designId, {
      ...state,
      pendingSection: null,
      awaitingConceptRegenerationConfirmation: false,
    });
    return conceptGeneration.regenerateAfterRevision(designId, version.id);
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
   * every new project's pre-approval turn, and for Edit/Continue replies
   * (which now get real multi-field, correction-aware extraction instead
   * of a single appended note).
   *
   * Sprint 2G Part 2: also computes Revision Impact every turn (comparing
   * the brief immediately before and after this turn's proposals) so
   * Design/Product Intelligence only re-run what the reply actually
   * touched, and so a re-presented Design Summary can flag what changed.
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

    const extraction = intentExtraction.extract({
      brief: current.brief,
      phase,
      reply: trimmed,
      pendingSection,
    });
    for (const proposal of extraction.proposals) {
      await designBrief.applyProposal(designId, proposal);
    }

    const workingBrief = await designBrief.getWorkingBrief(designId);
    const impact = revisionIntelligence.analyze(current.brief, workingBrief);
    const evaluation = briefEvaluation.evaluate(workingBrief);
    const assessment = designIntelligence.assess(workingBrief, evaluation, impact);

    const act = interviewIntelligence.selectNextAct({
      evaluation,
      assessment,
      context: {
        pendingSection,
        askCounts: state.askCounts,
        dismissedAdvisories: state.dismissedAdvisories,
      },
    });

    if (act.type === "summarize") {
      await presentDesignSummary(
        designId,
        workingBrief,
        current.conversation.interviewState,
        impact.changedSections,
      );
      const snapshot = await repo.getProject(designId);
      if (!snapshot) throw new Error("Project not found");
      return snapshot;
    }

    const nextState = applyActToInterviewState(state, act);
    await repo.updateConversationPhase(designId, "interviewing");
    await repo.updateConversationInterviewState(designId, nextState);

    if (act.type !== "await_customer") {
      await repo.addMessage(designId, {
        role: "assistant",
        content: act.message,
        metadata: {
          phase: "interviewing",
          act: act.type,
          section: actSection(act),
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
   * unless this revision itself invalidated it — Interview Intelligence's
   * `selectRevisionAct` only reacts to what Revision Intelligence says
   * actually changed. If concepts already exist and the change affects
   * them, asks once whether to regenerate rather than silently doing so.
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

    // A pending "would you like updated concepts?" question takes priority
    // over interpreting this reply as a fresh revision.
    if (state.awaitingConceptRegenerationConfirmation) {
      const answer = classifyYesNo(trimmed);
      if (answer === "yes") {
        return regenerateConcepts(designId, state);
      }
      if (answer === "no") {
        await repo.updateConversationPhase(designId, "revision_received");
        await repo.updateConversationInterviewState(designId, {
          ...state,
          awaitingConceptRegenerationConfirmation: false,
        });
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
      // Unclear — fall through and treat this as a new revision instead.
    }

    const previousBrief = current.brief;
    const pendingSection = narrowSection(state.pendingSection);

    const extraction = intentExtraction.extract({
      brief: previousBrief,
      phase,
      reply: trimmed,
      pendingSection,
    });
    for (const proposal of extraction.proposals) {
      await designBrief.applyProposal(designId, proposal);
    }

    const updatedBrief = await designBrief.getWorkingBrief(designId);
    const impact = revisionIntelligence.analyze(previousBrief, updatedBrief);

    if (impact.isNoOp) {
      // Nothing structured changed — unstructured feedback was already
      // preserved as a note by extraction. Stay in the loop.
      await repo.updateConversationPhase(designId, "revision_received");
      await repo.addMessage(designId, {
        role: "assistant",
        content:
          "Got it — I've noted that. Anything else you would like to adjust?",
        metadata: { phase: "revision_received" },
      });
      const snapshot = await repo.getProject(designId);
      if (!snapshot) throw new Error("Project not found");
      return snapshot;
    }

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
      const nextState = applyActToInterviewState(state, act);
      await repo.updateConversationPhase(designId, "revision_received");
      await repo.updateConversationInterviewState(designId, {
        ...nextState,
        awaitingConceptRegenerationConfirmation: false,
      });
      await repo.addMessage(designId, {
        role: "assistant",
        content: act.message,
        metadata: {
          phase: "revision_received",
          act: act.type,
          section: actSection(act),
        },
      });
      const snapshot = await repo.getProject(designId);
      if (!snapshot) throw new Error("Project not found");
      return snapshot;
    }

    // The revision was unambiguous and raised nothing new — continue
    // naturally. Only ask about regenerating concepts if some already
    // exist and this change would actually make them stale.
    const hasExistingConcepts = current.artworkVersions.length > 0;
    const shouldPromptRegeneration =
      impact.needsConceptRegeneration && hasExistingConcepts;

    await repo.updateConversationPhase(designId, "revision_received");
    await repo.updateConversationInterviewState(designId, {
      ...state,
      pendingSection: null,
      awaitingConceptRegenerationConfirmation: shouldPromptRegeneration,
    });
    await repo.addMessage(designId, {
      role: "assistant",
      content: shouldPromptRegeneration
        ? `${acknowledgeRevision(impact.changedSections)} ${conceptRegenerationPrompt()}`
        : acknowledgeRevision(impact.changedSections),
      metadata: {
        phase: "revision_received",
        act: "acknowledge",
        updatedSections: impact.changedSections,
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

      if (action === "edit") {
        await repo.updateConversationPhase(designId, "edit_requested");
        await repo.addMessage(designId, {
          role: "assistant",
          content: "What would you like to change about the design?",
          metadata: { phase: "edit_requested" },
        });
      } else {
        await repo.updateConversationPhase(designId, "continue_requested");
        await repo.addMessage(designId, {
          role: "assistant",
          content: "What else would you like the designer to know?",
          metadata: { phase: "continue_requested" },
        });
      }

      const snapshot = await repo.getProject(designId);
      if (!snapshot) throw new Error("Project not found");
      return snapshot;
    },
  };
}

function narrowSection(pending: string | null): BriefSectionKey | null {
  if (pending && KNOWN_SECTIONS.has(pending)) {
    return pending as BriefSectionKey;
  }
  return null;
}

function classifyYesNo(reply: string): "yes" | "no" | "unclear" {
  const trimmed = reply.trim();
  if (YES_PATTERN.test(trimmed)) return "yes";
  if (NO_PATTERN.test(trimmed)) return "no";
  return "unclear";
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

// Re-exported only so downstream call sites can type revision-derived
// context without importing `@/capabilities/shared/contracts` directly.
export type { RevisionImpact };
