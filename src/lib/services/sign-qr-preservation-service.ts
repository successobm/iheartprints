/**
 * SIGNS QR / MACHINE-READABLE CONTENT PRESERVATION + DESTINATION
 * RESOLUTION.
 *
 * Four actions:
 *
 *   `checkSignQrPreservation`     — read-only to the artwork. Decodes the
 *                                   immutable source and the CURRENT
 *                                   candidate, compares, applies any
 *                                   durable resolution records
 *                                   (`SignPreparation.qrResolutions`), and
 *                                   persists the result as a NEW
 *                                   `ProductionAssetValidation` for the
 *                                   SAME (unmodified) asset. Never creates
 *                                   a candidate, never touches a pixel,
 *                                   never calls a provider — unchanged
 *                                   contract from the prior phase.
 *
 *   `restoreSignQrCode`           — the existing SOURCE-VERIFIED
 *                                   restoration path (a source QR that
 *                                   decoded, but the candidate lost or
 *                                   changed it), UNCHANGED, PLUS: also
 *                                   applies any pending CONFIRMED-
 *                                   DESTINATION corrections that have not
 *                                   yet been baked into the candidate
 *                                   (closes the gap for a destination
 *                                   confirmed before any candidate
 *                                   existed). Either way, composites into
 *                                   a NEW derived `ProductionAsset` under
 *                                   the SAME `FinalArtworkJob` (never
 *                                   overwrites the prior candidate), then
 *                                   re-verifies the ACTUAL persisted bytes
 *                                   before recording success.
 *
 *   `confirmSignQrDestination`    — NEW. Records a customer/operator's
 *                                   explicit confirmation of a detected-
 *                                   but-undecodable QR's intended
 *                                   destination, and — Section U's own
 *                                   real-project guidance — IMMEDIATELY
 *                                   attempts the deterministic correction
 *                                   if a production candidate already
 *                                   exists (no Topaz rerun; reuses this
 *                                   same restoration machinery).
 *
 *   `acceptSignQrPrintAsSupplied` — NEW. Records an explicit
 *                                   acknowledgment that no functioning QR
 *                                   is required for a detected-but-
 *                                   undecodable region. Never claims the
 *                                   QR is verified.
 *
 * All four are idempotent: re-running any of them when nothing has
 * materially changed produces the same evidence again.
 *
 * VALIDATION INTEGRATION (Section Y): reuses the SAME
 * `PrintValidationCheck`/`ProductionAssetValidation` architecture every
 * other Signs check already uses — never a second, independent "Print
 * Ready" authority. See `recomputeAggregateStatus` for the one deliberate
 * compromise (working from the prior validation's persisted `report` JSON
 * rather than the full typed `PrintValidationInput`), unchanged from the
 * prior phase.
 *
 * SOURCE-OF-TRUTH / AUTHORITY (Section J): a confirmed destination and a
 * source-decoded payload are NEVER mixed silently — every persisted
 * `SignQrResolutionRecord` and every produced evidence instance carries
 * its own `provenance` (`"verified_from_source_qr"` vs
 * `"confirmed_by_user"` vs `"print_as_supplied"`), and `confirmSignQr
 * Destination` only ever governs a region that genuinely failed to decode
 * from the source — it can never override an already-decodable source QR
 * (see `resolveUndecodedSourceRegion`'s own fail-closed check).
 *
 * QR REPAIR V2 — CONFIRMED PAYLOAD DOES NOT EQUAL CONFIRMED PLACEMENT
 * (Section J of that phase): a confirmed destination alone never
 * authorizes overwriting candidate pixels. `restoreFromConfirmedDestinations`
 * (`qr-restore.ts`) runs every correction through
 * `localizeConfirmedDestinationReplacementRegion` first — a region whose
 * SOURCE localization confidence is `"low"` (fewer than 3 confirmed
 * finder-pattern corners — see `MachineReadablePreservationInstance
 * .sourceLocalizationConfidence`), or whose mapped candidate region cannot
 * be independently corroborated by the CANDIDATE's own pixels, is REFUSED
 * — no composite, no new asset, no new validation. The destination remains
 * durably recorded regardless (this function's own existing resilience:
 * `SignQrPreservationError` from `restoreSignQrCode` is caught and reported
 * as `appliedImmediately: false`, never a lost confirmation) — this is
 * exactly what closed the real, production-exposed defect where a
 * malformed 2:1 source detection caused a replacement QR to be composited
 * over unrelated artwork ("FOLLOW US" / social-icon graphics) on the real
 * Get Hibachi project.
 */

