/**
 * SIGNS QR DESTINATION RESOLUTION: service-layer integration tests for
 * `sign-qr-preservation-service.ts` — `confirmSignQrDestination`,
 * `acceptSignQrPrintAsSupplied`, and their interaction with
 * `checkSignQrPreservation`/`restoreSignQrCode`, run against a REAL sign
 * pipeline (upload -> plan -> authorize -> worker -> candidate), through
 * `getCapabilityGraph()` and local-store persistence — mirrors
 * `sign-artwork-service.test.ts`'s own established pattern for this
 * service layer exactly (fresh temp-dir local store per test, zero Topaz,
 * zero OpenAI).
 *
 * This file exists specifically to prove the write/persistence path (durable
 * `SignPreparation.qrResolutions`, fail-closed `regionKey` re-derivation,
 * immediate-apply-on-confirm) end to end WITHOUT depending on the
 * `qr_resolutions` Supabase column having been deployed to any live
 * database — local-store persistence requires no schema migration at all,
 * so this is the primary, repeatable proof of the durable-record write
 * path (the pure `applyQrResolutions` combination logic is already
 * exhaustively covered separately in `qr-resolution.test.ts`).
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { PNG } from "pngjs";
import QRCode from "qrcode";

import { exactAspectSignArtwork, fillRect, makeImage, toPngBytes } from "@/capabilities/sign-preparation/sign-fixtures";
import type { RgbaImage } from "@/capabilities/final-artwork/raster-transform";
import { resetDecodedCandidateCacheForTests } from "@/lib/services/sign-wand-candidate-cache";
import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";

describe("sign-qr-preservation-service: SIGNS QR DESTINATION RESOLUTION", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-sign-qr-destination-service-"));
    process.chdir(tempDir);
  });

  after(async () => {
    await cleanupTempWorkspace(tempDir, previousCwd);
  });

  async function freshGraph() {
    const { resetCapabilityGraphForTests, getCapabilityGraph } = await import("@/capabilities/composition");
    resetCapabilityGraphForTests();
    resetDecodedCandidateCacheForTests();
    const graph = getCapabilityGraph();
    const { getProjectRepository } = await import("@/lib/db");
    return { graph, repo: getProjectRepository() };
  }

  async function synthesizeDamagedQr(payload: string, sizePx: number): Promise<RgbaImage> {
    const buf = await QRCode.toBuffer(payload, { errorCorrectionLevel: "H", margin: 4, width: sizePx });
    const png = PNG.sync.read(buf);
    // Damage a central band (25%-75% of both axes, checkerboard) — reliably
    // breaks decode while leaving finder patterns intact, the same proven
    // parameters used throughout this whole engagement's QR fixtures
    // (`qr-restore.test.ts`, the prior QR-preservation phase).
    const y0 = Math.floor(png.height * 0.25);
    const y1 = y0 + Math.floor(png.height * 0.5);
    const x0 = Math.floor(png.width * 0.25);
    const x1 = x0 + Math.floor(png.width * 0.5);
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * png.width + x) * 4;
        const v = (x + y) % 2 === 0 ? 0 : 255;
        png.data[i] = v;
        png.data[i + 1] = v;
        png.data[i + 2] = v;
      }
    }
    return { width: png.width, height: png.height, data: Buffer.from(png.data) };
  }

  function paste(canvas: RgbaImage, source: RgbaImage, atX: number, atY: number): void {
    for (let y = 0; y < source.height; y++) {
      for (let x = 0; x < source.width; x++) {
        const si = (y * source.width + x) * 4;
        const dx = atX + x;
        const dy = atY + y;
        if (dx < 0 || dx >= canvas.width || dy < 0 || dy >= canvas.height) continue;
        const di = (dy * canvas.width + dx) * 4;
        canvas.data[di] = source.data[si];
        canvas.data[di + 1] = source.data[si + 1];
        canvas.data[di + 2] = source.data[si + 2];
        canvas.data[di + 3] = 255;
      }
    }
  }

  /**
   * 600x900px = exactly 4x6in at 150 PPI (the RIGID_RECT_UP_TO_24X36_V1
   * target) — the SAME already-proven-safe geometry as
   * `sign-artwork-service.test.ts`'s own fixture (scale-1, no upscale, no
   * Topaz call required), with a genuinely-undecodable-but-finder-pattern-
   * detectable QR embedded near the bottom-right corner, mirroring the
   * real Get Hibachi project's own relative QR placement.
   */
  async function signWithBrokenQr(payload: string): Promise<{ image: RgbaImage; qrBoundsPx: { xPx: number; yPx: number; widthPx: number; heightPx: number } }> {
    const image = makeImage(600, 900, { r: 250, g: 250, b: 250 });
    fillRect(image, 20, 20, 580, 100, { r: 30, g: 30, b: 30 }); // unrelated content, never a QR region
    const damagedQr = await synthesizeDamagedQr(payload, 150);
    const atX = 400;
    const atY = 700;
    paste(image, damagedQr, atX, atY);
    return { image, qrBoundsPx: { xPx: atX, yPx: atY, widthPx: damagedQr.width, heightPx: damagedQr.height } };
  }

  /**
   * QR REPAIR V2: erases the ENTIRE top-right quadrant of a real QR raster
   * — destroying that corner's finder pattern outright — leaving only 2 of
   * the 3 real finder patterns detectable. This is the real-world shape of
   * the actual Get Hibachi defect: with only 2 confirmed corners, the
   * detector's own bounding-box estimate is a genuine UNDER-estimate on
   * one axis, never trustworthy for automatic placement (`"low"`
   * localization confidence) — even though it is still perfectly good
   * evidence that "something QR-shaped is here" for detection/blocking
   * purposes.
   */
  async function synthesizePoorlyLocalizedQr(payload: string, sizePx: number): Promise<RgbaImage> {
    const buf = await QRCode.toBuffer(payload, { errorCorrectionLevel: "H", margin: 4, width: sizePx });
    const png = PNG.sync.read(buf);
    const halfW = Math.floor(png.width / 2);
    const halfH = Math.floor(png.height / 2);
    for (let y = 0; y < halfH; y++) {
      for (let x = halfW; x < png.width; x++) {
        const i = (y * png.width + x) * 4;
        png.data[i] = 255;
        png.data[i + 1] = 255;
        png.data[i + 2] = 255;
      }
    }
    return { width: png.width, height: png.height, data: Buffer.from(png.data) };
  }

  async function signWithPoorlyLocalizedQr(payload: string): Promise<{ image: RgbaImage }> {
    const image = makeImage(600, 900, { r: 250, g: 250, b: 250 });
    fillRect(image, 20, 20, 580, 100, { r: 30, g: 30, b: 30 });
    const badQr = await synthesizePoorlyLocalizedQr(payload, 150);
    paste(image, badQr, 400, 700);
    return { image };
  }

  async function projectWithPoorlyLocalizedQrCandidate(
    graph: Awaited<ReturnType<typeof freshGraph>>["graph"],
    repo: Awaited<ReturnType<typeof freshGraph>>["repo"],
    payload: string,
  ) {
    const { image } = await signWithPoorlyLocalizedQr(payload);
    const created = await repo.createProject();
    const projectId = created.project.id;
    await graph.signPreparation.uploadSignArtwork(projectId, {
      bytes: toPngBytes(image),
      declaredContentType: "image/png",
      filename: "sign-with-poorly-localized-qr.png",
    });
    await graph.signPreparation.confirmSignProductionSpec(projectId, 4, 6);
    await graph.signPreparation.confirmSignCompositionPlan(projectId, {
      reconstruction: null,
      crop: null,
      fitBackground: { r: 250, g: 250, b: 250 },
      fitPlacement: null,
      moves: [],
      fills: [],
      replacements: [],
    });
    await graph.signPreparation.authorizeSignRepairPlan(projectId, { authorizedBy: "operator" });
    const { job } = await graph.finalArtwork.requestSignFinalArtwork(projectId);
    await graph.finalArtworkScheduler.runBatch();
    const completedJob = await repo.getFinalArtworkJob(job.id);
    assert.equal(completedJob!.status, "completed", "sanity: the worker run must complete for this fixture");
    return { projectId, job };
  }

  async function projectWithBrokenQrCandidate(
    graph: Awaited<ReturnType<typeof freshGraph>>["graph"],
    repo: Awaited<ReturnType<typeof freshGraph>>["repo"],
    payload: string,
  ) {
    const { image } = await signWithBrokenQr(payload);
    const created = await repo.createProject();
    const projectId = created.project.id;
    await graph.signPreparation.uploadSignArtwork(projectId, {
      bytes: toPngBytes(image),
      declaredContentType: "image/png",
      filename: "sign-with-broken-qr.png",
    });
    await graph.signPreparation.confirmSignProductionSpec(projectId, 4, 6);
    await graph.signPreparation.confirmSignCompositionPlan(projectId, {
      reconstruction: null,
      crop: null,
      fitBackground: { r: 250, g: 250, b: 250 },
      fitPlacement: null,
      moves: [],
      fills: [],
      replacements: [],
    });
    await graph.signPreparation.authorizeSignRepairPlan(projectId, { authorizedBy: "operator" });
    const { job } = await graph.finalArtwork.requestSignFinalArtwork(projectId);
    await graph.finalArtworkScheduler.runBatch();
    const completedJob = await repo.getFinalArtworkJob(job.id);
    assert.equal(completedJob!.status, "completed", "sanity: the worker run must complete for this fixture");
    return { projectId, job };
  }

  it("sanity: checkSignQrPreservation reports review_required (BLOCKING) for a genuinely undecodable source QR, and it survives into the candidate untouched", async () => {
    const { graph, repo } = await freshGraph();
    const { checkSignQrPreservation } = await import("./sign-qr-preservation-service");
    const { projectId } = await projectWithBrokenQrCandidate(graph, repo, "https://example-test-business.com/original-broken");

    const result = await checkSignQrPreservation(projectId);
    assert.equal(result.report.overall, "review_required");
    assert.equal(result.validationStatus, "finalization_required", "review_required must BLOCK — this is the core product requirement of this phase");
    assert.equal(result.report.instances.length, 1);
    assert.equal(result.report.instances[0].provenance, null);
    assert.ok(result.report.instances[0].regionKey, "a regionKey must be derived for the customer-facing UI to reference");
  });

  it("confirmSignQrDestination: fail-closed — a regionKey that does not match any currently-undecodable region is refused, and nothing is persisted", async () => {
    const { graph, repo } = await freshGraph();
    const { confirmSignQrDestination, SignQrPreservationError } = await import("./sign-qr-preservation-service");
    const { projectId } = await projectWithBrokenQrCandidate(graph, repo, "https://example-test-business.com/fail-closed-case");

    await assert.rejects(
      () =>
        confirmSignQrDestination(projectId, {
          regionKey: "0000000000000000",
          destination: "https://example-test-business.com/booking",
          confirmedBy: "customer",
        }),
      SignQrPreservationError,
    );

    const preparation = await repo.getSignPreparation(projectId);
    assert.ok(
      !preparation?.qrResolutions || preparation.qrResolutions.length === 0,
      "a forged/mismatched regionKey must never create a phantom resolution record",
    );
  });

  it("confirmSignQrDestination: an invalid destination is rejected BEFORE anything is persisted", async () => {
    const { graph, repo } = await freshGraph();
    const { checkSignQrPreservation, confirmSignQrDestination, SignQrPreservationError } = await import(
      "./sign-qr-preservation-service"
    );
    const { projectId } = await projectWithBrokenQrCandidate(graph, repo, "https://example-test-business.com/invalid-dest-case");
    const before = await checkSignQrPreservation(projectId);
    const regionKey = before.report.instances[0].regionKey!;

    await assert.rejects(
      () =>
        confirmSignQrDestination(projectId, {
          regionKey,
          destination: "javascript:alert(1)",
          confirmedBy: "customer",
        }),
      SignQrPreservationError,
    );

    const preparation = await repo.getSignPreparation(projectId);
    assert.ok(
      !preparation?.qrResolutions || preparation.qrResolutions.length === 0,
      "an invalid destination must never reach persistence",
    );
  });

  it("confirmSignQrDestination: CONFIRM DESTINATION — persists the record, applies the correction immediately (a candidate already exists), and the returned evidence shows pass/confirmed_by_user — never claiming source verification", async () => {
    const { graph, repo } = await freshGraph();
    const { checkSignQrPreservation, confirmSignQrDestination } = await import("./sign-qr-preservation-service");
    const { projectId } = await projectWithBrokenQrCandidate(graph, repo, "https://example-test-business.com/confirm-case");

    const before = await checkSignQrPreservation(projectId);
    const regionKey = before.report.instances[0].regionKey!;
    const destination = "https://example-test-business.com/booking";

    const result = await confirmSignQrDestination(projectId, { regionKey, destination, confirmedBy: "customer" });
    assert.equal(result.appliedImmediately, true, "a candidate already exists — the correction must apply immediately, no Topaz rerun");
    assert.ok(result.report);
    assert.equal(result.report!.instances[0].result, "pass");
    assert.equal(
      result.report!.instances[0].provenance,
      "confirmed_by_user",
      "provenance must distinguish a confirmed-destination pass from a source-verified pass",
    );

    // Durability: the record itself was persisted, with the EXACT confirmed
    // payload, correct provenance, and no destination-authority confusion.
    const preparation = await repo.getSignPreparation(projectId);
    const resolutions = (preparation?.qrResolutions ?? []) as Array<Record<string, unknown>>;
    assert.equal(resolutions.length, 1);
    assert.equal(resolutions[0].state, "confirmed_destination");
    assert.equal(resolutions[0].confirmedPayload, destination);
    assert.equal(resolutions[0].confirmedBy, "customer");
    assert.equal(resolutions[0].regionKey, regionKey);
  });

  it("QR REPAIR V2: a genuinely low-confidence (poorly-localized) region refuses automatic replacement — the destination is durably recorded, but no asset is created and the region stays needs_attention", async () => {
    const { graph, repo } = await freshGraph();
    const { checkSignQrPreservation, confirmSignQrDestination } = await import("./sign-qr-preservation-service");
    const { projectId, job } = await projectWithPoorlyLocalizedQrCandidate(
      graph,
      repo,
      "https://example-test-business.com/poorly-localized-case",
    );

    const before = await checkSignQrPreservation(projectId);
    assert.equal(before.report.overall, "review_required");
    assert.equal(
      before.report.instances[0].sourceLocalizationConfidence,
      "low",
      "sanity: this fixture must actually produce low localization confidence (only 2 of 3 finder patterns present)",
    );
    const regionKey = before.report.instances[0].regionKey!;
    const assetsBefore = (await repo.listAssetsForFinalArtworkJob(projectId, job.id)).length;

    const result = await confirmSignQrDestination(projectId, {
      regionKey,
      destination: "https://example-test-business.com/poorly-localized-destination",
      confirmedBy: "customer",
    });
    assert.equal(result.appliedImmediately, false, "a low-confidence region must never be automatically composited into, even with a confirmed destination");

    // The destination IS durably recorded regardless (Section J: confirming
    // a destination and being able to safely place it are separate
    // authorities) — never lost merely because placement isn't safe yet.
    const preparation = await repo.getSignPreparation(projectId);
    const resolutions = (preparation?.qrResolutions ?? []) as Array<Record<string, unknown>>;
    assert.equal(resolutions.length, 1);
    assert.equal(resolutions[0].state, "confirmed_destination");
    assert.equal(resolutions[0].confirmedPayload, "https://example-test-business.com/poorly-localized-destination");

    // No new asset/validation was created — nothing was composited.
    const assetsAfter = (await repo.listAssetsForFinalArtworkJob(projectId, job.id)).length;
    assert.equal(assetsAfter, assetsBefore, "a refused placement must never create a derived asset");

    const after = await checkSignQrPreservation(projectId);
    assert.equal(after.report.overall, "review_required", "still genuinely unresolved — never silently promoted to pass");
    assert.equal(after.validationStatus, "finalization_required");
  });

  it("confirmSignQrDestination: re-checking from scratch afterwards still reports pass/confirmed_by_user — the resolution is durable, not just returned once", async () => {
    const { graph, repo } = await freshGraph();
    const { checkSignQrPreservation, confirmSignQrDestination } = await import("./sign-qr-preservation-service");
    const { projectId, job } = await projectWithBrokenQrCandidate(graph, repo, "https://example-test-business.com/durable-case");

    const before = await checkSignQrPreservation(projectId);
    const regionKey = before.report.instances[0].regionKey!;
    await confirmSignQrDestination(projectId, {
      regionKey,
      destination: "https://example-test-business.com/durable-booking",
      confirmedBy: "customer",
    });

    const after = await checkSignQrPreservation(projectId);
    assert.equal(after.report.overall, "pass");
    assert.equal(after.report.instances[0].provenance, "confirmed_by_user");

    // Assert the SPECIFIC machine_readable_content_preserved check, not the
    // aggregate validationStatus: this fixture's composition plan always
    // requires semantic-preservation verification, which the automated
    // test environment's placeholder provider deliberately never certifies
    // as "preserved" (mirrors `sign-artwork-service.test.ts`'s own
    // documented caveat) — an UNRELATED, always-failing
    // `executed_plan_matches_recorded_plan` check in this harness, so the
    // aggregate can never reach "ready" here regardless of QR resolution.
    const validation = await repo.getLatestProductionAssetValidationForJob(projectId, job.id);
    const checks = (validation!.report as { checks: Array<{ check: string; status: string; severity: string }> }).checks;
    const qrCheck = checks.find((c) => c.check === "machine_readable_content_preserved");
    assert.equal(qrCheck?.status, "pass", "with the QR resolved, machine_readable_content_preserved must no longer block");
    assert.equal(qrCheck?.severity, "blocking");
  });

  it("acceptSignQrPrintAsSupplied: PRINT AS SUPPLIED — persists the record and reports accepted_as_supplied, never pass, and never blocks Print Ready by itself", async () => {
    const { graph, repo } = await freshGraph();
    const { checkSignQrPreservation, acceptSignQrPrintAsSupplied } = await import("./sign-qr-preservation-service");
    const { projectId } = await projectWithBrokenQrCandidate(graph, repo, "https://example-test-business.com/print-as-supplied-case");

    const before = await checkSignQrPreservation(projectId);
    const regionKey = before.report.instances[0].regionKey!;

    const result = await acceptSignQrPrintAsSupplied(projectId, { regionKey, confirmedBy: "customer" });
    assert.ok(result.report);
    assert.equal(result.report!.instances[0].result, "accepted_as_supplied");
    assert.notEqual(result.report!.instances[0].result, "pass", "print-as-supplied must never claim the QR was verified");
    assert.equal(result.report!.instances[0].provenance, "print_as_supplied");

    const preparation = await repo.getSignPreparation(projectId);
    const resolutions = (preparation?.qrResolutions ?? []) as Array<Record<string, unknown>>;
    assert.equal(resolutions.length, 1);
    assert.equal(resolutions[0].state, "print_as_supplied");
    assert.equal(resolutions[0].confirmedPayload, null);

    // accepted_as_supplied is a WARNING, not blocking — the aggregate status
    // must not be forced to finalization_required by this check alone.
    const after = await checkSignQrPreservation(projectId);
    assert.equal(after.report.overall, "accepted_as_supplied");
  });

  it("restoreSignQrCode: applying a pending confirmed-destination correction produces a NEW derived asset whose ACTUAL persisted bytes decode exactly the confirmed payload", async () => {
    const { graph, repo } = await freshGraph();
    const { checkSignQrPreservation, confirmSignQrDestination } = await import("./sign-qr-preservation-service");
    const { decodeQrCodes } = await import("@/capabilities/machine-readable-content/qr-detect-decode");
    const { readPhysicalPixelDensity } = await import("@/capabilities/final-artwork/production-png");
    const { projectId, job } = await projectWithBrokenQrCandidate(graph, repo, "https://example-test-business.com/derived-asset-case");

    const before = await checkSignQrPreservation(projectId);
    const regionKey = before.report.instances[0].regionKey!;
    const destination = "https://example-test-business.com/derived-asset-booking";

    const confirmResult = await confirmSignQrDestination(projectId, { regionKey, destination, confirmedBy: "customer" });
    assert.equal(confirmResult.appliedImmediately, true);

    // A NEW production asset must exist under the SAME job — the original
    // candidate is never overwritten in place.
    const validation = await repo.getLatestProductionAssetValidationForJob(projectId, job.id);
    assert.ok(validation);
    const newAssetId = validation!.assetId;
    const downloaded = await graph.assets.downloadAssetBytes(newAssetId);
    assert.ok(downloaded);
    const png = PNG.sync.read(downloaded!.bytes);
    const decoded = decodeQrCodes({ width: png.width, height: png.height, data: Buffer.from(png.data) });
    assert.equal(decoded.length, 1, "the persisted derived asset itself must decode a QR");
    assert.equal(decoded[0].payload, destination, "the ACTUAL persisted bytes must decode to EXACTLY the confirmed destination");

    // Fix Final PNG Physical Size / PPI Metadata Integrity Phase (real Get
    // Hibachi production incident): the ACTUAL persisted bytes of a
    // QR-corrected candidate must carry correct pHYs — parsed directly
    // from the real PNG chunk data (`downloaded!.bytes`), never an
    // in-memory metadata object, exactly reproducing the real defect
    // (`PNG.sync.write` with no density wrap) and proving it is fixed.
    // This fixture's own composition (600x900px, ordered 4x6in,
    // reconstruction: null, exact-aspect 1:1 fit) is exactly 150 PPI.
    const density = readPhysicalPixelDensity(downloaded!.bytes);
    assert.ok(density, "the QR-corrected candidate's ACTUAL bytes must carry a pHYs chunk — this is the exact real defect (missing pHYs -> 72 DPI in production software)");
    assert.equal(density!.pixelsPerMetreX, 5906, "round(150 * 39.3700787402) = 5906");
    assert.equal(density!.pixelsPerMetreY, 5906);
    assert.ok(Math.abs(density!.ppiX - 150) < 0.1, `declared PPI (${density!.ppiX}) must match the ordered 4x6in @ 150 PPI geometry, never a default like 72 DPI`);
    assert.ok(Math.abs(density!.ppiY - 150) < 0.1);
    // Independent confirmation via the same authoritative check the worker
    // and PrintValidation both use — the merged validation's OWN
    // physical_resolution_metadata check for this NEW asset (never carried
    // forward stale from the OLD asset's validation).
    const checks = (validation!.report as { checks: Array<{ check: string; status: string }> }).checks;
    const physicalCheck = checks.find((c) => c.check === "physical_resolution_metadata");
    assert.equal(physicalCheck?.status, "pass");
  });

  it("multiple projects (independent regions): resolving one project's QR never affects another project's evidence", async () => {
    const { graph, repo } = await freshGraph();
    const { checkSignQrPreservation, confirmSignQrDestination } = await import("./sign-qr-preservation-service");
    const projectA = await projectWithBrokenQrCandidate(graph, repo, "https://example-test-business.com/project-a");
    const projectB = await projectWithBrokenQrCandidate(graph, repo, "https://example-test-business.com/project-b");

    const beforeA = await checkSignQrPreservation(projectA.projectId);
    const regionKeyA = beforeA.report.instances[0].regionKey!;
    await confirmSignQrDestination(projectA.projectId, {
      regionKey: regionKeyA,
      destination: "https://example-test-business.com/project-a-booking",
      confirmedBy: "customer",
    });

    const afterA = await checkSignQrPreservation(projectA.projectId);
    const afterB = await checkSignQrPreservation(projectB.projectId);
    assert.equal(afterA.report.overall, "pass");
    assert.equal(afterB.report.overall, "review_required", "project B's own unresolved QR must remain blocking — untouched by project A's resolution");
  });
});

