import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { DataUriAssetStorageProvider } from "@/capabilities/asset-storage";
import { createAssetCapability, PngThumbnailGenerator } from "@/capabilities/assets";
import { createDesignBriefCapability } from "@/capabilities/design-brief";
import { createArtworkPreparationCapability } from "@/capabilities/artwork-preparation/artwork-preparation-capability";
import { createCanvas, fillRect, toPngBytes, whiteBackgroundArtwork } from "@/capabilities/artwork-preparation/artwork-fixtures";
import { getConversation } from "@/lib/services/conversation-service";
import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";

/**
 * Phase 28H/28I — PROGRESSIVE PRINT-READY FILE CREATION, server-side proof.
 *
 * Phase 28H proved the SEQUENCING contract (Raster attempted first,
 * automatically; Halftone never auto-created) against the REAL wired
 * capability graph and REAL final-artwork scheduler — no mocks, no fakes,
 * zero network, zero paid-provider calls (no Topaz key configured in this
 * environment).
 *
 * Phase 28I HARD CORRECTION: Phase 28H allowed Halftone once Raster reached
 * ANY terminal state (`print_ready`, `needs_attention`, or
 * `retryable_failure`). Product policy explicitly overrules that: Halftone
 * is now available ONLY once Standard Raster is genuinely `print_ready` —
 * enforced server-side in `requestPreparedUploadFinalArtwork` itself
 * (`ArtworkFinalizationRasterNotReadyError`), not merely by hiding a
 * button. This file's tests that used to request Halftone while Raster was
 * `needs_attention` are rewritten below to prove the OPPOSITE: that
 * sequence is now REJECTED.
 *
 * TWO FIXTURE SHAPES, BOTH SYNTHETIC AND ZERO-COST:
 *
 *   `readyProject()` — `whiteBackgroundArtwork()` (120x120), `full_front`,
 *   Standard Adult. Deliberately far too small for that print size, so
 *   Standard Raster deterministically reaches `needs_attention` (the exact
 *   "local raster interpolation cannot safely satisfy the required print
 *   resolution" condition the bug report described) — used to prove the
 *   GATE'S REFUSAL.
 *
 *   `readySufficientProject()` — a much larger fixture (1400x1400, ~1250px
 *   of visible artwork after background removal) at `left_chest`
 *   (4in/300 PPI = 1200px required), which is ALREADY at or above the
 *   target resolution. This needs NO reconstruction at all
 *   (`resolutionProvenance: "native"`), so Standard Raster reaches genuine
 *   `print_ready` locally, with zero cost and zero Topaz involvement — used
 *   to prove the GATE'S UNLOCK, and everything downstream of it (Halftone
 *   creation, coexistence, shared confirmed dimensions).
 *
 * WHY NOT THE REAL CHILI & SALSA PROJECT. This is a SERVER-SIDE sequencing
 * question these tests prove generically — they do not need, and must not
 * risk mutating, the real local project the phase's own human-acceptance
 * script separately exercises by hand.
 */
