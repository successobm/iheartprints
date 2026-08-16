import type { ConversationPhase, TShirtDesignBrief } from "./types";

/**
 * Sprint 2F: this module's phase-ladder functions (`applyUserReplyToBrief`,
 * `nextPhaseAfterUserReply`, `promptForPhase`) are legacy-only, still used
 * for historical projects still sitting in an `ask_*` phase (resumed, not
 * upgraded mid-flow — see `isLegacyScriptedPhase`). New projects and every
 * pre-approval interview turn go through `IntentExtractionCapability` +
 * `InterviewIntelligenceCapability` instead.
 *
 * Sprint 2G Part 2: the post-concept revision loop (`ask_revisions` /
 * `revision_received`) is no longer legacy either — ConversationCapability
 * routes it through the same adaptive pipeline plus RevisionIntelligence.
 * `nextPhaseAfterUserReply`'s cases for those two phases and
 * `applyUserReplyToBrief`'s append-only case for them are dead for new
 * activity but left in place; nothing calls them for these phases anymore.
 */
export const OPENING_PROMPT = "What are we printing today?";

/**
 * Correction A: the durable record that a customer chose "Create New
 * Artwork" at the workflow card.
 *
 * Stamped on the assistant message that `beginCreateNewWorkflow` writes,
 * and read back by `isAtProjectStart` so the card does not reappear on
 * reload. Message metadata rather than a new column for the same reason the
 * `concepts_ready` anchor lives there: it is a conversation-shaped fact
 * about a specific turn, the existing JSONB already carries facts the UI
 * branches on, and inventing a `workflow` column would create a second
 * place workflow identity is recorded — the Existing Artwork side already
 * derives its identity durably from the preparation record instead of an
 * enum (`components/chat/uploaded-artwork-flow.ts`).
 *
 * Deliberately NOT read as "this project is a create_new project": absence
 * proves nothing (every project that predates this correction, and every
 * customer who simply started typing, has no marker). It answers only
 * "was the button pressed", which is the one question the card and the
 * idempotency check actually ask.
 */
export const CREATE_NEW_WORKFLOW = "create_new";

/** Whether the Create New workflow choice has been durably recorded. */
export function createNewWorkflowChosen(input: {
  messages: readonly { metadata: Record<string, unknown> }[];
}): boolean {
  return input.messages.some(
    (message) => message.metadata?.workflow === CREATE_NEW_WORKFLOW,
  );
}

/** Phases still driven by the fixed ladder in this module, never the adaptive engine. */
const LEGACY_PHASES: ConversationPhase[] = [
  "ask_product",
  "ask_design",
  "ask_shirt_color",
  "ask_text",
];

export function isLegacyScriptedPhase(phase: ConversationPhase): boolean {
  return LEGACY_PHASES.includes(phase);
}

const PHASE_PROMPTS: Record<ConversationPhase, string | null> = {
  ask_product: OPENING_PROMPT,
  ask_design: "Tell me about your design.",
  ask_shirt_color: "What shirt color will this be printed on?",
  ask_text:
    'What exact text should appear on the design? Say "none" if there is no text.',
  skip_references:
    "Reference artwork can help a lot — we will skip uploads for now and keep going.",
  generating: "I have enough to draft concepts. Generating three directions...",
  concepts_ready:
    "Here are three concept directions. Pick the one that feels closest.",
  ask_revisions: "What changes would you like to make to this concept?",
  revision_received:
    "Got it — I have noted those changes. Anything else you would like to adjust?",
  // Sprint 2D: presented via DesignSummaryCapability, not a static prompt.
  awaiting_summary_confirmation: null,
  brief_approved: null,
  edit_requested: "What would you like to change about the design?",
  continue_requested: "What else would you like the designer to know?",
  // Sprint 2F: adaptive interview messages come from InterviewIntelligence's
  // question catalog, not a static per-phase prompt.
  interviewing: null,
};

export function promptForPhase(phase: ConversationPhase): string | null {
  return PHASE_PROMPTS[phase];
}

export function nextPhaseAfterUserReply(
  phase: ConversationPhase,
): ConversationPhase | null {
  switch (phase) {
    case "ask_product":
      return "ask_design";
    case "ask_design":
      return "ask_shirt_color";
    case "ask_shirt_color":
      return "ask_text";
    case "ask_text":
      // Sprint 2D: the scripted interview no longer auto-generates. It hands
      // off to the Design Summary confirmation gate instead.
      return "awaiting_summary_confirmation";
    case "skip_references":
      return "generating";
    case "ask_revisions":
      return "revision_received";
    case "revision_received":
      return "revision_received";
    default:
      return null;
  }
}

export function applyUserReplyToBrief(
  brief: TShirtDesignBrief,
  phase: ConversationPhase,
  reply: string,
): Partial<TShirtDesignBrief> {
  const trimmed = reply.trim();

  switch (phase) {
    case "ask_product":
      return {
        productSummary: trimmed,
        projectName: brief.projectName ?? deriveProjectName(trimmed),
      };
    case "ask_design":
      return { designDescription: trimmed };
    case "ask_shirt_color":
      return { shirtColor: trimmed };
    case "ask_text": {
      const normalized = trimmed.toLowerCase();
      const none =
        normalized === "none" ||
        normalized === "no text" ||
        normalized === "n/a" ||
        normalized === "na";
      return { exactText: none ? "" : trimmed };
    }
    case "ask_revisions":
    case "revision_received":
    case "edit_requested":
    case "continue_requested":
      return {
        additionalInstructions: appendInstruction(
          brief.additionalInstructions,
          trimmed,
        ),
      };
    default:
      return {};
  }
}

function deriveProjectName(productSummary: string): string {
  const cleaned = productSummary.replace(/\s+/g, " ").trim();
  if (!cleaned) return "Untitled T-shirt design";
  const titled = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
  return titled.length > 60 ? `${titled.slice(0, 57)}…` : titled;
}

function appendInstruction(
  existing: string | null,
  next: string,
): string {
  return appendNote(existing, next);
}

/** Shared "add a note, keep prior notes" helper (Sprint 2F: also used by intent extraction). */
export function appendNote(existing: string | null, next: string): string {
  if (!existing?.trim()) return next;
  return `${existing.trim()}\n\n${next}`;
}

export function projectNameFromBrief(brief: TShirtDesignBrief): string {
  return brief.projectName?.trim() || "Untitled T-shirt design";
}
