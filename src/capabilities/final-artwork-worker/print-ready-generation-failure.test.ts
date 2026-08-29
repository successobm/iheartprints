import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { PNG } from "pngjs";

import { DataUriAssetStorageProvider } from "@/capabilities/asset-storage";
import { createAssetCapability, PngThumbnailGenerator } from "@/capabilities/assets";
import { createDesignBriefCapability } from "@/capabilities/design-brief";
import { createArtworkPreparationCapability } from "@/capabilities/artwork-preparation/artwork-preparation-capability";
import { createFinalArtworkCapability } from "@/capabilities/final-artwork";
import { resolveReconstructionRequest } from "@/capabilities/final-artwork/topaz-transparency-upscale-provider";
import type {
  FinalArtworkProvider,
  FinalArtworkProviderInput,
  FinalArtworkProviderOutput,
} from "@/capabilities/final-artwork/provider";
import { ProviderError } from "@/capabilities/providers/provider-error";
import { createPrintValidationCapability } from "@/capabilities/print-validation";
import { toCustomerFinalizationView } from "@/lib/services/conversation-service";
import { assessHalftoneEligibility } from "@/capabilities/shared/production-treatment";
import { resolveAttentionCheckName, describeVariantAttentionReason, classifyVariantAttentionKind } from "@/capabilities/shared/production-variant";
import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";

import { createFinalArtworkWorkerCapability } from "./final-artwork-worker-capability";

/**
 * Phase 27M — THE REAL FAILURE.
 *
 * Human acceptance of Phase 27L reached "Prepare Print-Ready Artwork" for
 * the manually-corrected real INCREDI-BOWLS artwork at the newly-confirmed
 * Standard Adult size (10.5in x ~9.08in), and got a generic-looking error
 * after ~10 seconds.
 *
 * TRACED ROOT CAUSE (proven, not assumed): the source is 584x640px and the
 * confirmed size requires roughly a 5.4x-5.7x reconstruction on the trimmed
 * artwork -- above `PROVIDER_MAX_RECONSTRUCTION_SCALE` (4x), the ceiling
 * `fix: enforce Topaz reconstruction ceiling` (commit b9abb6a) added for
 * exactly this artwork after a live Topaz credit was silently misspent.
 * That ceiling is CORRECT and untouched here. `resolveReconstructionRequest`
 * refuses BEFORE any dispatch, throwing
 * `ProviderError("invalid_request", reason, "not_dispatched")` -- nothing
 * left the process, nothing was billed.
 *
 * THE ACTUAL BUG: `produceProductionAsset`'s dispatch catch routed EVERY
 * provider throw (including this provably-pre-dispatch, durable
 * print-readiness verdict) through `failJob`, which leaves
 * `PrintProject.status` at `"finalizing"`. `toCustomerFinalizationView` reads
 * that combination as `"retryable_failure"` -- a false promise that an
 * unchanged retry could succeed. `resolvePreparedUploadJob`'s OWN doc comment
 * already drew this exact line ("`failed` ... an infrastructure problem ...
 * never a print-readiness verdict" vs "a `completed` job ... is a real,
 * honest verdict about this artwork"), which is what proves this was an
 * inconsistency, not a considered design choice.
 *
 * THE FIX (final-artwork-worker-capability.ts): a `ProviderError` with
 * `classification === "invalid_request"` and `dispatch === "not_dispatched"`
 * now completes the job via `completeWithoutAsset` (status `"completed"`,
 * project -> `"finalization_required"`) instead of `failJob` -- landing on
 * the SAME honest `"needs_review"` verdict every other genuine
 * cannot-auto-finalize conclusion in this file already uses. No enhancement
 * algorithm, ceiling, threshold, or provider integration changed.
 *
 * NEVER calls a real Topaz endpoint. The fake provider below reuses the
 * REAL, pure `resolveReconstructionRequest` (the exact function that saved
 * the live credit) to decide whether to throw -- so this proves the real
 * geometry decision without ever making a network request.
 */
