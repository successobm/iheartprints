/**
 * SIGNS QR / MACHINE-READABLE CONTENT PRESERVATION — the two internal-
 * operator-only actions this feature adds:
 *
 *   `checkSignQrPreservation`  — read-only to the artwork. Decodes the
 *                                 immutable source and the CURRENT
 *                                 candidate, compares, and persists the
 *                                 result as a NEW `ProductionAssetValidation`
 *                                 for the SAME (unmodified) asset — the
 *                                 governed way this system already records
 *                                 a re-check (mirrors "Check my artwork").
 *                                 Never creates a candidate, never touches
 *                                 a pixel, never calls a provider.
 *
 *   `restoreSignQrCode`        — only reachable when the check found a
 *                                 provable regression (a source instance
 *                                 that decoded but the candidate lost or
 *                                 changed). Deterministically regenerates
 *                                 and composites the verified payload into
 *                                 a NEW derived `ProductionAsset` under the
 *                                 SAME `FinalArtworkJob` (Section P: "Never
 *                                 overwrite the provider output"), then
 *                                 re-runs the SAME comparison against the
 *                                 ACTUAL persisted bytes before recording
 *                                 success (Section Q). No provider call —
 *                                 purely deterministic local pixel work.
 *
 * Both are internal-operator-only (called from routes gated the same way
 * every other `/api/internal/projects/[projectId]/sign-artwork/*` route
 * already is) and both are idempotent: re-running either when nothing has
 * changed produces the same evidence again.
 *
 * VALIDATION INTEGRATION (Section R): reuses the SAME
 * `PrintValidationCheck`/`ProductionAssetValidation` architecture every
 * other Signs check already uses — never a second, independent "Print
 * Ready" authority. The one deliberate compromise: this service works from
 * the PRIOR validation's persisted `report` JSON (not the full typed
 * `PrintValidationInput` the worker originally built, which is not cheaply
 * reconstructible outside the worker's own execution) and merges in
 * exactly one check (`machine_readable_content_preserved`), recomputing
 * overall status with the SAME "every blocking check must pass" rule
 * `print-validation-capability.ts`'s own `aggregateStatus` uses — see
 * `recomputeAggregateStatus` below, kept in one small, obviously-correct
 * place rather than duplicated inline.
 */

import { PNG } from "pngjs";

import { getCapabilityGraph } from "@/capabilities/composition";
import { hasAnyTransparentPixel } from "@/capabilities/final-artwork/raster-transform";
import { compareMachineReadableContent } from "@/capabilities/machine-readable-content/qr-preservation";
import { restoreAllFixableQrInstances } from "@/capabilities/machine-readable-content/qr-restore";
import type { MachineReadablePreservationReport } from "@/capabilities/machine-readable-content/contracts";
import { getProjectRepository } from "@/lib/db";
import type { FinalArtworkJob, SignPreparation } from "@/lib/domain/types";

export class SignQrPreservationError extends Error {}

interface RgbaImage {
  width: number;
  height: number;
  data: Buffer;
}

interface CurrentSignCandidate {
  job: FinalArtworkJob;
  assetId: string;
}

/** The current candidate for the preparation's CURRENT plan — whichever of the two existing resolvers has one (ready, or blocked-awaiting-review). Neither existing resolver's own certified/blocked semantics are altered; this just tries both in order. */
async function resolveCurrentSignCandidate(projectId: string): Promise<CurrentSignCandidate | null> {
  const graph = getCapabilityGraph();
  const ready = await graph.finalArtwork.resolveCurrentSignProductionDelivery(projectId);
  if (ready) return ready;
  const blocked = await graph.finalArtwork.resolveBlockedSignProductionCandidate(projectId);
  if (blocked) return { job: blocked.job, assetId: blocked.assetId };
  return null;
}

async function loadSignPreparationOrThrow(projectId: string): Promise<SignPreparation> {
  const repo = getProjectRepository();
  const preparation = await repo.getSignPreparation(projectId);
  if (!preparation || preparation.projectId !== projectId) {
    throw new SignQrPreservationError("No sign artwork uploaded for this project.");
  }
  return preparation;
}

async function downloadRgba(assetId: string): Promise<RgbaImage> {
  const graph = getCapabilityGraph();
  const downloaded = await graph.assets.downloadAssetBytes(assetId);
  if (!downloaded) {
    throw new SignQrPreservationError("The requested asset could not be read.");
  }
  const png = PNG.sync.read(downloaded.bytes);
  return { width: png.width, height: png.height, data: Buffer.from(png.data) };
}

