import type { ConversationCapability } from "@/capabilities/conversation";
import type { ProjectSnapshot } from "@/lib/domain/types";

/**
 * Concrete, non-ambiguous answers for the four required sections. Every
 * other section Interview Intelligence might ask about (the five
 * high-value sections) is answered with an explicit deferral — this keeps
 * the helper generic and independent of exactly which high-value sections
 * happen to still be outstanding.
 */
const REQUIRED_ANSWERS: Record<string, string> = {
  product: "Camp shirts",
  graphics: "A friendly bear logo",
  productColor: "Navy",
  requiredWording: "Camp Wildwood 2026",
};

const DEFER_REPLY = "You choose.";
const MAX_TURNS = 20;

export interface AdaptiveInterviewResult {
  projectId: string;
  /** Snapshot after the Design Summary gate is reached. */
  afterSummary: ProjectSnapshot;
}

/**
 * Drives a fresh adaptive conversation to the Design Summary confirmation
 * gate. Reads `conversation.interviewState.pendingSection` off each
 * response and replies with the matching canned answer for a required
 * section, or an explicit deferral for anything else (high-value sections,
 * and any advisory, which self-resolves once shown regardless of reply
 * content) — so it stays correct regardless of the exact turn-by-turn
 * priority order Interview Intelligence picks.
 */
export async function runAdaptiveInterviewToSummary(
  conversation: Pick<ConversationCapability, "start" | "handleUserMessage">,
  answerOverrides: Partial<Record<string, string>> = {},
): Promise<AdaptiveInterviewResult> {
  const started = await conversation.start();
  const projectId = started.project.id;
  const answers = { ...REQUIRED_ANSWERS, ...answerOverrides };

  let snapshot = started;
  for (let turn = 0; turn < MAX_TURNS; turn += 1) {
    if (snapshot.conversation.phase === "awaiting_summary_confirmation") {
      return { projectId, afterSummary: snapshot };
    }

    const pending = snapshot.conversation.interviewState.pendingSection;
    const reply = (pending && answers[pending]) || DEFER_REPLY;
    snapshot = await conversation.handleUserMessage(projectId, reply);
  }

  throw new Error(
    `Adaptive interview did not reach the Design Summary gate within ${MAX_TURNS} turns ` +
      `(stuck in phase "${snapshot.conversation.phase}", pending section ` +
      `"${snapshot.conversation.interviewState.pendingSection}")`,
  );
}
