/**
 * Signs QR Visual Revision Acceptance: the ONE place that answers "does
 * THIS exact production candidate contain a QR replacement that requires
 * a human to visually approve the revised artwork before it can be
 * delivered?" — reused identically by `final-artwork-capability.ts`'s own
 * delivery/blocked-candidate resolvers and by
 * `sign-plan-operator-review.ts`'s presentation-only peek, mirroring
 * `rigid-sign-print-ready-authority.ts`'s own "one authoritative function,
 * reused identically" discipline.
 *
 * WHY A LINEAGE WALK, NOT A FLAT METADATA READ:
 *
 *   `sign-qr-preservation-service.ts`'s `restoreSignQrCode` stamps
 *   `metadata.qrRestoration` directly on the asset it composites the
 *   replacement QR into. But a LATER, metadata-only derivative of that
 *   asset — today, only `repairSignPhysicalResolutionMetadata`'s pHYs
 *   repair (`metadata.physicalResolutionRepair.repairedFromAssetId`) —
 *   does NOT itself carry `qrRestoration`, even though its pixels are
 *   proven byte-for-byte identical to its parent's
 *   (`assertPhysicalResolutionRepairPreservesPixels`, asserted both
 *   pre- and post-persist). The real Get Hibachi production lineage is
 *   exactly this shape: `d5693652` (worker output, no QR) →
 *   `9783f071` (`qrRestoration` present — THE compositing step) →
 *   `6a76900f` (`physicalResolutionRepair` only — metadata-only, no
 *   `qrRestoration` of its own). Reading only the current candidate's own
 *   metadata would silently miss that this candidate's VISIBLE PIXELS
 *   still came from a QR replacement, and never require approval for it.
 *
 * Deliberately narrow: walks ONLY the metadata-only, pixel-preserving
 * derivative link(s) that exist today. A future derivative kind that
 * changes pixels must mint its OWN lineage decision (does IT count as a
 * new material revision requiring fresh approval?) rather than being
 * silently absorbed into this walk — see this module's own scope note in
 * the QR acceptance task this was built for: "do not automatically carry
 * review across arbitrary derivatives."
 */
import { isReconstructionIntermediateAsset } from "@/capabilities/final-artwork/production-request-identity";
import type { ProjectRepository } from "@/lib/db/repository";
import type { AssetRecord } from "@/lib/domain/types";

/** Defends against a corrupted/cyclic lineage chain — no real chain has ever been anywhere close to this deep. */
const MAX_LINEAGE_WALK_DEPTH = 25;

function readRepairedFromAssetId(asset: AssetRecord): string | null {
  const physicalResolutionRepair = asset.metadata?.physicalResolutionRepair as
    | Record<string, unknown>
    | undefined;
  const repairedFromAssetId = physicalResolutionRepair?.repairedFromAssetId;
  return typeof repairedFromAssetId === "string" ? repairedFromAssetId : null;
}

function hasQrRestorationMetadata(asset: AssetRecord): boolean {
  return Boolean(asset.metadata?.qrRestoration);
}

/**
 * `true` iff `assetId` — or any ancestor reached by walking ONLY
 * metadata-only/pixel-preserving derivative links back from it — carries
 * `metadata.qrRestoration`, i.e. was produced by compositing a
 * replacement QR into a prior candidate's pixels. A source-QR-verified
 * candidate (never a QR *replacement*, `machineReadableContentEvidence`
 * provenance `"verified_from_source_qr"`) never sets `qrRestoration` in
 * the first place, so it never requires this approval — this function
 * reads durable asset lineage only, never the validation report.
 *
 * `false` (never `true`) for an asset this walk cannot find under the
 * given job — fails closed toward "no approval required" is intentional
 * here ONLY because every caller already independently requires the
 * asset to be the job's own current, validation-bound candidate before
 * ever asking this question; this function's own job is narrowly "did a
 * QR replacement touch these particular pixels", not asset identity.
 */
export async function doesSignCandidateContainQrReplacement(
  repo: ProjectRepository,
  projectId: string,
  finalArtworkJobId: string,
  assetId: string,
): Promise<boolean> {
  const jobAssets = await repo.listAssetsForFinalArtworkJob(projectId, finalArtworkJobId);
  const byId = new Map(jobAssets.map((asset) => [asset.id, asset]));

  let current = byId.get(assetId) ?? null;
  let depth = 0;
  while (current && depth < MAX_LINEAGE_WALK_DEPTH) {
    if (hasQrRestorationMetadata(current)) return true;
    // Reconstruction-intermediate assets (pass1 buffers, etc.) are never
    // themselves a candidate and never carry a `repairedFromAssetId` link
    // worth following further — same discipline every other candidate
    // resolver in this profile already applies.
    if (isReconstructionIntermediateAsset(current)) return false;
    const parentId = readRepairedFromAssetId(current);
    current = parentId ? (byId.get(parentId) ?? null) : null;
    depth += 1;
  }
  return false;
}
