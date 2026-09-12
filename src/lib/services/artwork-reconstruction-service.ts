/**
 * Phase R5 (Confirmed-Authority Raster Reconstruction v1): stable facade
 * for the artwork-reconstruction API route, mirroring
 * `artwork-fidelity-service.ts`'s own role and cross-capability
 * orchestration rule exactly (`capability-boundaries.ts`: cross-capability
 * orchestration lives at the app layer, never inside a capability).
 *
 * SOURCE BINDING: resolved the SAME way `artwork-fidelity-service.ts`
 * resolves it — `artworkPreparation.getOriginalAssetReference`, the same
 * immutable original both the fidelity confirmation step and (via
 * `bridgeSignArtworkIfNeeded`) the Signs path key off of. `sourceSha256` is
 * ALWAYS recomputed server-side from freshly downloaded bytes — never
 * trusted from a client request body.
 *
 * "Request reconstruction" runs one worker batch INLINE before returning,
 * so the customer sees a result (candidate or a clear failure) without a
 * separate polling step — mirrors `confirmSignArtworkSize`'s own
 * auto-chain-into-planning precedent. The job/claim machinery underneath
 * is what makes this safe to call again on a refresh (idempotent — see
 * `RasterReconstructionCapability.requestReconstruction`'s own doc
 * comment), not this inline call itself.
 */

import { getCapabilityGraph } from "@/capabilities/composition";
import { sha256Hex } from "@/capabilities/artwork-fidelity-proposal";
import {
  ArtworkReconstructionAuthorityError,
  ArtworkReconstructionStateError,
} from "@/capabilities/artwork-reconstruction";
import {
  getConversation,
  type ApiProjectSnapshot,
} from "@/lib/services/conversation-service";

export class ArtworkReconstructionServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtworkReconstructionServiceError";
  }
}

export {
  ArtworkReconstructionAuthorityError,
  ArtworkReconstructionStateError,
};

async function resolveOriginalSourceBytes(
  projectId: string,
): Promise<{ assetId: string; sha256: string }> {
  const graph = getCapabilityGraph();
  const reference = await graph.artworkPreparation.getOriginalAssetReference(projectId);
  if (!reference) {
    throw new ArtworkReconstructionServiceError(
      "Upload your artwork before it can be rebuilt.",
    );
  }
  const downloaded = await graph.assets.downloadAssetBytes(reference.assetId);
  if (!downloaded) {
    throw new ArtworkReconstructionServiceError(
      "We couldn't read your uploaded artwork. Please try uploading again.",
    );
  }
  return { assetId: reference.assetId, sha256: sha256Hex(downloaded.bytes) };
}

/**
 * The customer's explicit "Rebuild my artwork" action (Section 10 of the
 * R5 task: reconstruction is EXPLICITLY requested for this v1 slice, never
 * auto-triggered merely from a resolution-insufficiency signal).
 *
 * Requires a CONFIRMED fidelity contract for the CURRENT source — refuses
 * (no job created, no provider ever consulted) otherwise. See
 * `RasterReconstructionCapability.requestReconstruction`'s own doc comment
 * for the full authority re-verification this delegates to.
 */
export async function requestArtworkReconstruction(
  projectId: string,
): Promise<ApiProjectSnapshot> {
  const graph = getCapabilityGraph();
  const source = await resolveOriginalSourceBytes(projectId);

  const contract = await graph.artworkFidelity.getContract(projectId);
  if (!contract || contract.status !== "confirmed") {
    throw new ArtworkReconstructionAuthorityError(
      "Confirm what's in your artwork before it can be rebuilt.",
    );
  }

  await graph.artworkReconstruction.requestReconstruction(projectId, {
    sourceAssetId: source.assetId,
    currentSourceSha256: source.sha256,
    fidelityContractId: contract.id,
  });

  // Run one worker batch inline — see this file's own doc comment.
  await graph.artworkReconstructionScheduler.runBatch();

  return requireSnapshot(projectId);
}

export async function approveArtworkReconstruction(
  projectId: string,
  jobId: string,
): Promise<ApiProjectSnapshot> {
  const graph = getCapabilityGraph();
  await graph.artworkReconstruction.approveCandidate(projectId, jobId);
  return requireSnapshot(projectId);
}

export async function rejectArtworkReconstruction(
  projectId: string,
  jobId: string,
): Promise<ApiProjectSnapshot> {
  const graph = getCapabilityGraph();
  await graph.artworkReconstruction.rejectCandidate(projectId, jobId);
  return requireSnapshot(projectId);
}

/**
 * Mints a short-lived signed URL for the candidate image of the latest
 * reconstruction job for this project's current source — mirrors
 * `getPreparationImageUrl`'s own role-based, asset-id-hiding shape exactly.
 * `null` whenever no candidate exists yet (queued/running/failed), never a
 * throw.
 */
export async function getReconstructionCandidateImageUrl(
  projectId: string,
): Promise<{ url: string } | null> {
  const graph = getCapabilityGraph();
  const reference = await graph.artworkPreparation.getOriginalAssetReference(projectId);
  if (!reference) return null;
  const job = await graph.artworkReconstruction.getLatestJobForSource(
    projectId,
    reference.assetId,
  );
  if (!job?.candidateAssetId) return null;
  const url = await graph.assets.getSignedUrl(job.candidateAssetId);
  return url ? { url } : null;
}

async function requireSnapshot(projectId: string): Promise<ApiProjectSnapshot> {
  const snapshot = await getConversation(projectId);
  if (!snapshot) throw new ArtworkReconstructionServiceError("Project not found");
  return snapshot;
}
