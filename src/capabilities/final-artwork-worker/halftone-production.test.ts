import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { PNG } from "pngjs";

import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";
import { confirmProductionSizeForTests } from "@/test-support/confirm-production-size";
import { DataUriAssetStorageProvider } from "@/capabilities/asset-storage";
import { createAssetCapability, PngThumbnailGenerator } from "@/capabilities/assets";
import { createDesignBriefCapability } from "@/capabilities/design-brief";
import { createFinalArtworkCapability } from "@/capabilities/final-artwork";
import { LocalRasterInterpolationProvider } from "@/capabilities/final-artwork/local-raster-provider";
import { resolveReconstructionRequest } from "@/capabilities/final-artwork/topaz-transparency-upscale-provider";
import type {
  FinalArtworkProvider,
  FinalArtworkProviderOutput,
} from "@/capabilities/final-artwork/provider";
import { readPhysicalPixelDensity } from "@/capabilities/final-artwork/production-png";
import { createPrintValidationCapability } from "@/capabilities/print-validation";
import type {
  PrintValidationCheck,
  PrintValidationReport,
} from "@/capabilities/print-validation/contracts";
import { sizingPolicyForConfirmedSize } from "@/capabilities/shared/confirmed-production-size";
import {
  normalizeHalftoneSettings,
  productionTreatmentKey,
  resolveGarmentColor,
  type HalftoneSettingsRequest,
} from "@/capabilities/shared/production-treatment";
import type { AssetRecord } from "@/lib/domain/types";
import type { ProjectRepository } from "@/lib/db/repository";

import { createFinalArtworkWorkerCapability } from "./final-artwork-worker-capability";

/**
 * Print'em All Phase 2 — THE LIVE FIXTURE.
 *
 * These numbers are not invented. They are the real Print'em All job that
 * motivated this phase: a 584x640 prepared canvas whose visible artwork is
 * 562x486, a black garment, a full-back placement, and a confirmed adult
 * standard production size of 10.5 inches.
 *
 * That file needs a 5.6x reconstruction to reach 3150px of continuous tone,
 * and the reconstruction provider's proven effective ceiling is 4x. Standard
 * raster therefore refuses it BEFORE dispatch, for free — and this file
 * asserts that refusal still stands, unchanged, alongside the halftone path
 * succeeding on the very same artwork.
 *
 * BOTH must be true at once. If making the halftone case pass ever required
 * loosening the standard-raster case, the treatment would have become the
 * loophole it is explicitly not.
 *
 * NO PAID PROVIDER IS REACHABLE HERE. The reconstruction provider injected
 * below THROWS if it is ever called at all — a spy that merely counted would
 * let a regression produce a passing suite with a nonzero count nobody read.
 *
 * ON TEST SHAPE: the full-size scenarios each produce a real 3150x2736 plate
 * and persist it through the JSON-file test repository, so each one is
 * genuinely expensive. Scenarios that assert something about the SAME plate
 * therefore share one pipeline run via a `before` hook, and scenarios about
 * things physical size cannot affect (which control reached the raster,
 * lineage, immutability) run at a small confirmed size. Nothing is skipped;
 * the same assertions are simply not paid for repeatedly.
 */

/** The exact live geometry. */
const LIVE_FIXTURE = {
  canvasWidthPx: 584,
  canvasHeightPx: 640,
  artworkWidthPx: 562,
  artworkHeightPx: 486,
};

/** Full-back's technical minimum — a real production size, and a cheap plate. */
const SMALL_WIDTH_IN = 4;

class ForbiddenReconstructionProvider implements FinalArtworkProvider {
  readonly providerKey = "forbidden_paid_reconstruction";
  calls = 0;
  async produce(): Promise<FinalArtworkProviderOutput> {
    this.calls += 1;
    throw new Error(
      "PAID RECONSTRUCTION PROVIDER WAS CALLED — the halftone path must never reach it",
    );
  }
}

/** Counts local normalization calls, so "which local path ran" stays observable. */
class CountingLocalProvider implements FinalArtworkProvider {
  readonly providerKey = "local_raster_interpolation";
  calls = 0;
  private readonly inner = new LocalRasterInterpolationProvider();
  async produce(input: Parameters<FinalArtworkProvider["produce"]>[0]) {
    this.calls += 1;
    return this.inner.produce(input);
  }
}

/**
 * The prepared, background-removed transparent source: a tonal subject on a
 * fully transparent canvas.
 *
 * Deliberately TONAL rather than flat. A halftone represents tone, so a
 * fixture with none would prove the plumbing while saying nothing about the
 * thing being built. The colour cast makes full-colour preservation
 * observable in the same fixture.
 */
