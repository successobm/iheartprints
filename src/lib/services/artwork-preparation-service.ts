/**
 * Existing Artwork → Print Ready Phase 1: stable facade for the uploaded-
 * artwork API routes, mirroring `conversation-service.ts`'s role for the
 * Create New Artwork flow.
 *
 * Every function returns the SAME shape the chat surface already consumes
 * (`ApiProjectSnapshot`) with the preparation view attached, so the client
 * never has to reconcile two independently-fetched sources of truth about
 * one project.
 */

import { getCapabilityGraph } from "@/capabilities/composition";
import type {
  ArtworkPreparationView,
  GuidedCleanupOutcomeCode,
  GuidedRemovalPoint,
  UploadArtworkInput,
  UploadedArtworkContextInput,
} from "@/capabilities/artwork-preparation";
import {
  getConversation,
  type ApiProjectSnapshot,
} from "@/lib/services/conversation-service";
import { maybeTriggerLocalFinalArtworkWorker } from "@/lib/services/local-final-artwork-trigger";

export async function uploadArtwork(
  projectId: string,
  input: UploadArtworkInput,
): Promise<ApiProjectSnapshot> {
  await getCapabilityGraph().artworkPreparation.uploadOriginal(projectId, input);
  return requireSnapshot(projectId);
}

export async function setUploadedArtworkContext(
  projectId: string,
  input: UploadedArtworkContextInput,
): Promise<ApiProjectSnapshot> {
  await getCapabilityGraph().artworkPreparation.setProductionContext(
    projectId,
    input,
  );
  return requireSnapshot(projectId);
}

export async function prepareUploadedArtwork(
  projectId: string,
): Promise<ApiProjectSnapshot> {
  await getCapabilityGraph().artworkPreparation.prepareBackground(projectId);
  return requireSnapshot(projectId);
}

export async function approvePreparedArtwork(
  projectId: string,
): Promise<ApiProjectSnapshot> {
  await getCapabilityGraph().artworkPreparation.approvePreparedArtwork(projectId);
  return requireSnapshot(projectId);
}

/**
 * Existing Artwork → Print Ready Phase 1.2: one guided-cleanup action, plus
 * the refreshed project snapshot.
 *
 * The outcome rides ALONGSIDE the snapshot rather than inside it, because it
 * describes THIS click rather than the state of the project — "that looks like
 * part of your artwork" is not a fact about the preparation, and persisting it
 * anywhere would make it reappear after a reload that has nothing to do with
 * it.
 */
export interface GuidedCleanupResponse extends ApiProjectSnapshot {
  cleanup: {
    outcome: GuidedCleanupOutcomeCode;
    /** Already-phrased by `preparation-copy.ts`. Rendered verbatim. */
    message: string;
  };
}

export async function applyGuidedCleanup(
  projectId: string,
  point: GuidedRemovalPoint,
): Promise<GuidedCleanupResponse> {
  const result =
    await getCapabilityGraph().artworkPreparation.applyGuidedCleanup(
      projectId,
      point,
    );
  return {
    ...(await requireSnapshot(projectId)),
    cleanup: { outcome: result.outcome, message: result.message },
  };
}

export async function undoGuidedCleanup(
  projectId: string,
): Promise<GuidedCleanupResponse> {
  const result =
    await getCapabilityGraph().artworkPreparation.undoGuidedCleanup(projectId);
  return {
    ...(await requireSnapshot(projectId)),
    cleanup: { outcome: result.outcome, message: result.message },
  };
}

/**
 * Existing Artwork → Print Ready Phase 2: the customer's explicit "prepare my
 * print-ready artwork" action for artwork they uploaded.
 *
 * The upload workflow's counterpart to `approveFinalDirection` — same shape,
 * same idempotency guarantee, same interactive-dev worker kick. It takes no
 * artwork id, because there is nothing to choose: the project has exactly one
 * approved prepared artwork, and naming it from the client would only create a
 * value to forge (Goal 18).
 */
export async function prepareUploadedArtworkForPrint(
  projectId: string,
): Promise<ApiProjectSnapshot> {
  await getCapabilityGraph().finalArtwork.requestPreparedUploadFinalArtwork(
    projectId,
  );
  const snapshot = await requireSnapshot(projectId);
  // Interactive `next dev` only — production and automated tests no-op. Same
  // policy and the same scheduler as the create_new path; no second worker
  // exists for uploaded artwork (Goal 17).
  if (snapshot.project.status === "finalizing") {
    maybeTriggerLocalFinalArtworkWorker({
      projectId,
      reason: "prepare_uploaded_artwork",
    });
  }
  return snapshot;
}

export interface PreparedArtworkImageView {
  /** Short-lived signed URL from `AssetCapability.getSignedUrl` — never a raw object key. */
  url: string;
}

/**
 * The only path from a browser to a real, renderable uploaded-artwork image.
 * The browser names a ROLE ("original" / "prepared"), never an asset id — the
 * asset id never leaves the server, exactly as with concept images.
 *
 * Every miss (no project, no preparation, no prepared artwork yet, asset not
 * owned by this project) returns `null`, so a caller renders one
 * indistinguishable 404 rather than leaking which case applied.
 */
export async function getPreparationImageUrl(
  projectId: string,
  role: "original" | "prepared",
): Promise<PreparedArtworkImageView | null> {
  const graph = getCapabilityGraph();
  const assetId = await graph.artworkPreparation.resolveImageAssetId(
    projectId,
    role,
  );
  if (!assetId) return null;

  const url = await graph.assets.getSignedUrl(assetId);
  return url ? { url } : null;
}

/** Read-only preparation view, for callers that do not need the whole snapshot. */
export async function getArtworkPreparation(
  projectId: string,
): Promise<ArtworkPreparationView | null> {
  return getCapabilityGraph().artworkPreparation.getPreparation(projectId);
}

async function requireSnapshot(projectId: string): Promise<ApiProjectSnapshot> {
  const snapshot = await getConversation(projectId);
  if (!snapshot) throw new Error("Project not found");
  return snapshot;
}
