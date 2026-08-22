import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { rm } from "node:fs/promises";
import { after, before, describe, it } from "node:test";
import { PNG } from "pngjs";

import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";
import { runAdaptiveInterviewToSummary } from "@/test-support/run-adaptive-interview";
import { createAcquisitionCapability } from "@/capabilities/acquisition";
import { createAssetCapability, PngThumbnailGenerator } from "@/capabilities/assets";
import { DataUriAssetStorageProvider } from "@/capabilities/asset-storage";
import { createFinalArtworkWorkerCapability } from "@/capabilities/final-artwork-worker";
import { createPrintValidationCapability } from "@/capabilities/print-validation";
import { LocalRasterInterpolationProvider } from "@/capabilities/final-artwork/local-raster-provider";
import type {
  FinalArtworkProvider,
  FinalArtworkProviderOutput,
} from "@/capabilities/final-artwork/provider";
import type { ProjectRepository } from "@/lib/db/repository";

/**
 * Print'em All Phase 2 — THE OPERATOR RECOVERY FLOW, END TO END.
 *
 * THE LIVE FAILURE THIS FILE EXISTS FOR.
 *
 * A real internal Print'em All project: Existing Artwork, preparation approved,
 * an earlier Standard Raster finalization failed. The restored UI rendered the
 * print-size card and the treatment card correctly, and yet:
 *
 *   - "Use recommended size" did not confirm anything
 *   - picking an explicit width did not confirm anything
 *   - DTF Halftone stayed disabled ("no size has been confirmed")
 *   - Retry Preparation stayed disabled
 *   - and the page said "being prepared right now" while ALSO saying
 *     "Print-ready preparation couldn't finish"
 *
 * Both halves of that contradiction were true readings of two different
 * fields:
 *
 *   finalization.status  is derived from the JOB      -> retryable_failure ✓
 *   the mutation guards read project.status           -> "finalizing" ✗
 *
 * and `failJob` deliberately never clears `PrintProject.status`. So after any
 * failed job the project sits at `"finalizing"` forever, and every guard that
 * used it as "is work in flight?" refused every recovery action.
 *
 * These scenarios drive the REAL capability graph over a real repository — the
 * same functions the HTTP routes call — rather than asserting on constants.
 */

class ForbiddenReconstructionProvider implements FinalArtworkProvider {
  readonly providerKey = "forbidden_paid_reconstruction";
  calls = 0;
  async produce(): Promise<FinalArtworkProviderOutput> {
    this.calls += 1;
    throw new Error("PAID PROVIDER REACHED — the halftone recovery path must never call it");
  }
}