import { createHash } from "node:crypto";

import { PNG } from "pngjs";

import { getCapabilityGraph } from "@/capabilities/composition";
import { hasAnyTransparentPixel } from "@/capabilities/final-artwork/raster-transform";
import type { MachineReadablePreservationReport } from "@/capabilities/machine-readable-content/contracts";
import { compareMachineReadableContent } from "@/capabilities/machine-readable-content/qr-preservation";
import { decodeQrCodes, scanForQrFinderPatterns } from "@/capabilities/machine-readable-content/qr-detect-decode";
import { validateQrDestination } from "@/capabilities/machine-readable-content/qr-destination-validation";
import {
  applyQrResolutions,
  deriveRegionKey,
  type SignQrResolutionRecord,
} from "@/capabilities/machine-readable-content/qr-resolution";
import { restoreAllFixableQrInstances, restoreFromConfirmedDestinations } from "@/capabilities/machine-readable-content/qr-restore";
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

/**
 * The current candidate to REPAIR — whichever of two resolvers has one
 * (a certified-ready delivery, or the current TRUSTWORTHY repair parent).
 * Neither existing resolver's own certified/trustworthy semantics are
 * altered; this just tries both in order.
 *
 * SIGNS CANDIDATE AUTHORITY: deliberately `resolveTrustworthySignRepair
 * Parent`, never `resolveBlockedSignProductionCandidate` — this function's
 * ENTIRE purpose is selecting the base image a WRITE (a new QR
 * correction) derives from, which is exactly the "repair parent" question,
 * never the "what should an operator visually inspect" question
 * `resolveBlockedSignProductionCandidate` answers. Using the wrong one
 * here is precisely the real defect a genuine Get Hibachi repair attempt
 * exposed: a QR replacement whose placement was visibly wrong became,
 * being newest, the candidate the NEXT correction would have derived
 * from.
 */
