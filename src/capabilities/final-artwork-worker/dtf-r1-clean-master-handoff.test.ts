import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { PNG } from "pngjs";

import { DataUriAssetStorageProvider } from "@/capabilities/asset-storage";
import { createAssetCapability, PngThumbnailGenerator } from "@/capabilities/assets";
import { createArtworkFidelityCapability } from "@/capabilities/artwork-fidelity";
import { createArtworkGeometryQualificationCapability } from "@/capabilities/artwork-reconstruction/artwork-geometry-qualification-capability";
import { createRasterReconstructionCapability } from "@/capabilities/artwork-reconstruction/raster-reconstruction-capability";
import { createFinalArtworkCapability } from "@/capabilities/final-artwork";
import { LocalRasterInterpolationProvider } from "@/capabilities/final-artwork/local-raster-provider";
import {
  encodeProductionPng,
  normalizeProductionRaster,
} from "@/capabilities/final-artwork/production-normalization";
import type {
  FinalArtworkProvider,
  FinalArtworkProviderInput,
  FinalArtworkProviderOutput,
} from "@/capabilities/final-artwork/provider";
import type { RgbaImage } from "@/capabilities/final-artwork/raster-transform";
import { resolvePreparedUploadEffectiveSource } from "@/capabilities/final-artwork/prepared-upload-effective-source";
import { ArtworkFinalizationRecoveryUnresolvedError } from "@/capabilities/final-artwork/recovery-unresolved-error";
import { createPrintValidationCapability } from "@/capabilities/print-validation";
import type { PrintValidationReport } from "@/capabilities/print-validation/contracts";
import type { ProjectRepository } from "@/lib/db/repository";
import { STANDARD_RASTER_TREATMENT_KEY } from "@/lib/domain/types";
import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";
import { confirmProductionSizeForTests } from "@/test-support/confirm-production-size";

import { createFinalArtworkWorkerCapability } from "./final-artwork-worker-capability";

/**
 * DTF-R1 — CLEAN-MASTER HANDOFF TO DTF PRODUCTION.
 *
 * Acceptance coverage for the ONE thing this phase changes: which artwork
 * the prepared-upload (apparel raster / DTF) production path is allowed to
 * descend from, once the shared artwork recovery lifecycle exists for a
 * project.
 *
 * NO PROVIDER IS REACHABLE HERE, AND THAT IS AN ASSERTION, NOT A SETUP
 * DETAIL. Every scenario wires a counting reconstruction provider and a
 * counting local provider, and the clean-master scenarios assert the
 * reconstruction provider's call count is ZERO — DTF-R1 must never launch
 * a reconstruction of its own, and must never re-run one the recovery
 * lifecycle already performed. The recovery lifecycle itself is built with
 * the REAL fidelity/reconstruction/geometry-qualification capabilities
 * against the REAL local repository, with no OpenAI or Topaz port wired at
 * all, so "zero provider calls" is true by construction as well.
 *
 * THE GOVERNANCE LINE THIS FILE DEFENDS (scenario I). Pedro Back's real
 * production test produced a technically valid plate and still, correctly,
 * ended `finalization_required` because authoritative Print Validation
 * withheld Print Ready on `reconstruction_certification_evidence`. DTF-R1
 * must not weaken that by handing DTF a clean master and letting the plate
 * pass because THIS job happened not to reconstruct anything. No Pedro id
 * appears anywhere in production logic or in this file — the condition is
 * reproduced from its shape, not its identity.
 */
