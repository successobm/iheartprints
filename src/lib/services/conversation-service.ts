import type { ArtworkPreparationView } from "@/capabilities/artwork-preparation";
import { getCapabilityGraph } from "@/capabilities/composition";
import type { DesignBriefDecisionAction } from "@/capabilities/conversation";
import {
  toCustomerArtworkVersions,
  toCustomerConceptStatusView,
  type CustomerArtworkVersion,
  type CustomerConceptStatusView,
} from "@/capabilities/shared/contracts";
import {
  describePrintReadySize,
  type PrintReadySizeView,
} from "@/capabilities/shared/print-ready-size";
import type { ProjectSnapshot, ProjectStatus } from "@/lib/domain/types";
import { printPlacementLabel } from "@/lib/domain/print-placement";
import {
  maybeRecoverStrandedLocalFinalArtworkJobs,
  maybeTriggerLocalFinalArtworkWorker,
  type LocalFinalArtworkTriggerReason,
} from "@/lib/services/local-final-artwork-trigger";
import {
  maybeRecoverStrandedLocalGenerationJobs,
  maybeTriggerLocalGenerationWorker,
  type LocalGenerationTriggerReason,
} from "@/lib/services/local-generation-trigger";
import { buildPrintReadyFilename } from "@/lib/services/print-ready-filename";

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
  artworkVersions: CustomerArtworkVersion[];
  conceptStatus: CustomerConceptStatusView;
  finalization: CustomerFinalizationView;
  /**
   * Live Acceptance Cleanup (Issue 5): the physical size the selected
   * concept will be prepared at, so the customer can decide before
   * finalization starts rather than discovering it afterwards. `null` when
   * there is nothing to state honestly — no concept selected, or no print
   * placement known yet. Every figure is derived server-side from the one
   * placement policy table; no client component computes inches.
   */
  printReadySize: PrintReadySizeView | null;
  /**
   * Existing Artwork → Print Ready Phase 1: the Upload Existing Artwork
   * workflow's state, already phrased for the customer (no analysis numbers,
   * no asset ids, no storage keys). `null` for every Create New Artwork
   * project — and that `null` IS the workflow identity the UI branches on,
   * which is why Phase 1 needs no workflow enum anywhere.
   */
  artworkPreparation: ArtworkPreparationView | null;
};

async function withConceptStatus(
  snapshot: ProjectSnapshot,
): Promise<ApiProjectSnapshot> {
  const conceptStatus = getCapabilityGraph().conceptGeneration.describeConceptStatus(
    snapshot.brief,
    snapshot.artworkVersions,
    snapshot.designBriefVersions,
  );
  const artworkPreparation = await resolveArtworkPreparation(snapshot.project.id);
  return {
    ...snapshot,
    artworkVersions: toCustomerArtworkVersions(snapshot.artworkVersions),
    conceptStatus: toCustomerConceptStatusView(conceptStatus),
    finalization: toCustomerFinalizationView(snapshot.project.status),
    printReadySize: await resolvePrintReadySize(snapshot, artworkPreparation),
    artworkPreparation,
  };
}

/**
 * Never allowed to take down a snapshot the customer is waiting on: a project
 * with no preparation is the overwhelmingly common case, and a lookup failure
 * must degrade to "no uploaded artwork" rather than a failed page load. Same
 * advisory-not-a-gate rule as `resolvePrintReadySize`.
 */
async function resolveArtworkPreparation(
  projectId: string,
): Promise<ArtworkPreparationView | null> {
  try {
    return await getCapabilityGraph().artworkPreparation.getPreparation(projectId);
  } catch {
    return null;
  }
}

/**
 * Live Acceptance Cleanup (Issue 5). Height comes from the SELECTED
 * concept's own pixel aspect ratio through the same
 * `resolveWidthConstrainedSizing` the production transform uses, so the
 * size shown before finalizing and the plate produced afterwards are the
 * same arithmetic rather than two independent estimates. When the artwork's
 * dimensions aren't resolvable, height is reported as unknown rather than
 * guessed.
 *
 * Skipped entirely once artwork is print-ready — the delivery card shows the
 * plate's real measured size at that point, which is strictly better than a
 * pre-finalization projection.
 */