describe("Phase 28H/28I — progressive print-ready creation (Standard Raster first, DTF Halftone gated on Raster print_ready)", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-phase28i-progressive-"));
    process.chdir(tempDir);
  });

  after(async () => {
    await cleanupTempWorkspace(tempDir, previousCwd);
  });

  async function harness() {
    const { resetCapabilityGraphForTests, getCapabilityGraph } = await import("@/capabilities/composition");
    resetCapabilityGraphForTests();
    const graph = getCapabilityGraph();
    const { LocalProjectRepository } = await import("@/lib/db/local-store");
    const repo = new LocalProjectRepository();
    const assets = createAssetCapability(repo, new DataUriAssetStorageProvider(), new PngThumbnailGenerator());
    const artworkPreparation = createArtworkPreparationCapability(repo, assets, createDesignBriefCapability(repo));
    return { graph, repo, assets, artworkPreparation };
  }

  /** Comfortably at or above what a 4in/300 PPI left-chest print requires (1200px) -- needs NO reconstruction. */
  function sufficientResolutionArtwork() {
    const image = createCanvas(1400, 1400, { r: 255, g: 255, b: 255, a: 255 });
    fillRect(image, 75, 75, 1250, 1250, { r: 30, g: 60, b: 140, a: 255 });
    return image;
  }

  async function selectHalftone(projectId: string) {
    const treatmentRoute = await import("@/app/api/projects/[projectId]/production-treatment/route");
    return treatmentRoute.POST(
      new Request("http://localhost/x", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ treatment: "halftone_dtf", halftone: {} }),
      }),
      { params: Promise.resolve({ projectId }) },
    );
  }

  async function selectStandardRaster(projectId: string) {
    const treatmentRoute = await import("@/app/api/projects/[projectId]/production-treatment/route");
    return treatmentRoute.POST(
      new Request("http://localhost/x", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ treatment: "standard_raster" }),
      }),
      { params: Promise.resolve({ projectId }) },
    );
  }

  async function confirmSize(projectId: string, garmentSizeClass: string) {
    const sizeRoute = await import("@/app/api/projects/[projectId]/print-size/confirm/route");
    return sizeRoute.POST(
      new Request("http://localhost/x", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ garmentSizeClass, useRecommended: true }),
      }),
      { params: Promise.resolve({ projectId }) },
    );
  }

  /** An internal, approved+prepared, size-confirmed project -- but with NO production treatment ever selected. Deterministically reaches Raster `needs_attention` (too small for the requested size). */
  async function readyProject() {
    const { graph, repo, artworkPreparation } = await harness();
    const session = await graph.acquisition.resolveOrCreateSession(null);
    await repo.grantInternalEntitlement(session.id);
    const created = await repo.createProject(session.id);
    const projectId = created.project.id;

    await artworkPreparation.uploadOriginal(projectId, {
      bytes: toPngBytes(whiteBackgroundArtwork()),
      declaredContentType: "image/png",
      filename: "tiny-logo.png",
    });
    await artworkPreparation.setProductionContext(projectId, {
      productSummary: "T-shirts",
      productColor: "Black",
      printPlacement: "full_front",
    });
    await artworkPreparation.prepareBackground(projectId);
    await artworkPreparation.approvePreparedArtwork(projectId);

    const sizeRes = await confirmSize(projectId, "adult_standard");
    assert.equal(sizeRes.status, 200, "print size must confirm cleanly before any print-ready request");

    return { graph, repo, projectId };
  }

  /** Same shape as `readyProject()`, but with a source large enough to need NO reconstruction at `left_chest` -- Standard Raster reaches genuine `print_ready` locally, zero cost. */
  async function readySufficientProject() {
    const { graph, repo, artworkPreparation } = await harness();
    const session = await graph.acquisition.resolveOrCreateSession(null);
    await repo.grantInternalEntitlement(session.id);
    const created = await repo.createProject(session.id);
    const projectId = created.project.id;

    await artworkPreparation.uploadOriginal(projectId, {
      bytes: toPngBytes(sufficientResolutionArtwork()),
      declaredContentType: "image/png",
      filename: "sufficient-logo.png",
    });
    await artworkPreparation.setProductionContext(projectId, {
      productSummary: "T-shirts",
      productColor: "Black",
      printPlacement: "left_chest",
    });
    await artworkPreparation.prepareBackground(projectId);
    await artworkPreparation.approvePreparedArtwork(projectId);

    const sizeRes = await confirmSize(projectId, "adult_standard");
    assert.equal(sizeRes.status, 200, "print size must confirm cleanly before any print-ready request");

    return { graph, repo, projectId };
  }

  it("B/C: Create Print-Ready Artwork with NO treatment ever selected creates a Standard Raster job ONLY -- Halftone is never auto-generated", async () => {
    const { graph, repo, projectId } = await readyProject();

    const rasterRequest = await graph.finalArtwork.requestPreparedUploadFinalArtwork(projectId);
    await graph.finalArtworkScheduler.runBatch();

    const rasterJob = await repo.getFinalArtworkJob(rasterRequest.job.id);
    assert.ok(rasterJob, "a Standard Raster job must exist");
    assert.ok(
      rasterJob!.productionTreatmentKey === null || rasterJob!.productionTreatmentKey === "standard_raster",
      "the created job's identity must be Standard Raster (legacy null or the explicit key)",
    );
    assert.equal(rasterJob!.status, "completed", "local raster interpolation is deterministic and synchronous in this environment");

    const snapshot = (await getConversation(projectId))!;
    assert.ok(snapshot.printReadyPackage, "an internal, approved+prepared project must have a package view");
    const raster = snapshot.printReadyPackage!.variants.find((v) => v.treatment === "standard_raster")!;
    const halftone = snapshot.printReadyPackage!.variants.find((v) => v.treatment === "halftone_dtf")!;

    assert.notEqual(raster.status, "not_created", "Standard Raster was actually attempted");
    // C: nothing about requesting print-ready artwork ever creates a second,
    // halftone-identity job on its own.
    assert.equal(halftone.status, "not_created", "DTF Halftone must never be auto-created");
    assert.equal(halftone.finalArtworkJobId, null);
  });

  describe("Phase 28I Section 19 -- THE RASTER-FIRST HARD GATE", () => {
    it("Raster not_created -> Halftone blocked", async () => {
      const { graph, projectId } = await readyProject();
      // Raster has never even been attempted yet.
      await selectHalftone(projectId);
      await assert.rejects(
        () => graph.finalArtwork.requestPreparedUploadFinalArtwork(projectId),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /Print Ready/);
          return true;
        },
      );
    });

    it("Raster needs_attention -> Halftone blocked (Phase 28I overrules Phase 28H's opposite rule)", async () => {
      const { graph, projectId } = await readyProject();
      await graph.finalArtwork.requestPreparedUploadFinalArtwork(projectId);
      await graph.finalArtworkScheduler.runBatch();

      const beforeHalftone = (await getConversation(projectId))!;
      const rasterBefore = beforeHalftone.printReadyPackage!.variants.find((v) => v.treatment === "standard_raster")!;
      // A 120x120 source at a full Standard Adult front-print size is exactly
      // the deterministic "cannot safely reconstruct" case the bug report
      // described -- reproduced here without any external asset or Topaz.
      assert.equal(rasterBefore.status, "needs_attention");
      assert.equal(rasterBefore.attentionKind, "deterministic_enhancement");

      // Selecting the treatment itself still succeeds (it is only a
      // specification change) -- the gate lives on the REQUEST, not the selection.
      const treatmentRes = await selectHalftone(projectId);
      assert.equal(treatmentRes.status, 200);

      await assert.rejects(
        () => graph.finalArtwork.requestPreparedUploadFinalArtwork(projectId),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /Standard Raster/);
          assert.match(error.message, /needs_attention/);
          return true;
        },
        "Halftone must be rejected while Raster needs_attention -- Phase 28H's opposite rule is explicitly overruled",
      );

      // G: Raster's OWN job is completely untouched by the rejected attempt.
      const afterHalftoneAttempt = (await getConversation(projectId))!;
      const rasterAfter = afterHalftoneAttempt.printReadyPackage!.variants.find((v) => v.treatment === "standard_raster")!;
      assert.equal(rasterAfter.status, "needs_attention");
      assert.equal(rasterAfter.finalArtworkJobId, rasterBefore.finalArtworkJobId);
      const halftoneAfter = afterHalftoneAttempt.printReadyPackage!.variants.find((v) => v.treatment === "halftone_dtf")!;
      assert.equal(halftoneAfter.status, "not_created", "a rejected request must never leave behind a Halftone job");
    });

    it("Raster print_ready -> Halftone available; the server-side gate accepts the request", async () => {
      const { graph, repo, projectId } = await readySufficientProject();
      const rasterRequest = await graph.finalArtwork.requestPreparedUploadFinalArtwork(projectId);
      await graph.finalArtworkScheduler.runBatch();
      const rasterJob = await repo.getFinalArtworkJob(rasterRequest.job.id);
      assert.equal(rasterJob!.status, "completed");

      const snapshot = (await getConversation(projectId))!;
      const raster = snapshot.printReadyPackage!.variants.find((v) => v.treatment === "standard_raster")!;
      assert.equal(raster.status, "print_ready", "a sufficiently large source needs no reconstruction and must reach genuine print_ready locally");
      assert.equal(rasterJob!.providerKey, null, "no paid provider was involved");

      const treatmentRes = await selectHalftone(projectId);
      assert.equal(treatmentRes.status, 200);

      const halftoneRequest = await graph.finalArtwork.requestPreparedUploadFinalArtwork(projectId);
      await graph.finalArtworkScheduler.runBatch();
      const halftoneJob = await repo.getFinalArtworkJob(halftoneRequest.job.id);
      assert.ok(halftoneJob, "Halftone must be creatable once Raster is genuinely print_ready");
      assert.notEqual(halftoneJob!.id, rasterJob!.id);
    });

    it("direct server request before Raster print_ready is rejected with a stable, machine-readable reason", async () => {
      const { graph, projectId } = await readyProject();
      await selectHalftone(projectId);
      try {
        await graph.finalArtwork.requestPreparedUploadFinalArtwork(projectId);
        assert.fail("expected the request to be rejected");
      } catch (error) {
        const { ArtworkFinalizationRasterNotReadyError } = await import(
          "@/capabilities/final-artwork/raster-not-ready-error"
        );
        assert.ok(error instanceof ArtworkFinalizationRasterNotReadyError);
        assert.equal(error.safeErrorCode, "STANDARD_RASTER_NOT_PRINT_READY");
        assert.equal(error.currentRasterStatus, "not_created");
      }
    });

    it("direct server request after Raster print_ready is accepted", async () => {
      const { graph, projectId } = await readySufficientProject();
      await graph.finalArtwork.requestPreparedUploadFinalArtwork(projectId);
      await graph.finalArtworkScheduler.runBatch();
      await selectHalftone(projectId);
      // No throw -- the request is genuinely accepted.
      const result = await graph.finalArtwork.requestPreparedUploadFinalArtwork(projectId);
      assert.ok(result.job);
    });

    it("the HTTP route surfaces the rejection as a 409 with the safe error code, never a 500", async () => {
      const { projectId } = await readyProject();
      await selectHalftone(projectId);
      const printReadyRoute = await import("@/app/api/projects/[projectId]/artwork-preparation/route");
      const res = await printReadyRoute.POST(
        new Request("http://localhost/x", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "print_ready" }),
        }),
        { params: Promise.resolve({ projectId }) },
      );
      assert.equal(res.status, 409);
      const body = await res.json();
      assert.equal(body.safeErrorCode, "STANDARD_RASTER_NOT_PRINT_READY");
    });
  });

  it("L: repeated Create Print-Ready Artwork clicks are idempotent -- no duplicate active Standard Raster job", async () => {
    const { graph, repo, projectId } = await readyProject();

    const first = await graph.finalArtwork.requestPreparedUploadFinalArtwork(projectId);
    await graph.finalArtworkScheduler.runBatch();
    const second = await graph.finalArtwork.requestPreparedUploadFinalArtwork(projectId);

    assert.equal(second.job.id, first.job.id, "a second request for the SAME confirmed size/treatment must return the SAME job, never a new one");

    const preparation = await repo.getArtworkPreparation(projectId);
    const allJobs = await repo.listFinalArtworkJobsForPreparation(projectId, preparation!.id);
    const rasterJobs = allJobs.filter(
      (j) => j.productionTreatmentKey === null || j.productionTreatmentKey === "standard_raster",
    );
    assert.equal(rasterJobs.length, 1, "exactly one Standard Raster job must ever exist for this project/size");
  });

  it("M: refreshing (re-reading the snapshot) preserves the true status of each variant -- no client-side state involved", async () => {
    const { graph, projectId } = await readyProject();
    await graph.finalArtwork.requestPreparedUploadFinalArtwork(projectId);
    await graph.finalArtworkScheduler.runBatch();

    const first = await getConversation(projectId);
    const second = await getConversation(projectId);
    assert.deepEqual(
      first!.printReadyPackage!.variants.map((v) => ({ treatment: v.treatment, status: v.status })),
      second!.printReadyPackage!.variants.map((v) => ({ treatment: v.treatment, status: v.status })),
      "two independent reads of the same persisted state must agree exactly",
    );
  });

  it("B (precise): a second Create Print-Ready Artwork click WHILE the first is still queued (batch not yet run) returns the SAME job, never a second one", async () => {
    const { graph, repo, projectId } = await readyProject();

    // Deliberately do NOT run the batch between the two requests -- this is
    // the "still processing" window Section 15.B describes, not the
    // "already completed" window "L" above covers.
    const first = await graph.finalArtwork.requestPreparedUploadFinalArtwork(projectId);
    const second = await graph.finalArtwork.requestPreparedUploadFinalArtwork(projectId);
    assert.equal(second.job.id, first.job.id, "a duplicate click while still queued must return the SAME job, never enqueue a second one");

    const preparation = await repo.getArtworkPreparation(projectId);
    const allJobs = await repo.listFinalArtworkJobsForPreparation(projectId, preparation!.id);
    assert.equal(allJobs.length, 1, "exactly one job must exist even before the batch has run");

    // Let it actually run so the harness leaves no dangling queued job.
    await graph.finalArtworkScheduler.runBatch();
  });

  it("D: a second Create DTF Halftone Version click WHILE the first is still queued returns the SAME Halftone job, never a second one", async () => {
    const { graph, repo, projectId } = await readySufficientProject();
    await graph.finalArtwork.requestPreparedUploadFinalArtwork(projectId);
    await graph.finalArtworkScheduler.runBatch();
    await selectHalftone(projectId);

    const first = await graph.finalArtwork.requestPreparedUploadFinalArtwork(projectId);
    const second = await graph.finalArtwork.requestPreparedUploadFinalArtwork(projectId);
    assert.equal(second.job.id, first.job.id, "a duplicate Halftone click while still queued must return the SAME job");

    const preparation = await repo.getArtworkPreparation(projectId);
    const allJobs = await repo.listFinalArtworkJobsForPreparation(projectId, preparation!.id);
    const halftoneJobs = allJobs.filter((j) => j.productionTreatmentKey?.startsWith("halftone_dtf"));
    assert.equal(halftoneJobs.length, 1, "exactly one Halftone job must exist even before the batch has run");

    await graph.finalArtworkScheduler.runBatch();
  });

  it("I: creating a NEW Standard Raster attempt (after a confirmed-size change) never mutates an already-completed Halftone job", async () => {
    const { graph, repo, projectId } = await readySufficientProject();

    // Raster reaches print_ready (the sufficient fixture at left_chest).
    const firstRaster = await graph.finalArtwork.requestPreparedUploadFinalArtwork(projectId);
    await graph.finalArtworkScheduler.runBatch();
    assert.equal((await repo.getFinalArtworkJob(firstRaster.job.id))!.status, "completed");

    // Halftone succeeds independently once Raster is print_ready.
    await selectHalftone(projectId);
    const halftoneRequest = await graph.finalArtwork.requestPreparedUploadFinalArtwork(projectId);
    await graph.finalArtworkScheduler.runBatch();
    const halftoneJobBefore = await repo.getFinalArtworkJob(halftoneRequest.job.id);
    assert.equal(halftoneJobBefore!.status, "completed");

    // Now switch back to Standard Raster (a specification change touching
    // only the brief's CURRENT treatment, never Halftone's own completed
    // job) and request print-ready again -- whether this reuses the
    // existing completed Raster job or creates a new one, Halftone's own
    // job must be completely unaffected either way.
    await selectStandardRaster(projectId);
    await graph.finalArtwork.requestPreparedUploadFinalArtwork(projectId);
    await graph.finalArtworkScheduler.runBatch();

    const halftoneJobAfter = await repo.getFinalArtworkJob(halftoneRequest.job.id);
    assert.equal(halftoneJobAfter!.id, halftoneJobBefore!.id);
    assert.equal(halftoneJobAfter!.status, halftoneJobBefore!.status, "a new Raster attempt must never mutate Halftone's own job");
    assert.equal(halftoneJobAfter!.providerKey, halftoneJobBefore!.providerKey);
  });

  it("H: a deterministic Raster refusal is NOT stuck forever -- confirming a smaller (identity-relevant) size allows a genuinely new Raster attempt", async () => {
    const { graph, repo, projectId } = await readyProject();
    const firstAttempt = await graph.finalArtwork.requestPreparedUploadFinalArtwork(projectId);
    await graph.finalArtworkScheduler.runBatch();
    const firstJob = await repo.getFinalArtworkJob(firstAttempt.job.id);
    assert.equal(firstJob!.status, "completed");

    // Confirm a smaller box -- a genuinely different physical size.
    const sizeRes = await confirmSize(projectId, "youth");
    assert.equal(sizeRes.status, 200);

    const secondAttempt = await graph.finalArtwork.requestPreparedUploadFinalArtwork(projectId);
    await graph.finalArtworkScheduler.runBatch();

    assert.notEqual(secondAttempt.job.id, firstAttempt.job.id, "a genuinely different confirmed size must be a NEW job, not the same stuck refusal");
    const secondJob = await repo.getFinalArtworkJob(secondAttempt.job.id);
    assert.notEqual(secondJob!.productionWidthIn, firstJob!.productionWidthIn, "the new job's identity must reflect the new confirmed width");

    // The OLD job (the original deterministic refusal) is left completely
    // untouched as evidence -- never rewritten in place.
    const firstJobAfter = await repo.getFinalArtworkJob(firstAttempt.job.id);
    assert.equal(firstJobAfter!.id, firstJob!.id);
    assert.equal(firstJobAfter!.status, firstJob!.status);
  });

  it("O: Standard Raster and DTF Halftone are produced at the SAME confirmed physical dimensions", async () => {
    const { graph, repo, projectId } = await readySufficientProject();
    const rasterRequest = await graph.finalArtwork.requestPreparedUploadFinalArtwork(projectId);
    await graph.finalArtworkScheduler.runBatch();
    assert.equal((await repo.getFinalArtworkJob(rasterRequest.job.id))!.status, "completed");

    await selectHalftone(projectId);
    const halftoneRequest = await graph.finalArtwork.requestPreparedUploadFinalArtwork(projectId);
    await graph.finalArtworkScheduler.runBatch();

    const rasterJob = await repo.getFinalArtworkJob(rasterRequest.job.id);
    const halftoneJob = await repo.getFinalArtworkJob(halftoneRequest.job.id);
    assert.equal(
      rasterJob!.productionWidthIn,
      halftoneJob!.productionWidthIn,
      "both variants must be produced at the SAME confirmed physical width -- no separate size authority per treatment",
    );
  });
});