interface PersistedCheck {
  check: string;
  status: string;
  severity: string;
  reason: string;
}

/** Mirrors `print-validation-capability.ts`'s own `aggregateStatus` exactly: every `severity: "blocking"` check must be `status: "pass"`. Kept here, in one place, specifically so it stays trivially inspectable against that canonical implementation rather than silently drifting. */
function recomputeAggregateStatus(checks: PersistedCheck[]): "ready" | "finalization_required" {
  const blocking = checks.filter((c) => c.severity === "blocking");
  return blocking.every((c) => c.status === "pass") ? "ready" : "finalization_required";
}

/** Internal rationale only — never the decoded payload itself (Section T). Mirrors `print-validation-capability.ts`'s own `describeMachineReadableContentResult` wording. */
function describeMachineReadableCheck(report: MachineReadablePreservationReport): string {
  if (report.overall === "not_applicable") {
    return "No machine-readable (QR) region was detected in the source artwork.";
  }
  const counts = {
    pass: report.instances.filter((r) => r.result === "pass").length,
    fail: report.instances.filter((r) => r.result === "fail").length,
    hard_fail: report.instances.filter((r) => r.result === "hard_fail").length,
    review_required: report.instances.filter((r) => r.result === "review_required").length,
  };
  const parts: string[] = [];
  if (counts.pass > 0) parts.push(`${counts.pass} verified preserved`);
  if (counts.fail > 0) parts.push(`${counts.fail} lost decodability during preparation`);
  if (counts.hard_fail > 0) parts.push(`${counts.hard_fail} now decode a DIFFERENT payload than the source`);
  if (counts.review_required > 0) {
    parts.push(`${counts.review_required} could not be verified from the original source artwork`);
  }
  return `${report.instances.length} machine-readable region(s) found in the source: ${parts.join("; ")}.`;
}

function buildMachineReadableCheck(report: MachineReadablePreservationReport): PersistedCheck {
  const blocking = report.overall === "fail" || report.overall === "hard_fail";
  return {
    check: "machine_readable_content_preserved",
    status: report.overall === "review_required" ? "warning" : blocking ? "fail" : "pass",
    severity: report.overall === "review_required" ? "warning" : "blocking",
    reason: describeMachineReadableCheck(report),
  };
}

function mergeMachineReadableCheck(
  priorReport: Record<string, unknown> | null | undefined,
  newCheck: PersistedCheck,
  evidence: MachineReadablePreservationReport,
): { report: Record<string, unknown>; status: "ready" | "finalization_required" } {
  const priorChecks = Array.isArray(priorReport?.checks) ? (priorReport!.checks as PersistedCheck[]) : [];
  const checks = [...priorChecks.filter((c) => c.check !== "machine_readable_content_preserved"), newCheck];
  const status = recomputeAggregateStatus(checks);
  return {
    // `machineReadableContentEvidence` mirrors `fitToProductionEvidence`'s
    // own placement on the persisted report exactly — the STRUCTURED
    // (hash-only, never-raw-payload — see `contracts.ts`) evidence
    // `sign-plan-operator-review.ts`'s own reader pulls back out for the
    // operator page, the same way `readFitToProductionSummary` already
    // reads that sibling field.
    report: { ...(priorReport ?? {}), checks, status, machineReadableContentEvidence: evidence },
    status,
  };
}

export interface SignQrCheckResult {
  report: MachineReadablePreservationReport;
  validationStatus: "ready" | "finalization_required";
}

/**
 * Read-only to the artwork: decodes the immutable source and the CURRENT
 * candidate, compares, and persists a NEW `ProductionAssetValidation` for
 * the SAME asset recording the result. Never mutates a pixel, never
 * creates a candidate, never calls a provider.
 */
export async function checkSignQrPreservation(projectId: string): Promise<SignQrCheckResult> {
  const preparation = await loadSignPreparationOrThrow(projectId);
  const candidate = await resolveCurrentSignCandidate(projectId);
  if (!candidate) {
    throw new SignQrPreservationError("No production candidate exists yet for this sign — nothing to check.");
  }

  const [sourceImage, candidateImage] = await Promise.all([
    downloadRgba(preparation.originalAssetId),
    downloadRgba(candidate.assetId),
  ]);

  const report = compareMachineReadableContent(sourceImage, candidateImage);

  const repo = getProjectRepository();
  const priorValidation = await repo.getLatestProductionAssetValidationForJob(projectId, candidate.job.id);
  const merged = mergeMachineReadableCheck(
    priorValidation?.report as Record<string, unknown> | null | undefined,
    buildMachineReadableCheck(report),
    report,
  );

  await repo.createProductionAssetValidation(projectId, {
    finalArtworkJobId: candidate.job.id,
    assetId: candidate.assetId,
    status: merged.status,
    report: merged.report,
  });

  return { report, validationStatus: merged.status };
}