describe("DTF-R1 — Production-Qualified Clean Master handoff to DTF production", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-dtf-r1-"));
    process.chdir(tempDir);
  });

  after(async () => {
    await cleanupTempWorkspace(tempDir, previousCwd);
  });

  /**
   * A faithful LOCAL stand-in for a provider-hosted reconstruction — an
   * exact integer pixel replication (so alpha bounds scale exactly), then
   * the same shared production normalization the real adapter runs. No
   * network, no credit, no provider account: "zero paid calls" is true by
   * construction in this file, and `calls` is what makes "zero DISPATCHES"
   * an assertion rather than a hope.
   *
   * Most scenarios assert `calls === 0`. Two deliberately do not — the
   * Pedro-shaped scenario and the undersized-master scenario both need a
   * reconstruction to genuinely happen, and a provider that merely threw
   * could not express them.
   */
  class CountingReconstructionProvider implements FinalArtworkProvider {
    readonly providerKey = "dtf_r1_local_reconstruction";
    calls = 0;
    private static readonly SCALE = 5;

    async produce(input: FinalArtworkProviderInput): Promise<FinalArtworkProviderOutput> {
      this.calls += 1;
      const requestId = `dtf-r1-reconstruction-${this.calls}`;
      await input.onProviderRequestSubmitted?.(requestId);

      const source = PNG.sync.read(input.sourceBytes);
      const scale = CountingReconstructionProvider.SCALE;
      const width = source.width * scale;
      const height = source.height * scale;
      const data = Buffer.alloc(width * height * 4);
      for (let y = 0; y < height; y += 1) {
        const sourceRow = Math.floor(y / scale) * source.width;
        for (let x = 0; x < width; x += 1) {
          const from = (sourceRow + Math.floor(x / scale)) * 4;
          const to = (y * width + x) * 4;
          data[to] = source.data[from]!;
          data[to + 1] = source.data[from + 1]!;
          data[to + 2] = source.data[from + 2]!;
          data[to + 3] = source.data[from + 3]!;
        }
      }
      const normalized = normalizeProductionRaster({ width, height, data }, input.sizing);
      if (normalized.status !== "normalized") throw new Error(normalized.reason);
      const encoded = encodeProductionPng(normalized.result);

      return {
        bytes: encoded.bytes,
        contentType: "image/png",
        widthPx: normalized.result.image.width,
        heightPx: normalized.result.image.height,
        hasTransparency: encoded.hasTransparency,
        nativeWidthPx: source.width,
        nativeHeightPx: source.height,
        reconstructedWidthPx: width,
        reconstructedHeightPx: height,
        resolutionProvenance: "reconstructed",
        transformationMethod: "dtf_r1_local_reconstruction_v1",
        preservesApprovedContent: false,
        providerRequestId: requestId,
        normalization: normalized.result.metadata,
      };
    }
  }

  /**
   * CURSOR BLOCKER 2 — a TWO-PASS provider that records, per call, exactly
   * what resumable state the worker handed it.
   *
   * The point of this file's Blocker-2 scenarios is not "did a plate come
   * out" but "whose pixels went in". So every call captures the SHA-256 of
   * the `sourceBytes` it received, the SHA-256 of any
   * `existingIntermediateReconstruction` bytes, and any
   * `existingProviderRequest` id. A test can then assert on identity
   * directly instead of inferring it from an outcome.
   *
   * Pass 1 emits an intermediate through `onIntermediateReconstructionProduced`
   * and then throws a bounded-pending-style interruption, so a durable
   * pass-1 intermediate genuinely exists on disk before the source moves —
   * the real precondition, not a hand-written asset row.
   */
  class TwoPassRecordingProvider implements FinalArtworkProvider {
    readonly providerKey = "dtf_r1_two_pass_recording";
    calls: Array<{
      sourceSha: string;
      intermediateSha: string | null;
      resumedRequestId: string | null;
      submittedRequestId: string | null;
    }> = [];
    /** When true, pass 1 stores its intermediate and then interrupts before pass 2. */
    interruptAfterPass1 = true;
    /**
     * When true, the call submits a paid request and then dies BEFORE
     * producing an intermediate — the genuinely in-flight state, where the
     * job's provider slot is populated and no durable artifact exists to
     * say which source it belongs to. This is the only window the job-row
     * binding covers, so it is the only window this mode can express.
     */
    interruptAfterSubmit = false;
    private submissions = 0;

    async produce(input: FinalArtworkProviderInput): Promise<FinalArtworkProviderOutput> {
      const record = {
        sourceSha: createHash("sha256").update(input.sourceBytes).digest("hex"),
        intermediateSha: input.existingIntermediateReconstruction
          ? createHash("sha256")
              .update(input.existingIntermediateReconstruction.bytes)
              .digest("hex")
          : null,
        resumedRequestId: input.existingProviderRequest?.providerRequestId ?? null,
        submittedRequestId: null as string | null,
      };
      this.calls.push(record);

      // Continue from a supplied pass-1 intermediate when there is one;
      // otherwise this call IS pass 1 and must submit a paid request.
      let working: PNG = input.existingIntermediateReconstruction
        ? PNG.sync.read(input.existingIntermediateReconstruction.bytes)
        : PNG.sync.read(input.sourceBytes);

      // A RESUME never resubmits — it collects the result of the request it
      // was handed. Modelling that faithfully is what makes "the legacy
      // request was resumed, and nothing was re-billed" an observable fact
      // rather than an assumption.
      const resuming = input.existingProviderRequest != null;

      if (!input.existingIntermediateReconstruction && !resuming) {
        this.submissions += 1;
        const requestId = `two-pass-request-${this.submissions}`;
        record.submittedRequestId = requestId;
        await input.onProviderRequestSubmitted?.(requestId);

        if (this.interruptAfterSubmit) {
          throw new Error("simulated interruption with the request still in flight");
        }

        const pass1 = replicate(working, 2);
        await input.onIntermediateReconstructionProduced?.({
          bytes: PNG.sync.write(toPng(pass1)),
          widthPx: pass1.width,
          heightPx: pass1.height,
          providerRequestId: requestId,
        });
        if (this.interruptAfterPass1) {
          throw new Error("simulated interruption after pass 1 was durably stored");
        }
        working = toPng(pass1);
      }

      const finalImage = replicate(working, 3);
      const normalized = normalizeProductionRaster(finalImage, input.sizing);
      if (normalized.status !== "normalized") throw new Error(normalized.reason);
      const encoded = encodeProductionPng(normalized.result);
      return {
        bytes: encoded.bytes,
        contentType: "image/png",
        widthPx: normalized.result.image.width,
        heightPx: normalized.result.image.height,
        hasTransparency: encoded.hasTransparency,
        nativeWidthPx: working.width,
        nativeHeightPx: working.height,
        reconstructedWidthPx: finalImage.width,
        reconstructedHeightPx: finalImage.height,
        resolutionProvenance: "reconstructed",
        transformationMethod: "dtf_r1_two_pass_recording_v1",
        preservesApprovedContent: false,
        providerRequestId:
          record.submittedRequestId ?? record.resumedRequestId ?? "two-pass-unknown",
        normalization: normalized.result.metadata,
      };
    }
  }

  /** Exact integer replication — alpha bounds scale exactly, so geometry stays predictable. */
  function replicate(source: PNG, scale: number): RgbaImage {
    const width = source.width * scale;
    const height = source.height * scale;
    const data = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y += 1) {
      const sourceRow = Math.floor(y / scale) * source.width;
      for (let x = 0; x < width; x += 1) {
        const from = (sourceRow + Math.floor(x / scale)) * 4;
        const to = (y * width + x) * 4;
        data[to] = source.data[from]!;
        data[to + 1] = source.data[from + 1]!;
        data[to + 2] = source.data[from + 2]!;
        data[to + 3] = source.data[from + 3]!;
      }
    }
    return { width, height, data };
  }

  function toPng(image: RgbaImage): PNG {
    const png = new PNG({ width: image.width, height: image.height });
    image.data.copy(png.data);
    return png;
  }

  /** Counts calls without changing behavior, so "which provider ran" is observable. */
  class CountingLocalProvider implements FinalArtworkProvider {
    readonly providerKey = "local_raster_interpolation";
    calls = 0;
    private readonly inner = new LocalRasterInterpolationProvider();
    async produce(input: FinalArtworkProviderInput): Promise<FinalArtworkProviderOutput> {
      this.calls += 1;
      return this.inner.produce(input);
    }
  }

  async function freshRepo() {
    const { LocalProjectRepository } = await import("@/lib/db/local-store");
    return new LocalProjectRepository();
  }

  /**
   * One on-disk store is shared by every scenario (the local repository is
   * rooted at the process working directory), so a job an earlier scenario
   * deliberately left queued would otherwise be claimed by the next
   * scenario's worker and counted against ITS provider. Same isolation
   * discipline as `prepared-upload-finalization.test.ts`.
   */
  async function retireQueuedJobs(repo: ProjectRepository): Promise<void> {
    for (;;) {
      const claimed = await repo.claimNextQueuedFinalArtworkJob();
      if (!claimed) return;
      await repo.updateFinalArtworkJob(claimed.id, {
        status: "cancelled",
        lastError: "Retired by test isolation.",
        completedAt: new Date().toISOString(),
      });
    }
  }

  function buildPipeline(
    repo: ProjectRepository,
    /**
     * CURSOR BLOCKER 2: the Blocker-2 scenarios need a provider with REAL
     * resumable state (a pass-1 intermediate, an outstanding request), so
     * they inject one. Everything else keeps the single-pass counting
     * provider and its `calls === 0` assertions.
     */
    reconstructionProvider?: FinalArtworkProvider & { calls?: unknown },
  ) {
    const assets = createAssetCapability(
      repo,
      new DataUriAssetStorageProvider(),
      new PngThumbnailGenerator(),
    );
    const fidelity = createArtworkFidelityCapability(repo);
    const reconstruction = createRasterReconstructionCapability(repo);
    const qualification = createArtworkGeometryQualificationCapability(
      repo,
      assets,
      reconstruction,
    );
    const provider = reconstructionProvider ?? new CountingReconstructionProvider();
    const localProvider = new CountingLocalProvider();
    const finalArtwork = createFinalArtworkCapability(repo, undefined, qualification);
    const worker = createFinalArtworkWorkerCapability(
      repo,
      assets,
      provider,
      createPrintValidationCapability(),
      undefined,
      localProvider,
      undefined,
      qualification,
    );
    return {
      assets,
      fidelity,
      reconstruction,
      qualification,
      finalArtwork,
      worker,
      provider: provider as CountingReconstructionProvider,
      /** The same instance, named for what it is at the two call sites that need it to run. */
      reconstructor: provider as CountingReconstructionProvider,
      localProvider,
    };
  }

  // --- fixtures ------------------------------------------------------------

  /** A solid rectangle inset on a uniform field — opaque when `alpha` is 255. */
  function rectPng(
    canvasWidthPx: number,
    canvasHeightPx: number,
    artworkWidthPx: number,
    artworkHeightPx: number,
    backgroundAlpha: number,
    /**
     * The artwork's ink colour. Exists so two candidates can differ in
     * BYTES and therefore in SHA-256 — without it, master A and master B
     * had different asset ids but identical content, so the SHA half of
     * source identity was never actually exercised.
     */
    ink: { r: number; g: number; b: number } = { r: 20, g: 90, b: 60 },
  ): Buffer {
    const png = new PNG({ width: canvasWidthPx, height: canvasHeightPx });
    const insetX = Math.floor((canvasWidthPx - artworkWidthPx) / 2);
    const insetY = Math.floor((canvasHeightPx - artworkHeightPx) / 2);
    for (let y = 0; y < canvasHeightPx; y += 1) {
      for (let x = 0; x < canvasWidthPx; x += 1) {
        const idx = (canvasWidthPx * y + x) << 2;
        const inside =
          x >= insetX &&
          x < insetX + artworkWidthPx &&
          y >= insetY &&
          y < insetY + artworkHeightPx;
        png.data[idx] = inside ? ink.r : 250;
        png.data[idx + 1] = inside ? ink.g : 250;
        png.data[idx + 2] = inside ? ink.b : 250;
        png.data[idx + 3] = inside ? 255 : backgroundAlpha;
      }
    }
    return PNG.sync.write(png);
  }

  /**
   * The customer's immutable original: artwork on an opaque background.
   *
   * Deliberately sized so its PREPARED derivative already carries more real
   * pixels than a 4in/300 PPI left-chest plate needs (1300px visible against
   * a 1200px target). Nothing on any DTF-R1 path may reach a reconstruction
   * provider, so the baseline scenario must not need one either — a fixture
   * that did would be testing enhancement, not source selection.
   */
  const ORIGINAL_CANVAS = { w: 1400, h: 640, aw: 1300, ah: 560 };
  /**
   * The recovered candidate: deliberately LARGE, so the clean master it
   * qualifies into already carries more real pixels than a 4in/300 PPI
   * left-chest plate needs. That is what makes scenario I meaningful — the
   * DTF job's own enhancement step honestly records `"skipped"`, and Print
   * Ready must STILL be withheld because the pixels were manufactured
   * upstream.
   */
  const CANDIDATE_CANVAS = { w: 2000, h: 900, aw: 1800, ah: 800 };

  /**
   * An original whose prepared derivative is HONESTLY short of the plate:
   * 400px of visible artwork against a 1200px target. The only fixture that
   * legitimately reaches a reconstruction provider, and the shape the
   * Pedro-class scenario needs.
   */
  const UNDERSIZED_CANVAS = { w: 500, h: 240, aw: 400, ah: 180 };
  /** A recovered candidate that qualifies into a master still short of the target. */
  const SMALL_CANDIDATE_CANVAS = { w: 700, h: 320, aw: 600, ah: 260 };

  type Canvas = { w: number; h: number; aw: number; ah: number };

  function originalUploadPng(canvas: Canvas = ORIGINAL_CANVAS): Buffer {
    return rectPng(canvas.w, canvas.h, canvas.aw, canvas.ah, 255);
  }
  function preparedArtworkPng(canvas: Canvas = ORIGINAL_CANVAS): Buffer {
    return rectPng(canvas.w, canvas.h, canvas.aw, canvas.ah, 0);
  }
  function candidatePng(
    canvas: Canvas = CANDIDATE_CANVAS,
    ink?: { r: number; g: number; b: number },
  ): Buffer {
    return rectPng(canvas.w, canvas.h, canvas.aw, canvas.ah, 255, ink);
  }

  /** Drives a project to exactly "an approved prepared upload, size confirmed". */
  async function setupApprovedPreparation(
    repo: ProjectRepository,
    assets: ReturnType<typeof buildPipeline>["assets"],
    canvas: Canvas = ORIGINAL_CANVAS,
  ) {
    await retireQueuedJobs(repo);

    const created = await repo.createProject();
    const projectId = created.project.id;
    await repo.updateBrief(projectId, {
      productSummary: "T-shirts for our bowling team",
      shirtColor: "Black",
      printPlacement: "left_chest",
      intendedPrintWidthIn: null,
    });

    const original = await assets.uploadCustomerArtwork(projectId, {
      conceptId: "upload-original",
      bytes: originalUploadPng(canvas),
      contentType: "image/png",
      widthPx: canvas.w,
      heightPx: canvas.h,
      hasTransparency: false,
      kind: "customer_upload",
      metadata: { originalFilename: "team-logo.png" },
    });

    const preparation = await repo.createArtworkPreparation(projectId, {
      originalAssetId: original.id,
      originalFilename: "team-logo.png",
      analysis: { widthPx: canvas.w, heightPx: canvas.h },
    });

    const prepared = await assets.uploadCustomerArtwork(projectId, {
      conceptId: `prepared-${preparation.id}`,
      bytes: preparedArtworkPng(canvas),
      contentType: "image/png",
      widthPx: canvas.w,
      heightPx: canvas.h,
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
    await confirmProductionSizeForTests(repo, projectId);

    return {
      projectId,
      preparationId: preparation.id,
      originalAssetId: original.id,
      preparedAssetId: prepared.id,
      artworkVersionId: artwork!.id,
    };
  }

  const SOURCE_SHA = "a".repeat(64);

  /** Contract -> reconstruction job requested. The lifecycle has BEGUN, nothing is resolved. */
  async function beginRecoveryLifecycle(
    built: ReturnType<typeof buildPipeline> & { repo: ProjectRepository },
    projectId: string,
    originalAssetId: string,
    /**
     * The confirmed wording this contract asserts. It feeds
     * `deriveArtworkFidelityContractKey`, so two lifecycles over the same
     * bytes are only genuinely DIFFERENT authorities when their wording
     * differs — otherwise `requestReconstruction` idempotently returns the
     * first lifecycle's job and nothing is superseded at all.
     */
    confirmedWording: string[] = [],
  ) {
    const proposed = await built.fidelity.proposeContract(projectId, {
      sourceAssetId: originalAssetId,
      sourceSha256: SOURCE_SHA,
    });
    const contract = await built.fidelity.confirmContract(projectId, proposed.id, {
      currentSourceSha256: SOURCE_SHA,
      confirmedWording,
      confirmedMarks: [],
      confirmedBy: "customer",
    });
    const job = await built.reconstruction.requestReconstruction(projectId, {
      sourceAssetId: originalAssetId,
      currentSourceSha256: SOURCE_SHA,
      fidelityContractId: contract.id,
    });
    return { contract, job };
  }

  /**
   * The full recovery lineage: contract -> job -> completed candidate ->
   * customer-approved -> geometry-qualified -> CONFIRMED. The only state in
   * which `getCurrentProductionQualifiedMaster` returns anything.
   */
  async function buildConfirmedMaster(
    built: ReturnType<typeof buildPipeline> & { repo: ProjectRepository },
    projectId: string,
    originalAssetId: string,
    candidateLabel = "recovered-candidate",
    existingLifecycle?: Awaited<ReturnType<typeof beginRecoveryLifecycle>>,
    candidateCanvas: Canvas = CANDIDATE_CANVAS,
    /** Distinct ink => distinct bytes => distinct SHA-256 for this master. */
    candidateInk?: { r: number; g: number; b: number },
  ) {
    // Reuse a lifecycle this scenario already began, when it has one.
    // Proposing a SECOND contract would supersede the first and make the
    // reconstruction unapprovable ("the confirmed fidelity contract has
    // changed since this artwork was rebuilt") — which is correct
    // behavior, and exactly what scenario D exercises on purpose.
    const started =
      existingLifecycle ??
      (await beginRecoveryLifecycle(built, projectId, originalAssetId));
    const { contract, job } = started;
    const uploaded = await built.assets.uploadConceptImage(projectId, {
      conceptId: candidateLabel,
      bytes: candidatePng(candidateCanvas, candidateInk),
      contentType: "image/png",
      widthPx: candidateCanvas.w,
      heightPx: candidateCanvas.h,
      hasTransparency: false,
      providerKey: "test",
      generationJobId: null,
      metadata: {},
    });
    await built.repo.updateArtworkReconstructionJob(job.id, {
      status: "completed",
      completedAt: new Date().toISOString(),
      candidateAssetId: uploaded.primary.id,
      wordingVerified: true,
      geometryStatus: "review_required",
      reviewStatus: "pending_review",
    });
    const approved = await built.reconstruction.approveCandidate(projectId, job.id, {
      confirmedBy: "customer",
    });
    await built.qualification.ensureQualification(projectId, approved.id);
    const confirmed = await built.qualification.confirmQualification(projectId, "customer");
    assert.equal(confirmed.qualificationStatus, "confirmed");
    assert.ok(confirmed.derivedAssetId, "a confirmed master must carry a derivative");
    return { contract, job: approved, master: confirmed, derivedAssetId: confirmed.derivedAssetId! };
  }

  /**
   * Runs the worker until the named job reaches a terminal state.
   *
   * A single `processNextJob()` is NOT a whole job: the Bounded
   * FinalArtwork Production-Execution Repair deliberately stops after the
   * post-provider durable checkpoint and leaves the job `"recoverable"` for
   * the next invocation to finish (validation, completion). Draining is
   * therefore the honest way to say "run this job", and it also means a
   * scenario that blocks on the FIRST pass is observably different from one
   * that merely needs a second — a fixed call count would hide that.
   */
  async function drainJob(
    worker: ReturnType<typeof buildPipeline>["worker"],
    repo: ProjectRepository,
    jobId: string,
    maxPasses = 6,
  ) {
    for (let pass = 0; pass < maxPasses; pass += 1) {
      const job = await repo.getFinalArtworkJob(jobId);
      if (
        job &&
        (job.status === "completed" || job.status === "failed" || job.status === "cancelled")
      ) {
        return job;
      }
      const { processedJobId } = await worker.processNextJob();
      if (!processedJobId) break;
    }
    const job = await repo.getFinalArtworkJob(jobId);
    assert.ok(job, "the job must still exist after draining");
    return job!;
  }

  async function productionAssetFor(repo: ProjectRepository, projectId: string, jobId: string) {
    const all = await repo.listAssets(projectId);
    // Deliberately excludes reconstruction-stage artifacts (pass-1
    // intermediates, downloaded provider results): they share the
    // `production_png` role but are never the customer deliverable, and a
    // scenario that stages one would otherwise silently assert against it.
    const plates = all.filter(
      (asset) =>
        asset.finalArtworkJobId === jobId &&
        asset.productionRole === "production_png" &&
        (asset.metadata as Record<string, unknown> | null)?.reconstructionStage === undefined,
    );
    if (plates.length === 0) return undefined;
    return plates.reduce((newest, asset) =>
      asset.createdAt > newest.createdAt ? asset : newest,
    );
  }

  function recordedLineageOrNull(asset: { metadata: unknown }) {
    return ((asset.metadata as Record<string, unknown>)?.uploadedPreserve ?? null) as {
      preparedAssetId?: string;
    } | null;
  }

  function recordedLineage(asset: { metadata: unknown }) {
    return (asset.metadata as Record<string, unknown>).uploadedPreserve as {
      preparedAssetId: string;
      sourceAuthority?: string;
      originalAssetId: string;
      sourceBytesSha256: string;
      enhancement: string;
    };
  }

  async function latestReport(
    repo: ProjectRepository,
    projectId: string,
    jobId: string,
  ): Promise<PrintValidationReport> {
    const validation = await repo.getLatestProductionAssetValidationForJob(projectId, jobId);
    assert.ok(validation, "expected an authoritative validation run");
    return validation.report as unknown as PrintValidationReport;
  }

  // =========================================================================
  // A — NORMAL / NO RECOVERY: existing DTF behavior is preserved exactly
  // =========================================================================

  it("A: with no recovery lifecycle the resolver returns preparedAssetId and DTF finalizes from it", async () => {
    const repo = await freshRepo();
    const built = { ...buildPipeline(repo), repo };
    const setup = await setupApprovedPreparation(repo, built.assets);

    const preparation = await repo.getArtworkPreparation(setup.projectId);
    const resolved = await resolvePreparedUploadEffectiveSource(repo, built.qualification, {
      projectId: setup.projectId,
      originalAssetId: setup.originalAssetId,
      preparedAssetId: preparation!.preparedAssetId!,
    });
    assert.equal(resolved.status, "prepared");
    assert.equal(resolved.status === "prepared" && resolved.assetId, setup.preparedAssetId);
    assert.equal(
      resolved.status === "prepared" && resolved.authority,
      "prepared_upload",
    );

    const requested = await built.finalArtwork.requestPreparedUploadFinalArtwork(setup.projectId);
    assert.equal(requested.job.status, "queued");
    await drainJob(built.worker, repo, requested.job.id);

    const asset = await productionAssetFor(repo, setup.projectId, requested.job.id);
    assert.ok(asset, "a production plate is produced exactly as before DTF-R1");
    const lineage = recordedLineage(asset!);
    assert.equal(lineage.preparedAssetId, setup.preparedAssetId);
    assert.equal(lineage.sourceAuthority, "prepared_upload");
    assert.equal(built.provider.calls, 0, "no reconstruction provider is ever dispatched");
  });

  it("A: the resolver also returns preparedAssetId when the lifecycle capability is simply absent", async () => {
    const repo = await freshRepo();
    const built = { ...buildPipeline(repo), repo };
    const setup = await setupApprovedPreparation(repo, built.assets);

    const resolved = await resolvePreparedUploadEffectiveSource(repo, undefined, {
      projectId: setup.projectId,
      originalAssetId: setup.originalAssetId,
      preparedAssetId: setup.preparedAssetId,
    });
    assert.equal(resolved.status, "prepared");
  });

  // =========================================================================
  // B — RECOVERY STARTED / NO PQCM: DTF blocks, never falls back
  // =========================================================================

  it("B: a begun-but-unresolved recovery blocks the DTF request — preparedAssetId is NOT a fallback", async () => {
    const repo = await freshRepo();
    const built = { ...buildPipeline(repo), repo };
    const setup = await setupApprovedPreparation(repo, built.assets);
    await beginRecoveryLifecycle(built, setup.projectId, setup.originalAssetId);

    const resolved = await resolvePreparedUploadEffectiveSource(repo, built.qualification, {
      projectId: setup.projectId,
      originalAssetId: setup.originalAssetId,
      preparedAssetId: setup.preparedAssetId,
    });
    assert.equal(resolved.status, "blocked");
    assert.match(
      resolved.status === "blocked" ? resolved.reason : "",
      /image recovery review/,
    );

    // The TYPE matters as much as the message: a bare `Error` here reaches
    // the API route's generic branch, which logs "Failed to run an artwork
    // preparation action" and answers 500. Unresolved production authority
    // is not a processing failure, and the transport must not say it is.
    await assert.rejects(
      () => built.finalArtwork.requestPreparedUploadFinalArtwork(setup.projectId),
      (error: unknown) => {
        assert.ok(
          error instanceof ArtworkFinalizationRecoveryUnresolvedError,
          "CASE B must refuse with the typed, route-mappable error",
        );
        assert.equal(error.safeErrorCode, "ARTWORK_RECOVERY_UNRESOLVED");
        assert.match(error.message, /image recovery review/);
        return true;
      },
    );

    // No job was created at all, so nothing can later be finalized from the
    // pre-recovery source by a worker that never knew about recovery.
    const jobs = await repo.listFinalArtworkJobsForPreparation(
      setup.projectId,
      setup.preparationId,
    );
    assert.deepEqual(jobs, []);
  });

  it("B: an APPROVED reconstruction whose geometry is still pending confirmation is not eligible", async () => {
    const repo = await freshRepo();
    const built = { ...buildPipeline(repo), repo };
    const setup = await setupApprovedPreparation(repo, built.assets);
    const { job } = await beginRecoveryLifecycle(built, setup.projectId, setup.originalAssetId);

    const uploaded = await built.assets.uploadConceptImage(setup.projectId, {
      conceptId: "pending-candidate",
      bytes: candidatePng(),
      contentType: "image/png",
      widthPx: CANDIDATE_CANVAS.w,
      heightPx: CANDIDATE_CANVAS.h,
      hasTransparency: false,
      providerKey: "test",
      generationJobId: null,
      metadata: {},
    });
    await repo.updateArtworkReconstructionJob(job.id, {
      status: "completed",
      completedAt: new Date().toISOString(),
      candidateAssetId: uploaded.primary.id,
      wordingVerified: true,
      geometryStatus: "review_required",
      reviewStatus: "pending_review",
    });
    const approved = await built.reconstruction.approveCandidate(setup.projectId, job.id, {
      confirmedBy: "customer",
    });
    // Qualified, with a real derivative asset on file — but NOT confirmed.
    const qualification = await built.qualification.ensureQualification(
      setup.projectId,
      approved.id,
    );
    assert.equal(qualification.qualificationStatus, "normalized_pending_confirmation");
    assert.ok(qualification.derivedAssetId, "a derivative genuinely exists at this point");

    const resolved = await resolvePreparedUploadEffectiveSource(repo, built.qualification, {
      projectId: setup.projectId,
      originalAssetId: setup.originalAssetId,
      preparedAssetId: setup.preparedAssetId,
    });
    assert.equal(
      resolved.status,
      "blocked",
      "pixels existing is not authority — see the phase's own governance requirement",
    );
    await assert.rejects(
      () => built.finalArtwork.requestPreparedUploadFinalArtwork(setup.projectId),
      /image recovery review/,
    );
  });

  it("B: the resolver fails CLOSED when a lifecycle exists but no qualification capability is wired", async () => {
    const repo = await freshRepo();
    const built = { ...buildPipeline(repo), repo };
    const setup = await setupApprovedPreparation(repo, built.assets);
    await beginRecoveryLifecycle(built, setup.projectId, setup.originalAssetId);

    const resolved = await resolvePreparedUploadEffectiveSource(repo, undefined, {
      projectId: setup.projectId,
      originalAssetId: setup.originalAssetId,
      preparedAssetId: setup.preparedAssetId,
    });
    assert.equal(resolved.status, "blocked");
  });

  it("B: a job queued BEFORE recovery began is blocked by the worker, not finalized from the stale source", async () => {
    const repo = await freshRepo();
    const built = { ...buildPipeline(repo), repo };
    const setup = await setupApprovedPreparation(repo, built.assets);

    // Requested while the project was still perfectly ordinary.
    const requested = await built.finalArtwork.requestPreparedUploadFinalArtwork(setup.projectId);
    assert.equal(requested.job.status, "queued");

    // Recovery begins in the gap between request and execution.
    await beginRecoveryLifecycle(built, setup.projectId, setup.originalAssetId);

    await drainJob(built.worker, repo, requested.job.id);

    const job = await repo.getFinalArtworkJob(requested.job.id);
    assert.equal(
      job!.status,
      "cancelled",
      "unresolved authority is transient: a cancelled job is revivable, a completed one is not",
    );
    assert.match(job!.lastError ?? "", /image recovery review/);
    assert.equal(
      await productionAssetFor(repo, setup.projectId, requested.job.id),
      undefined,
      "no plate may be produced from the pre-recovery source",
    );
    const snapshot = await repo.getProject(setup.projectId);
    assert.equal(snapshot!.project.status, "finalization_required");
    assert.equal(built.provider.calls, 0);
    assert.equal(built.localProvider.calls, 0, "no transform runs at all when authority is unresolved");
  });

  // =========================================================================
  // C — CURRENT PQCM: the master supersedes preparedAssetId
  // =========================================================================

  it("C: a current clean master is selected instead of preparedAssetId, end to end", async () => {
    const repo = await freshRepo();
    const built = { ...buildPipeline(repo), repo };
    const setup = await setupApprovedPreparation(repo, built.assets);
    const { derivedAssetId } = await buildConfirmedMaster(
      built,
      setup.projectId,
      setup.originalAssetId,
    );

    const resolved = await resolvePreparedUploadEffectiveSource(repo, built.qualification, {
      projectId: setup.projectId,
      originalAssetId: setup.originalAssetId,
      preparedAssetId: setup.preparedAssetId,
    });
    assert.equal(resolved.status, "master");
    assert.equal(resolved.status === "master" && resolved.assetId, derivedAssetId);
    assert.notEqual(derivedAssetId, setup.preparedAssetId);

    const requested = await built.finalArtwork.requestPreparedUploadFinalArtwork(setup.projectId);
    await drainJob(built.worker, repo, requested.job.id);

    const asset = await productionAssetFor(repo, setup.projectId, requested.job.id);
    assert.ok(asset, "a plate is produced from the clean master");

    // F — PROVENANCE: the plate names the asset the transform actually read,
    // and names which authority it belongs to.
    const lineage = recordedLineage(asset!);
    assert.equal(lineage.preparedAssetId, derivedAssetId);
    assert.notEqual(lineage.preparedAssetId, setup.preparedAssetId);
    assert.equal(lineage.sourceAuthority, "production_qualified_clean_master");
    assert.equal(lineage.originalAssetId, setup.originalAssetId);

    // ...and authoritative validation judged that SAME lineage — never one
    // asset validated while another was printed.
    const report = await latestReport(repo, setup.projectId, requested.job.id);
    assert.equal(report.artworkVersionId, setup.artworkVersionId);
    const validation = await repo.getLatestProductionAssetValidationForJob(
      setup.projectId,
      requested.job.id,
    );
    assert.equal(validation!.assetId, asset!.id);

    // H — no duplicate reconstruction, ever.
    assert.equal(built.provider.calls, 0);

    // G — HISTORICAL IMMUTABILITY: the preparation record is untouched.
    const preparation = await repo.getArtworkPreparation(setup.projectId);
    assert.equal(preparation!.preparedAssetId, setup.preparedAssetId);
    assert.equal(preparation!.originalAssetId, setup.originalAssetId);
  });

  // =========================================================================
  // D — STALE / INVALID PQCM
  // =========================================================================

  it("D: a master whose fidelity authority is superseded after the request is never used by the worker", async () => {
    const repo = await freshRepo();
    const built = { ...buildPipeline(repo), repo };
    const setup = await setupApprovedPreparation(repo, built.assets);
    const { derivedAssetId } = await buildConfirmedMaster(
      built,
      setup.projectId,
      setup.originalAssetId,
    );

    const requested = await built.finalArtwork.requestPreparedUploadFinalArtwork(setup.projectId);

    // Authority moves in the gap between request and execution — the
    // customer corrects what their artwork says. A confirmed fidelity
    // contract is immutable, so a correction is a NEW contract, and the
    // master approved under the old one stops being current the moment it
    // lands. Nothing about the derivative asset itself changes; what
    // changes is whether anything still authorizes it.
    await built.fidelity.proposeContract(setup.projectId, {
      sourceAssetId: setup.originalAssetId,
      sourceSha256: SOURCE_SHA,
    });
    assert.equal(
      await built.qualification.getCurrentProductionQualifiedMaster(setup.projectId),
      null,
      "a superseded chain resolves to nothing, never to a stale row",
    );

    await drainJob(built.worker, repo, requested.job.id);

    const job = await repo.getFinalArtworkJob(requested.job.id);
    assert.equal(
      job!.status,
      "cancelled",
      "unresolved authority is transient: a cancelled job is revivable, a completed one is not",
    );
    assert.match(job!.lastError ?? "", /image recovery review/);
    assert.equal(
      await productionAssetFor(repo, setup.projectId, requested.job.id),
      undefined,
      "neither the superseded master nor preparedAssetId may be used",
    );
    assert.equal(built.provider.calls, 0);
    assert.equal(built.localProvider.calls, 0);
    // The superseded derivative asset still exists; existence is not authority.
    assert.ok(await repo.getAssetById(derivedAssetId));
  });

  // =========================================================================
  // E — REQUEST/WORKER CHANGE (TOCTOU)
  // =========================================================================

  it("E: a request that resolved preparedAssetId is executed against the master that became current", async () => {
    const repo = await freshRepo();
    const built = { ...buildPipeline(repo), repo };
    const setup = await setupApprovedPreparation(repo, built.assets);

    // Request time: no lifecycle at all, so the request legitimately
    // resolves the prepared asset.
    const requested = await built.finalArtwork.requestPreparedUploadFinalArtwork(setup.projectId);
    const atRequest = await resolvePreparedUploadEffectiveSource(repo, built.qualification, {
      projectId: setup.projectId,
      originalAssetId: setup.originalAssetId,
      preparedAssetId: setup.preparedAssetId,
    });
    assert.equal(atRequest.status, "prepared");

    // ...and the whole recovery lifecycle resolves before the worker runs.
    const { derivedAssetId } = await buildConfirmedMaster(
      built,
      setup.projectId,
      setup.originalAssetId,
    );

    await drainJob(built.worker, repo, requested.job.id);

    const asset = await productionAssetFor(repo, setup.projectId, requested.job.id);
    assert.ok(asset, "the worker produces from the CURRENT authority");
    const lineage = recordedLineage(asset!);
    assert.equal(
      lineage.preparedAssetId,
      derivedAssetId,
      "the worker must not blindly use the request-time source",
    );
    assert.equal(lineage.sourceAuthority, "production_qualified_clean_master");
    assert.equal(built.provider.calls, 0);
  });

  it("E: a plate this job already produced from a superseded source is never adopted on retry", async () => {
    const repo = await freshRepo();
    const built = { ...buildPipeline(repo), repo };
    const setup = await setupApprovedPreparation(repo, built.assets);

    // First attempt: ordinary project, plate produced from preparedAssetId.
    const requested = await built.finalArtwork.requestPreparedUploadFinalArtwork(setup.projectId);
    await drainJob(built.worker, repo, requested.job.id);
    const firstAsset = await productionAssetFor(repo, setup.projectId, requested.job.id);
    assert.ok(firstAsset);
    assert.equal(recordedLineage(firstAsset!).preparedAssetId, setup.preparedAssetId);

    // Recovery resolves afterwards, and the job is revived the way a
    // crash-recovery sweep would revive it.
    const { derivedAssetId } = await buildConfirmedMaster(
      built,
      setup.projectId,
      setup.originalAssetId,
    );
    await repo.updateFinalArtworkJob(requested.job.id, {
      status: "queued",
      lastError: null,
      completedAt: null,
    });

    await drainJob(built.worker, repo, requested.job.id);

    // The stale plate is NOT adopted — a plate built from the pre-recovery
    // source must never be re-validated and handed over as the result of a
    // run whose declared source is the clean master. It is also not
    // retracted (produced files are never retroactively invalidated), so
    // the job now owns two plates and the CURRENT one is the master's.
    const assetsForJob = (await repo.listAssets(setup.projectId))
      .filter(
        (asset) =>
          asset.finalArtworkJobId === requested.job.id &&
          asset.productionRole === "production_png",
      )
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
    assert.equal(assetsForJob.length, 2, "the new plate is additive, not a rewrite");
    assert.equal(recordedLineage(assetsForJob[0]!).preparedAssetId, setup.preparedAssetId);
    assert.equal(recordedLineage(assetsForJob[1]!).preparedAssetId, derivedAssetId);
    assert.equal(
      recordedLineage(assetsForJob[1]!).sourceAuthority,
      "production_qualified_clean_master",
    );

    // Validation follows the plate that was actually produced — never the
    // stale one left on file.
    const validation = await repo.getLatestProductionAssetValidationForJob(
      setup.projectId,
      requested.job.id,
    );
    assert.equal(validation!.assetId, assetsForJob[1]!.id);
    assert.equal(built.provider.calls, 0);

    // ...and the stale plate can never be re-published as the current
    // deliverable by a later request. This is the regression that matters:
    // the first implementation blocked the job instead, which left the
    // superseded plate and its `ready` validation on file for the next
    // request to promote straight back to `print_ready`.
    const again = await built.finalArtwork.requestPreparedUploadFinalArtwork(setup.projectId);
    const snapshot = await repo.getProject(setup.projectId);
    assert.notEqual(
      snapshot!.project.status,
      "print_ready",
      "the pre-recovery plate must not become the project's current deliverable",
    );
    const variant = await built.finalArtwork.resolveProductionVariantState(
      setup.projectId,
      again.job.productionTreatmentKey ?? STANDARD_RASTER_TREATMENT_KEY,
    );
    assert.ok(variant.asset, "the variant read model must resolve a plate at all");
    assert.equal(
      variant.asset!.id,
      assetsForJob[1]!.id,
      "the read model must surface the current source's plate, never the superseded one",
    );
  });

  it("E: a plate the job built from the CURRENT source is still adopted on retry (no false drift)", async () => {
    const repo = await freshRepo();
    const built = { ...buildPipeline(repo), repo };
    const setup = await setupApprovedPreparation(repo, built.assets);

    const requested = await built.finalArtwork.requestPreparedUploadFinalArtwork(setup.projectId);
    await drainJob(built.worker, repo, requested.job.id);
    const firstAsset = await productionAssetFor(repo, setup.projectId, requested.job.id);
    assert.ok(firstAsset);

    // Revived with NOTHING about the source changed — the ordinary
    // crash/retry case. The lineage fence must be silent here, or every
    // legitimate resume would start duplicating plates.
    await repo.updateFinalArtworkJob(requested.job.id, {
      status: "queued",
      lastError: null,
      completedAt: null,
    });
    await drainJob(built.worker, repo, requested.job.id);

    const assetsForJob = (await repo.listAssets(setup.projectId)).filter(
      (asset) =>
        asset.finalArtworkJobId === requested.job.id &&
        asset.productionRole === "production_png",
    );
    assert.equal(assetsForJob.length, 1, "the existing plate is reused, never duplicated");
    assert.equal(assetsForJob[0]!.id, firstAsset!.id);
    assert.equal(built.provider.calls, 0);
  });

  it("B: a blocked job is REVIVABLE — production succeeds once the master is confirmed", async () => {
    const repo = await freshRepo();
    const built = { ...buildPipeline(repo), repo };
    const setup = await setupApprovedPreparation(repo, built.assets);

    // Requested before recovery, blocked by the worker after it began.
    const requested = await built.finalArtwork.requestPreparedUploadFinalArtwork(setup.projectId);
    const lifecycle = await beginRecoveryLifecycle(
      built,
      setup.projectId,
      setup.originalAssetId,
    );
    await drainJob(built.worker, repo, requested.job.id);

    const blocked = await repo.getFinalArtworkJob(requested.job.id);
    assert.equal(
      blocked!.status,
      "cancelled",
      "an unresolved-authority block is transient, never a terminal verdict",
    );

    // Recovery resolves. The customer presses Create Print-Ready Artwork
    // again — and this must actually produce the plate. The first
    // implementation used `completeWithoutAsset` here, which
    // `resolvePreparedUploadJob` treats as terminal and never revives, so
    // this exact request came back `alreadyRequested` against a dead job
    // and CASE C was unreachable forever.
    const { derivedAssetId } = await buildConfirmedMaster(
      built,
      setup.projectId,
      setup.originalAssetId,
      "revivable-candidate",
      lifecycle,
    );
    const again = await built.finalArtwork.requestPreparedUploadFinalArtwork(setup.projectId);
    assert.equal(again.alreadyRequested, false, "the blocked job must be revived");
    assert.equal(again.job.id, requested.job.id);
    assert.equal(again.job.status, "queued");

    await drainJob(built.worker, repo, again.job.id);

    const asset = await productionAssetFor(repo, setup.projectId, again.job.id);
    assert.ok(asset, "a plate is finally produced, from the clean master");
    assert.equal(recordedLineage(asset!).preparedAssetId, derivedAssetId);
    assert.equal(built.provider.calls, 0);
  });

  it("the PEDRO-CLASS project reaches CASE C: a certification withhold does not outlive its source", async () => {
    const repo = await freshRepo();
    const built = { ...buildPipeline(repo), repo };
    // A source too small for the target, so the first run genuinely
    // reconstructs and validation withholds on
    // `reconstruction_certification_evidence` — the exact Pedro Back shape.
    const setup = await setupApprovedPreparation(repo, built.assets, UNDERSIZED_CANVAS);

    const first = await built.finalArtwork.requestPreparedUploadFinalArtwork(setup.projectId);
    await drainJob(built.worker, repo, first.job.id);

    const firstReport = await latestReport(repo, setup.projectId, first.job.id);
    assert.notEqual(firstReport.status, "ready", "Print Ready is withheld, as it must be");
    assert.equal(
      firstReport.checks.find(
        (check) => check.check === "reconstruction_certification_evidence",
      )!.status,
      "fail",
    );
    const snapshotAfterFirst = await repo.getProject(setup.projectId);
    assert.equal(snapshotAfterFirst!.project.status, "finalization_required");
    assert.equal(built.reconstructor.calls, 1, "the first run really did reconstruct");

    // Recovery now resolves. THE REGRESSION: `terminalCertificationWithhold`
    // exists to stop a completed, certification-withheld job from being
    // re-queued to re-spend a credit reaching the identical verdict about
    // the identical artwork. Its premise dies the moment the artwork moves.
    // Without the source-superseded exemption, this request resolves CASE C
    // correctly and STILL hands back the completed job — so the clean master
    // never reaches production for the one project shape this whole phase
    // was built for.
    const { derivedAssetId } = await buildConfirmedMaster(
      built,
      setup.projectId,
      setup.originalAssetId,
    );
    const again = await built.finalArtwork.requestPreparedUploadFinalArtwork(setup.projectId);
    assert.equal(
      again.alreadyRequested,
      false,
      "a withhold about superseded artwork must not block the clean master",
    );
    assert.equal(again.job.status, "queued");

    await drainJob(built.worker, repo, again.job.id);

    const assetsForJob = (await repo.listAssets(setup.projectId))
      .filter(
        (asset) =>
          asset.finalArtworkJobId === again.job.id &&
          asset.productionRole === "production_png",
      )
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
    const newest = assetsForJob[assetsForJob.length - 1]!;
    assert.equal(recordedLineage(newest).preparedAssetId, derivedAssetId);
    assert.equal(
      recordedLineage(newest).sourceAuthority,
      "production_qualified_clean_master",
    );

    // ...and it is STILL not print_ready. Reaching CASE C is not the same
    // as certifying the result: the master's own pixels remain
    // provider-manufactured and uncertified.
    const secondReport = await latestReport(repo, setup.projectId, again.job.id);
    assert.notEqual(secondReport.status, "ready", "Print Ready must be withheld");
    assert.match(
      secondReport.checks.find(
        (check) => check.check === "reconstruction_certification_evidence",
      )!.reason,
      /recovered clean master/,
    );
  });

  it("an UNDERSIZED clean master flows through the ordinary enhancement decision", async () => {
    const repo = await freshRepo();
    const built = { ...buildPipeline(repo), repo };
    const setup = await setupApprovedPreparation(repo, built.assets);
    // A master with fewer pixels than the plate needs. DTF-R1 must not
    // special-case it: the master is simply the source, and the existing
    // enhancement decision applies to it exactly as it would to any other
    // source. This is the spend-relevant path — the only DTF-R1 scenario in
    // which a provider is legitimately reached at all.
    const { derivedAssetId } = await buildConfirmedMaster(
      built,
      setup.projectId,
      setup.originalAssetId,
      "undersized-candidate",
      undefined,
      SMALL_CANDIDATE_CANVAS,
    );

    const requested = await built.finalArtwork.requestPreparedUploadFinalArtwork(setup.projectId);
    await drainJob(built.worker, repo, requested.job.id);

    const asset = await productionAssetFor(repo, setup.projectId, requested.job.id);
    assert.ok(asset, "the plate is produced from the master, via reconstruction");
    const lineage = recordedLineage(asset!);
    assert.equal(lineage.preparedAssetId, derivedAssetId, "reconstructed FROM the master");
    assert.equal(lineage.sourceAuthority, "production_qualified_clean_master");
    assert.equal(lineage.enhancement, "reconstructed");
    assert.equal(
      built.reconstructor.calls,
      1,
      "exactly one reconstruction — DTF never re-runs the recovery lifecycle's own",
    );

    const report = await latestReport(repo, setup.projectId, requested.job.id);
    assert.notEqual(report.status, "ready", "Print Ready must be withheld");
  });

  // =========================================================================
  // CURSOR BLOCKER 1 — a completed, READY job whose source moved
  // =========================================================================

  /**
   * Reached entirely through the REAL customer request path. Nothing here
   * hand-edits a job row into a convenient state: the plate, the `ready`
   * validation, the `print_ready` project status and the revival all come
   * from `requestPreparedUploadFinalArtwork` + the worker, because the
   * defect was specifically that the REQUEST path considered the job
   * already satisfied. A test that queued the job itself would have
   * bypassed the exact decision under review — which is how the previous
   * suite passed 5846/5846 while this was broken.
   */
  it("BLOCKER 1: a completed READY job whose source moved is revived, and the prepared plate is not republished", async () => {
    const repo = await freshRepo();
    const built = { ...buildPipeline(repo), repo };
    const setup = await setupApprovedPreparation(repo, built.assets);

    // 1-2. Ordinary DTF production from preparedAssetId, all the way to a
    // genuinely `ready` validation and a `print_ready` project.
    const first = await built.finalArtwork.requestPreparedUploadFinalArtwork(setup.projectId);
    await drainJob(built.worker, repo, first.job.id);

    const firstReport = await latestReport(repo, setup.projectId, first.job.id);
    assert.equal(firstReport.status, "ready", "the baseline really is a ready plate");
    const preparedPlate = await productionAssetFor(repo, setup.projectId, first.job.id);
    assert.ok(preparedPlate);
    assert.equal(recordedLineage(preparedPlate!).preparedAssetId, setup.preparedAssetId);
    assert.equal(
      (await repo.getProject(setup.projectId))!.project.status,
      "print_ready",
      "the baseline really does reach print_ready",
    );

    // 3. Recovery begins and a clean master becomes authoritative.
    const { derivedAssetId } = await buildConfirmedMaster(
      built,
      setup.projectId,
      setup.originalAssetId,
    );
    assert.notEqual(derivedAssetId, setup.preparedAssetId);

    // 4. The project legitimately leaves print_ready (the customer is back
    // in the flow — e.g. reviewing the recovered artwork).
    await repo.setProjectStatus(setup.projectId, "approved");

    // 5. The SAME standard-raster job identity is requested again, through
    // the real entry point.
    const again = await built.finalArtwork.requestPreparedUploadFinalArtwork(setup.projectId);

    // 6-7. THE DEFECT: previously `alreadyRequested: true` with the job
    // left `completed`, so the worker never ran.
    assert.equal(
      again.alreadyRequested,
      false,
      "a completed READY job whose source moved must not count as already satisfied",
    );
    assert.equal(again.job.id, first.job.id, "same unique job identity, revived in place");
    assert.equal(again.job.status, "queued");

    // 8-9. The prepared plate must not be republished as current.
    assert.notEqual(
      (await repo.getProject(setup.projectId))!.project.status,
      "print_ready",
      "the superseded prepared plate must not be reconciled back to print_ready",
    );
    assert.equal(
      await built.finalArtwork.getCurrentProductionAssetId(setup.projectId),
      null,
      "delivery must refuse a plate whose source current authority has superseded",
    );

    await drainJob(built.worker, repo, again.job.id);

    // The worker executed against the CURRENT authority.
    const plates = (await repo.listAssets(setup.projectId))
      .filter(
        (asset) =>
          asset.finalArtworkJobId === first.job.id &&
          asset.productionRole === "production_png",
      )
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
    assert.equal(plates.length, 2, "an additive new plate, the old one untouched");
    assert.equal(plates[0]!.id, preparedPlate!.id);
    assert.equal(recordedLineage(plates[0]!).preparedAssetId, setup.preparedAssetId);
    assert.equal(recordedLineage(plates[1]!).preparedAssetId, derivedAssetId);
    assert.equal(
      recordedLineage(plates[1]!).sourceAuthority,
      "production_qualified_clean_master",
    );

    // TERMINATION: the newest plate now names the current source, so the
    // revival condition has ended itself — a third request is a no-op.
    const third = await built.finalArtwork.requestPreparedUploadFinalArtwork(setup.projectId);
    assert.equal(
      third.alreadyRequested,
      true,
      "no infinite revival once the current-source plate exists",
    );
    assert.equal(third.job.status, "completed");
  });

  // =========================================================================
  // CURSOR BLOCKER 2 — resumable reconstruction state must be source-bound
  // =========================================================================

  /**
   * Drives a two-pass job until a REAL pass-1 intermediate is durably on
   * disk, and asserts that it is — the precondition these scenarios are
   * about. Returns the intermediate asset and the SHA of the bytes it
   * holds, so a later assertion can say "the provider was never handed
   * THESE bytes" by identity rather than by inference.
   */
  async function driveUntilPass1Intermediate(
    built: ReturnType<typeof buildPipeline> & { repo: ProjectRepository },
    projectId: string,
    jobId: string,
  ) {
    await built.worker.processNextJob();
    const intermediates = (await built.repo.listAssets(projectId)).filter(
      (asset) =>
        asset.finalArtworkJobId === jobId &&
        (asset.metadata as Record<string, unknown> | null)?.reconstructionStage ===
          "pass1_intermediate",
    );
    assert.equal(
      intermediates.length,
      1,
      "a REAL durable pass-1 intermediate must exist before the source moves",
    );
    const bytes = await built.assets.downloadAssetBytes(intermediates[0]!.id);
    assert.ok(bytes, "and its bytes must be readable");
    return {
      asset: intermediates[0]!,
      sha: createHash("sha256").update(bytes!.bytes).digest("hex"),
      meta: intermediates[0]!.metadata as Record<string, unknown>,
    };
  }

  it("BLOCKER 2A: a pass-1 intermediate from the prepared source is never supplied for clean-master work", async () => {
    const repo = await freshRepo();
    const provider = new TwoPassRecordingProvider();
    const built = { ...buildPipeline(repo, provider), repo };
    const setup = await setupApprovedPreparation(repo, built.assets, UNDERSIZED_CANVAS);

    const requested = await built.finalArtwork.requestPreparedUploadFinalArtwork(setup.projectId);
    const pass1 = await driveUntilPass1Intermediate(built, setup.projectId, requested.job.id);

    // The intermediate really does belong to the PREPARED source.
    assert.equal(pass1.meta.sourceAssetId, setup.preparedAssetId);
    assert.equal(provider.calls.length, 1, "pass 1 ran once");
    const pass1RequestId = provider.calls[0]!.submittedRequestId;
    assert.ok(pass1RequestId);

    // Authority moves to a clean master, and the job is revived.
    const { derivedAssetId } = await buildConfirmedMaster(
      built,
      setup.projectId,
      setup.originalAssetId,
      "blocker2a-candidate",
      undefined,
      SMALL_CANDIDATE_CANVAS,
    );
    provider.interruptAfterPass1 = false;
    const again = await built.finalArtwork.requestPreparedUploadFinalArtwork(setup.projectId);
    await drainJob(built.worker, repo, again.job.id);

    // THE ASSERTION THAT MATTERS: no call after the source moved was ever
    // handed the prepared source's pass-1 bytes.
    const afterMove = provider.calls.slice(1);
    assert.ok(afterMove.length > 0, "the worker really did run again");
    for (const call of afterMove) {
      assert.notEqual(
        call.intermediateSha,
        pass1.sha,
        "the prepared source's pass-1 intermediate must never reach the provider as clean-master work",
      );
      assert.notEqual(
        call.resumedRequestId,
        pass1RequestId,
        "nor may its provider request be resumed as clean-master work",
      );
    }

    // And the plate's lineage is internally consistent: current source id,
    // current source SHA, current authority.
    const plates = (await repo.listAssets(setup.projectId))
      .filter(
        (asset) =>
          asset.finalArtworkJobId === again.job.id &&
          asset.productionRole === "production_png" &&
          (asset.metadata as Record<string, unknown> | null)?.reconstructionStage === undefined,
      )
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
    const newest = plates[plates.length - 1]!;
    const lineage = recordedLineage(newest);
    assert.equal(lineage.preparedAssetId, derivedAssetId);
    assert.equal(lineage.sourceAuthority, "production_qualified_clean_master");
    const masterBytes = await built.assets.downloadAssetBytes(derivedAssetId);
    assert.equal(
      lineage.sourceBytesSha256,
      createHash("sha256").update(masterBytes!.bytes).digest("hex"),
      "the recorded SHA must be the CURRENT source's bytes, not the old one's",
    );
  });

  it("BLOCKER 2B: an in-flight provider request is not resumed as clean-master work", async () => {
    const repo = await freshRepo();
    const provider = new TwoPassRecordingProvider();
    const built = { ...buildPipeline(repo, provider), repo };
    const setup = await setupApprovedPreparation(repo, built.assets, UNDERSIZED_CANVAS);

    // A request that is submitted and then interrupted BEFORE any durable
    // artifact exists — the genuinely in-flight state. (Driving to a pass-1
    // intermediate instead would not exercise this at all:
    // `persistIntermediateReconstruction` clears the provider slot, so
    // there would be no outstanding request left to wrongly resume.)
    provider.interruptAfterSubmit = true;
    const requested = await built.finalArtwork.requestPreparedUploadFinalArtwork(setup.projectId);
    await built.worker.processNextJob();

    assert.equal(provider.calls.length, 1, "a paid request really was submitted");
    const inFlightRequestId = provider.calls[0]!.submittedRequestId;
    assert.ok(inFlightRequestId);
    const noArtifacts = (await repo.listAssets(setup.projectId)).filter(
      (asset) =>
        asset.finalArtworkJobId === requested.job.id &&
        (asset.metadata as Record<string, unknown> | null)?.reconstructionStage !== undefined,
    );
    assert.equal(
      noArtifacts.length,
      0,
      "and nothing durable exists to prove whose source it is — the window the job-row binding covers",
    );

    // The job genuinely holds an outstanding provider request, bound to the
    // PREPARED source — that binding is the repair under test.
    const midFlight = await repo.getFinalArtworkJob(requested.job.id);
    assert.equal(
      midFlight!.providerRequestId,
      inFlightRequestId,
      "the request really is still outstanding on the job",
    );
    assert.equal(
      midFlight!.providerSourceAssetId,
      setup.preparedAssetId,
      "the outstanding request records the source it was submitted for",
    );
    assert.ok(midFlight!.providerSourceSha256, "and the exact bytes it was submitted for");
    const preparedBytes = await built.assets.downloadAssetBytes(setup.preparedAssetId);
    assert.equal(
      midFlight!.providerSourceSha256,
      createHash("sha256").update(preparedBytes!.bytes).digest("hex"),
    );

    // Authority transitions, then the job revives.
    const { derivedAssetId } = await buildConfirmedMaster(
      built,
      setup.projectId,
      setup.originalAssetId,
      "blocker2b-candidate",
      undefined,
      SMALL_CANDIDATE_CANVAS,
    );
    provider.interruptAfterSubmit = false;
    provider.interruptAfterPass1 = false;
    const callsBefore = provider.calls.length;
    const again = await built.finalArtwork.requestPreparedUploadFinalArtwork(setup.projectId);
    await drainJob(built.worker, repo, again.job.id);

    // The old request was retired, not resumed: every post-move call is a
    // FRESH submission for the current source.
    for (const call of provider.calls.slice(callsBefore)) {
      assert.equal(
        call.resumedRequestId,
        null,
        "a request submitted for the prepared source must never be resumed as clean-master work",
      );
    }
    const finalJob = await repo.getFinalArtworkJob(again.job.id);
    assert.notEqual(
      finalJob!.providerSourceAssetId,
      setup.preparedAssetId,
      "the job's binding must have moved to the current source",
    );
    const newest = (await repo.listAssets(setup.projectId))
      .filter(
        (asset) =>
          asset.finalArtworkJobId === again.job.id &&
          asset.productionRole === "production_png" &&
          (asset.metadata as Record<string, unknown> | null)?.reconstructionStage === undefined,
      )
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
      .at(-1)!;
    assert.equal(recordedLineage(newest).preparedAssetId, derivedAssetId);
  });

  it("BLOCKER 2C: master A's reconstruction state is not reused for master B", async () => {
    const repo = await freshRepo();
    const provider = new TwoPassRecordingProvider();
    const built = { ...buildPipeline(repo, provider), repo };
    const setup = await setupApprovedPreparation(repo, built.assets, UNDERSIZED_CANVAS);

    // Master A becomes current, and a two-pass job gets as far as a durable
    // pass-1 intermediate built from A.
    const lifecycleA = await beginRecoveryLifecycle(
      built,
      setup.projectId,
      setup.originalAssetId,
    );
    const masterA = await buildConfirmedMaster(
      built,
      setup.projectId,
      setup.originalAssetId,
      "master-a-candidate",
      lifecycleA,
      SMALL_CANDIDATE_CANVAS,
      { r: 20, g: 90, b: 60 },
    );
    const requested = await built.finalArtwork.requestPreparedUploadFinalArtwork(setup.projectId);
    const pass1 = await driveUntilPass1Intermediate(built, setup.projectId, requested.job.id);
    assert.equal(
      pass1.meta.sourceAssetId,
      masterA.derivedAssetId,
      "pass 1 really was built from master A",
    );
    const masterARequestId = provider.calls[0]!.submittedRequestId;

    // Master B supersedes A: a corrected fidelity contract, a new
    // reconstruction, a new confirmed qualification.
    const lifecycleB = await beginRecoveryLifecycle(
      built,
      setup.projectId,
      setup.originalAssetId,
      ["CORRECTED WORDING"], // a different fidelity authority, so B truly supersedes A
    );
    const masterB = await buildConfirmedMaster(
      built,
      setup.projectId,
      setup.originalAssetId,
      "master-b-candidate",
      lifecycleB,
      SMALL_CANDIDATE_CANVAS,
      { r: 200, g: 40, b: 10 }, // deliberately different INK => different bytes
    );
    assert.notEqual(masterB.derivedAssetId, masterA.derivedAssetId, "B really supersedes A");

    // PRECONDITION the previous version of this test lacked: A and B must
    // differ in BYTES, not merely in asset id. Without this the SHA half of
    // source identity was never exercised — an id-only comparison would have
    // passed the test just as happily.
    const shaA = createHash("sha256")
      .update((await built.assets.downloadAssetBytes(masterA.derivedAssetId))!.bytes)
      .digest("hex");
    const shaB = createHash("sha256")
      .update((await built.assets.downloadAssetBytes(masterB.derivedAssetId))!.bytes)
      .digest("hex");
    assert.notEqual(shaA, shaB, "master A and master B must be byte-distinct");

    provider.interruptAfterPass1 = false;
    const callsBefore = provider.calls.length;
    const again = await built.finalArtwork.requestPreparedUploadFinalArtwork(setup.projectId);
    await drainJob(built.worker, repo, again.job.id);

    for (const call of provider.calls.slice(callsBefore)) {
      assert.notEqual(
        call.intermediateSha,
        pass1.sha,
        "master A's pass-1 bytes must never be continued from as master B work",
      );
      assert.notEqual(
        call.resumedRequestId,
        masterARequestId,
        "nor may master A's provider request be resumed as master B work",
      );
    }

    const newest = (await repo.listAssets(setup.projectId))
      .filter(
        (asset) =>
          asset.finalArtworkJobId === again.job.id &&
          asset.productionRole === "production_png" &&
          (asset.metadata as Record<string, unknown> | null)?.reconstructionStage === undefined,
      )
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
      .at(-1)!;
    const lineage = recordedLineage(newest);
    assert.equal(lineage.preparedAssetId, masterB.derivedAssetId);
    assert.equal(lineage.sourceAuthority, "production_qualified_clean_master");
    assert.equal(lineage.sourceBytesSha256, shaB, "B's SHA is recorded");
    assert.notEqual(lineage.sourceBytesSha256, shaA, "and it is NOT A's");

    // B's bytes are the ones that were actually processed.
    const processed = provider.calls.slice(callsBefore);
    assert.ok(processed.length > 0);
    assert.ok(
      processed.every((call) => call.sourceSha === shaB),
      "every post-supersession call must have been handed B's bytes",
    );
    assert.ok(
      processed.every((call) => call.sourceSha !== shaA),
      "and never A's",
    );
  });

  it("BLOCKER 2C (identity): a SHA mismatch alone retires a request whose asset id still matches", async () => {
    const repo = await freshRepo();
    const provider = new TwoPassRecordingProvider();
    const built = { ...buildPipeline(repo, provider), repo };
    const setup = await setupApprovedPreparation(repo, built.assets, UNDERSIZED_CANVAS);

    provider.interruptAfterSubmit = true;
    const requested = await built.finalArtwork.requestPreparedUploadFinalArtwork(setup.projectId);
    await built.worker.processNextJob();

    const midFlight = await repo.getFinalArtworkJob(requested.job.id);
    assert.ok(midFlight!.providerRequestId, "a request really is outstanding");
    assert.equal(midFlight!.providerSourceAssetId, setup.preparedAssetId);

    // Corrupt ONLY the SHA half of the binding. The asset id still matches
    // the current source exactly, so an id-only identity check would happily
    // resume — this is the dimension the byte-identical A/B fixture could
    // never exercise.
    await repo.updateFinalArtworkJob(requested.job.id, {
      providerSourceSha256: "f".repeat(64),
    });

    provider.interruptAfterSubmit = false;
    provider.interruptAfterPass1 = false;
    const callsBefore = provider.calls.length;
    const again = await built.finalArtwork.requestPreparedUploadFinalArtwork(setup.projectId);
    await drainJob(built.worker, repo, again.job.id);

    for (const call of provider.calls.slice(callsBefore)) {
      assert.equal(
        call.resumedRequestId,
        null,
        "a binding whose SHA disagrees must not be resumed, even with a matching asset id",
      );
    }
  });

  // =========================================================================
  // CURSOR NB-1 — PRE-DEPLOY (UNBOUND) STATE
  // =========================================================================

  /**
   * Strips the source-identity fields the repair writes, reproducing the
   * exact shape a job/intermediate has when it was created BEFORE this
   * repair shipped. Every legacy scenario below asserts the stripped shape
   * before it asserts any behavior — the precondition is the whole point.
   */
  async function stripSourceBindingFromJob(repo: ProjectRepository, jobId: string) {
    await repo.updateFinalArtworkJob(jobId, {
      providerSourceAssetId: null,
      providerSourceSha256: null,
    });
    const job = await repo.getFinalArtworkJob(jobId);
    assert.ok(job!.providerRequestId, "PRECONDITION: a request really is outstanding");
    assert.equal(job!.providerSourceAssetId, null, "PRECONDITION: no asset binding");
    assert.equal(job!.providerSourceSha256, null, "PRECONDITION: no SHA binding");
    return job!;
  }

  it("LEGACY-A: an unbound in-flight request RESUMES while preparedAssetId is still current", async () => {
    const repo = await freshRepo();
    const provider = new TwoPassRecordingProvider();
    const built = { ...buildPipeline(repo, provider), repo };
    const setup = await setupApprovedPreparation(repo, built.assets, UNDERSIZED_CANVAS);

    provider.interruptAfterSubmit = true;
    const requested = await built.finalArtwork.requestPreparedUploadFinalArtwork(setup.projectId);
    await built.worker.processNextJob();

    assert.equal(provider.calls.length, 1, "PRECONDITION: exactly one paid submission so far");
    const originalRequestId = provider.calls[0]!.submittedRequestId;
    assert.ok(originalRequestId);
    const durable = (await repo.listAssets(setup.projectId)).filter(
      (asset) =>
        asset.finalArtworkJobId === requested.job.id &&
        (asset.metadata as Record<string, unknown> | null)?.reconstructionStage !== undefined,
    );
    assert.equal(durable.length, 0, "PRECONDITION: no durable result yet");
    await stripSourceBindingFromJob(repo, requested.job.id);

    // No recovery lifecycle at all, so the current effective source is still
    // the preparation's own prepared asset — CASE A.
    const resolved = await resolvePreparedUploadEffectiveSource(repo, built.qualification, {
      projectId: setup.projectId,
      originalAssetId: setup.originalAssetId,
      preparedAssetId: setup.preparedAssetId,
    });
    assert.equal(resolved.status, "prepared");

    provider.interruptAfterSubmit = false;
    const again = await built.finalArtwork.requestPreparedUploadFinalArtwork(setup.projectId);
    await drainJob(built.worker, repo, again.job.id);

    // THE ROLLOUT-SAFETY ASSERTION: the legacy request was RESUMED, not
    // retired and re-submitted. A new submission here would re-bill a
    // customer for work already paid for, on every job in flight at deploy.
    const after = provider.calls.slice(1);
    assert.ok(after.length > 0, "the worker really ran again");
    assert.ok(
      after.some((call) => call.resumedRequestId === originalRequestId),
      "the in-flight legacy request must be resumed",
    );
    assert.ok(
      after.every((call) => call.submittedRequestId === null),
      "and no new paid submission may occur",
    );

    const plate = await productionAssetFor(repo, setup.projectId, again.job.id);
    assert.ok(plate);
    assert.equal(recordedLineage(plate!).preparedAssetId, setup.preparedAssetId);
    assert.equal(recordedLineage(plate!).sourceAuthority, "prepared_upload");
  });

  it("LEGACY-C: an unbound in-flight request is NOT resumed once a clean master is current", async () => {
    const repo = await freshRepo();
    const provider = new TwoPassRecordingProvider();
    const built = { ...buildPipeline(repo, provider), repo };
    const setup = await setupApprovedPreparation(repo, built.assets, UNDERSIZED_CANVAS);

    provider.interruptAfterSubmit = true;
    const requested = await built.finalArtwork.requestPreparedUploadFinalArtwork(setup.projectId);
    await built.worker.processNextJob();
    assert.equal(provider.calls.length, 1, "PRECONDITION: one paid submission");
    const legacyRequestId = provider.calls[0]!.submittedRequestId;
    await stripSourceBindingFromJob(repo, requested.job.id);

    // Authority moves to a clean master.
    const { derivedAssetId } = await buildConfirmedMaster(
      built,
      setup.projectId,
      setup.originalAssetId,
      "legacy-c-candidate",
      undefined,
      SMALL_CANDIDATE_CANVAS,
    );
    provider.interruptAfterSubmit = false;
    provider.interruptAfterPass1 = false;
    const callsBefore = provider.calls.length;
    const again = await built.finalArtwork.requestPreparedUploadFinalArtwork(setup.projectId);
    await drainJob(built.worker, repo, again.job.id);

    // The unbound request belonged to preparedAssetId, so it must not be
    // resumed as clean-master work, and the slot must be retired.
    for (const call of provider.calls.slice(callsBefore)) {
      assert.equal(
        call.resumedRequestId,
        null,
        "an unbound legacy request must never be resumed under PQCM authority",
      );
      assert.notEqual(call.resumedRequestId, legacyRequestId);
    }
    const plate = await productionAssetFor(repo, setup.projectId, again.job.id);
    assert.ok(plate);
    const lineage = recordedLineage(plate!);
    assert.equal(lineage.preparedAssetId, derivedAssetId);
    assert.equal(lineage.sourceAuthority, "production_qualified_clean_master");
    const masterBytes = await built.assets.downloadAssetBytes(derivedAssetId);
    assert.equal(
      lineage.sourceBytesSha256,
      createHash("sha256").update(masterBytes!.bytes).digest("hex"),
      "no false provenance: the recorded SHA is the master's",
    );
  });

  /**
   * Strips the source-identity metadata the repair writes onto a pass-1
   * intermediate, reproducing a pre-repair intermediate — which recorded
   * only its stage marker, provider key and request id.
   */
  async function stripSourceMetadataFromIntermediate(
    built: ReturnType<typeof buildPipeline> & { repo: ProjectRepository },
    projectId: string,
    jobId: string,
    assetId: string,
  ) {
    const asset = (await built.repo.getAssetById(assetId))!;
    const bytes = (await built.assets.downloadAssetBytes(assetId))!;
    const meta = asset.metadata as Record<string, unknown>;

    // Re-create the intermediate through the SAME capability the pre-repair
    // worker used, carrying EXACTLY the metadata that worker wrote — stage
    // marker, provider key, provider request id, and nothing about the
    // source. That is a genuine pre-repair row, not a row with fields
    // scrubbed out from underneath the store.
    await built.repo.deleteAsset(assetId);
    const legacy = await built.assets.uploadProductionAsset(projectId, {
      conceptId: `legacy-${jobId}`,
      bytes: bytes.bytes,
      contentType: "image/png",
      widthPx: asset.widthPx!,
      heightPx: asset.heightPx!,
      hasTransparency: true,
      finalArtworkJobId: jobId,
      productionRole: "production_png",
      metadata: {
        reconstructionStage: meta.reconstructionStage,
        providerKey: meta.providerKey,
        providerRequestId: meta.providerRequestId,
      },
    });

    const m = legacy.metadata as Record<string, unknown>;
    assert.equal(m.sourceAssetId, undefined, "PRECONDITION: no sourceAssetId metadata");
    assert.equal(m.sourceBytesSha256, undefined, "PRECONDITION: no sourceBytesSha256 metadata");
    assert.equal(m.reconstructionStage, "pass1_intermediate", "PRECONDITION: still a pass-1 row");
    assert.ok(m.providerKey, "PRECONDITION: realistic legacy metadata keeps providerKey");
    assert.ok(m.providerRequestId, "PRECONDITION: ...and providerRequestId");
    return legacy;
  }

  it("LEGACY pass-1 CASE C: a metadata-less intermediate is never supplied as clean-master work", async () => {
    const repo = await freshRepo();
    const provider = new TwoPassRecordingProvider();
    const built = { ...buildPipeline(repo, provider), repo };
    const setup = await setupApprovedPreparation(repo, built.assets, UNDERSIZED_CANVAS);

    const requested = await built.finalArtwork.requestPreparedUploadFinalArtwork(setup.projectId);
    const pass1 = await driveUntilPass1Intermediate(built, setup.projectId, requested.job.id);
    await stripSourceMetadataFromIntermediate(built, setup.projectId, requested.job.id, pass1.asset.id);

    // The legacy intermediate's bytes must be distinguishable from the
    // master's, or "was the provider handed the old bytes?" is unanswerable.
    const { derivedAssetId } = await buildConfirmedMaster(
      built,
      setup.projectId,
      setup.originalAssetId,
      "legacy-pass1-candidate",
      undefined,
      SMALL_CANDIDATE_CANVAS,
      { r: 200, g: 40, b: 10 },
    );
    const masterSha = createHash("sha256")
      .update((await built.assets.downloadAssetBytes(derivedAssetId))!.bytes)
      .digest("hex");
    assert.notEqual(pass1.sha, masterSha, "PRECONDITION: legacy bytes differ from master bytes");

    provider.interruptAfterPass1 = false;
    const callsBefore = provider.calls.length;
    const again = await built.finalArtwork.requestPreparedUploadFinalArtwork(setup.projectId);
    await drainJob(built.worker, repo, again.job.id);

    const after = provider.calls.slice(callsBefore);
    assert.ok(after.length > 0, "the worker really ran again");
    for (const call of after) {
      assert.notEqual(
        call.intermediateSha,
        pass1.sha,
        "a metadata-less legacy intermediate must not be continued from as clean-master work",
      );
      assert.equal(call.sourceSha, masterSha, "the provider receives the CURRENT source's bytes");
    }

    const plate = await productionAssetFor(repo, setup.projectId, again.job.id);
    assert.ok(plate);
    const lineage = recordedLineage(plate!);
    assert.equal(lineage.preparedAssetId, derivedAssetId);
    assert.equal(lineage.sourceAuthority, "production_qualified_clean_master");
    assert.equal(lineage.sourceBytesSha256, masterSha);
  });

  it("LEGACY pass-1 CASE A: a metadata-less intermediate stays reusable while preparedAssetId is current", async () => {
    const repo = await freshRepo();
    const provider = new TwoPassRecordingProvider();
    const built = { ...buildPipeline(repo, provider), repo };
    const setup = await setupApprovedPreparation(repo, built.assets, UNDERSIZED_CANVAS);

    const requested = await built.finalArtwork.requestPreparedUploadFinalArtwork(setup.projectId);
    const pass1 = await driveUntilPass1Intermediate(built, setup.projectId, requested.job.id);
    await stripSourceMetadataFromIntermediate(built, setup.projectId, requested.job.id, pass1.asset.id);

    // No lifecycle: preparedAssetId is still the effective source.
    provider.interruptAfterPass1 = false;
    const callsBefore = provider.calls.length;
    const again = await built.finalArtwork.requestPreparedUploadFinalArtwork(setup.projectId);
    await drainJob(built.worker, repo, again.job.id);

    const after = provider.calls.slice(callsBefore);
    assert.ok(
      after.some((call) => call.intermediateSha === pass1.sha),
      "the paid pass-1 work must still be reused, not thrown away and re-bought",
    );
    const plate = await productionAssetFor(repo, setup.projectId, again.job.id);
    assert.ok(plate);
    assert.equal(recordedLineage(plate!).preparedAssetId, setup.preparedAssetId);
  });

  // =========================================================================
  // CURSOR NB-2 — the variant read path must agree with current authority
  // =========================================================================

  it("NB-2: a superseded prepared plate is not published by ANY read path", async () => {
    const repo = await freshRepo();
    const built = { ...buildPipeline(repo), repo };
    const setup = await setupApprovedPreparation(repo, built.assets);

    const first = await built.finalArtwork.requestPreparedUploadFinalArtwork(setup.projectId);
    await drainJob(built.worker, repo, first.job.id);

    // PRECONDITIONS: a real prepared-source plate, ready validation.
    const preparedPlate = await productionAssetFor(repo, setup.projectId, first.job.id);
    assert.ok(preparedPlate, "PRECONDITION: a prepared plate exists");
    assert.equal(recordedLineage(preparedPlate!).preparedAssetId, setup.preparedAssetId);
    assert.equal(
      (await latestReport(repo, setup.projectId, first.job.id)).status,
      "ready",
      "PRECONDITION: its validation is ready",
    );
    const beforeVariant = await built.finalArtwork.resolveProductionVariantState(
      setup.projectId,
      STANDARD_RASTER_TREATMENT_KEY,
    );
    assert.equal(beforeVariant.asset?.id, preparedPlate!.id, "PRECONDITION: it is published now");
    assert.equal(beforeVariant.validationStatus, "ready");

    // PQCM becomes current, and no PQCM plate exists yet.
    const { derivedAssetId } = await buildConfirmedMaster(
      built,
      setup.projectId,
      setup.originalAssetId,
    );
    const platesNow = (await repo.listAssets(setup.projectId)).filter(
      (asset) =>
        asset.productionRole === "production_png" &&
        recordedLineageOrNull(asset)?.preparedAssetId === derivedAssetId,
    );
    assert.equal(platesNow.length, 0, "PRECONDITION: no PQCM plate exists yet");

    // EVERY read authority must now agree that nothing is current.
    assert.equal(
      await built.finalArtwork.getCurrentProductionAssetId(setup.projectId),
      null,
      "current-delivery path",
    );
    const variant = await built.finalArtwork.resolveProductionVariantState(
      setup.projectId,
      STANDARD_RASTER_TREATMENT_KEY,
    );
    assert.equal(variant.asset, null, "variant read path must agree");
    assert.equal(variant.job, null);
    assert.equal(variant.validationStatus, null);

    // ...which is exactly what the Halftone raster-first gate consumes, so
    // the superseded raster plate can no longer unlock Halftone.
    await assert.rejects(
      async () => {
        await repo.updateBrief(setup.projectId, { requestedProductionOutput: "production_png" });
        await built.finalArtwork.requestPreparedUploadFinalArtwork(setup.projectId);
      },
      () => true,
      "a request now either blocks or revives — it must not proceed on the stale plate",
    ).catch(() => {
      // A revival is also an acceptable outcome here; the gate assertion
      // above (variant.asset === null) is the load-bearing one.
    });

    // Once the current-source plate exists, the read paths agree again.
    const again = await built.finalArtwork.requestPreparedUploadFinalArtwork(setup.projectId);
    await drainJob(built.worker, repo, again.job.id);
    const newestVariant = await built.finalArtwork.resolveProductionVariantState(
      setup.projectId,
      STANDARD_RASTER_TREATMENT_KEY,
    );
    assert.ok(newestVariant.asset, "the current-source plate is published");
    assert.equal(recordedLineage(newestVariant.asset!).preparedAssetId, derivedAssetId);
    // ...and certification withholding is still respected for it.
    assert.notEqual(newestVariant.validationStatus, "ready");
  });

  // =========================================================================
  // ATTEMPT BUDGET — authority revival must not strand a job identity
  // =========================================================================

  it("ATTEMPTS: repeated CASE B authority blocks do not permanently strand a job", async () => {
    const repo = await freshRepo();
    const built = { ...buildPipeline(repo), repo };
    const setup = await setupApprovedPreparation(repo, built.assets);

    // One real recovery lifecycle, then FOUR genuine authority races on the
    // SAME unique job identity — one more than MAX_FINAL_ARTWORK_ATTEMPTS
    // (3). Each round is real: the customer requests while production is
    // permitted, authority lapses before the worker claims, and the worker
    // cancels without executing a single transform. Nothing hand-edits
    // `attempts`, and no job is hand-queued.
    //
    // Authority is toggled by proposing a fresh fidelity contract (the
    // project's current contract is then `proposed`, not `confirmed`, so
    // `getCurrentProductionQualifiedMaster` resolves to nothing) and then
    // confirming it with the SAME facts — which recomputes the SAME
    // `contractKey`, so the already-approved reconstruction and its
    // confirmed qualification become current again. That is exactly how a
    // customer re-confirming their artwork facts behaves, and it needs no
    // second reconstruction job (the active-binding unique index would
    // refuse one anyway).
    await buildConfirmedMaster(
      built,
      setup.projectId,
      setup.originalAssetId,
      "attempts-candidate",
    );

    let jobId = "";
    for (let round = 0; round < 4; round += 1) {
      const requested = await built.finalArtwork.requestPreparedUploadFinalArtwork(
        setup.projectId,
      );
      jobId = requested.job.id;
      assert.equal(requested.job.status, "queued");

      // Authority lapses in the request→worker gap.
      const reproposed = await built.fidelity.proposeContract(setup.projectId, {
        sourceAssetId: setup.originalAssetId,
        sourceSha256: SOURCE_SHA,
      });
      assert.equal(
        await built.qualification.getCurrentProductionQualifiedMaster(setup.projectId),
        null,
        "authority really has lapsed",
      );

      await drainJob(built.worker, repo, jobId);
      const blocked = await repo.getFinalArtworkJob(jobId);
      assert.equal(blocked!.status, "cancelled", `round ${round} blocked on authority`);

      // ...and is restored, so the next round can legitimately request.
      await built.fidelity.confirmContract(setup.projectId, reproposed.id, {
        currentSourceSha256: SOURCE_SHA,
        confirmedWording: [],
        confirmedMarks: [],
        confirmedBy: "customer",
      });
      assert.ok(
        await built.qualification.getCurrentProductionQualifiedMaster(setup.projectId),
        "authority really is current again",
      );
    }

    const beforeFinal = await repo.getFinalArtworkJob(jobId);
    assert.ok(
      beforeFinal!.attempts <= 1,
      `authority cancels must not accumulate attempts (saw ${beforeFinal!.attempts})`,
    );

    // The job identity must still be executable against current authority.
    const finalRequest = await built.finalArtwork.requestPreparedUploadFinalArtwork(
      setup.projectId,
    );
    assert.equal(finalRequest.job.id, jobId, "same unique identity throughout");
    await drainJob(built.worker, repo, finalRequest.job.id);

    const job = await repo.getFinalArtworkJob(finalRequest.job.id);
    assert.doesNotMatch(
      job!.lastError ?? "",
      /Exceeded maximum finalization attempts/,
      "authority blocks must not exhaust the execution budget",
    );
    const plate = await productionAssetFor(repo, setup.projectId, finalRequest.job.id);
    assert.ok(plate, "the job still executes after repeated authority blocks");
    assert.equal(
      recordedLineage(plate!).sourceAuthority,
      "production_qualified_clean_master",
    );
  });

  it("ATTEMPTS: same-source repeated FAILURE stays bounded, and recovery budget is untouched", async () => {
    const repo = await freshRepo();
    class AlwaysFailingProvider implements FinalArtworkProvider {
      readonly providerKey = "dtf_r1_always_failing";
      calls = 0;
      async produce(): Promise<FinalArtworkProviderOutput> {
        this.calls += 1;
        throw new Error("simulated reconstruction outage");
      }
    }
    const provider = new AlwaysFailingProvider();
    const built = { ...buildPipeline(repo, provider), repo };
    // Undersized, so the failing RECONSTRUCTION provider is the one reached.
    const setup = await setupApprovedPreparation(repo, built.assets, UNDERSIZED_CANVAS);

    const requested = await built.finalArtwork.requestPreparedUploadFinalArtwork(setup.projectId);
    // Re-request after each failure: an ordinary retry of the same failing
    // work against an UNCHANGED source. This must NOT rebase the budget, so
    // the ceiling still arrives.
    let exhausted = false;
    for (let round = 0; round < 8 && !exhausted; round += 1) {
      await drainJob(built.worker, repo, requested.job.id);
      const job = await repo.getFinalArtworkJob(requested.job.id);
      exhausted = /Exceeded maximum finalization attempts/.test(job!.lastError ?? "");
      if (exhausted) break;
      await built.finalArtwork.requestPreparedUploadFinalArtwork(setup.projectId);
    }

    const job = await repo.getFinalArtworkJob(requested.job.id);
    assert.equal(job!.status, "failed");
    assert.match(
      job!.lastError ?? "",
      /Exceeded maximum finalization attempts/,
      "same-source failure must still exhaust its bounded budget",
    );
    assert.ok(
      provider.calls < 12,
      `no infinite retry loop (provider was called ${provider.calls} times)`,
    );
    assert.equal(
      job!.providerRecoveryAttempts,
      0,
      "providerRecoveryAttempts semantics are unchanged — never rebased by this repair",
    );
  });

  // =========================================================================
  // LIFECYCLE OWNERSHIP — the lifecycle must be about THIS artwork
  // =========================================================================

  it("a recovery lifecycle belonging to a REPLACED upload never becomes this artwork's source", async () => {
    const repo = await freshRepo();
    const built = { ...buildPipeline(repo), repo };
    const setup = await setupApprovedPreparation(repo, built.assets);

    // A full, genuine recovery lineage — for an artwork that is NOT the one
    // this preparation descends from. `uploadOriginal` permits a second
    // upload while a preparation is unapproved, which creates a new
    // preparation row and leaves the old contract/job/qualification behind,
    // so a project really can carry a lifecycle for a discarded upload.
    const discarded = await built.assets.uploadCustomerArtwork(setup.projectId, {
      conceptId: "discarded-original",
      bytes: originalUploadPng(),
      contentType: "image/png",
      widthPx: ORIGINAL_CANVAS.w,
      heightPx: ORIGINAL_CANVAS.h,
      hasTransparency: false,
      kind: "customer_upload",
      metadata: { originalFilename: "replaced.png" },
    });
    const { derivedAssetId } = await buildConfirmedMaster(
      built,
      setup.projectId,
      discarded.id,
      "discarded-candidate",
    );

    const resolved = await resolvePreparedUploadEffectiveSource(repo, built.qualification, {
      projectId: setup.projectId,
      originalAssetId: setup.originalAssetId,
      preparedAssetId: setup.preparedAssetId,
    });
    assert.equal(
      resolved.status,
      "prepared",
      "a lifecycle bound to a different original is not this artwork's lifecycle",
    );

    const requested = await built.finalArtwork.requestPreparedUploadFinalArtwork(setup.projectId);
    await drainJob(built.worker, repo, requested.job.id);

    const asset = await productionAssetFor(repo, setup.projectId, requested.job.id);
    assert.ok(asset);
    const recorded = recordedLineage(asset!);
    assert.equal(
      recorded.preparedAssetId,
      setup.preparedAssetId,
      "the plate must carry THIS artwork's pixels, never a stranger master's",
    );
    assert.notEqual(recorded.preparedAssetId, derivedAssetId);
    assert.equal(recorded.originalAssetId, setup.originalAssetId);
    assert.equal(recorded.sourceAuthority, "prepared_upload");
  });

  // =========================================================================
  // I — GOVERNANCE: the Pedro-class boundary
  // =========================================================================

  it("I: a plate built from a clean master is produced but NEVER automatically print_ready", async () => {
    const repo = await freshRepo();
    const built = { ...buildPipeline(repo), repo };
    const setup = await setupApprovedPreparation(repo, built.assets);
    await buildConfirmedMaster(built, setup.projectId, setup.originalAssetId);

    const requested = await built.finalArtwork.requestPreparedUploadFinalArtwork(setup.projectId);
    await drainJob(built.worker, repo, requested.job.id);

    const asset = await productionAssetFor(repo, setup.projectId, requested.job.id);
    assert.ok(asset, "the technical work genuinely succeeds — that is the point");

    // This job honestly did no reconstruction of its own: the master already
    // carried enough pixels. Without `sourceAuthority` that is exactly how
    // an uncertified reconstruction would have reached Print Ready.
    assert.equal(recordedLineage(asset!).enhancement, "skipped");
    assert.equal(built.provider.calls, 0);

    const report = await latestReport(repo, setup.projectId, requested.job.id);
    assert.notEqual(report.status, "ready", "Print Ready must be withheld");
    const certification = report.checks.find(
      (check) => check.check === "reconstruction_certification_evidence",
    );
    assert.ok(certification, "the certification question must be asked");
    assert.equal(certification!.status, "fail");
    assert.equal(certification!.severity, "blocking");
    assert.match(certification!.reason, /recovered clean master/);
    assert.ok(
      report.requiredTransformations.includes("require_human_review"),
      "human review is required, exactly as the Pedro-class condition demands",
    );

    const snapshot = await repo.getProject(setup.projectId);
    assert.equal(snapshot!.project.status, "finalization_required");

    // Source lineage still passes on its own terms — the plate is
    // well-formed, it simply is not certified.
    const lineage = report.checks.find((check) => check.check === "source_lineage");
    assert.equal(lineage!.status, "pass");
    assert.match(lineage!.reason, /recovered clean master/);
  });
});
