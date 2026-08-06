import { getCapabilityGraph } from "@/capabilities/composition";
import type { DesignBriefDecisionAction } from "@/capabilities/conversation";
import type { ConceptStatusView } from "@/capabilities/shared/contracts";
import type { ProjectSnapshot, ProjectStatus } from "@/lib/domain/types";

/**
 * Stable facade for API routes and existing tests.
 * Delegates to the ConversationCapability composition root.
 *
 * Sprint 2G Part 3: every snapshot-returning function also attaches
 * `conceptStatus` — computed fresh from already-public snapshot data via
 * `ConceptGenerationCapability.describeConceptStatus`, not a new capability
 * dependency — so the UI's persistent concept-status action reflects
 * reality on every fetch, not only right after a revision turn.
 */

export type ApiProjectSnapshot = ProjectSnapshot & {
  conceptStatus: ConceptStatusView;
};

function withConceptStatus(snapshot: ProjectSnapshot): ApiProjectSnapshot {
  const conceptStatus = getCapabilityGraph().conceptGeneration.describeConceptStatus(
    snapshot.brief,
    snapshot.artworkVersions,
    snapshot.designBriefVersions,
  );
  return { ...snapshot, conceptStatus };
}

export async function startConversation(): Promise<ApiProjectSnapshot> {
  return withConceptStatus(await getCapabilityGraph().conversation.start());
}

export async function getConversation(
  projectId: string,
): Promise<ApiProjectSnapshot | null> {
  const snapshot = await getCapabilityGraph().conversation.get(projectId);
  return snapshot ? withConceptStatus(snapshot) : null;
}

export async function handleUserMessage(
  projectId: string,
  content: string,
): Promise<ApiProjectSnapshot> {
  const snapshot = await getCapabilityGraph().conversation.handleUserMessage(
    projectId,
    content,
  );
  return withConceptStatus(snapshot);
}

export async function selectConcept(
  projectId: string,
  artworkVersionId: string,
): Promise<ApiProjectSnapshot> {
  const snapshot = await getCapabilityGraph().conversation.selectConcept(
    projectId,
    artworkVersionId,
  );
  return withConceptStatus(snapshot);
}

/**
 * Sprint 2D: Approve / Edit / Continue in response to a presented Design
 * Summary. Approval is idempotent and is the only path that can trigger
 * concept generation.
 */
export async function submitDesignBriefDecision(
  projectId: string,
  action: DesignBriefDecisionAction,
): Promise<ApiProjectSnapshot> {
  const snapshot = await getCapabilityGraph().conversation.submitDesignBriefDecision(
    projectId,
    action,
  );
  return withConceptStatus(snapshot);
}

/** Sprint 2G Part 3: explicit action behind the persistent "Generate Updated Concepts" control. */
export async function regenerateConcepts(
  projectId: string,
): Promise<ApiProjectSnapshot> {
  const snapshot = await getCapabilityGraph().conversation.regenerateConcepts(
    projectId,
  );
  return withConceptStatus(snapshot);
}

/** Sprint 2G Part 3: explicit action behind an "Undo" control. */
export async function undoLastChange(
  projectId: string,
): Promise<ApiProjectSnapshot> {
  const snapshot = await getCapabilityGraph().conversation.undoLastChange(
    projectId,
  );
  return withConceptStatus(snapshot);
}

/**
 * Sprint 2H Part 2B: provider-neutral generation status, safe for the
 * conversation to poll every few seconds — no job id, no provider name, no
 * queue detail. Purely read-only: a status read and nothing else. It never
 * recovers abandoned jobs, never claims work, and never runs generation —
 * that all belongs to the independent worker (the protected worker
 * endpoint, a scheduled trigger, or a standalone worker process; see
 * `capabilities/worker-scheduler/`), never to a customer's browser polling
 * this endpoint. Polling only answers "what does the customer see right
 * now" — it must never be a hidden way to make progress happen.
 */
export type GenerationStatus = "idle" | "generating" | "ready" | "failed";

export interface GenerationStatusView {
  status: GenerationStatus;
}

function toGenerationStatusView(status: ProjectStatus): GenerationStatusView {
  if (status === "generating") return { status: "generating" };
  if (status === "concepts_ready") return { status: "ready" };
  if (status === "failed") return { status: "failed" };
  return { status: "idle" };
}

export async function getGenerationStatus(
  projectId: string,
): Promise<GenerationStatusView | null> {
  const snapshot = await getCapabilityGraph().conversation.get(projectId);
  if (!snapshot) return null;
  return toGenerationStatusView(snapshot.project.status);
}