export interface SignQrRestoreResult {
  restoredCount: number;
  newAssetId: string;
  report: MachineReadablePreservationReport;
  validationStatus: "ready" | "finalization_required";
}

/**
 * The governed deterministic restoration (Sections N/P/Q). Only proceeds
 * when the CURRENT check finds at least one source instance whose
 * candidate counterpart genuinely regressed — an undecodable source
 * (review_required) is never restored FROM (Section I), and an
 * already-matching instance is left untouched.
 *
 * After compositing, the ACTUAL new asset's bytes are downloaded back and
 * re-decoded (never trusting the in-memory buffer alone) before ANY
 * success is recorded — Section Q's own explicit requirement.
 */
export async function restoreSignQrCode(projectId: string): Promise<SignQrRestoreResult> {
  const preparation = await loadSignPreparationOrThrow(projectId);
  const candidate = await resolveCurrentSignCandidate(projectId);
  if (!candidate) {
    throw new SignQrPreservationError("No production candidate exists yet for this sign — nothing to restore.");
  }

  const [sourceImage, candidateImage] = await Promise.all([
    downloadRgba(preparation.originalAssetId),
    downloadRgba(candidate.assetId),
  ]);

  const beforeReport = compareMachineReadableContent(sourceImage, candidateImage);
  const fixableCount = beforeReport.instances.filter((i) => i.result === "fail" || i.result === "hard_fail").length;
  if (fixableCount === 0) {
    throw new SignQrPreservationError(
      "No provable QR regression was found to restore — either everything already matches the source, or the source itself could not be verified.",
    );
  }

  const restoration = restoreAllFixableQrInstances({ source: sourceImage, candidate: candidateImage });
  if (!restoration.changed) {
    throw new SignQrPreservationError("QR restoration did not produce any change — nothing was persisted.");
  }

  const restoredImage: RgbaImage = { width: candidateImage.width, height: candidateImage.height, data: restoration.data };
  const png = new PNG({ width: restoredImage.width, height: restoredImage.height });
  restoredImage.data.copy(png.data);
  const restoredPngBytes = PNG.sync.write(png);

  const graph = getCapabilityGraph();
  const newAsset = await graph.assets.uploadProductionAsset(projectId, {
    conceptId: `sign-${candidate.job.id}-qr-restored-${Date.now()}`,
    bytes: restoredPngBytes,
    contentType: "image/png",
    widthPx: restoredImage.width,
    heightPx: restoredImage.height,
    hasTransparency: hasAnyTransparentPixel(restoredImage),
    finalArtworkJobId: candidate.job.id,
    productionRole: "production_png",
    metadata: {
      qrRestoration: {
        restoredFromAssetId: candidate.assetId,
        sourceAssetId: preparation.originalAssetId,
        planKey: preparation.planKey,
        restoredCount: restoration.restoredCount,
      },
    },
  });

  // Section Q: decode the ACTUAL persisted bytes back from storage — never
  // trust the in-memory buffer this function just wrote.
  const persistedImage = await downloadRgba(newAsset.id);
  const afterReport = compareMachineReadableContent(sourceImage, persistedImage);
  const stillBroken = afterReport.instances.some((i) => i.result === "fail" || i.result === "hard_fail");
  if (stillBroken) {
    throw new SignQrPreservationError(
      "Restoration was written, but the persisted result did not verify — treat this as unresolved.",
    );
  }

  const repo = getProjectRepository();
  const priorValidation = await repo.getLatestProductionAssetValidationForJob(projectId, candidate.job.id);
  const merged = mergeMachineReadableCheck(
    priorValidation?.report as Record<string, unknown> | null | undefined,
    buildMachineReadableCheck(afterReport),
    afterReport,
  );

  await repo.createProductionAssetValidation(projectId, {
    finalArtworkJobId: candidate.job.id,
    assetId: newAsset.id,
    status: merged.status,
    report: merged.report,
  });

  return {
    restoredCount: restoration.restoredCount,
    newAssetId: newAsset.id,
    report: afterReport,
    validationStatus: merged.status,
  };
}