const INCREDI_BOWLS_PATH =
  "C:\\Users\\eric\\Downloads\\e0078e6f-e802-4da1-ba3d-9f97490c4868_image_1_.png";
const EXPECTED_SHA256 =
  "3643f74e5834bfef50fb8f101eb36a7b60655d9934d6f5cefaf91945c5e2ea70";
const hasAsset = existsSync(INCREDI_BOWLS_PATH);

/**
 * Stands in for `TopazTransparencyUpscaleProvider` faithfully enough to be
 * trustworthy: it decodes the SAME bytes the real provider would decode and
 * calls the SAME pure pre-dispatch resolver, so whether it throws (and what
 * it throws) is a real production decision, not a guess. It performs no
 * network I/O and can never be billed -- if the fixture ever needed <=4x
 * (a future fixture change), this provider would throw loudly rather than
 * silently fabricate a plate, so this test can never pass for the wrong
 * reason.
 */
class TopazShapedFakeProvider implements FinalArtworkProvider {
  readonly providerKey = "topaz_transparency_upscale";
  calls = 0;
  lastSourceBytes: Buffer | null = null;

  async produce(input: FinalArtworkProviderInput): Promise<FinalArtworkProviderOutput> {
    this.calls += 1;
    this.lastSourceBytes = Buffer.from(input.sourceBytes);
    const source = PNG.sync.read(input.sourceBytes);
    const resolved = resolveReconstructionRequest(
      { width: source.width, height: source.height, data: source.data },
      input.sizing,
    );
    if (resolved.status !== "resolved") {
      throw new ProviderError("invalid_request", resolved.reason, "not_dispatched");
    }
    throw new Error(
      "TEST FIXTURE ASSUMPTION VIOLATED: expected this fixture to exceed the " +
        "provider's reconstruction ceiling at the confirmed size. If this " +
        "fires, the fixture or confirmed size changed and this test no " +
        "longer proves what it claims to.",
    );
  }
}

