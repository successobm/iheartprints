import { getCapabilityGraph } from "@/capabilities/composition";
import type { DesignBriefDecisionAction } from "@/capabilities/conversation";
import type { ProjectSnapshot } from "@/lib/domain/types";

/**
 * Stable facade for API routes and existing tests.
 * Delegates to the ConversationCapability composition root.
 */

export async function startConversation(): Promise<ProjectSnapshot> {
  return getCapabilityGraph().conversation.start();
}

export async function getConversation(
  projectId: string,
): Promise<ProjectSnapshot | null> {
  return getCapabilityGraph().conversation.get(projectId);
}

export async function handleUserMessage(
  projectId: string,
  content: string,
): Promise<ProjectSnapshot> {
  return getCapabilityGraph().conversation.handleUserMessage(
    projectId,
    content,
  );
}

export async function selectConcept(
  projectId: string,
  artworkVersionId: string,
): Promise<ProjectSnapshot> {
  return getCapabilityGraph().conversation.selectConcept(
    projectId,
    artworkVersionId,
  );
}

/**
 * Sprint 2D: Approve / Edit / Continue in response to a presented Design
 * Summary. Approval is idempotent and is the only path that can trigger
 * concept generation.
 */
export async function submitDesignBriefDecision(
  projectId: string,
  action: DesignBriefDecisionAction,
): Promise<ProjectSnapshot> {
  return getCapabilityGraph().conversation.submitDesignBriefDecision(
    projectId,
    action,
  );
}