async function resolveCurrentSignCandidate(projectId: string): Promise<CurrentSignCandidate | null> {
  const graph = getCapabilityGraph();
  const ready = await graph.finalArtwork.resolveCurrentSignProductionDelivery(projectId);
  if (ready) return ready;
  const trustworthy = await graph.finalArtwork.resolveTrustworthySignRepairParent(projectId);
  if (trustworthy) return { job: trustworthy.job, assetId: trustworthy.assetId };
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

async function downloadRgba(assetId: string): Promise<{ image: RgbaImage; sha256: string }> {
  const graph = getCapabilityGraph();
  const downloaded = await graph.assets.downloadAssetBytes(assetId);
  if (!downloaded) {
    throw new SignQrPreservationError("The requested asset could not be read.");
  }
  const sha256 = createHash("sha256").update(downloaded.bytes).digest("hex");
  const png = PNG.sync.read(downloaded.bytes);
  return { image: { width: png.width, height: png.height, data: Buffer.from(png.data) }, sha256 };
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

/** Internal rationale only — never the decoded payload itself (Section T/X). Mirrors `print-validation-capability.ts`'s own `describeMachineReadableContentResult` wording and blocking rule exactly. */
function describeMachineReadableCheck(report: MachineReadablePreservationReport): string {
  if (report.overall === "not_applicable") {
    return "No machine-readable (QR) region was detected in the source artwork.";
  }
  const counts = {
    pass: report.instances.filter((r) => r.result === "pass" && r.provenance === "verified_from_source_qr").length,
    confirmed: report.instances.filter((r) => r.result === "pass" && r.provenance === "confirmed_by_user").length,
    fail: report.instances.filter((r) => r.result === "fail").length,
    hard_fail: report.instances.filter((r) => r.result === "hard_fail").length,
    review_required: report.instances.filter((r) => r.result === "review_required").length,
    accepted_as_supplied: report.instances.filter((r) => r.result === "accepted_as_supplied").length,
  };
  const parts: string[] = [];
  if (counts.pass > 0) parts.push(`${counts.pass} verified preserved`);
  if (counts.confirmed > 0) parts.push(`${counts.confirmed} resolved with a confirmed destination`);
  if (counts.fail > 0) parts.push(`${counts.fail} lost decodability during preparation`);
  if (counts.hard_fail > 0) parts.push(`${counts.hard_fail} now decode a DIFFERENT payload than the source`);
  if (counts.review_required > 0) {
    parts.push(`${counts.review_required} could not be verified from the original source artwork and remain unresolved`);
  }
  if (counts.accepted_as_supplied > 0) {
    parts.push(`${counts.accepted_as_supplied} explicitly accepted as supplied, without a verified functioning QR`);
  }
  return `${report.instances.length} machine-readable region(s) found in the source: ${parts.join("; ")}.`;
}

function buildMachineReadableCheck(report: MachineReadablePreservationReport): PersistedCheck {
  const result = report.overall;
  // SIGNS QR DESTINATION RESOLUTION: `review_required` is now BLOCKING
  // alongside `fail`/`hard_fail` — mirrors `print-validation-capability
  // .ts`'s identical rule exactly (kept in sync deliberately, not
  // imported, per this file's own existing cross-capability discipline).
  const blocking = result === "fail" || result === "hard_fail" || result === "review_required";
  const acceptedAsSupplied = result === "accepted_as_supplied";
  return {
    check: "machine_readable_content_preserved",
    status: blocking ? "fail" : acceptedAsSupplied ? "warning" : "pass",
    severity: acceptedAsSupplied ? "warning" : "blocking",
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
    report: { ...(priorReport ?? {}), checks, status, machineReadableContentEvidence: evidence },
    status,
  };
}

/** Loosely-typed `SignPreparation.qrResolutions` narrowed to `SignQrResolutionRecord[]` — malformed/legacy entries are dropped, never guessed (mirrors every other jsonb reader in this codebase). */
function parseQrResolutions(preparation: SignPreparation): SignQrResolutionRecord[] {
  const raw = preparation.qrResolutions;
  if (!Array.isArray(raw)) return [];
  const valid = raw.filter(
    (r) =>
      typeof r.sourceAssetId === "string" &&
      typeof r.sourceSha256 === "string" &&
      typeof r.regionKey === "string" &&
      (r.state === "confirmed_destination" || r.state === "print_as_supplied") &&
      (r.confirmedPayload === null || typeof r.confirmedPayload === "string") &&
      (r.confirmedBy === "customer" || r.confirmedBy === "operator") &&
      typeof r.confirmedAt === "string",
  );
  return valid as unknown as SignQrResolutionRecord[];
}

/** Upserts one resolution record (replacing any existing entry for the SAME `regionKey` bound to the SAME source — Section L: never a second, conflicting decision for the same region/source pair) and persists it durably. */
async function persistQrResolution(preparation: SignPreparation, record: SignQrResolutionRecord): Promise<void> {
  const repo = getProjectRepository();
  const existing = parseQrResolutions(preparation);
  const next = [
    ...existing.filter((r) => !(r.regionKey === record.regionKey && r.sourceAssetId === record.sourceAssetId)),
    record,
  ];
  await repo.updateSignPreparation(preparation.id, { qrResolutions: next as unknown as Record<string, unknown>[] });
}

/**
 * Fail-closed lookup: confirms `regionKey` corresponds to a REAL,
 * currently-detected, currently-UNDECODABLE region in the CURRENT
 * immutable source — freshly re-detected here, never trusted from
 * client-supplied geometry (Section X: never trust a client-supplied
 * identifier for a server-side write). Returns `null` if the source
 * cannot be read, if nothing undecodable is detected at all, or if
 * `regionKey` does not match any currently-detected undecodable region —
 * including the case where the region NOW decodes fine (a customer must
 * never be able to "confirm a destination" for a region that already has
 * a verified source payload; Section V: "if source QR already decodes,
 * do not ask the customer for its destination").
 */
async function resolveUndecodedSourceRegion(
  preparation: SignPreparation,
  regionKey: string,
): Promise<{ sourceImage: RgbaImage; sourceSha256: string; bounds: { xPx: number; yPx: number; widthPx: number; heightPx: number } } | null> {
  const { image: sourceImage, sha256: sourceSha256 } = await downloadRgba(preparation.originalAssetId);
  if (decodeQrCodes(sourceImage).length > 0) return null; // Already decodable — never governed by a confirmation.
  const undecoded = scanForQrFinderPatterns(sourceImage);
  const match = undecoded.find((u) => deriveRegionKey(u.bounds) === regionKey);
  if (!match) return null;
  return { sourceImage, sourceSha256, bounds: match.bounds };
}

export interface SignQrCheckResult {
  report: MachineReadablePreservationReport;
  validationStatus: "ready" | "finalization_required";
}

/**
 * Read-only to the artwork: decodes the immutable source and the CURRENT
 * candidate, compares, applies any durable resolution records, and
 * persists a NEW `ProductionAssetValidation` for the SAME asset recording
 * the result. Never mutates a pixel, never creates a candidate, never
 * calls a provider.
 */
export async function checkSignQrPreservation(projectId: string): Promise<SignQrCheckResult> {
  const preparation = await loadSignPreparationOrThrow(projectId);
  const candidate = await resolveCurrentSignCandidate(projectId);
  if (!candidate) {
    throw new SignQrPreservationError("No production candidate exists yet for this sign — nothing to check.");
  }

  const [source, candidateImage] = await Promise.all([
    downloadRgba(preparation.originalAssetId),
    downloadRgba(candidate.assetId),
  ]);

  const raw = compareMachineReadableContent(source.image, candidateImage.image);
  const resolutions = parseQrResolutions(preparation);
  const { report } = applyQrResolutions(raw, resolutions, {
    assetId: preparation.originalAssetId,
    sha256: source.sha256,
  });

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
 * The governed deterministic restoration (Sections N/P/Q of the original
 * preservation phase, Section U of destination resolution). Composites
 * TWO independent kinds of correction into one derived candidate, in one
 * pass:
 *
 *   1. Source-verified restoration (UNCHANGED from the prior phase): a
 *      source instance that decoded, but the candidate lost or changed it
 *      (`fail`/`hard_fail`).
 *   2. Pending confirmed-destination corrections: a source instance that
 *      never decoded, but has a durable `"confirmed_destination"`
 *      resolution the candidate does not yet encode.
 *
 * Throws if NEITHER kind has anything to fix. After compositing, the
 * ACTUAL new asset's bytes are downloaded back and re-decoded (never
 * trusting the in-memory buffer alone) before ANY success is recorded.
 */
export async function restoreSignQrCode(projectId: string): Promise<SignQrRestoreResult> {
  const preparation = await loadSignPreparationOrThrow(projectId);
  const candidate = await resolveCurrentSignCandidate(projectId);
  if (!candidate) {
    throw new SignQrPreservationError("No production candidate exists yet for this sign — nothing to restore.");
  }

  const [source, candidateImage] = await Promise.all([
    downloadRgba(preparation.originalAssetId),
    downloadRgba(candidate.assetId),
  ]);

  const beforeRaw = compareMachineReadableContent(source.image, candidateImage.image);
  const resolutions = parseQrResolutions(preparation);
  const { pendingCorrections } = applyQrResolutions(beforeRaw, resolutions, {
    assetId: preparation.originalAssetId,
    sha256: source.sha256,
  });

  const sourceVerifiedFixable = beforeRaw.instances.some((i) => i.result === "fail" || i.result === "hard_fail");
  if (!sourceVerifiedFixable && pendingCorrections.length === 0) {
    throw new SignQrPreservationError(
      "No provable QR regression or pending confirmed destination was found to restore.",
    );
  }

  let working = candidateImage.image;
  let restoredCount = 0;

  if (sourceVerifiedFixable) {
    const restoration = restoreAllFixableQrInstances({ source: source.image, candidate: working });
    working = { width: working.width, height: working.height, data: restoration.data };
    restoredCount += restoration.restoredCount;
  }

  if (pendingCorrections.length > 0) {
    const restoration = restoreFromConfirmedDestinations({
      candidate: working,
      sourceImageWidthPx: source.image.width,
      sourceImageHeightPx: source.image.height,
      corrections: pendingCorrections
        .filter((p) => p.resolution.confirmedPayload !== null)
        .map((p) => ({
          sourceBounds: p.instance.sourceBounds!,
          // review_required instances are always undecoded-source
          // instances (qr-preservation.ts always stamps a non-null
          // confidence for those) — never null here in practice.
          sourceLocalizationConfidence: p.instance.sourceLocalizationConfidence ?? "low",
          sourceFinderCenters: p.instance.sourceFinderCenters,
          payload: p.resolution.confirmedPayload!,
        })),
    });
    working = { width: working.width, height: working.height, data: restoration.data };
    restoredCount += restoration.restoredCount;
  }

  if (restoredCount === 0) {
    throw new SignQrPreservationError("QR restoration did not produce any change — nothing was persisted.");
  }

  const png = new PNG({ width: working.width, height: working.height });
  working.data.copy(png.data);
  const restoredPngBytes = PNG.sync.write(png);

  const graph = getCapabilityGraph();
  const newAsset = await graph.assets.uploadProductionAsset(projectId, {
    conceptId: `sign-${candidate.job.id}-qr-restored-${Date.now()}`,
    bytes: restoredPngBytes,
    contentType: "image/png",
    widthPx: working.width,
    heightPx: working.height,
    hasTransparency: hasAnyTransparentPixel(working),
    finalArtworkJobId: candidate.job.id,
    productionRole: "production_png",
    metadata: {
      qrRestoration: {
        restoredFromAssetId: candidate.assetId,
        sourceAssetId: preparation.originalAssetId,
        planKey: preparation.planKey,
        restoredCount,
        // SIGNS CANDIDATE AUTHORITY: durable proof this exact asset's QR
        // content was placement-validated before ever being composited —
        // every correction that reaches this point already passed
        // `restoreQrInCandidate`'s own payload+location verification
        // (source-verified fixes) and/or `localizeConfirmedDestination
        // ReplacementRegion`'s replacement safety gate (confirmed-
        // destination fixes, commit 444f431) — a correction that failed
        // either check is never composited and therefore never reaches
        // this upload at all. This is what lets
        // `isAssetTrustworthyAsSignRepairParent` (final-artwork-
        // capability.ts) recognize a FUTURE QR derivative as a trustworthy
        // repair parent, and — just as importantly — recognize a
        // HISTORICAL one created before this field existed as NOT
        // trustworthy, without any project- or asset-specific logic.
        placementValidated: true,
      },
    },
  });

  // Section Q: decode the ACTUAL persisted bytes back from storage — never
  // trust the in-memory buffer this function just wrote.
  const persisted = await downloadRgba(newAsset.id);
  const afterRaw = compareMachineReadableContent(source.image, persisted.image);
  const { report: afterReport } = applyQrResolutions(afterRaw, resolutions, {
    assetId: preparation.originalAssetId,
    sha256: source.sha256,
  });
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
    restoredCount,
    newAssetId: newAsset.id,
    report: afterReport,
    validationStatus: merged.status,
  };
}

export interface SignQrDestinationConfirmationResult {
  /** True iff a production candidate already existed and the correction was applied immediately (Section U). `false` means the destination was recorded but there is nothing to correct yet — it will apply the next time an evaluation runs against a real candidate. */
  appliedImmediately: boolean;
  report: MachineReadablePreservationReport | null;
}

/**
 * SIGNS QR DESTINATION RESOLUTION: records a customer/operator's explicit
 * confirmation of a detected-but-undecodable QR's intended destination.
 * `regionKey` MUST correspond to a region this function itself freshly
 * re-detects as currently undecodable in the CURRENT source (Section X —
 * never trusts a client-supplied region blindly); an already-decodable
 * region, or a `regionKey` that matches nothing, is refused.
 *
 * `destination` is validated (`validateQrDestination`) and stored EXACTLY
 * as confirmed — never normalized, never fetched, never resolved
 * (Sections K/N/X).
 *
 * If a production candidate already exists, the correction is applied
 * IMMEDIATELY, synchronously, in this same call (Section U: "confirm
 * destination -> deterministically derive corrected candidate from
 * existing candidate -> NO TOPAZ rerun -> revalidate"). If none exists
 * yet, only the resolution is durably recorded — `restoreSignQrCode`
 * (the existing "Restore QR code" action) applies any still-pending
 * confirmed destination the next time it runs.
 */
export async function confirmSignQrDestination(
  projectId: string,
  input: { regionKey: string; destination: string; confirmedBy: "customer" | "operator" },
): Promise<SignQrDestinationConfirmationResult> {
  const validation = validateQrDestination(input.destination);
  if (!validation.ok) {
    throw new SignQrPreservationError(validation.reason ?? "That destination isn't valid.");
  }

  const preparation = await loadSignPreparationOrThrow(projectId);
  const region = await resolveUndecodedSourceRegion(preparation, input.regionKey);
  if (!region) {
    throw new SignQrPreservationError(
      "That QR code could not be matched to a currently unreadable region on this artwork.",
    );
  }

  const record: SignQrResolutionRecord = {
    sourceAssetId: preparation.originalAssetId,
    sourceSha256: region.sourceSha256,
    regionKey: input.regionKey,
    state: "confirmed_destination",
    confirmedPayload: input.destination.trim(),
    confirmedBy: input.confirmedBy,
    confirmedAt: new Date().toISOString(),
  };
  await persistQrResolution(preparation, record);

  const candidate = await resolveCurrentSignCandidate(projectId);
  if (!candidate) {
    return { appliedImmediately: false, report: null };
  }

  try {
    const result = await restoreSignQrCode(projectId);
    return { appliedImmediately: true, report: result.report };
  } catch (error) {
    // The destination is durably recorded regardless — a correction
    // attempt failing here (e.g. a structural transform this phase's
    // region mapping cannot trust) must never lose the customer's own
    // confirmation. It remains a pending correction, fail-closed, for an
    // operator to resolve through the existing correction workspace.
    if (error instanceof SignQrPreservationError) {
      return { appliedImmediately: false, report: null };
    }
    throw error;
  }
}

export interface SignQrPrintAsSuppliedResult {
  report: MachineReadablePreservationReport | null;
}

/**
 * SIGNS QR DESTINATION RESOLUTION: records an explicit acknowledgment that
 * no functioning QR is required for a detected-but-undecodable region
 * (Section Q). Never claims the QR is verified — the resulting evidence
 * reads `"accepted_as_supplied"`, never `"pass"`. Requires no candidate to
 * exist (there is nothing to composite) — if one already exists, this
 * re-evaluates and persists updated evidence immediately so the operator
 * workspace reflects the acceptance right away; otherwise the acceptance
 * is simply durably recorded and will be reflected the next time
 * evaluation runs.
 */
export async function acceptSignQrPrintAsSupplied(
  projectId: string,
  input: { regionKey: string; confirmedBy: "customer" | "operator" },
): Promise<SignQrPrintAsSuppliedResult> {
  const preparation = await loadSignPreparationOrThrow(projectId);
  const region = await resolveUndecodedSourceRegion(preparation, input.regionKey);
  if (!region) {
    throw new SignQrPreservationError(
      "That QR code could not be matched to a currently unreadable region on this artwork.",
    );
  }

  const record: SignQrResolutionRecord = {
    sourceAssetId: preparation.originalAssetId,
    sourceSha256: region.sourceSha256,
    regionKey: input.regionKey,
    state: "print_as_supplied",
    confirmedPayload: null,
    confirmedBy: input.confirmedBy,
    confirmedAt: new Date().toISOString(),
  };
  await persistQrResolution(preparation, record);

  const candidate = await resolveCurrentSignCandidate(projectId);
  if (!candidate) return { report: null };

  const result = await checkSignQrPreservation(projectId);
  return { report: result.report };
}
