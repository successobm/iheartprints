import type { ProjectRepository } from "@/lib/db/repository";
import type {
  ConversationPhase,
  ProjectSnapshot,
} from "@/lib/domain/types";
import type { BriefEvaluationCapability } from "@/capabilities/brief-evaluation";
import type { ConceptGenerationCapability } from "@/capabilities/concept-generation";
import type { DesignBriefCapability } from "@/capabilities/design-brief";
import type { DesignIntelligenceCapability } from "@/capabilities/design-intelligence";
import type { DesignSummaryCapability } from "@/capabilities/design-summary";
import type { IntentExtractionCapability } from "@/capabilities/intent-extraction";
import type { InterviewIntelligenceCapability } from "@/capabilities/interview-intelligence";

export type DesignBriefDecisionAction = "approve" | "edit" | "continue";

export interface ConversationCapabilityDeps {
  repo: ProjectRepository;
  intentExtraction: IntentExtractionCapability;
  designBrief: DesignBriefCapability;
  briefEvaluation: BriefEvaluationCapability;
  designIntelligence: DesignIntelligenceCapability;
  interviewIntelligence: InterviewIntelligenceCapability;
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
];

/**
 * Owns conversation lifecycle, messages, state, and orchestration.
 * Must NOT own brief mutation logic, generation internals, or product rules.
 *
 * Sprint 2D: the scripted interview no longer generates concepts on its own.
 * It hands off to a Design Summary confirmation gate; only an explicit
 * customer Approve decision may trigger concept generation.
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
    designSummary,
    conceptGeneration,
  } = deps;

  async function presentDesignSummary(designId: string): Promise<void> {
    const brief = await designBrief.getWorkingBrief(designId);
    const evaluation = briefEvaluation.evaluate(brief);
    const summary = designSummary.createSummary(brief, evaluation);
    const content = designSummary.formatForCustomer(summary);

    await repo.updateConversationPhase(designId, "awaiting_summary_confirmation");
    await repo.addMessage(designId, {
      role: "assistant",
      content,
      metadata: { phase: "awaiting_summary_confirmation", summary },
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

      // Intent Extraction proposes; Design Brief accepts — Conversation never
      // patches the brief directly.
      const extraction = intentExtraction.extract({
        brief: current.brief,
        phase,
        reply: trimmed,
      });

      for (const proposal of extraction.proposals) {
        await designBrief.applyProposal(designId, proposal);
      }

      // Edit / Continue collection: any reply here updates the working brief
      // (via the extraction above) and returns straight to an updated
      // Design Summary — no adaptive question selection is attempted.
      if (phase === "edit_requested" || phase === "continue_requested") {
        await presentDesignSummary(designId);
        const snapshot = await repo.getProject(designId);
        if (!snapshot) throw new Error("Project not found");
        return snapshot;
      }

      const workingBrief = await designBrief.getWorkingBrief(designId);
      const evaluation = briefEvaluation.evaluate(workingBrief);
      const assessment = designIntelligence.assess(workingBrief, evaluation);
      const act = interviewIntelligence.selectNextAct({
        phase,
        evaluation,
        assessment,
      });

      if (act.type === "summarize") {
        await presentDesignSummary(designId);
        const snapshot = await repo.getProject(designId);
        if (!snapshot) throw new Error("Project not found");
        return snapshot;
      }

      if (!act.nextPhase) {
        const snapshot = await repo.getProject(designId);
        if (!snapshot) throw new Error("Project not found");
        return snapshot;
      }

      if (
        act.nextPhase === "ask_revisions" ||
        act.nextPhase === "revision_received"
      ) {
        await repo.setProjectStatus(designId, "revision_requested");
      } else if (act.nextPhase === "ask_design") {
        await repo.setProjectStatus(designId, "intake");
      }

      await repo.updateConversationPhase(designId, act.nextPhase);
      if (act.message) {
        await repo.addMessage(designId, {
          role: "assistant",
          content: act.message,
          metadata: { phase: act.nextPhase },
        });
      }

      const snapshot = await repo.getProject(designId);
      if (!snapshot) throw new Error("Project not found");
      return snapshot;
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