async function resolvePrintReadySize(
  snapshot: ProjectSnapshot,
  preparation: ArtworkPreparationView | null,
): Promise<PrintReadySizeView | null> {
  // Existing Artwork → Print Ready Phase 2: an upload project has no
  // "selected concept" and never will — its production artwork is the
  // prepared upload the customer approved. Height comes from that artwork's
  // OWN visible bounds rather than its canvas, because the production
  // transform trims to those bounds before sizing; quoting the canvas would
  // promise a height the finished plate will not have.
  //
  // Unlike the create_new path below, this is NOT skipped once the artwork is
  // print-ready. A create_new customer who wants a different size reopens the
  // creative loop they are still in ("Make Another Change"); an upload
  // customer has no creative loop, so this control is their only route to a
  // different size, and hiding it would strand them.
  if (preparation?.approved) {
    return describePrintReadySize({
      printPlacement: snapshot.brief.printPlacement,
      intendedPrintWidthIn: snapshot.brief.intendedPrintWidthIn,
      artworkWidthPx: preparation.visibleArtworkWidthPx,
      artworkHeightPx: preparation.visibleArtworkHeightPx,
    });
  }

  if (snapshot.project.status === "print_ready") return null;

  const selectedId = snapshot.project.selectedArtworkVersionId;
  if (!selectedId) return null;

  const selected = snapshot.artworkVersions.find(
    (version) => version.id === selectedId,
  );
  if (!selected) return null;

  let artworkWidthPx: number | null = null;
  let artworkHeightPx: number | null = null;
  if (selected.primaryAssetId) {
    try {
      const assets = await getCapabilityGraph().assets.listAssets(
        snapshot.project.id,
      );
      const asset = assets.find((item) => item.id === selected.primaryAssetId);
      artworkWidthPx = asset?.widthPx ?? null;
      artworkHeightPx = asset?.heightPx ?? null;
    } catch {
      // Size is advisory copy, never a gate — an asset lookup failure must
      // not take down the whole snapshot the customer is waiting on.
      artworkWidthPx = null;
      artworkHeightPx = null;
    }
  }

  return describePrintReadySize({
    printPlacement: snapshot.brief.printPlacement,
    intendedPrintWidthIn: snapshot.brief.intendedPrintWidthIn,
    artworkWidthPx,
    artworkHeightPx,
  });
}

export async function startConversation(): Promise<ApiProjectSnapshot> {
  return await withConceptStatus(await getCapabilityGraph().conversation.start());
}

/**
 * Loading a project also repairs a generation request that a previous turn
 * left half-applied — an approved brief or a pending revision with no
 * `GenerationJob` behind it. See
 * `ConversationCapability.recoverInterruptedGenerationRequest` for why
 * those states are otherwise terminal, and why completing them honors the
 * customer's existing instruction rather than generating on the platform's
 * own initiative. Awaited, not fired and forgotten, so the snapshot the
 * customer receives already reflects the recovered work instead of a stale
 * "approved but idle".
 */
