/**
 * Phase R6A (Geometry-Qualified Clean Master v1): stable facade for the
 * geometry-qualification API route, mirroring
 * `artwork-reconstruction-service.ts`'s own role and cross-capability
 * orchestration rule exactly (`capability-boundaries.ts`: cross-capability
 * orchestration lives at the app layer, never inside a capability).
 *
 * BACKFILL: `ensureCurrentGeometryQualification` is the "normal
 * customer/runtime path" the R6A task's own Section 11/16 describes — it
 * resolves whatever reconstruction job is CURRENTLY accepted for this
 * project and idempotently qualifies it, requiring NO new upload, NO new
 * reconstruction, NO provider call, NO fidelity/wording/mark
 * reconfirmation. Called every time the project's conversation snapshot is
 * assembled (`conversation-service.ts`'s own `resolveGeometryQualificationView`)
 * — safe to call repeatedly because `ArtworkGeometryQualificationCapability
 * .ensureQualification` is itself idempotent.
 */

import { getCapabilityGraph } from "@/capabilities/composition";
import {
  ArtworkGeometryQualificationAuthorityError,
  ArtworkGeometryQualificationStateError,
} from "@/capabilities/artwork-reconstruction";
import {
  getConversation,
  type ApiProjectSnapshot,
} from "@/lib/services/conversation-service";

export class ArtworkGeometryQualificationServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtworkGeometryQualificationServiceError";
  }
}

export {
  ArtworkGeometryQualificationAuthorityError,
  ArtworkGeometryQualificationStateError,
};

/**
 * Idempotently ensures a geometry-qualification row exists for the
 * project's CURRENT accepted reconstruction, if one exists. `null` when
 * there is no current accepted reconstruction at all (nothing to qualify
 * yet) — never a throw for that ordinary case. Swallows authority/state
 * refusals to `null` too: those mean "not qualifiable right now" (e.g. a
 * contract correction landed between approval and this call), which is
 * advisory information for the flow-routing layer, never a customer-facing
 * error on an ordinary project load.
 */
export async function ensureCurrentGeometryQualification(projectId: string) {
  const graph = getCapabilityGraph();
  const contract = await graph.artworkFidelity.getContract(projectId);
  if (!contract || contract.status !== "confirmed") return null;
  const job = await graph.artworkReconstruction.getCurrentAcceptedMaster(
    projectId,
    contract.sourceAssetId,
  );
  if (!job) return null;
  try {
    return await graph.artworkGeometryQualification.ensureQualification(projectId, job.id);
  } catch (error) {
    if (
      error instanceof ArtworkGeometryQualificationAuthorityError ||
      error instanceof ArtworkGeometryQualificationStateError
    ) {
      return null;
    }
    throw error;
  }
}

export async function confirmGeometryQualification(
  projectId: string,
): Promise<ApiProjectSnapshot> {
  const graph = getCapabilityGraph();
  await graph.artworkGeometryQualification.confirmQualification(projectId, "customer");
  return requireSnapshot(projectId);
}

export async function rejectGeometryQualification(
  projectId: string,
): Promise<ApiProjectSnapshot> {
  const graph = getCapabilityGraph();
  await graph.artworkGeometryQualification.rejectQualification(projectId);
  return requireSnapshot(projectId);
}

/**
 * Mints a short-lived signed URL for the CURRENT geometry qualification's
 * derivative image — mirrors `getReconstructionCandidateImageUrl`'s own
 * role-based, asset-id-hiding shape exactly. `null` whenever no derivative
 * exists yet (pending qualification, or qualification abstained), never a
 * throw.
 */
export async function getGeometryQualificationDerivativeImageUrl(
  projectId: string,
): Promise<{ url: string } | null> {
  const graph = getCapabilityGraph();
  const contract = await graph.artworkFidelity.getContract(projectId);
  if (!contract || contract.status !== "confirmed") return null;
  const job = await graph.artworkReconstruction.getCurrentAcceptedMaster(
    projectId,
    contract.sourceAssetId,
  );
  if (!job) return null;
  const qualification = await graph.artworkGeometryQualification.getQualificationByJob(job.id);
  if (!qualification?.derivedAssetId) return null;
  const url = await graph.assets.getSignedUrl(qualification.derivedAssetId);
  return url ? { url } : null;
}

async function requireSnapshot(projectId: string): Promise<ApiProjectSnapshot> {
  const snapshot = await getConversation(projectId);
  if (!snapshot) throw new ArtworkGeometryQualificationServiceError("Project not found");
  return snapshot;
}
