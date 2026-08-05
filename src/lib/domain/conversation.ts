import type { ConversationPhase, TShirtDesignBrief } from "./types";

export const OPENING_PROMPT = "What are we printing today?";

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
  if (!existing?.trim()) return next;
  return `${existing.trim()}\n\n${next}`;
}

export function projectNameFromBrief(brief: TShirtDesignBrief): string {
  return brief.projectName?.trim() || "Untitled T-shirt design";
}
