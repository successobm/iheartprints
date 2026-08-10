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
  UploadArtworkInput,
  UploadedArtworkContextInput,
} from "@/capabilities/artwork-preparation";
import {
  getConversation,
  type ApiProjectSnapshot,
} from "@/lib/services/conversation-service";

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
