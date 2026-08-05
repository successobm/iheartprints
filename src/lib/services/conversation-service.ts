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
 * Sprint 2H Part 2A: fire-and-forget dispatch of the next queued generation
 * job. Call this right after an action that enqueues generation (approve,
 * regenerate) — never awaited by the caller, so the customer's HTTP
 * request returns as soon as the job is enqueued, not after a provider
 * call finishes. Safe to call even when nothing is queued (a no-op) and
 * safe to call more than once (the underlying claim is optimistic — at
 * most one caller ever actually runs a given job).
 *
 * In-flight promises are tracked only so tests can drain them before
 * deleting a temp workspace — callers still must not await this function.
 */
let inFlightGenerationWorkers: Promise<void> = Promise.resolve();

export function triggerGenerationWorker(): void {
  const run = getCapabilityGraph()
    .generationWorker.processNextJob()
    .then(
      () => undefined,
      () => undefined,
    );
  inFlightGenerationWorkers = inFlightGenerationWorkers.then(
    () => run,
    () => run,
  );
}

/** Test-only: wait for every fire-and-forget `triggerGenerationWorker` run to settle. */
export async function drainGenerationWorkersForTests(): Promise<void> {
  await inFlightGenerationWorkers;
}

/**
 * Sprint 2H Part 2A: provider-neutral generation status, safe for the
 * conversation to poll every few seconds — no job id, no provider name, no
 * queue detail. Cheap: no provider call, just a status read plus an
 * opportunistic (also cheap) sweep for abandoned jobs so a stuck
 * "generating" state gets flagged recoverable instead of hanging silently.
 * Recovering a job only changes its status here — actually resuming it
 * still goes through `triggerGenerationWorker` the next time generation is
 * (re-)enqueued.
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
  const graph = getCapabilityGraph();
  await graph.generationWorker.recoverAbandonedJobs();
  const snapshot = await graph.conversation.get(projectId);
  if (!snapshot) return null;
  return toGenerationStatusView(snapshot.project.status);
}