/**
 * Fix Existing Final Sign Candidate Physical-Resolution Metadata Repair
 * Phase (real Get Hibachi production incident): `repairSignPhysicalResolution
 * Metadata` — a governed, metadata-ONLY repair for a current candidate whose
 * embedded `pHYs` density is missing or disagrees with the ordered physical
 * size. `600x900px` ordered `4x6in` = exactly 150 PPI, the SAME already-
 * proven-safe geometry every other fixture in this file uses.
 */
describe("repairSignPhysicalResolutionMetadata: Fix Existing Final Sign Candidate Physical-Resolution Metadata Repair Phase", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-sign-physical-resolution-repair-"));
    process.chdir(tempDir);
  });

  after(async () => {
    await cleanupTempWorkspace(tempDir, previousCwd);
  });

  async function freshGraph() {
    const { resetCapabilityGraphForTests, getCapabilityGraph } = await import("@/capabilities/composition");
    resetCapabilityGraphForTests();
    resetDecodedCandidateCacheForTests();
    const graph = getCapabilityGraph();
    const { getProjectRepository } = await import("@/lib/db");
    return { graph, repo: getProjectRepository() };
  }

  /**
   * A clean, print-ready sign candidate with NO QR content at all — the
   * SAME shape `sign-plan-operator-review.test.ts`'s own "prepared and
   * print-ready" fixture uses (1800x2400px, ordered 12x16in = exactly 150
   * PPI), so the worker's own real completion path (which, post-dcf0ca6,
   * always writes correct pHYs) is the ONLY source of the "before"
   * candidate — this test file never hand-constructs a FinalArtworkJob or
   * ProductionAsset for the candidate under repair.
   */
  async function projectWithPrintReadySignCandidate(
    graph: Awaited<ReturnType<typeof freshGraph>>["graph"],
    repo: Awaited<ReturnType<typeof freshGraph>>["repo"],
  ) {
    const created = await repo.createProject();
    const projectId = created.project.id;
    await graph.signPreparation.uploadSignArtwork(projectId, {
      bytes: toPngBytes(exactAspectSignArtwork(1800, 2400)),
      declaredContentType: "image/png",
      filename: "sign-clean.png",
    });
    await graph.signPreparation.confirmSignProductionSpec(projectId, 12, 16);
    await graph.signPreparation.planSignRepair(projectId);
    await graph.signPreparation.authorizeSignRepairPlan(projectId, { authorizedBy: "operator" });
    const { job } = await graph.finalArtwork.requestSignFinalArtwork(projectId);
    await graph.finalArtworkScheduler.runBatch();
    const completedJob = await repo.getFinalArtworkJob(job.id);
    assert.equal(completedJob!.status, "completed", "sanity: the worker run must complete for this fixture");
    const project = await repo.getProject(projectId);
    assert.equal(project!.project.status, "print_ready", "sanity: this fixture must reach print_ready on its own");
    return { projectId, job };
  }

  /**
   * Simulates the REAL historical defect: takes the worker's own correctly-
   * tagged candidate bytes and re-encodes them through a bare `pngjs`
   * round-trip (`PNG.sync.write(PNG.sync.read(bytes))`), which — exactly
   * like the real `restoreSignQrCode` call before `dcf0ca6` — carries no
   * `pHYs` chunk at all, while leaving the decoded RGBA pixels themselves
   * untouched. Uploads the corrupted bytes as a NEW candidate under the
   * SAME job (mirroring how the real defect actually arose: a genuinely
   * NEW derived asset, never an in-place overwrite) and persists a
   * validation for it naming `physical_resolution_metadata` as the sole
   * failing check — a report shape indistinguishable from what the real,
   * fully up-to-date validation logic would produce against these exact
   * corrupted bytes.
   */
  async function simulateHistoricalMissingPhysCandidate(
    graph: Awaited<ReturnType<typeof freshGraph>>["graph"],
    repo: Awaited<ReturnType<typeof freshGraph>>["repo"],
    projectId: string,
    job: { id: string },
  ) {
    const { PNG: PngCodec } = await import("pngjs");
    const priorValidation = await repo.getLatestProductionAssetValidationForJob(projectId, job.id);
    const cleanAssetId = priorValidation!.assetId;
    const downloaded = await graph.assets.downloadAssetBytes(cleanAssetId);
    const cleanPng = PngCodec.sync.read(downloaded!.bytes);
    const corruptedBytes = PngCodec.sync.write(cleanPng); // pngjs never writes pHYs — exactly the real historical bug.

    const corruptedAsset = await graph.assets.uploadProductionAsset(projectId, {
      conceptId: `sign-${job.id}-historical-missing-phys-${Date.now()}`,
      bytes: corruptedBytes,
      contentType: "image/png",
      widthPx: cleanPng.width,
      heightPx: cleanPng.height,
      hasTransparency: false,
      finalArtworkJobId: job.id,
      productionRole: "production_png",
      metadata: {},
    });
    const priorChecks = Array.isArray((priorValidation!.report as { checks?: unknown[] })?.checks)
      ? ((priorValidation!.report as { checks: Array<Record<string, unknown>> }).checks)
      : [];
    await repo.createProductionAssetValidation(projectId, {
      finalArtworkJobId: job.id,
      assetId: corruptedAsset.id,
      status: "finalization_required",
      report: {
        checks: [
          ...priorChecks.filter((c) => c.check !== "physical_resolution_metadata"),
          {
            check: "physical_resolution_metadata",
            status: "fail",
            severity: "blocking",
            reason: "test: embedded physical-resolution metadata is missing",
          },
        ],
        status: "finalization_required",
      },
    });
    return { corruptedAsset, cleanAssetId, cleanRgba: Buffer.from(cleanPng.data), width: cleanPng.width, height: cleanPng.height };
  }

  it("Section O: exact Get Hibachi shape (missing pHYs entirely) — repaired to the correct density, decoded RGBA byte-for-byte identical, old asset never overwritten, new asset becomes the print-ready delivery", async () => {
    const { graph, repo } = await freshGraph();
    const { repairSignPhysicalResolutionMetadata } = await import("./sign-qr-preservation-service");
    const { readPhysicalPixelDensity } = await import("@/capabilities/final-artwork/production-png");

    const { projectId, job } = await projectWithPrintReadySignCandidate(graph, repo);
    const { corruptedAsset, cleanAssetId, cleanRgba, width, height } = await simulateHistoricalMissingPhysCandidate(
      graph,
      repo,
      projectId,
      job,
    );

    const assetsBefore = await repo.listAssetsForFinalArtworkJob(projectId, job.id);

    const result = await repairSignPhysicalResolutionMetadata(projectId);
    assert.equal(result.repaired, true);
    assert.ok(result.newAssetId);
    assert.notEqual(result.newAssetId, corruptedAsset.id, "the corrupted asset must never be overwritten in place");
    assert.notEqual(result.newAssetId, cleanAssetId);
    assert.equal(result.pixelsPerMetre, 5906, "round(150 * 39.3700787402) = 5906");
    assert.ok(Math.abs(result.achievedPpi! - 150) < 0.001);

    // The ACTUAL persisted bytes carry the correct pHYs.
    const downloadedNew = await graph.assets.downloadAssetBytes(result.newAssetId!);
    const density = readPhysicalPixelDensity(downloadedNew!.bytes);
    assert.ok(density, "the repaired candidate's actual bytes must carry a pHYs chunk");
    assert.equal(density!.pixelsPerMetreX, 5906);
    assert.equal(density!.pixelsPerMetreY, 5906);
    assert.ok(Math.abs(density!.ppiX - 150) < 0.1, "within the rounding tolerance of round-to-nearest-integer pixelsPerMetre");

    // Section H/Q: decoded RGBA byte-for-byte identical to the pre-repair candidate.
    const { PNG } = await import("pngjs");
    const newPng = PNG.sync.read(downloadedNew!.bytes);
    assert.equal(newPng.width, width);
    assert.equal(newPng.height, height);
    assert.ok(Buffer.from(newPng.data).equals(cleanRgba), "decoded RGBA must be byte-for-byte identical — not a single artwork pixel may change");

    // The corrupted (and the original clean) assets remain historical,
    // completely untouched.
    const corruptedStillThere = await graph.assets.downloadAssetBytes(corruptedAsset.id);
    assert.ok(corruptedStillThere);
    assert.equal(readPhysicalPixelDensity(corruptedStillThere!.bytes), null, "the corrupted historical asset itself is never mutated");
    const assetsAfter = await repo.listAssetsForFinalArtworkJob(projectId, job.id);
    assert.equal(assetsAfter.length, assetsBefore.length + 1, "exactly one NEW asset — nothing overwritten, nothing else created");

    // Section K/L: the NEW validation's own physical_resolution_metadata
    // check passes, and download/current-candidate authority now resolve
    // to the NEW asset.
    const newValidation = await repo.getLatestProductionAssetValidationForJob(projectId, job.id);
    assert.equal(newValidation!.assetId, result.newAssetId);
    const checks = (newValidation!.report as { checks: Array<{ check: string; status: string }> }).checks;
    assert.equal(checks.find((c) => c.check === "physical_resolution_metadata")?.status, "pass");

    const delivery = await graph.finalArtwork.resolveCurrentSignProductionDelivery(projectId);
    if (result.validationStatus === "ready") {
      assert.equal(delivery?.assetId, result.newAssetId, "download authority must select the NEW repaired asset, never the corrupted historical one");
    }
  });

  it("Section P: wrong-72-DPI-equivalent metadata — replaced with the correct density, pixels unchanged", async () => {
    const { graph, repo } = await freshGraph();
    const { repairSignPhysicalResolutionMetadata } = await import("./sign-qr-preservation-service");
    const { readPhysicalPixelDensity, withPhysicalPixelDensity, pixelsPerMetreForPpi } = await import(
      "@/capabilities/final-artwork/production-png"
    );
    const { PNG } = await import("pngjs");

    const { projectId, job } = await projectWithPrintReadySignCandidate(graph, repo);
    const priorValidation = await repo.getLatestProductionAssetValidationForJob(projectId, job.id);
    const cleanAssetId = priorValidation!.assetId;
    const downloadedClean = await graph.assets.downloadAssetBytes(cleanAssetId);
    const cleanPng = PNG.sync.read(downloadedClean!.bytes);
    const cleanRgba = Buffer.from(cleanPng.data);
    // Wrong 72 DPI, the classic "no density tag at all" production-software
    // default — a genuinely WRONG (never missing) declared density.
    const wrongDensityBytes = withPhysicalPixelDensity(downloadedClean!.bytes, pixelsPerMetreForPpi(72));
    assert.equal(readPhysicalPixelDensity(wrongDensityBytes)!.pixelsPerMetreX, 2835, "round(72 * 39.3700787402) = 2835 — sanity on the wrong fixture itself");

    const wrongAsset = await graph.assets.uploadProductionAsset(projectId, {
      conceptId: `sign-${job.id}-wrong-72dpi-${Date.now()}`,
      bytes: wrongDensityBytes,
      contentType: "image/png",
      widthPx: cleanPng.width,
      heightPx: cleanPng.height,
      hasTransparency: false,
      finalArtworkJobId: job.id,
      productionRole: "production_png",
      metadata: {},
    });
    const priorChecks = (priorValidation!.report as { checks: Array<Record<string, unknown>> }).checks;
    await repo.createProductionAssetValidation(projectId, {
      finalArtworkJobId: job.id,
      assetId: wrongAsset.id,
      status: "finalization_required",
      report: {
        checks: [
          ...priorChecks.filter((c) => c.check !== "physical_resolution_metadata"),
          { check: "physical_resolution_metadata", status: "fail", severity: "blocking", reason: "test: wrong density" },
        ],
        status: "finalization_required",
      },
    });

    const result = await repairSignPhysicalResolutionMetadata(projectId);
    assert.equal(result.repaired, true);
    assert.equal(result.pixelsPerMetre, 5906);

    const downloadedNew = await graph.assets.downloadAssetBytes(result.newAssetId!);
    const density = readPhysicalPixelDensity(downloadedNew!.bytes);
    assert.equal(density!.pixelsPerMetreX, 5906, "the wrong 72 DPI declaration must be REPLACED, not merged with or averaged against");
    const newPng = PNG.sync.read(downloadedNew!.bytes);
    assert.ok(Buffer.from(newPng.data).equals(cleanRgba), "pixels must be unchanged by a density-only correction");
  });

  it("Section Q: idempotency — a current candidate whose metadata already agrees is a genuine no-op, no new asset, no new validation", async () => {
    const { graph, repo } = await freshGraph();
    const { repairSignPhysicalResolutionMetadata } = await import("./sign-qr-preservation-service");

    const { projectId, job } = await projectWithPrintReadySignCandidate(graph, repo);
    const assetsBefore = await repo.listAssetsForFinalArtworkJob(projectId, job.id);
    const validationBefore = await repo.getLatestProductionAssetValidationForJob(projectId, job.id);

    const result = await repairSignPhysicalResolutionMetadata(projectId);
    assert.equal(result.repaired, false);
    assert.equal(result.newAssetId, null);
    assert.equal(result.validationStatus, null);
    assert.equal(result.pixelsPerMetre, 5906, "reports the ALREADY-correct density back, for informational purposes only");

    const assetsAfter = await repo.listAssetsForFinalArtworkJob(projectId, job.id);
    assert.equal(assetsAfter.length, assetsBefore.length, "no new asset — a genuine no-op");
    const validationAfter = await repo.getLatestProductionAssetValidationForJob(projectId, job.id);
    assert.equal(validationAfter!.id, validationBefore!.id, "no new validation record either");

    // Double-submission: calling it again is equally inert.
    const secondResult = await repairSignPhysicalResolutionMetadata(projectId);
    assert.equal(secondResult.repaired, false);
    const assetsAfterSecond = await repo.listAssetsForFinalArtworkJob(projectId, job.id);
    assert.equal(assetsAfterSecond.length, assetsBefore.length, "a repeated call never creates a duplicate derived candidate");
  });

  it("Section Q: double-submission after a genuine repair — the second call sees the now-current (repaired) candidate already agrees, and is a no-op", async () => {
    const { graph, repo } = await freshGraph();
    const { repairSignPhysicalResolutionMetadata } = await import("./sign-qr-preservation-service");

    const { projectId, job } = await projectWithPrintReadySignCandidate(graph, repo);
    await simulateHistoricalMissingPhysCandidate(graph, repo, projectId, job);

    const first = await repairSignPhysicalResolutionMetadata(projectId);
    assert.equal(first.repaired, true);
    const assetsAfterFirst = await repo.listAssetsForFinalArtworkJob(projectId, job.id);

    const second = await repairSignPhysicalResolutionMetadata(projectId);
    assert.equal(second.repaired, false, "the repaired candidate from the first call is now current and already agrees");
    assert.equal(second.newAssetId, null);
    const assetsAfterSecond = await repo.listAssetsForFinalArtworkJob(projectId, job.id);
    assert.equal(assetsAfterSecond.length, assetsAfterFirst.length, "no second derived candidate is ever created");
  });

  it("Section R (CRITICAL): the pixel-mutation safety net refuses when decoded pixels would differ, and never refuses when they are genuinely identical", async () => {
    const { assertPhysicalResolutionRepairPreservesPixels, SignQrPreservationError } = await import(
      "./sign-qr-preservation-service"
    );

    const before = { width: 4, height: 4, data: Buffer.alloc(4 * 4 * 4, 7) };
    const identical = { width: 4, height: 4, data: Buffer.from(before.data) };
    assert.doesNotThrow(() => assertPhysicalResolutionRepairPreservesPixels(before, identical));

    const differentBytes = { width: 4, height: 4, data: Buffer.alloc(4 * 4 * 4, 9) };
    assert.throws(() => assertPhysicalResolutionRepairPreservesPixels(before, differentBytes), SignQrPreservationError);

    const differentWidth = { width: 5, height: 4, data: Buffer.alloc(5 * 4 * 4, 7) };
    assert.throws(() => assertPhysicalResolutionRepairPreservesPixels(before, differentWidth), SignQrPreservationError);

    const differentHeight = { width: 4, height: 5, data: Buffer.alloc(4 * 5 * 4, 7) };
    assert.throws(() => assertPhysicalResolutionRepairPreservesPixels(before, differentHeight), SignQrPreservationError);
  });

  it("QR identity (Section I): a candidate with an intact, decodable QR keeps decoding to the EXACT same payload after the repair, re-verified against the actual new asset", async () => {
    const { graph, repo } = await freshGraph();
    const { repairSignPhysicalResolutionMetadata } = await import("./sign-qr-preservation-service");
    const { decodeQrCodes } = await import("@/capabilities/machine-readable-content/qr-detect-decode");
    const { PNG } = await import("pngjs");
    const QRCode = (await import("qrcode")).default;

    // A clean sign candidate with a fully intact (undamaged) QR pasted in —
    // decodes on both the source and the candidate from the start, so this
    // fixture never enters the QR review/restoration machinery at all; it
    // exists solely to prove the metadata repair leaves the QR provably
    // untouched.
    const payload = "https://example-test-business.com/physical-resolution-qr-case";
    const qrBuf = await QRCode.toBuffer(payload, { errorCorrectionLevel: "H", margin: 4, width: 150 });
    const qrPng = PNG.sync.read(qrBuf);
    const image = makeImage(600, 900, { r: 250, g: 250, b: 250 });
    fillRect(image, 20, 20, 580, 100, { r: 30, g: 30, b: 30 });
    for (let y = 0; y < qrPng.height; y++) {
      for (let x = 0; x < qrPng.width; x++) {
        const si = (y * qrPng.width + x) * 4;
        const dx = 400 + x;
        const dy = 700 + y;
        if (dx < 0 || dx >= image.width || dy < 0 || dy >= image.height) continue;
        const di = (dy * image.width + dx) * 4;
        image.data[di] = qrPng.data[si];
        image.data[di + 1] = qrPng.data[si + 1];
        image.data[di + 2] = qrPng.data[si + 2];
        image.data[di + 3] = 255;
      }
    }

    const created = await repo.createProject();
    const projectId = created.project.id;
    await graph.signPreparation.uploadSignArtwork(projectId, {
      bytes: toPngBytes(image),
      declaredContentType: "image/png",
      filename: "sign-with-intact-qr.png",
    });
    await graph.signPreparation.confirmSignProductionSpec(projectId, 4, 6);
    await graph.signPreparation.confirmSignCompositionPlan(projectId, {
      reconstruction: null,
      crop: null,
      fitBackground: { r: 250, g: 250, b: 250 },
      fitPlacement: null,
      moves: [],
      fills: [],
      replacements: [],
    });
    await graph.signPreparation.authorizeSignRepairPlan(projectId, { authorizedBy: "operator" });
    const { job } = await graph.finalArtwork.requestSignFinalArtwork(projectId);
    await graph.finalArtworkScheduler.runBatch();
    const completedJob = await repo.getFinalArtworkJob(job.id);
    assert.equal(completedJob!.status, "completed", "sanity: the worker run must complete for this fixture");

    await simulateHistoricalMissingPhysCandidate(graph, repo, projectId, job);

    const result = await repairSignPhysicalResolutionMetadata(projectId);
    assert.equal(result.repaired, true);

    const downloadedNew = await graph.assets.downloadAssetBytes(result.newAssetId!);
    const newPng = PNG.sync.read(downloadedNew!.bytes);
    const decoded = decodeQrCodes({ width: newPng.width, height: newPng.height, data: Buffer.from(newPng.data) });
    assert.equal(decoded.length, 1, "the repaired candidate's ACTUAL persisted bytes must still decode a QR");
    assert.equal(decoded[0].payload, payload, "the exact same payload — the QR was never regenerated, moved, or recomposited");

    const newValidation = await repo.getLatestProductionAssetValidationForJob(projectId, job.id);
    const checks = (newValidation!.report as { checks: Array<{ check: string; status: string }> }).checks;
    assert.equal(checks.find((c) => c.check === "machine_readable_content_preserved")?.status, "pass", "re-verified fresh against the ACTUAL new asset, never merely copied forward");
  });

  it("eligibility (Section E): refuses when this sign has no confirmed ordered physical size", async () => {
    const { graph, repo } = await freshGraph();
    const { repairSignPhysicalResolutionMetadata, SignQrPreservationError } = await import(
      "./sign-qr-preservation-service"
    );
    const { projectId } = await projectWithPrintReadySignCandidate(graph, repo);
    // Defensive: a real production candidate cannot exist without a
    // confirmed ordered size, so this simulates the guard directly.
    await repo.updateSignPreparation((await repo.getSignPreparation(projectId))!.id, {
      orderedWidthIn: null,
      orderedHeightIn: null,
    });

    await assert.rejects(() => repairSignPhysicalResolutionMetadata(projectId), SignQrPreservationError);
  });

  it("refuses when no production candidate exists yet for this sign", async () => {
    const { graph, repo } = await freshGraph();
    const { repairSignPhysicalResolutionMetadata, SignQrPreservationError } = await import(
      "./sign-qr-preservation-service"
    );
    const created = await repo.createProject();
    const projectId = created.project.id;
    await graph.signPreparation.uploadSignArtwork(projectId, {
      bytes: toPngBytes(exactAspectSignArtwork(1800, 2400)),
      declaredContentType: "image/png",
      filename: "sign.png",
    });
    await graph.signPreparation.confirmSignProductionSpec(projectId, 12, 16);
    await graph.signPreparation.planSignRepair(projectId);
    await graph.signPreparation.authorizeSignRepairPlan(projectId, { authorizedBy: "operator" });

    await assert.rejects(() => repairSignPhysicalResolutionMetadata(projectId), SignQrPreservationError);
  });
});