function preparedTransparentPng(): Buffer {
  const { canvasWidthPx, canvasHeightPx, artworkWidthPx, artworkHeightPx } =
    LIVE_FIXTURE;
  const png = new PNG({ width: canvasWidthPx, height: canvasHeightPx });
  const insetX = Math.floor((canvasWidthPx - artworkWidthPx) / 2);
  const insetY = Math.floor((canvasHeightPx - artworkHeightPx) / 2);

  for (let y = 0; y < canvasHeightPx; y += 1) {
    for (let x = 0; x < canvasWidthPx; x += 1) {
      const i = (canvasWidthPx * y + x) << 2;
      const inside =
        x >= insetX &&
        x < insetX + artworkWidthPx &&
        y >= insetY &&
        y < insetY + artworkHeightPx;
      if (!inside) {
        png.data[i] = 0;
        png.data[i + 1] = 0;
        png.data[i + 2] = 0;
        png.data[i + 3] = 0;
        continue;
      }
      const tx = (x - insetX) / (artworkWidthPx - 1);
      const ty = (y - insetY) / (artworkHeightPx - 1);
      const level = Math.round(((tx + ty) / 2) * 255);
      png.data[i] = level;
      png.data[i + 1] = Math.round(level * 0.72);
      png.data[i + 2] = Math.round(level * 0.4);
      png.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

/** The immutable original: the same artwork on an OPAQUE BLACK background. */
function originalOpaqueBlackPng(): Buffer {
  const prepared = PNG.sync.read(preparedTransparentPng());
  for (let i = 0; i < prepared.data.length; i += 4) {
    if (prepared.data[i + 3] === 0) {
      prepared.data[i] = 0;
      prepared.data[i + 1] = 0;
      prepared.data[i + 2] = 0;
      prepared.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(prepared);
}

describe("Print'em All Phase 2 — DTF halftone production", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-halftone-"));
    process.chdir(tempDir);
  });

  after(async () => {
    await cleanupTempWorkspace(tempDir, previousCwd);
  });

  /**
   * A genuinely EMPTY repository.
   *
   * TWO REASONS, both found the hard way by this file.
   *
   * CORRECTNESS. `claimNextQueuedFinalArtworkJob` claims the oldest due job
   * in the STORE, not in the project. A scenario that deliberately leaves a
   * job queued (superseding one, then enqueueing its replacement) would
   * otherwise have that job claimed by the NEXT scenario's
   * `processNextJob()`, which would then assert against a plate belonging to
   * a different project entirely.
   *
   * COST. Every call into the local store is a read-modify-write of the whole
   * JSON file, and this file persists real multi-megabyte production plates.
   * Carrying twenty of them forward makes each successive scenario slower than
   * the last, quadratically, for no test value at all.
   *
   * The FILE is what gets removed, not the working directory. `local-store`
   * resolves its path once at module load, so `process.chdir` after the first
   * import moves the process and leaves the store exactly where it was —
   * which is the shape of the bug this comment exists to stop somebody
   * reintroducing.
   */
  async function freshRepo() {
    await rm(path.join(process.cwd(), ".data", "sprint1-store.json"), {
      force: true,
    });
    const { LocalProjectRepository } = await import("@/lib/db/local-store");
    return new LocalProjectRepository();
  }

  function buildPipeline(repo: ProjectRepository) {
    const assets = createAssetCapability(
      repo,
      new DataUriAssetStorageProvider(),
      new PngThumbnailGenerator(),
    );
    const paidProvider = new ForbiddenReconstructionProvider();
    const localProvider = new CountingLocalProvider();
    const worker = createFinalArtworkWorkerCapability(
      repo,
      assets,
      paidProvider,
      createPrintValidationCapability(),
      {
        async evaluate() {
          throw new Error("Concept Evaluation must never run for uploaded artwork");
        },
      } as never,
      localProvider,
    );
    return { assets, worker, paidProvider, localProvider };
  }

  interface Setup {
    /**
     * Skip the size confirmation entirely, leaving the project in the state
     * every pre-Phase-1 project is actually in: a prepared upload nobody ever
     * confirmed a physical size for.
     */
    confirmSize?: false;
    /** Confirmed physical production width, in inches. */
    widthIn?: number;
    /** Halftone settings to select, or omitted to leave the project on standard raster. */
    halftone?: HalftoneSettingsRequest;
    shirtColor?: string;
  }

  async function setupLiveFixture(
    repo: ProjectRepository,
    assets: ReturnType<typeof buildPipeline>["assets"],
    options: Setup = {},
  ) {
    const created = await repo.createProject();
    const projectId = created.project.id;

    await repo.updateBrief(projectId, {
      productSummary: "T-shirts for our bowling team",
      shirtColor: options.shirtColor ?? "Black",
      printPlacement: "full_back",
    });

    // --- Goal 26: the REAL black-background workflow. An opaque upload, a
    // deterministic background isolation, and an approved transparent prepared
    // asset. Halftoning starts from the prepared asset and never re-runs
    // background removal.
    const original = await assets.uploadCustomerArtwork(projectId, {
      conceptId: "upload-original",
      bytes: originalOpaqueBlackPng(),
      contentType: "image/png",
      widthPx: LIVE_FIXTURE.canvasWidthPx,
      heightPx: LIVE_FIXTURE.canvasHeightPx,
      hasTransparency: false,
      kind: "customer_upload",
      metadata: { originalFilename: "team artwork.png" },
    });

    const preparation = await repo.createArtworkPreparation(projectId, {
      originalAssetId: original.id,
      originalFilename: "team artwork.png",
      analysis: {
        widthPx: LIVE_FIXTURE.canvasWidthPx,
        heightPx: LIVE_FIXTURE.canvasHeightPx,
      },
    });

    const preparedBytes = preparedTransparentPng();
    const prepared = await assets.uploadCustomerArtwork(projectId, {
      conceptId: `prepared-${preparation.id}`,
      bytes: preparedBytes,
      contentType: "image/png",
      widthPx: LIVE_FIXTURE.canvasWidthPx,
      heightPx: LIVE_FIXTURE.canvasHeightPx,
      hasTransparency: true,
      kind: "png",
      metadata: { derivedFromAssetId: original.id },
    });

    await repo.updateArtworkPreparation(preparation.id, {
      status: "prepared",
      preparedAssetId: prepared.id,
      preparation: { backgroundRemoved: true },
    });

    const [artwork] = await repo.addArtworkVersions(projectId, [
      {
        versionNumber: 1,
        kind: "prepared_upload",
        title: "Your artwork, prepared",
        summary: "Your uploaded artwork with its background removed.",
        placeholderLabel: "Your artwork",
        accentColor: "#173F35",
        designBriefVersionId: null,
        generationJobId: null,
        providerKey: null,
        primaryAssetId: prepared.id,
        thumbnailAssetId: null,
        sourceArtworkVersionId: null,
        conceptDirectionKey: null,
      },
    ]);
    await repo.updateArtworkPreparation(preparation.id, {
      status: "approved",
      preparedArtworkVersionId: artwork!.id,
      approvedAt: new Date().toISOString(),
    });
    await repo.setProjectStatus(projectId, "approved");

    if (options.confirmSize !== false) {
      await confirmProductionSizeForTests(repo, projectId, {
        widthIn: options.widthIn ?? 10.5,
      });
    }

    if (options.halftone) {
      await selectHalftone(repo, projectId, options.halftone);
    }

    return {
      projectId,
      preparationId: preparation.id,
      artworkVersionId: artwork!.id,
      originalAssetId: original.id,
      preparedAssetId: prepared.id,
      preparedBytes,
    };
  }

  async function selectHalftone(
    repo: ProjectRepository,
    projectId: string,
    request: HalftoneSettingsRequest,
  ) {
    const snapshot = await repo.getProject(projectId);
    const garment = resolveGarmentColor(snapshot!.brief.shirtColor)!;
    const settings = normalizeHalftoneSettings(request, garment);
    assert.ok(settings, "the test asked for settings the domain refuses");
    await createDesignBriefCapability(repo).selectProductionTreatment(projectId, {
      selection: { treatment: "halftone_dtf", halftone: settings },
      selectedAt: new Date().toISOString(),
    });
    return settings;
  }

  interface PipelineResult {
    jobId: string;
    jobStatus: string;
    validationStatus: string | null;
    asset: AssetRecord | null;
    bytes: Buffer | null;
    paidCalls: number;
    localCalls: number;
    report: PrintValidationReport | null;
    projectStatus: string;
  }

  async function runToCompletion(
    repo: ProjectRepository,
    projectId: string,
  ): Promise<PipelineResult> {
    const { worker, paidProvider, localProvider, assets } = buildPipeline(repo);
    const finalArtwork = createFinalArtworkCapability(repo);
    const requested = await finalArtwork.requestPreparedUploadFinalArtwork(projectId);
    await worker.processNextJob();

    const job = (await repo.getFinalArtworkJob(requested.job.id))!;
    const validation = await repo.getLatestProductionAssetValidationForJob(
      projectId,
      job.id,
    );
    const asset = validation?.assetId
      ? await repo.getAssetById(validation.assetId)
      : null;
    const downloaded = validation?.assetId
      ? await assets.downloadAssetBytes(validation.assetId)
      : null;
    const snapshot = await repo.getProject(projectId);

    return {
      jobId: job.id,
      jobStatus: job.status,
      validationStatus: validation?.status ?? null,
      asset,
      bytes: downloaded?.bytes ?? null,
      paidCalls: paidProvider.calls,
      localCalls: localProvider.calls,
      report: (validation?.report ?? null) as PrintValidationReport | null,
      projectStatus: snapshot!.project.status,
    };
  }

  function checkOf(
    report: PrintValidationReport | null,
    code: string,
  ): PrintValidationCheck | null {
    return report?.checks.find((c) => c.check === code) ?? null;
  }

  function halftoneMetadata(asset: AssetRecord | null): Record<string, number | string> {
    const recorded = (asset?.metadata as Record<string, unknown> | undefined)?.halftone;
    assert.ok(recorded && typeof recorded === "object", "the screen must travel with the plate");
    return recorded as Record<string, number | string>;
  }

  /** One shared full-size run, so the assertions about it are not paid for repeatedly. */
  async function runOnce(options: Setup) {
    const repo = await freshRepo();
    const { assets } = buildPipeline(repo);
    const setup = await setupLiveFixture(repo, assets, options);
    const result = await runToCompletion(repo, setup.projectId);
    return { repo, assets, setup, result };
  }

  // -------------------------------------------------------------------------
  // A / B — standard raster is unchanged, and still refuses this file for free
  // -------------------------------------------------------------------------

  describe("standard raster is untouched (test matrix A, B)", () => {
    it("B: the live fixture still needs more than 4x, and is refused BEFORE any provider dispatch", () => {
      // Asserted against the REAL pre-dispatch resolver, not a mock: this is
      // the exact function that saved the live credit, and Phase 2 must not
      // have moved it by a pixel.
      const source = PNG.sync.read(preparedTransparentPng());
      const outcome = resolveReconstructionRequest(
        { width: source.width, height: source.height, data: source.data },
        sizingPolicyForConfirmedSize("full_back", {
          widthIn: 10.5,
          boxMaxHeightIn: 10.5,
          confirmedAt: "2026-08-21T00:00:00.000Z",
        }),
      );
      assert.equal(outcome.status, "insufficient_reconstruction");
      assert.match(
        outcome.status === "insufficient_reconstruction" ? outcome.reason : "",
        /4x maximum this reconstruction provider can actually deliver/,
      );
    });

    it("A: with no treatment selected the project stays standard raster and produces no plate", async () => {
      // NOTE what is deliberately NOT asserted here: that the reconstruction
      // provider went uncalled. On the standard path it IS selected — that is
      // unchanged Phase 0 behaviour — and it refuses INSIDE `produce()`,
      // before any network request, which is exactly what the test above
      // proves against the real resolver. "No paid call" on this path means
      // "no request left the process", and the honest place to assert it is
      // there rather than at a provider-selection counter.
      //
      // What this scenario owns is the outcome: selecting no treatment leaves
      // the project on standard raster, and standard raster does not produce
      // a plate for this artwork at this size.
      const { result } = await runOnce({});
      assert.notEqual(result.projectStatus, "print_ready");
      assert.equal(result.validationStatus, null);
      assert.equal(result.asset, null);
    });
  });

  // -------------------------------------------------------------------------
  // C / D / E — the halftone path on the very same artwork
  // -------------------------------------------------------------------------

  describe("the 10.5in halftone plate (test matrix C, D, E, K, L, V, X)", () => {
    let run: Awaited<ReturnType<typeof runOnce>>;

    before(async () => {
      run = await runOnce({ halftone: { lpi: 35 } });
    });

    it("C + D + X: produces a validated print-ready plate from >4x artwork, with ZERO paid calls", () => {
      // The paid provider throws if reached, so this is structural rather than
      // a counter nobody reads.
      assert.equal(run.result.paidCalls, 0);
      // Nor is it the ordinary local normalization provider: the halftone
      // provider was constructed for this job and ran instead.
      assert.equal(run.result.localCalls, 0);

      assert.equal(run.result.jobStatus, "completed");
      assert.equal(run.result.validationStatus, "ready");
      assert.equal(run.result.projectStatus, "print_ready");
    });

    it("E: the plate is 3150px wide — 10.5in of final-size dot geometry at 300 PPI", () => {
      assert.equal(run.result.asset?.widthPx, 3150);
      // Height follows the trimmed artwork's own aspect ratio. Never a fixed
      // canvas, never a stretch.
      const heightPx = run.result.asset?.heightPx ?? 0;
      assert.ok(heightPx > 2700 && heightPx < 2800, `height was ${heightPx}`);
    });

    it("V: the lattice was generated AT the delivered dimensions, never enlarged afterwards", () => {
      const recorded = halftoneMetadata(run.result.asset);
      assert.equal(recorded.screenWidthPx, run.result.asset?.widthPx);
      assert.equal(recorded.screenHeightPx, run.result.asset?.heightPx);

      const check = checkOf(run.result.report, "halftone_final_size_generation");
      assert.equal(check?.status, "pass");
      assert.match(
        String(check?.reason),
        /generated directly at the final production size/,
      );
    });

    it("E: the physical line frequency is exactly what was asked for, on an unrounded cell pitch", () => {
      const recorded = halftoneMetadata(run.result.asset);
      // 300 PPI / 35 LPI = 8.571px. Rounded to 8 or 9 the plate would print
      // 37.5 or 33.3 LPI while its own record still claimed 35.
      assert.ok(Math.abs(Number(recorded.cellPx) - 300 / 35) < 1e-9);
      assert.ok(Math.abs(Number(recorded.achievedLpi) - 35) < 1e-9);
      assert.equal(
        checkOf(run.result.report, "halftone_screen_geometry")?.status,
        "pass",
      );
    });

    it("L: the plate carries real transparency — dots and garment, not a solid rectangle", () => {
      assert.equal(run.result.asset?.hasTransparency, true);
      assert.equal(checkOf(run.result.report, "transparency")?.status, "pass");

      const plate = PNG.sync.read(run.result.bytes!);
      let transparent = 0;
      let opaque = 0;
      for (let i = 3; i < plate.data.length; i += 4) {
        if (plate.data[i] === 0) transparent += 1;
        else if (plate.data[i] === 255) opaque += 1;
      }
      assert.ok(opaque > 0, "ink must land");
      assert.ok(transparent > 0, "the garment must show through");
    });

    it("K: the plate is full colour — screening controls coverage, never hue", () => {
      const plate = PNG.sync.read(run.result.bytes!);
      const colours = new Set<string>();
      let redDominant = 0;
      let inverted = 0;
      let inked = 0;
      for (let i = 0; i < plate.data.length; i += 4) {
        if (plate.data[i + 3] === 0) continue;
        inked += 1;
        colours.add(`${plate.data[i]},${plate.data[i + 1]},${plate.data[i + 2]}`);
        if (plate.data[i] > plate.data[i + 2]) redDominant += 1;
        if (plate.data[i] < plate.data[i + 2]) inverted += 1;
      }
      // A monochrome screen would collapse this to one or two entries.
      assert.ok(colours.size > 50, `expected full colour, saw ${colours.size} colours`);
      // And it is the SOURCE's colour. The fixture is red-dominant everywhere
      // it has any tone at all, so NOTHING on the plate may read blue-dominant
      // — that is what a hue shift would look like. Stated as "never
      // inverted" rather than "always red-dominant" because the fixture's
      // darkest pixels are pure black, where the two channels are equal and
      // neither dominates.
      assert.ok(inked > 0);
      assert.equal(inverted, 0, `${inverted} plate pixels had their hue inverted`);
      assert.ok(redDominant > inked / 2, "the source's colour cast must survive");
    });

    it("writes 300 PPI density matching the geometry the file actually has", () => {
      const density = readPhysicalPixelDensity(run.result.bytes!);
      assert.ok(density);
      // 300 PPI is 11811 px/m, to the integer pHYs field's own resolution.
      assert.ok(Math.abs(density!.pixelsPerMetreX - 11811) <= 1);
      assert.equal(checkOf(run.result.report, "density_metadata")?.status, "pass");
    });

    it("records final-size halftone geometry, NOT reconstructed source detail (Goal 17)", () => {
      const meta = run.result.asset!.metadata as Record<string, unknown>;
      assert.equal(meta.resolutionProvenance, "halftone_generated");

      const provenance = checkOf(run.result.report, "resolution_provenance");
      assert.equal(provenance?.status, "pass");
      assert.match(String(provenance?.reason), /final-size halftone production geometry/);
      assert.match(
        String(provenance?.reason),
        /not a claim of reconstructed source detail/,
      );
    });

    it("Goal 18: swaps continuous-tone sufficiency for the halftone's own four checks", () => {
      // INAPPLICABLE, so not emitted — never emitted as a pass, which would be
      // a claim of continuous-tone sufficiency this plate does not make.
      assert.equal(checkOf(run.result.report, "reconstruction_sufficiency"), null);
      assert.equal(run.result.report?.productionTreatment, "halftone_dtf");

      for (const code of [
        "halftone_treatment",
        "halftone_final_size_generation",
        "halftone_screen_geometry",
        "halftone_tonal_sufficiency",
      ]) {
        const check = checkOf(run.result.report, code);
        assert.ok(check, `${code} must be emitted`);
        assert.notEqual(check!.status, "fail", `${code}: ${check!.reason}`);
      }
    });

    it("passes tonal sufficiency: ~55 PPI of source tone against a 35 LPI screen", () => {
      const tone = checkOf(run.result.report, "halftone_tonal_sufficiency");
      assert.equal(tone?.status, "pass");
      assert.match(
        String(tone?.reason),
        /every halftone cell is backed by real source tone/,
      );
    });

    it("N: lineage points at the APPROVED PREPARED asset, never the original upload", () => {
      const preserve = (
        run.result.asset!.metadata as Record<string, Record<string, unknown>>
      ).uploadedPreserve;
      assert.equal(preserve.preparedAssetId, run.setup.preparedAssetId);
      assert.equal(preserve.originalAssetId, run.setup.originalAssetId);
      assert.notEqual(preserve.preparedAssetId, preserve.originalAssetId);
      assert.equal(checkOf(run.result.report, "source_lineage")?.status, "pass");

      // Its own value, never folded into "skipped" — otherwise "no credit was
      // spent because none was needed" and "no credit was spent because a
      // screen was made instead" become indistinguishable in the record.
      assert.equal(preserve.enhancement, "halftone_screened");
    });

    it("O: the original opaque black background cannot come back through the screen", () => {
      // The prepared source's transparent margin is where a re-introduced
      // background would show up first: an opaque plate corner.
      const plate = PNG.sync.read(run.result.bytes!);
      const corners = [
        0,
        (plate.width - 1) * 4,
        (plate.height - 1) * plate.width * 4,
        ((plate.height - 1) * plate.width + plate.width - 1) * 4,
      ];
      for (const corner of corners) {
        assert.equal(plate.data[corner + 3], 0, "plate corners must stay transparent");
      }
    });

    it("leaves the immutable prepared source byte-identical", async () => {
      const after = await run.assets.downloadAssetBytes(run.setup.preparedAssetId);
      assert.ok(after!.bytes.equals(run.setup.preparedBytes));
    });
  });

  // -------------------------------------------------------------------------
  // F / S — larger physical sizes, same physical LPI
  // -------------------------------------------------------------------------

  describe("larger plates keep the same PHYSICAL line frequency (test matrix F, S)", () => {
    it("F: 12in generates 3600px at an identical dot pitch, still with no paid call", async () => {
      const { result } = await runOnce({ widthIn: 12, halftone: { lpi: 35 } });

      assert.equal(result.paidCalls, 0);
      assert.equal(result.validationStatus, "ready");
      assert.equal(result.asset?.widthPx, 3600);

      const recorded = halftoneMetadata(result.asset);
      // THE REASON PHASE 1 HAD TO COME FIRST. The plate is 14% wider in
      // pixels and the dot pitch is IDENTICAL, because LPI is a physical
      // frequency derived from output density — not a fraction of the image.
      assert.ok(Math.abs(Number(recorded.cellPx) - 300 / 35) < 1e-9);
      assert.ok(Math.abs(Number(recorded.achievedLpi) - 35) < 1e-9);
      assert.equal(recorded.screenWidthPx, 3600);
    });

    it("F: at 12in the thinner tonal margin WARNS rather than blocking", async () => {
      // The same 578px of source now spans 12in — about 48 PPI of tone against
      // a 35 LPI screen. Real, but tight. An observation for the operator
      // looking at the proof, not a refusal.
      const { result } = await runOnce({ widthIn: 12, halftone: { lpi: 35 } });
      const tone = checkOf(result.report, "halftone_tonal_sufficiency");
      assert.equal(tone?.status, "warning");
      assert.equal(tone?.severity, "warning");
      assert.match(
        String(tone?.reason),
        /does not restore detail the source never had/,
      );
      assert.equal(result.validationStatus, "ready");
    });

    it("S: an explicit custom width inside the technical band is honoured exactly", async () => {
      const { result } = await runOnce({ widthIn: 13, halftone: { lpi: 25 } });
      assert.equal(result.validationStatus, "ready");
      assert.equal(result.asset?.widthPx, 3900);
      assert.equal(result.paidCalls, 0);
    });

    it("BLOCKS when the screen would out-resolve the tone the source actually carries", async () => {
      // 13in at 55 LPI: 578px over 13in is ~44 PPI of tone against a screen
      // that consumes 55. Cells would share source samples, so the screen
      // would be inventing tonal structure — the same dishonesty the
      // continuous-tone path refuses, measured in this representation's unit.
      const { result } = await runOnce({ widthIn: 13, halftone: { lpi: 55 } });

      const tone = checkOf(result.report, "halftone_tonal_sufficiency");
      assert.equal(tone?.status, "fail");
      assert.equal(result.validationStatus, "finalization_required");
      assert.notEqual(result.projectStatus, "print_ready");
      // And still no paid call: an honest refusal costs nothing.
      assert.equal(result.paidCalls, 0);
    });
  });

  // -------------------------------------------------------------------------
  // G / H / I / J — operator controls reach the delivered plate
  // -------------------------------------------------------------------------

  describe("operator controls reach the plate (test matrix G, H, I, J)", () => {
    // Run at the placement's technical minimum: which control reached the
    // raster is not a function of physical size, and the controls' pixel-level
    // behaviour is already proven exhaustively in `halftone-screen.test.ts`.
    async function plateFor(halftone: HalftoneSettingsRequest) {
      const { result } = await runOnce({ widthIn: SMALL_WIDTH_IN, halftone });
      assert.equal(result.validationStatus, "ready");
      assert.equal(result.paidCalls, 0);
      return result;
    }

    it("G/H: round and ellipse produce different plates, both validating", async () => {
      const round = await plateFor({ dotShape: "round" });
      const ellipse = await plateFor({ dotShape: "ellipse" });
      assert.ok(!round.bytes!.equals(ellipse.bytes!));
      assert.equal(halftoneMetadata(round.asset).dotShape, "round");
      assert.equal(halftoneMetadata(ellipse.asset).dotShape, "ellipse");
    });

    it("I: 22.5 degrees genuinely differs from 45 degrees on the delivered plate", async () => {
      const at45 = await plateFor({ angleDeg: 45 });
      const at225 = await plateFor({ angleDeg: 22.5 });
      assert.ok(!at45.bytes!.equals(at225.bytes!));
      assert.equal(halftoneMetadata(at45.asset).angleDeg, 45);
      assert.equal(halftoneMetadata(at225.asset).angleDeg, 22.5);
    });

    it("J: the midtone control changes delivered ink coverage, deterministically", async () => {
      const lean = await plateFor({ midtone: 0.7 });
      const rich = await plateFor({ midtone: 1.4 });
      const inkOf = (r: PipelineResult) => Number(halftoneMetadata(r.asset).inkedPixelFraction);
      assert.ok(
        inkOf(lean) < inkOf(rich),
        `midtone 0.7 (${inkOf(lean)}) must carry less ink than 1.4 (${inkOf(rich)})`,
      );
    });

    it("LPI changes the delivered dot pitch, not the tonal weight", async () => {
      const coarse = await plateFor({ lpi: 25 });
      const fine = await plateFor({ lpi: 45 });
      assert.ok(!coarse.bytes!.equals(fine.bytes!));
      const pitch = (r: PipelineResult) => Number(halftoneMetadata(r.asset).cellPx);
      assert.ok(pitch(coarse) > pitch(fine));
    });

    it("the garment colour is recorded on the plate and is never composited into it", async () => {
      const { repo, assets } = await runOnce({ widthIn: SMALL_WIDTH_IN });
      const setup = await setupLiveFixture(repo, assets, {
        widthIn: SMALL_WIDTH_IN,
        shirtColor: "Navy",
        halftone: {},
      });
      const result = await runToCompletion(repo, setup.projectId);

      assert.equal(halftoneMetadata(result.asset).garmentHex, "#1B2A44");
      // M: the garment colour is a TONAL REFERENCE. It never lands in the
      // export, so the plate's transparent regions stay transparent rather
      // than becoming navy.
      const plate = PNG.sync.read(result.bytes!);
      assert.equal(plate.data[3], 0, "plate corner must stay transparent, not navy");
    });
  });

  // -------------------------------------------------------------------------
  // Existing-project recovery (test matrix J, K)
  // -------------------------------------------------------------------------

  describe("a pre-Phase-1 project recovers entirely through the product", () => {
    /**
     * The exact live state that surfaced the dead end:
     *
     *   prepared artwork               approved
     *   garment_size_class             null
     *   production_size_confirmed_at   null
     *   an earlier Standard Raster job failed
     *
     * The failed job is written directly, because that is how it got there:
     * it was enqueued by a build that predated the confirmation requirement.
     * Recovery must need no database edit, no new project, no re-upload, and
     * no re-grant — only the controls the UI fix restored.
     */
    async function setupUnrecoveredProject(repo: ProjectRepository) {
      const { assets } = buildPipeline(repo);
      const setup = await setupLiveFixture(repo, assets, { confirmSize: false });

      const failed = await repo.createFinalArtworkJob(setup.projectId, {
        sourceKind: "prepared_upload",
        artworkPreparationId: setup.preparationId,
        artworkVersionId: setup.artworkVersionId,
        productionWidthIn: 10.5,
        requestedProductionOutput: "production_png",
        productionTreatmentKey: "standard_raster",
      });
      const historical = await repo.updateFinalArtworkJob(failed.id, {
        status: "failed",
        lastError: "This artwork cannot be reconstructed to the 3150x2736px this production size requires.",
        completedAt: "2026-08-20T00:00:00.000Z",
      });

      return { ...setup, historical };
    }

    it("is honestly blocked before a size is confirmed — the server agrees with the card", async () => {
      const repo = await freshRepo();
      const setup = await setupUnrecoveredProject(repo);
      const finalArtwork = createFinalArtworkCapability(repo);

      await assert.rejects(
        () => finalArtwork.requestPreparedUploadFinalArtwork(setup.projectId),
        (error: Error) => {
          assert.match(error.message, /Confirm the print size/);
          return true;
        },
      );
    });

    it("K: confirm size, choose halftone, and a NEW job is created for the new intent", async () => {
      const repo = await freshRepo();
      const setup = await setupUnrecoveredProject(repo);

      // Exactly the two acts the restored UI makes available, in order.
      await confirmProductionSizeForTests(repo, setup.projectId, { widthIn: 10.5 });
      const settings = await selectHalftone(repo, setup.projectId, { lpi: 35 });

      const finalArtwork = createFinalArtworkCapability(repo);
      const requested = await finalArtwork.requestPreparedUploadFinalArtwork(
        setup.projectId,
      );

      assert.notEqual(requested.job.id, setup.historical.id);
      assert.equal(requested.alreadyRequested, false);
      assert.equal(
        requested.job.productionTreatmentKey,
        productionTreatmentKey({ treatment: "halftone_dtf", halftone: settings }),
      );
      assert.equal(requested.job.status, "queued");
    });

    it("J: the earlier failed Standard Raster job is left untouched as evidence", async () => {
      const repo = await freshRepo();
      const setup = await setupUnrecoveredProject(repo);

      await confirmProductionSizeForTests(repo, setup.projectId, { widthIn: 10.5 });
      await selectHalftone(repo, setup.projectId, { lpi: 35 });
      await createFinalArtworkCapability(repo).requestPreparedUploadFinalArtwork(
        setup.projectId,
      );

      const after = await repo.getFinalArtworkJob(setup.historical.id);
      // Not revived, not re-keyed, not re-aimed, not deleted. It remains a
      // true record of what was attempted and what happened.
      assert.equal(after!.status, "failed");
      assert.equal(after!.lastError, setup.historical.lastError);
      assert.equal(after!.completedAt, setup.historical.completedAt);
      assert.equal(after!.productionTreatmentKey, "standard_raster");
      assert.equal(after!.productionWidthIn, 10.5);
    });

    it("the recovered project runs to a validated print-ready halftone plate", async () => {
      const repo = await freshRepo();
      const setup = await setupUnrecoveredProject(repo);

      await confirmProductionSizeForTests(repo, setup.projectId, {
        widthIn: SMALL_WIDTH_IN,
      });
      await selectHalftone(repo, setup.projectId, { lpi: 35 });

      const result = await runToCompletion(repo, setup.projectId);

      assert.equal(result.validationStatus, "ready");
      assert.equal(result.projectStatus, "print_ready");
      assert.equal(result.paidCalls, 0);
      // And the historical job is still exactly where it was.
      const after = await repo.getFinalArtworkJob(setup.historical.id);
      assert.equal(after!.status, "failed");
    });
  });

  describe("treatment persistence and staleness (test matrix P, Q, R)", () => {
    it("P: the treatment and every setting survive a reload, with no operator memory required", async () => {
      const repo = await freshRepo();
      const { assets } = buildPipeline(repo);
      const setup = await setupLiveFixture(repo, assets, {
        widthIn: SMALL_WIDTH_IN,
        halftone: {
          lpi: 45,
          angleDeg: 22.5,
          dotShape: "ellipse",
          midtone: 1.25,
          chokePx: 1,
        },
      });

      // A genuinely fresh read, exactly as a page reload does.
      const brief = (await repo.getProject(setup.projectId))!.brief;
      assert.equal(brief.productionTreatment, "halftone_dtf");
      assert.ok(brief.productionTreatmentSelectedAt);
      assert.equal(brief.halftoneSettings?.lpi, 45);
      assert.equal(brief.halftoneSettings?.angleDeg, 22.5);
      assert.equal(brief.halftoneSettings?.dotShape, "ellipse");
      assert.equal(brief.halftoneSettings?.midtone, 1.25);
      assert.equal(brief.halftoneSettings?.chokePx, 1);
      assert.equal(brief.halftoneSettings?.garment.hex, "#000000");
      assert.ok(brief.halftoneSettings?.algorithmVersion);
    });

    it("R: changing a halftone setting supersedes the queued job rather than re-aiming it", async () => {
      const repo = await freshRepo();
      const { assets, worker } = buildPipeline(repo);
      const setup = await setupLiveFixture(repo, assets, {
        widthIn: SMALL_WIDTH_IN,
        halftone: { lpi: 35 },
      });

      const finalArtwork = createFinalArtworkCapability(repo);
      const first = await finalArtwork.requestPreparedUploadFinalArtwork(
        setup.projectId,
      );

      // The operator moves a control while the job waits.
      const updated = await selectHalftone(repo, setup.projectId, { lpi: 45 });
      await worker.processNextJob();

      const superseded = await repo.getFinalArtworkJob(first.job.id);
      assert.equal(superseded!.status, "cancelled");
      assert.match(superseded!.lastError ?? "", /production treatment changed/);

      // And the new settings get their OWN job, with their own evidence.
      const second = await finalArtwork.requestPreparedUploadFinalArtwork(
        setup.projectId,
      );
      assert.notEqual(second.job.id, first.job.id);
      assert.equal(
        second.job.productionTreatmentKey,
        productionTreatmentKey({ treatment: "halftone_dtf", halftone: updated }),
      );
    });

    it("Q: changing the confirmed production size supersedes a queued halftone job", async () => {
      const repo = await freshRepo();
      const { assets, worker } = buildPipeline(repo);
      const setup = await setupLiveFixture(repo, assets, {
        widthIn: SMALL_WIDTH_IN,
        halftone: {},
      });

      const finalArtwork = createFinalArtworkCapability(repo);
      const first = await finalArtwork.requestPreparedUploadFinalArtwork(
        setup.projectId,
      );

      await confirmProductionSizeForTests(repo, setup.projectId, { widthIn: 5 });
      await worker.processNextJob();

      const superseded = await repo.getFinalArtworkJob(first.job.id);
      assert.equal(superseded!.status, "cancelled");
    });

    it("returning to previous settings reuses that plate rather than regenerating it", async () => {
      const repo = await freshRepo();
      const { assets } = buildPipeline(repo);
      const setup = await setupLiveFixture(repo, assets, {
        widthIn: SMALL_WIDTH_IN,
        halftone: { lpi: 35 },
      });

      const first = await runToCompletion(repo, setup.projectId);
      assert.equal(first.validationStatus, "ready");

      await selectHalftone(repo, setup.projectId, { lpi: 45 });
      await runToCompletion(repo, setup.projectId);

      // Back to 35 LPI: the original plate is still on file and answers again,
      // rather than the pipeline redoing work whose result already exists.
      await selectHalftone(repo, setup.projectId, { lpi: 35 });
      const finalArtwork = createFinalArtworkCapability(repo);
      const reused = await finalArtwork.requestPreparedUploadFinalArtwork(
        setup.projectId,
      );
      assert.equal(reused.job.id, first.jobId);
      assert.equal(reused.alreadyRequested, true);
    });

    it("retracting the treatment returns the project to standard raster", async () => {
      const repo = await freshRepo();
      const { assets } = buildPipeline(repo);
      const setup = await setupLiveFixture(repo, assets, {
        widthIn: SMALL_WIDTH_IN,
        halftone: {},
      });

      await createDesignBriefCapability(repo).clearProductionTreatment(setup.projectId);

      const brief = (await repo.getProject(setup.projectId))!.brief;
      assert.equal(brief.productionTreatment, "standard_raster");
      assert.equal(brief.halftoneSettings, null);
      assert.equal(brief.productionTreatmentSelectedAt, null);
    });
  });
});
