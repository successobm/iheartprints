import { getCapabilityGraph } from "@/capabilities/composition";
import type { DesignBriefDecisionAction } from "@/capabilities/conversation";
import {
  toCustomerArtworkVersion,
  toCustomerConceptStatusView,
  type CustomerConceptStatusView,
} from "@/capabilities/shared/contracts";
import type { ProjectSnapshot, ProjectStatus } from "@/lib/domain/types";
import {
  maybeRecoverStrandedLocalGenerationJobs,
  maybeTriggerLocalGenerationWorker,
  type LocalGenerationTriggerReason,
} from "@/lib/services/local-generation-trigger";

/**
 * Stable facade for API routes and existing tests.
 * Delegates to the ConversationCapability composition root.
 *
 * Sprint 2G Part 3: every snapshot-returning function also attaches
 * `conceptStatus` — computed fresh from already-public snapshot data via
 * `ConceptGenerationCapability.describeConceptStatus`, not a new capability
 * dependency — so the UI's persistent concept-status action reflects
 * reality on every fetch, not only right after a revision turn.
 *
 * Sprint 2K Phase 1: this is also the one place that shapes `ArtworkVersion`
 * into the browser-safe `CustomerArtworkVersion` (see contracts.ts) before
 * it leaves the server — every route funnels through the functions below,
 * so there is a single choke point rather than per-route sanitization.
 */

/**
 * Sprint 2M Phase 2B/2C: customer-safe finalization state, derived entirely
 * from `PrintProject.status` — never a raw job/approval id, internal job
 * status string, validation rule id, or other detail (Goal 13/16).
 * `"preparing"` covers both "still in progress" and, honestly, "genuinely
 * unfinished infrastructure state" — it is never claimed until authoritative
 * Print Validation actually returns `ready` (Constitution §15).
 * `"needs_review"` (Sprint 2M Phase 2C) is the truthful third state Phase 2B
 * could not yet produce: the worker ran to completion and a real production
 * asset exists, but it honestly is not print-ready yet.
 */
export type CustomerFinalizationStatus =
  | "not_requested"
  | "preparing"
  | "needs_review"
  | "print_ready";

export interface CustomerFinalizationView {
  status: CustomerFinalizationStatus;
}

function toCustomerFinalizationView(
  status: ProjectStatus,
): CustomerFinalizationView {
  if (status === "finalizing") return { status: "preparing" };
  if (status === "finalization_required") return { status: "needs_review" };
  if (status === "print_ready") return { status: "print_ready" };
  return { status: "not_requested" };
}

export type ApiProjectSnapshot = Omit<ProjectSnapshot, "artworkVersions"> & {
  artworkVersions: ReturnType<typeof toCustomerArtworkVersion>[];
  conceptStatus: CustomerConceptStatusView;
  finalization: CustomerFinalizationView;
};

function withConceptStatus(snapshot: ProjectSnapshot): ApiProjectSnapshot {
  const conceptStatus = getCapabilityGraph().conceptGeneration.describeConceptStatus(
    snapshot.brief,
    snapshot.artworkVersions,
    snapshot.designBriefVersions,
  );
  return {
    ...snapshot,
    artworkVersions: snapshot.artworkVersions.map(toCustomerArtworkVersion),
    conceptStatus: toCustomerConceptStatusView(conceptStatus),
    finalization: toCustomerFinalizationView(snapshot.project.status),
  };
}

export async function startConversation(): Promise<ApiProjectSnapshot> {
  return withConceptStatus(await getCapabilityGraph().conversation.start());
}

export async function getConversation(
  projectId: string,
): Promise<ApiProjectSnapshot | null> {
  const snapshot = await getCapabilityGraph().conversation.get(projectId);
  if (!snapshot) return null;
  const apiSnapshot = withConceptStatus(snapshot);
  if (apiSnapshot.project.status === "generating") {
    void maybeRecoverStrandedLocalGenerationJobs(projectId, "project_reload");
  }
  return apiSnapshot;
}

