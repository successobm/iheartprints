/**
 * LIVE PRODUCT BLOCKER #1: the customer-facing bridge from the Existing
 * Artwork upload into the Signs production authority.
 *
 * The customer uploads ONE file through the ordinary Existing Artwork
 * upload step, before knowing (or being asked) whether it is DTF/apparel
 * or a sign — see `uploaded-artwork-flow.ts`'s `choose_artwork_type` step.
 * When they identify it as a Sign, this is the ONE place that turns those
 * SAME already-uploaded bytes into the Signs profile's own immutable
 * original (`SignPreparationCapability.uploadSignArtwork` — never a second
 * customer upload, never two sources of truth for "what did the customer
 * upload") and then records the human-confirmed ordered size on it
 * (`confirmSignProductionSpec`, Constitution §16A.2 — both dimensions,
 * explicit, never defaulted or inferred).
 *
 * Deliberately its own service file rather than folded into
 * `artwork-preparation-service.ts`: this composes TWO capabilities
 * (`ArtworkPreparationCapability` for the already-uploaded source,
 * `SignPreparationCapability` for the sign authority itself), and neither
 * capability may depend on the other (`ARCHITECTURE.md`'s
 * `SignPreparationCapability` dependency list is `ProjectRepository` +
 * `AssetCapability` only). That composition belongs at the app layer, same
 * as every other cross-capability orchestration in this file's siblings.
 */

import { getCapabilityGraph } from "@/capabilities/composition";
import {
  getConversation,
  type ApiProjectSnapshot,
} from "@/lib/services/conversation-service";

export class SignArtworkBridgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SignArtworkBridgeError";
  }
}

/**
 * Idempotent: a second call for a project that already has a
 * `SignPreparation` re-confirms the (possibly changed) size against the
 * SAME sign original rather than adopting the upload a second time —
 * `SignPreparationCapability.uploadSignArtwork` refuses a second upload for
 * one project by construction, so this only ever bridges once.
 */
export async function confirmSignArtworkSize(
  projectId: string,
  input: { orderedWidthIn: number; orderedHeightIn: number },
): Promise<ApiProjectSnapshot> {
  const graph = getCapabilityGraph();

  let signPreparation = await graph.signPreparation.getSignPreparation(projectId);
  if (!signPreparation) {
    const reference =
      await graph.artworkPreparation.getOriginalAssetReference(projectId);
    if (!reference) {
      throw new SignArtworkBridgeError(
        "Upload your artwork before choosing a sign size.",
      );
    }
    const downloaded = await graph.assets.downloadAssetBytes(reference.assetId);
    if (!downloaded) {
      throw new SignArtworkBridgeError(
        "We couldn't read your uploaded artwork. Please try uploading again.",
      );
    }
    signPreparation = await graph.signPreparation.uploadSignArtwork(projectId, {
      bytes: downloaded.bytes,
      declaredContentType: downloaded.contentType,
      filename: reference.filename,
    });
  }

  await graph.signPreparation.confirmSignProductionSpec(
    projectId,
    input.orderedWidthIn,
    input.orderedHeightIn,
  );

  const snapshot = await getConversation(projectId);
  if (!snapshot) {
    throw new SignArtworkBridgeError("Project not found");
  }
  return snapshot;
}