export async function getConversation(
  projectId: string,
): Promise<ApiProjectSnapshot | null> {
  const snapshot =
    await getCapabilityGraph().conversation.recoverInterruptedGenerationRequest(
      projectId,
    );
  if (!snapshot) return null;
  const apiSnapshot = await withConceptStatus(snapshot);
  if (apiSnapshot.project.status === "generating") {
    // A job this call just recovered is `queued` with zero attempts, which
    // is exactly what the existing stranded-job trigger already picks up in
    // interactive dev — no second trigger needed here.
    void maybeRecoverStrandedLocalGenerationJobs(projectId, "project_reload");
  }
  if (apiSnapshot.project.status === "finalizing") {
    void maybeRecoverStrandedLocalFinalArtworkJobs(projectId, "project_reload");
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
  const apiSnapshot = await withConceptStatus(snapshot);
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
 * Live Acceptance Corrective Pass (Section 2): the customer's explicit "no
 * more changes, use this design" confirmation — the [Use This Design]
 * action. Distinct from, and strictly stronger than, `selectConcept`;
 * `FinalArtworkCapability.requestFinalArtwork` refuses to finalize without
 * it, independent of revision-pending state.
 */
export async function confirmSelectedDirection(
  projectId: string,
  artworkVersionId: string,
): Promise<ApiProjectSnapshot> {
  const snapshot = await getCapabilityGraph().conversation.confirmSelectedDirection(
    projectId,
    artworkVersionId,
  );
  return withConceptStatus(snapshot);
}

/**
 * Sprint 2M Phase 2B: the customer's explicit "this is my final direction —
 * prepare it for production" action. Idempotent — see `FinalArtworkCapability`.
 * Interactive `next dev` kicks the in-process final-artwork scheduler after a
 * durable claimable enqueue (mirrors generation's local trigger).
 */
export async function approveFinalDirection(
  projectId: string,
  artworkVersionId: string,
): Promise<ApiProjectSnapshot> {
  const snapshot = await getCapabilityGraph().conversation.approveFinalDirection(
    projectId,
    artworkVersionId,
  );
  const apiSnapshot = await withConceptStatus(snapshot);
  maybeKickLocalFinalArtworkWorker(
    projectId,
    apiSnapshot,
    "approve_final_direction",
  );
  return apiSnapshot;
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
  const apiSnapshot = await withConceptStatus(snapshot);
  if (action === "approve") {
    maybeKickLocalGenerationWorker(projectId, apiSnapshot, "approve_brief");
  }
  return apiSnapshot;
}

/**
 * Live Acceptance Cleanup (Issue 2): explicit "Change Selection" action.
 * Server-owned — never a client-side visual reset. See
 * `ConversationCapability.unselectConcept`.
 */
export async function unselectConcept(
  projectId: string,
): Promise<ApiProjectSnapshot> {
  return withConceptStatus(
    await getCapabilityGraph().conversation.unselectConcept(projectId),
  );
}

/**
 * Live Acceptance Cleanup (Issue 3): explicit "Show Me 3 New Concepts"
 * action — a fresh batch of three directions from the same approved brief.
 */
export async function exploreNewConceptBatch(
  projectId: string,
): Promise<ApiProjectSnapshot> {
  const snapshot =
    await getCapabilityGraph().conversation.exploreNewConceptBatch(projectId);
  const apiSnapshot = await withConceptStatus(snapshot);
  maybeKickLocalGenerationWorker(projectId, apiSnapshot, "regenerate_concepts");
  return apiSnapshot;
}

/**
 * Live Acceptance Cleanup (Issue 5): explicit "Change Size" action. A
 * production-specification change only — never generation, never a creative
 * revision, never a provider call.
 */
export async function setProductionPrintWidth(
  projectId: string,
  requestedWidthIn: number | null,
): Promise<ApiProjectSnapshot> {
  return withConceptStatus(
    await getCapabilityGraph().conversation.setProductionPrintWidth(
      projectId,
      requestedWidthIn,
    ),
  );
}

/** Sprint 2G Part 3: explicit action behind the persistent "Generate Updated Concepts" control. */
export async function regenerateConcepts(
  projectId: string,
): Promise<ApiProjectSnapshot> {
  const snapshot = await getCapabilityGraph().conversation.regenerateConcepts(
    projectId,
  );
  const apiSnapshot = await withConceptStatus(snapshot);
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
 * Interactive `next dev` only: after FinalArtworkJob enqueue persistence,
 * kick the in-process final-artwork scheduler so local Prepare Print-Ready
 * does not wait on a manual `POST /api/worker/final-artwork`. Production
 * and automated tests no-op — shared policy in
 * `local-generation-trigger-policy.ts`. Never throws to the customer request.
 */
function maybeKickLocalFinalArtworkWorker(
  projectId: string,
  snapshot: ApiProjectSnapshot,
  reason: LocalFinalArtworkTriggerReason,
): void {
  if (snapshot.project.status !== "finalizing") return;
  maybeTriggerLocalFinalArtworkWorker({ projectId, reason });
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
 * Customer-safe finalization status — the finalization counterpart of
 * `getGenerationStatus`. Same sanitization choke point as the snapshot's
 * `finalization` view (`toCustomerFinalizationView`): never a job id,
 * provider name, queue detail, or storage key. Production and automated
 * tests are purely read-only. Interactive `next dev` only may kick a
 * stranded `queued`/`attempts=0` FinalArtworkJob (missed post-enqueue
 * trigger or stale HMR) via `maybeRecoverStrandedLocalFinalArtworkJobs`.
 * Polling still never revives a failed/cancelled/completed job and never
 * calls a provider itself.
 */
export async function getFinalizationStatus(
  projectId: string,
): Promise<CustomerFinalizationView | null> {
  const snapshot = await getCapabilityGraph().conversation.get(projectId);
  if (!snapshot) return null;
  if (snapshot.project.status === "finalizing") {
    void maybeRecoverStrandedLocalFinalArtworkJobs(projectId, "status_poll");
  }
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
  /** Customer-safe download basename suggestion (e.g. `1988-toyota-mr2-print-ready.png`). */
  filename: string;
  mimeType: string;
  widthPx: number | null;
  heightPx: number | null;
  transparent: boolean | null;
  /** Plain-language print placement, e.g. "Full Front". */
  placementLabel: string | null;
  /** Customer-facing design label (required wording, else product summary). */
  designLabel: string | null;
  /**
   * Live Acceptance Cleanup (Issue 5): the plate's ACTUAL physical print
   * size and resolution, read from the production normalization record
   * persisted with the asset — never the placement default, and never
   * re-derived here. A customer who chose 12" must see 12", not a stale 10.5".
   * `null` for a production asset created before normalization recorded it.
   */
  widthIn: number | null;
  heightIn: number | null;
  dpi: number | null;
}

/**
 * Sprint 2M Phase 2C (Goal 14) + delivery-mode: the secure read boundary for
 * print-ready production artwork preview/download. Returns a fresh,
 * short-lived signed URL plus customer-safe metadata for the project's
 * current print-ready production PNG, or `null` on any miss (project not
 * found, not print-ready yet, or no production asset resolvable) — every
 * miss is deliberately indistinguishable. Never exposes asset/job/provider
 * ids or storage paths. Only ever exposes a URL once
 * `PrintProject.status === "print_ready"`.
 */
export async function getProductionArtworkUrl(
  projectId: string,
): Promise<ProductionArtworkView | null> {
  const resolved = await resolveCurrentProductionArtwork(projectId);
  if (!resolved) return null;

  const url = await getCapabilityGraph().assets.getSignedUrl(resolved.assetId);
  if (!url) return null;

  return {
    url,
    filename: resolved.filename,
    mimeType: resolved.mimeType,
    widthPx: resolved.widthPx,
    heightPx: resolved.heightPx,
    transparent: resolved.transparent,
    placementLabel: resolved.placementLabel,
    designLabel: resolved.designLabel,
    widthIn: resolved.widthIn,
    heightIn: resolved.heightIn,
    dpi: resolved.dpi,
  };
}

/**
 * Streams the current print-ready production PNG for a forced download with
 * a customer-safe Content-Disposition filename. Same authorization gates as
 * `getProductionArtworkUrl` — never a storage path or internal id.
 */
export async function getProductionArtworkDownload(
  projectId: string,
): Promise<{
  bytes: Buffer;
  contentType: string;
  filename: string;
} | null> {
  const resolved = await resolveCurrentProductionArtwork(projectId);
  if (!resolved) return null;

  const downloaded = await getCapabilityGraph().assets.downloadAssetBytes(
    resolved.assetId,
  );
  if (!downloaded) return null;

  return {
    bytes: downloaded.bytes,
    contentType: downloaded.contentType || resolved.mimeType,
    filename: resolved.filename,
  };
}

async function resolveCurrentProductionArtwork(projectId: string): Promise<{
  assetId: string;
  filename: string;
  mimeType: string;
  widthPx: number | null;
  heightPx: number | null;
  transparent: boolean | null;
  placementLabel: string | null;
  designLabel: string | null;
  widthIn: number | null;
  heightIn: number | null;
  dpi: number | null;
} | null> {
  const graph = getCapabilityGraph();
  const snapshot = await graph.conversation.get(projectId);
  if (!snapshot || snapshot.project.status !== "print_ready") return null;

  const assetId = await graph.finalArtwork.getCurrentProductionAssetId(projectId);
  if (!assetId) return null;

  const assets = await graph.assets.listAssets(projectId);
  const asset = assets.find((item) => item.id === assetId);
  if (!asset || asset.productionRole !== "production_png") return null;

  const placementRaw = printPlacementLabel(snapshot.brief.printPlacement);
  const placementLabel = placementRaw
    ? placementRaw.replace(/\b\w/g, (char) => char.toUpperCase())
    : null;
  const designLabel =
    snapshot.brief.exactText?.trim() ||
    snapshot.brief.productSummary?.trim() ||
    null;
  const mimeType = asset.contentType ?? "image/png";
  // The plate's own recorded production geometry (Print-Ready Normalization
  // Phase 1 writes it alongside the bytes) — the only honest source for
  // "what size is this file", since it is what the transform actually
  // produced rather than what policy would have asked for today.
  const normalization = asset.metadata?.normalization as
    | Record<string, unknown>
    | undefined;

  // Existing Artwork → Print Ready Phase 2: for an upload project, the
  // customer's own filename is the name they will recognize — see
  // `buildPrintReadyFilename`'s precedence. Resolved through the same
  // never-take-down-the-request helper as everywhere else: a filename is
  // presentation, and a lookup failure must degrade to the brief-derived
  // name rather than fail the download.
  const preparation = await resolveArtworkPreparation(projectId);

  return {
    assetId,
    widthIn: readFiniteNumber(normalization?.intendedWidthIn),
    heightIn: readFiniteNumber(normalization?.intendedHeightIn),
    dpi: readFiniteNumber(normalization?.targetPpi),
    filename: buildPrintReadyFilename({
      uploadedFilename: preparation?.originalFilename ?? null,
      exactText: snapshot.brief.exactText,
      productSummary: snapshot.brief.productSummary,
      mimeType,
    }),
    mimeType,
    widthPx: asset.widthPx,
    heightPx: asset.heightPx,
    transparent: asset.hasTransparency,
    placementLabel,
    designLabel,
  };
}

function readFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