export async function handleUserMessage(
  projectId: string,
  content: string,
): Promise<ApiProjectSnapshot> {
  const snapshot = await getCapabilityGraph().conversation.handleUserMessage(
    projectId,
    content,
  );
  const apiSnapshot = withConceptStatus(snapshot);
  maybeKickLocalGenerationWorker(projectId, apiSnapshot, "conversation_message");
  return apiSnapshot;
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
 * Sprint 2M Phase 2B: the customer's explicit "this is my final direction —
 * prepare it for production" action. Idempotent — see `FinalArtworkCapability`.
 */
export async function approveFinalDirection(
  projectId: string,
  artworkVersionId: string,
): Promise<ApiProjectSnapshot> {
  const snapshot = await getCapabilityGraph().conversation.approveFinalDirection(
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
  const apiSnapshot = withConceptStatus(snapshot);
  if (action === "approve") {
    maybeKickLocalGenerationWorker(projectId, apiSnapshot, "approve_brief");
  }
  return apiSnapshot;
}

/** Sprint 2G Part 3: explicit action behind the persistent "Generate Updated Concepts" control. */
export async function regenerateConcepts(
  projectId: string,
): Promise<ApiProjectSnapshot> {
  const snapshot = await getCapabilityGraph().conversation.regenerateConcepts(
    projectId,
  );
  const apiSnapshot = withConceptStatus(snapshot);
  maybeKickLocalGenerationWorker(projectId, apiSnapshot, "regenerate_concepts");
  return apiSnapshot;
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
 * Interactive `next dev` only: after enqueue persistence, kick the in-process
 * scheduler so local Approve/Create Concepts does not wait on a manual
 * `POST /api/worker/generation`. Production and automated tests no-op — see
 * `local-generation-trigger-policy.ts`. Never throws to the customer request.
 */
function maybeKickLocalGenerationWorker(
  projectId: string,
  snapshot: ApiProjectSnapshot,
  reason: LocalGenerationTriggerReason,
): void {
  if (snapshot.project.status !== "generating") return;
  maybeTriggerLocalGenerationWorker({ projectId, reason });
}

/**
 * Sprint 2H Part 2B: provider-neutral generation status, safe for the
 * conversation to poll every few seconds — no job id, no provider name, no
 * queue detail. Production and automated tests are purely read-only: a
 * status read and nothing else. They never recover abandoned jobs, never
 * claim work, and never run generation. Interactive `next dev` only may
 * kick a stranded `queued`/`attempts=0` job (missed post-enqueue trigger
 * or stale HMR) via `maybeRecoverStrandedLocalGenerationJobs`. Polling
 * still never revives a running/failed job and never calls a provider
 * itself.
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
  if (snapshot.project.status === "generating") {
    void maybeRecoverStrandedLocalGenerationJobs(projectId, "status_poll");
  }
  return toGenerationStatusView(snapshot.project.status);
}

/**
 * Read-only customer-safe finalization status — the finalization counterpart
 * of `getGenerationStatus`. Same sanitization choke point as the snapshot's
 * `finalization` view (`toCustomerFinalizationView`): never a job id,
 * provider name, queue detail, or storage key. Polling this must never
 * recover abandoned jobs, claim work, revive a failed job, or call a
 * provider.
 */
export async function getFinalizationStatus(
  projectId: string,
): Promise<CustomerFinalizationView | null> {
  const snapshot = await getCapabilityGraph().conversation.get(projectId);
  if (!snapshot) return null;
  return toCustomerFinalizationView(snapshot.project.status);
}

export interface ConceptImageView {
  /** Short-lived signed URL from `AssetCapability.getSignedUrl` — never a raw object key. */
  url: string;
}

/**
 * Sprint 2K Phase 1: the only path from a browser-visible `artworkVersionId`
 * to a real, renderable image. Looks the concept up in the internal
 * (unsanitized) snapshot purely to find its `primaryAssetId`, then asks
 * `AssetCapability` for a fresh signed URL — the asset id itself never
 * leaves the server. Returns `null` whenever the project, the concept, or a
 * generated image doesn't exist, so callers can render a uniform 404
 * without leaking which case applied.
 */
export async function getConceptImageUrl(
  projectId: string,
  artworkVersionId: string,
): Promise<ConceptImageView | null> {
  const graph = getCapabilityGraph();
  const snapshot = await graph.conversation.get(projectId);
  if (!snapshot) return null;

  const artwork = snapshot.artworkVersions.find(
    (version) => version.id === artworkVersionId && version.projectId === projectId,
  );
  if (!artwork || !artwork.primaryAssetId) return null;

  const url = await graph.assets.getSignedUrl(artwork.primaryAssetId);
  return url ? { url } : null;
}

export interface ProductionArtworkView {
  /** Short-lived signed URL — never a raw object key, asset id, or job/approval id. */
  url: string;
}

/**
 * Sprint 2M Phase 2C (Goal 14): the secure read boundary for a future
 * download feature — not wired into any UI yet. Returns a fresh, short-lived
 * signed URL for the project's current print-ready production PNG, or
 * `null` on any miss (project not found, not print-ready yet, or no
 * production asset resolvable) — every miss is deliberately
 * indistinguishable so a caller can render a uniform 404 (mirrors
 * `getConceptImageUrl`). Only ever exposes a URL once `PrintProject.status
 * === "print_ready"` — never while merely "preparing" or "needs_review".
 */
export async function getProductionArtworkUrl(
  projectId: string,
): Promise<ProductionArtworkView | null> {
  const graph = getCapabilityGraph();
  const snapshot = await graph.conversation.get(projectId);
  if (!snapshot || snapshot.project.status !== "print_ready") return null;

  const assetId = await graph.finalArtwork.getCurrentProductionAssetId(projectId);
  if (!assetId) return null;

  const url = await graph.assets.getSignedUrl(assetId);
  return url ? { url } : null;
}