describe("Phase 27M — the real final-generation failure (INCREDI-BOWLS, Standard Adult)", { skip: !hasAsset }, () => {
  let tempDir = "";
  let previousCwd = "";
  let originalBytes: Buffer;

  before(() => {
    originalBytes = readFileSync(INCREDI_BOWLS_PATH);
    const actualSha256 = createHash("sha256").update(originalBytes).digest("hex");
    assert.equal(actualSha256, EXPECTED_SHA256, "INCREDI-BOWLS asset SHA256 must match before use");

    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-print-ready-failure-"));
    process.chdir(tempDir);
  });

  after(async () => {
    await cleanupTempWorkspace(tempDir, previousCwd);
  });

  it("the manually-corrected asset, at the confirmed Standard Adult size, resolves to needs_review (not retryable_failure) with zero provider dispatch", async () => {
    await rm(path.join(process.cwd(), ".data", "sprint1-store.json"), { force: true });
    const { resetCapabilityGraphForTests, getCapabilityGraph } = await import("@/capabilities/composition");
    resetCapabilityGraphForTests();
    const graph = getCapabilityGraph();
    const { LocalProjectRepository } = await import("@/lib/db/local-store");
    const repo = new LocalProjectRepository();
    const assets = createAssetCapability(repo, new DataUriAssetStorageProvider(), new PngThumbnailGenerator());
    const artworkPreparation = createArtworkPreparationCapability(repo, assets, createDesignBriefCapability(repo));

    const session = await graph.acquisition.resolveOrCreateSession(null);
    await repo.grantInternalEntitlement(session.id);
    const created = await repo.createProject(session.id);
    const projectId = created.project.id;

    await artworkPreparation.uploadOriginal(projectId, {
      bytes: originalBytes,
      declaredContentType: "image/png",
      filename: "incredi-bowls.png",
    });
    await artworkPreparation.setProductionContext(projectId, {
      productSummary: "T-shirts",
      productColor: "Black",
      printPlacement: "full_front",
    });
    await artworkPreparation.prepareBackground(projectId);

    // The accepted manual-correction path (Phase 27H/27K): a couple of real
    // operations, then the authoritative finalize.
    await artworkPreparation.acceptCorrectionOperation(projectId, {
      clicks: [{ x: 5, y: 5 }],
      mode: "remove",
      toleranceLevel: "default",
    });
    await artworkPreparation.acceptCorrectionOperation(projectId, {
      tool: "erase_brush",
      points: [{ x: 20, y: 20 }],
      radius: 3,
    });
    const finalizeView = await artworkPreparation.finalizeCorrection(projectId);
    assert.equal(finalizeView.hasPreparedArtwork, true);

    const preparationAfterCorrection = await repo.getArtworkPreparation(projectId);
    const correctedAssetId = preparationAfterCorrection!.preparedAssetId!;
    const correctedBytesBefore = (await assets.downloadAssetBytes(correctedAssetId))!.bytes;
    const originalAssetId = preparationAfterCorrection!.originalAssetId;
    const originalBytesBefore = (await assets.downloadAssetBytes(originalAssetId))!.bytes;

    // Standard Adult, via the real route -- the exact Phase 27L fix.
    const route = await import("@/app/api/projects/[projectId]/print-size/confirm/route");
    const confirmRes = await route.POST(
      new Request("http://localhost/x", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ garmentSizeClass: "adult_standard", useRecommended: true }),
      }),
      { params: Promise.resolve({ projectId }) },
    );
    assert.equal(confirmRes.status, 200, await confirmRes.clone().text());

    const confirmedSnapshot = await repo.getProject(projectId);
    assert.equal(confirmedSnapshot!.brief.productionSizeConfirmedWidthIn, 10.5);

    // --- Dimension contract (Section 5B) ---------------------------------
    const sourcePng = PNG.sync.read(correctedBytesBefore);
    assert.equal(sourcePng.width, 584);
    assert.equal(sourcePng.height, 640);

    // --- Drive the REAL worker with the Topaz-shaped fake provider -------
    const topazFake = new TopazShapedFakeProvider();
    const forbiddenLocal: FinalArtworkProvider = {
      providerKey: "local_raster_interpolation",
      async produce(): Promise<FinalArtworkProviderOutput> {
        throw new Error(
          "local normalization must never run for a source that requires reconstruction",
        );
      },
    };
    const worker = createFinalArtworkWorkerCapability(
      repo,
      assets,
      topazFake,
      createPrintValidationCapability(),
      {
        async evaluate() {
          throw new Error("Concept Evaluation must never run for uploaded artwork");
        },
      } as never,
      forbiddenLocal,
    );

    const finalArtwork = createFinalArtworkCapability(repo);
    const requested = await finalArtwork.requestPreparedUploadFinalArtwork(projectId);
    await worker.processNextJob();

    const job = (await repo.getFinalArtworkJob(requested.job.id))!;
    const projectAfter = await repo.getProject(projectId);

    // --- B/D/E: enhancement was genuinely required, and dispatch was attempted exactly once, never twice ---
    assert.equal(topazFake.calls, 1, "the reconstruction provider must be consulted exactly once");

    // --- The actual fix: this is a durable verdict, never a retryable one ---
    assert.equal(job.status, "completed", "a provably pre-dispatch, unfixable-by-retry refusal must not read as an infrastructure failure");
    assert.match(job.lastError ?? "", /cannot be reconstructed|4x maximum/);
    assert.equal(projectAfter!.project.status, "finalization_required");

    // --- Phase 28T.1 regression: this exact honest, pre-dispatch, no-asset
    // completion must no longer surface as attentionReason/attentionKind
    // `null` in the customer-facing view (the real defect found on project
    // 0807429d-22dc-4dfe-aa0f-51918cf04be1 — no validation report ever
    // exists here, because no asset was ever produced) ---
    const checkName = resolveAttentionCheckName(null, job.status, job.lastError);
    assert.equal(checkName, "reconstruction_sufficiency");
    assert.equal(
      describeVariantAttentionReason("standard_raster", checkName),
      "Standard Raster needs additional image enhancement at this print size.",
    );
    assert.equal(classifyVariantAttentionKind(checkName), "deterministic_enhancement");

    const customerView = toCustomerFinalizationView(
      projectAfter!.project.status,
      job.status,
      projectAfter!.brief.requestedProductionOutput,
      true,
      false,
    );
    assert.equal(customerView.status, "needs_review", "the customer must see a review verdict, never a false 'try again' promise");

    // --- No production asset was fabricated ------------------------------
    const validation = await repo.getLatestProductionAssetValidationForJob(projectId, job.id);
    assert.equal(validation, null);

    // --- L/35: source authority -- the SUBMITTED bytes are the manually- ---
    // corrected asset's bytes, never the immutable original.
    assert.ok(topazFake.lastSourceBytes, "the provider must have been given source bytes");
    const submittedSha256 = createHash("sha256").update(topazFake.lastSourceBytes!).digest("hex");
    const correctedSha256 = createHash("sha256").update(correctedBytesBefore).digest("hex");
    const originalSha256 = createHash("sha256").update(originalBytesBefore).digest("hex");
    assert.equal(submittedSha256, correctedSha256, "final generation must submit the accepted manually-corrected asset");
    assert.notEqual(submittedSha256, originalSha256, "the immutable original must never be submitted as the production source");

    // --- M/36/37: immutability survives the failed attempt ----------------
    const correctedBytesAfter = (await assets.downloadAssetBytes(correctedAssetId))!.bytes;
    const originalBytesAfter = (await assets.downloadAssetBytes(originalAssetId))!.bytes;
    assert.equal(
      createHash("sha256").update(correctedBytesAfter).digest("hex"),
      correctedSha256,
      "the corrected asset must be unchanged by the failed attempt",
    );
    assert.equal(
      createHash("sha256").update(originalBytesAfter).digest("hex"),
      EXPECTED_SHA256,
      "the original asset must remain byte-identical to the real uploaded file",
    );

    // --- Q/T: DTF Halftone remains a real, working alternative for this ---
    // exact artwork -- it never needs reconstruction (dot geometry is
    // generated at final size), so the same too-small source that correctly
    // refuses Standard Raster can still legitimately produce a plate via
    // DTF Halftone. Eligibility alone (not a real halftone run) is asserted
    // here; the halftone pipeline itself is unchanged and out of scope.
    const preparationFinal = await repo.getArtworkPreparation(projectId);
    const eligibility = assessHalftoneEligibility({
      productionCategory: "apparel_raster",
      productionSizeConfirmed: true,
      preparedSourceAvailable:
        Boolean(preparationFinal!.preparedAssetId) && preparationFinal!.status === "approved",
      garment: { hex: "#000000", label: "Black", tone: "dark" } as never,
      tone: { visiblePixelCount: 1, midtoneFraction: 1 },
    });
    assert.equal(eligibility.eligible, true, "DTF Halftone must remain a real, selectable alternative after Standard Raster's refusal");

    // --- K/32: a second click (same intent) must not create a second job ---
    // or attempt a second dispatch -- `resolvePreparedUploadJob`'s own
    // documented contract for a "completed" job.
    const secondRequest = await finalArtwork.requestPreparedUploadFinalArtwork(projectId);
    assert.equal(secondRequest.job.id, job.id, "a duplicate request against a completed, honest verdict must reuse the same job, never create a second one");
    assert.equal(secondRequest.alreadyRequested, true);
    await worker.processNextJob();
    assert.equal(topazFake.calls, 1, "a duplicate 'Try Again' against an unchanged, already-verdicted intent must never dispatch to the provider again");
  });
});