describe("Internal operator recovery after a failed Standard Raster job", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-operator-recovery-"));
    process.chdir(tempDir);
  });

  after(async () => {
    await cleanupTempWorkspace(tempDir, previousCwd);
  });

  async function freshRepo() {
    // See `halftone-production.test.ts`: the local store resolves its path once
    // at module load, so isolation means removing the FILE, not chdir.
    const store = await import("@/lib/db/local-store");
    // Drain first: the store serializes every call through a mutex, and
    // deleting the file out from under a queued write leaves the next write
    // appending to a fresh file — i.e. corrupt JSON.
    await store.drainLocalStoreMutexForTests();
    await rm(path.join(process.cwd(), ".data", "sprint1-store.json"), { force: true });
    return new store.LocalProjectRepository();
  }

  /** A prepared, transparent, tonal source with the live fixture's geometry. */
  function preparedPng(): Buffer {
    const W = 584;
    const H = 640;
    const AW = 562;
    const AH = 486;
    const png = new PNG({ width: W, height: H });
    const ix = Math.floor((W - AW) / 2);
    const iy = Math.floor((H - AH) / 2);
    for (let y = 0; y < H; y += 1) {
      for (let x = 0; x < W; x += 1) {
        const i = (W * y + x) << 2;
        if (x < ix || x >= ix + AW || y < iy || y >= iy + AH) continue;
        const level = Math.round(
          (((x - ix) / (AW - 1) + (y - iy) / (AH - 1)) / 2) * 255,
        );
        png.data[i] = level;
        png.data[i + 1] = Math.round(level * 0.72);
        png.data[i + 2] = Math.round(level * 0.4);
        png.data[i + 3] = 255;
      }
    }
    return PNG.sync.write(png);
  }

  /**
   * THE EXACT LIVE SHAPE. Everything a real recovering project has, and
   * nothing it does not: approved preparation, transparent prepared asset,
   * internal entitlement, a FAILED Standard Raster job, no confirmed size, no
   * garment class, and `project.status` left at `"finalizing"` exactly as
   * `failJob` leaves it.
   */
  async function setupLiveFailureShape(repo: ProjectRepository) {
    const acquisition = createAcquisitionCapability(repo);
    const session = await acquisition.resolveOrCreateSession(null);
    await repo.grantInternalEntitlement(session.id);

    const created = await repo.createProject(session.id);
    const projectId = created.project.id;
    const assets = createAssetCapability(
      repo,
      new DataUriAssetStorageProvider(),
      new PngThumbnailGenerator(),
    );

    await repo.updateBrief(projectId, {
      productSummary: "T-shirts for our bowling team",
      shirtColor: "Black",
      printPlacement: "full_back",
    });

    const original = await assets.uploadCustomerArtwork(projectId, {
      conceptId: "upload-original",
      bytes: preparedPng(),
      contentType: "image/png",
      widthPx: 584,
      heightPx: 640,
      hasTransparency: false,
      kind: "customer_upload",
      metadata: { originalFilename: "team artwork.png" },
    });
    const preparation = await repo.createArtworkPreparation(projectId, {
      originalAssetId: original.id,
      originalFilename: "team artwork.png",
      analysis: { widthPx: 584, heightPx: 640 },
    });
    const prepared = await assets.uploadCustomerArtwork(projectId, {
      conceptId: `prepared-${preparation.id}`,
      bytes: preparedPng(),
      contentType: "image/png",
      widthPx: 584,
      heightPx: 640,
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
      approvedAt: "2026-08-20T00:00:00.000Z",
    });

    // The earlier Standard Raster attempt, and what it left behind.
    const failed = await repo.createFinalArtworkJob(projectId, {
      sourceKind: "prepared_upload",
      artworkPreparationId: preparation.id,
      artworkVersionId: artwork!.id,
      productionWidthIn: 10.5,
      requestedProductionOutput: "production_png",
      productionTreatmentKey: "standard_raster",
    });
    const historical = await repo.updateFinalArtworkJob(failed.id, {
      status: "failed",
      lastError:
        "This artwork cannot be reconstructed to the 3150x2736px this production size requires.",
      completedAt: "2026-08-20T01:00:00.000Z",
    });
    // THE STICKY MARKER. `failJob` deliberately leaves it here, so this is
    // precisely the state a real recovering project is in.
    await repo.setProjectStatus(projectId, "finalizing");

    return { projectId, preparationId: preparation.id, artworkVersionId: artwork!.id, historical };
  }

  /**
   * DYNAMICALLY imported, and that is load-bearing rather than stylistic.
   *
   * `local-store` resolves its data directory from `process.cwd()` ONCE, at
   * module load. `@/capabilities/composition` pulls it in transitively, so a
   * STATIC import at the top of this file would freeze the store path at the
   * repo root before `before()` can chdir — silently writing every scenario's
   * multi-megabyte plates into the real `.data/` and colliding with whichever
   * suite runs alongside it. That is exactly what happened here once, and it
   * corrupted a 53MB shared store mid-run.
   *
   * Every other suite in this repo imports composition dynamically for the
   * same reason; `cleanup-temp-workspace.ts` says so explicitly.
   */
  async function graphFor(repo: ProjectRepository) {
    const { createCapabilityGraph } = await import("@/capabilities/composition");
    return createCapabilityGraph(repo);
  }

  // -------------------------------------------------------------------------
  // The contradiction itself
  // -------------------------------------------------------------------------

  it("C/U: a FAILED job reports retryable_failure and must NOT read as in-flight", async () => {
    const repo = await freshRepo();
    const { projectId, historical } = await setupLiveFailureShape(repo);

    assert.equal(historical.status, "failed");
    // The sticky marker is real and is exactly what misled the guards.
    assert.equal((await repo.getProject(projectId))!.project.status, "finalizing");

    // No job is actually claimable or running.
    const jobs = await repo.listFinalArtworkJobsForPreparation(
      projectId,
      (await repo.getArtworkPreparation(projectId))!.id,
    );
    assert.equal(jobs.length, 1);
    assert.ok(!["queued", "running", "recoverable"].includes(jobs[0].status));
  });

  // -------------------------------------------------------------------------
  // D / E / F / G / H — the size authority must actually work
  // -------------------------------------------------------------------------

  it("D+E: selecting a garment class updates the recommendation and does NOT confirm", async () => {
    const repo = await freshRepo();
    const { projectId } = await setupLiveFailureShape(repo);
    const graph = await graphFor(repo);

    const after = await graph.conversation.setGarmentSizeClass(
      projectId,
      "adult_standard",
    );

    assert.equal(after.brief.garmentSizeClass, "adult_standard");
    // A class is context for a SUGGESTION. Consent is a separate act.
    assert.equal(after.brief.productionSizeConfirmedAt, null);
    assert.equal(after.brief.productionSizeConfirmedWidthIn, null);
  });

  it("F: 'Use recommended size' confirms 10.5in as durable authority", async () => {
    const repo = await freshRepo();
    const { projectId } = await setupLiveFailureShape(repo);
    const graph = await graphFor(repo);

    await graph.conversation.setGarmentSizeClass(projectId, "adult_standard");
    const confirmed = await graph.conversation.confirmRecommendedProductionSize(
      projectId,
    );

    assert.equal(confirmed.brief.productionSizeConfirmedWidthIn, 10.5);
    assert.equal(confirmed.brief.productionSizeConfirmedMaxHeightIn, 10.5);
    assert.ok(confirmed.brief.productionSizeConfirmedAt);
    assert.equal(confirmed.brief.intendedPrintWidthIn, 10.5);
  });

  it("G: an explicit width confirms the same durable authority", async () => {
    const repo = await freshRepo();
    const { projectId } = await setupLiveFailureShape(repo);
    const graph = await graphFor(repo);

    // An explicitly stated width IS the confirmation — "make it 12 inches"
    // is somebody saying a number out loud. This is the same call the preset
    // size chips and the Adjust control make, which is why clicking 10.5"
    // doing nothing was a bug and not an ambiguous control.
    const confirmed = await graph.conversation.setProductionPrintWidth(projectId, 12);
    assert.equal(confirmed.brief.intendedPrintWidthIn, 12);
    assert.equal(confirmed.brief.productionSizeConfirmedWidthIn, 12);
    assert.ok(confirmed.brief.productionSizeConfirmedAt);
  });

  it("H: the confirmation survives a fresh read (refresh/reload)", async () => {
    const repo = await freshRepo();
    const { projectId } = await setupLiveFailureShape(repo);
    const graph = await graphFor(repo);

    await graph.conversation.setGarmentSizeClass(projectId, "adult_standard");
    await graph.conversation.confirmRecommendedProductionSize(projectId);

    const reloaded = (await repo.getProject(projectId))!;
    assert.equal(reloaded.brief.productionSizeConfirmedWidthIn, 10.5);
    assert.ok(reloaded.brief.productionSizeConfirmedAt);
  });

  // -------------------------------------------------------------------------
  // I / J / K / L — treatment selection
  // -------------------------------------------------------------------------

  it("I: DTF Halftone is refused before confirmation — and for the RIGHT reason", async () => {
    const repo = await freshRepo();
    const { projectId } = await setupLiveFailureShape(repo);
    const graph = await graphFor(repo);

    await assert.rejects(
      () =>
        graph.conversation.selectProductionTreatment(projectId, {
          treatment: "halftone_dtf",
        }),
      (error: Error) => {
        // The honest reason (no confirmed size) — never the false one.
        assert.match(error.message, /Confirm the print size/);
        assert.doesNotMatch(error.message, /being prepared right now/);
        return true;
      },
    );
  });

  it("J+K: after confirmation, DTF Halftone is accepted and persisted", async () => {
    const repo = await freshRepo();
    const { projectId } = await setupLiveFailureShape(repo);
    const graph = await graphFor(repo);

    await graph.conversation.setGarmentSizeClass(projectId, "adult_standard");
    await graph.conversation.confirmRecommendedProductionSize(projectId);

    const selected = await graph.conversation.selectProductionTreatment(projectId, {
      treatment: "halftone_dtf",
    });

    assert.equal(selected.brief.productionTreatment, "halftone_dtf");
    assert.ok(selected.brief.productionTreatmentSelectedAt);
    assert.equal(selected.brief.halftoneSettings?.lpi, 35);
    assert.equal(selected.brief.halftoneSettings?.angleDeg, 45);
    assert.equal(selected.brief.halftoneSettings?.dotShape, "round");
    assert.equal(selected.brief.halftoneSettings?.midtone, 1);
    assert.equal(selected.brief.halftoneSettings?.chokePx, 0);
    assert.equal(selected.brief.halftoneSettings?.garment.hex, "#000000");
    assert.ok(selected.brief.halftoneSettings?.algorithmVersion);
  });

  it("L: every halftone setting round-trips through a fresh read", async () => {
    const repo = await freshRepo();
    const { projectId } = await setupLiveFailureShape(repo);
    const graph = await graphFor(repo);

    await graph.conversation.setGarmentSizeClass(projectId, "adult_standard");
    await graph.conversation.confirmRecommendedProductionSize(projectId);
    await graph.conversation.selectProductionTreatment(projectId, {
      treatment: "halftone_dtf",
      halftone: { lpi: 45, angleDeg: 22.5, dotShape: "ellipse", midtone: 1.2, chokePx: 2 },
    });

    const reloaded = (await repo.getProject(projectId))!.brief;
    assert.equal(reloaded.halftoneSettings?.lpi, 45);
    assert.equal(reloaded.halftoneSettings?.angleDeg, 22.5);
    assert.equal(reloaded.halftoneSettings?.dotShape, "ellipse");
    assert.equal(reloaded.halftoneSettings?.midtone, 1.2);
    assert.equal(reloaded.halftoneSettings?.chokePx, 2);
  });

  // -------------------------------------------------------------------------
  // GOAL 8 — the whole flow, end to end
  // -------------------------------------------------------------------------

  it("M+N+O+P+Q: the full recovery reaches print_ready with zero provider calls", async () => {
    const repo = await freshRepo();
    const { projectId, historical } = await setupLiveFailureShape(repo);
    const graph = await graphFor(repo);

    // --- exactly the operator's clicks, through the real capabilities -------
    await graph.conversation.setGarmentSizeClass(projectId, "adult_standard");
    await graph.conversation.confirmRecommendedProductionSize(projectId);
    await graph.conversation.selectProductionTreatment(projectId, {
      treatment: "halftone_dtf",
      // A small plate keeps this scenario fast; the geometry itself is proven
      // at full production size in `halftone-production.test.ts`.
      halftone: { lpi: 35 },
    });
    await graph.conversation.setProductionPrintWidth(projectId, 4);

    const requested = await graph.finalArtwork.requestPreparedUploadFinalArtwork(
      projectId,
    );

    // N: a NEW job, distinct from the failed Standard Raster one.
    assert.notEqual(requested.job.id, historical.id);
    assert.match(String(requested.job.productionTreatmentKey), /^halftone_dtf\//);

    // --- run the real worker with a paid provider that THROWS if reached ---
    const assets = createAssetCapability(
      repo,
      new DataUriAssetStorageProvider(),
      new PngThumbnailGenerator(),
    );
    const paid = new ForbiddenReconstructionProvider();
    const worker = createFinalArtworkWorkerCapability(
      repo,
      assets,
      paid,
      createPrintValidationCapability(),
      {
        async evaluate() {
          throw new Error("Concept Evaluation must never run for uploaded artwork");
        },
      } as never,
      new LocalRasterInterpolationProvider(),
    );
    await worker.processNextJob();

    // O: print_ready, from a validated production asset.
    const finished = (await repo.getProject(projectId))!;
    assert.equal(finished.project.status, "print_ready");

    const validation = await repo.getLatestProductionAssetValidationForJob(
      projectId,
      requested.job.id,
    );
    assert.equal(validation?.status, "ready");
    assert.ok(validation?.assetId);

    const asset = await repo.getAssetById(validation!.assetId);
    assert.equal(asset?.hasTransparency, true);
    assert.equal(
      (asset!.metadata as Record<string, unknown>).resolutionProvenance,
      "halftone_generated",
    );

    // P/Q: no paid provider, no OpenAI. The provider throws if called at all.
    assert.equal(paid.calls, 0);

    // M: the historical failure is untouched evidence.
    const after = await repo.getFinalArtworkJob(historical.id);
    assert.equal(after!.status, "failed");
    assert.equal(after!.lastError, historical.lastError);
    assert.equal(after!.completedAt, historical.completedAt);
    assert.equal(after!.productionTreatmentKey, "standard_raster");
  });

  // -------------------------------------------------------------------------
  // The lock must still exist where it is TRUE
  // -------------------------------------------------------------------------

  it("a genuinely queued job DOES lock size, garment, and treatment mutation", async () => {
    const repo = await freshRepo();
    const { projectId, preparationId, artworkVersionId } =
      await setupLiveFailureShape(repo);
    const graph = await graphFor(repo);

    await graph.conversation.setGarmentSizeClass(projectId, "adult_standard");
    await graph.conversation.confirmRecommendedProductionSize(projectId);

    // A real, claimable job — the state the guard exists for.
    await repo.createFinalArtworkJob(projectId, {
      sourceKind: "prepared_upload",
      artworkPreparationId: preparationId,
      artworkVersionId,
      productionWidthIn: 12,
      requestedProductionOutput: "production_png",
      productionTreatmentKey: "standard_raster",
    });

    for (const attempt of [
      () => graph.conversation.setGarmentSizeClass(projectId, "youth"),
      () => graph.conversation.setProductionPrintWidth(projectId, 12),
      () =>
        graph.conversation.selectProductionTreatment(projectId, {
          treatment: "halftone_dtf",
        }),
    ]) {
      await assert.rejects(attempt, (error: Error) => {
        assert.match(error.message, /being prepared right now/);
        return true;
      });
    }
  });

  // -------------------------------------------------------------------------
  // The SAME defect on the Create New path
  // -------------------------------------------------------------------------

  describe("Create New concept exploration after a failed finalization", () => {
    /**
     * The Create New half of the identical defect.
     *
     * `exploreNewConceptBatch` read `project.status === "finalizing"` for the
     * same purpose the four production mutations did — "is work in flight?" —
     * and got the same sticky answer. A customer whose finalization failed
     * could never explore new directions again, and the refusal told them
     * their artwork "is already being prepared".
     *
     * Driven through the REAL interview → approve → generate → select →
     * confirm path, so the project is a genuine Create New project rather
     * than a hand-assembled row.
     */
    async function runToFailedFinalization() {
      // Same isolation the Existing Artwork scenarios use, and for the same
      // reason: `processNextJob` claims the oldest due job in the STORE, so a
      // previous scenario's leftover generation job would otherwise be
      // processed here and this project's concepts would never arrive.
      const store = await import("@/lib/db/local-store");
      await store.drainLocalStoreMutexForTests();
      await rm(path.join(process.cwd(), ".data", "sprint1-store.json"), {
        force: true,
      });

      const { resetCapabilityGraphForTests, getCapabilityGraph } = await import(
        "@/capabilities/composition"
      );
      resetCapabilityGraphForTests();
      const { resetProjectRepositoryForTests, getProjectRepository } = await import(
        "@/lib/db"
      );
      resetProjectRepositoryForTests();
      const graph = getCapabilityGraph();
      const repo = getProjectRepository();

      const { projectId } = await runAdaptiveInterviewToSummary(graph.conversation, {
        printLocation: "Full front",
      });
      await graph.conversation.submitDesignBriefDecision(projectId, "approve");
      await graph.generationWorker.processNextJob();

      const ready = await graph.conversation.get(projectId);
      const concepts = ready!.artworkVersions.map((v) => v.id);
      await graph.conversation.selectConcept(projectId, concepts[0]!);
      await graph.conversation.confirmSelectedDirection(projectId, concepts[0]!);
      await graph.conversation.confirmRecommendedProductionSize(projectId);

      // A real finalization request, then a real failure.
      const requested = await graph.finalArtwork.requestFinalArtwork(
        projectId,
        concepts[0]!,
      );
      const failed = await repo.updateFinalArtworkJob(requested.job.id, {
        status: "failed",
        lastError: "simulated production outage",
        completedAt: "2026-08-20T01:00:00.000Z",
      });

      return { graph, repo, projectId, concepts, failed };
    }

    it("A: project.status is sticky at 'finalizing' while NO job is active", async () => {
      const { repo, projectId, failed } = await runToFailedFinalization();

      assert.equal(failed.status, "failed");
      // The marker the old guard trusted.
      assert.equal((await repo.getProject(projectId))!.project.status, "finalizing");
      // …and the truth it should have asked for instead.
      assert.equal((await repo.listActiveFinalArtworkJobs(projectId)).length, 0);
    });

    it("A: exploring new directions is ALLOWED once nothing is actually in flight", async () => {
      const { graph, projectId, concepts } = await runToFailedFinalization();

      const explored = await graph.conversation.exploreNewConceptBatch(projectId);

      // Exploration ENQUEUES a batch rather than producing one inline, so the
      // immediate evidence is that the project is generating again — which is
      // precisely what a stranded customer could not reach.
      assert.equal(explored.project.status, "generating");

      // …and running the real worker delivers genuinely new concepts.
      await graph.generationWorker.processNextJob();
      const after = await graph.conversation.get(projectId);
      const newConcepts = after!.artworkVersions
        .map((v) => v.id)
        .filter((id) => !concepts.includes(id));
      assert.ok(
        newConcepts.length > 0,
        `expected new concepts beyond ${concepts.length}, saw ${after!.artworkVersions.length} total`,
      );
    });

    it("B: a genuinely ACTIVE finalization still refuses exploration", async () => {
      // Real concurrency protection is not weakened — only the stale reading
      // of it is removed.
      const { graph, repo, projectId } = await runToFailedFinalization();

      const approval = await repo.getActiveFinalDirectionApproval(projectId);
      assert.ok(approval, "the confirmed direction's approval must exist");

      await repo.createFinalArtworkJob(projectId, {
        sourceKind: "generated_concept",
        finalDirectionApprovalId: approval!.id,
        artworkVersionId: approval!.artworkVersionId,
        productionWidthIn: 12,
        requestedProductionOutput: "production_png",
        productionTreatmentKey: "standard_raster",
      });

      await assert.rejects(
        () => graph.conversation.exploreNewConceptBatch(projectId),
        (error: Error) => {
          assert.match(error.message, /already being prepared/);
          return true;
        },
      );
    });

    it("B: print_ready still refuses exploration, unchanged", async () => {
      // The second half of that guard is a DELIVERED ASSET, not an in-flight
      // job, and it is left exactly as it was.
      const { graph, repo, projectId } = await runToFailedFinalization();
      await repo.setProjectStatus(projectId, "print_ready");

      await assert.rejects(
        () => graph.conversation.exploreNewConceptBatch(projectId),
        (error: Error) => {
          assert.match(error.message, /already being prepared|Make Another Change/);
          return true;
        },
      );
    });
  });

  it("R: the internal entitlement is what authorizes treatment, and it still is", async () => {
    const repo = await freshRepo();
    const { projectId } = await setupLiveFailureShape(repo);
    const graph = await graphFor(repo);
    assert.equal(await graph.acquisition.isInternalProject(projectId), true);
  });
});
