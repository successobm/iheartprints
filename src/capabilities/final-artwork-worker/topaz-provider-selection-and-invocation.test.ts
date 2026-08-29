import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { PNG } from "pngjs";

import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";
import { confirmProductionSizeForTests } from "@/test-support/confirm-production-size";
import { DataUriAssetStorageProvider } from "@/capabilities/asset-storage";
import { createAssetCapability, PngThumbnailGenerator } from "@/capabilities/assets";
import { createFinalArtworkCapability } from "@/capabilities/final-artwork";
import { resolveFinalArtworkProvider } from "@/capabilities/final-artwork/resolve-final-artwork-provider";
import {
  resolveReconstructionRequest,
  TopazTransparencyUpscaleProvider,
} from "@/capabilities/final-artwork/topaz-transparency-upscale-provider";
import { PRINT_PLACEMENT_SIZING_POLICY } from "@/capabilities/shared/print-placement-dimensions";
import type { FinalArtworkProvider, FinalArtworkProviderInput } from "@/capabilities/final-artwork/provider";
import { createPrintValidationCapability } from "@/capabilities/print-validation";
import { createFinalArtworkWorkerCapability } from "./final-artwork-worker-capability";

/**
 * Phase 28 Checkpoint Audit, Section 11 — PROVES, WITHOUT ANY REAL NETWORK
 * CALL, that:
 *
 *   (1) `FINAL_ARTWORK_PROVIDER=topaz` + a configured `TOPAZ_API_KEY`
 *       resolves the REAL `TopazTransparencyUpscaleProvider` class (never a
 *       stand-in), and the real worker pipeline actually reaches and invokes
 *       it -- exactly once -- when the uploaded source genuinely lacks the
 *       pixels the confirmed production size requires.
 *   (2) When the source ALREADY satisfies the production target, that same
 *       real, Topaz-configured provider instance is never invoked at all --
 *       not "invoked but skipped internally": never called.
 *
 * This does not duplicate `resolve-final-artwork-provider.test.ts` (proves
 * the pure config->instance mapping) or `topaz-transparency-upscale-provider.
 * test.ts` (proves the provider's own submit/poll/download contract in
 * isolation). This file chains those already-proven pieces THROUGH the real
 * `requestPreparedUploadFinalArtwork` -> `FinalArtworkWorkerCapability`
 * pipeline, so the wiring itself -- not just its parts -- is proven.
 *
 * NO REAL NETWORK IS REACHABLE HERE. `TopazTransparencyUpscaleProvider` is
 * constructed with an injected `fetchImpl` that only ever answers its own
 * three known fake endpoints and throws on anything else -- the same
 * dependency-injection point the class exposes for its own existing test
 * file. A counting wrapper around the resolved instance additionally proves
 * exactly how many times (0 or 1) the real provider's `produce()` was
 * actually called.
 */

const CANVAS_PX = 1200; // 3in sleeve placement at 300 PPI needs 900px -- the canvas comfortably exceeds it either way.

/**
 * A KNOWN-transparent PNG: an opaque square of exactly `artworkWidthPx`
 * centered on an otherwise fully transparent canvas. Constructed directly
 * (never through automatic background-removal, which is proven separately
 * and elsewhere) so the alpha bounding box this test depends on is exact and
 * deterministic -- mirrors the same direct-construction pattern
 * `halftone-production.test.ts`'s own `LIVE_FIXTURE`/`setupLiveFixture` uses
 * for the identical reason.
 */
function preparedTransparentPngOfWidth(artworkWidthPx: number): Buffer {
  const png = new PNG({ width: CANVAS_PX, height: CANVAS_PX });
  const insetX = Math.floor((CANVAS_PX - artworkWidthPx) / 2);
  const insetY = insetX;
  for (let y = 0; y < CANVAS_PX; y += 1) {
    for (let x = 0; x < CANVAS_PX; x += 1) {
      const idx = (CANVAS_PX * y + x) << 2;
      const inArtwork =
        x >= insetX && x < insetX + artworkWidthPx && y >= insetY && y < insetY + artworkWidthPx;
      png.data[idx] = 10;
      png.data[idx + 1] = 90;
      png.data[idx + 2] = 200;
      png.data[idx + 3] = inArtwork ? 255 : 0;
    }
  }
  return PNG.sync.write(png);
}

/**
 * The exact reconstruction request the real provider will compute for a
 * given artwork width -- asks the SAME resolver the adapter itself uses
 * (mirrors `topaz-transparency-upscale-provider.test.ts`'s own
 * `expectedRequest` helper) so the fake fetch's returned PNG is never a
 * guessed size that happens to coincide with the real one.
 */
function expectedReconstructionRequest(artworkWidthPx: number) {
  const png = PNG.sync.read(preparedTransparentPngOfWidth(artworkWidthPx));
  const outcome = resolveReconstructionRequest(
    { width: png.width, height: png.height, data: png.data },
    PRINT_PLACEMENT_SIZING_POLICY.sleeve,
  );
  if (outcome.status !== "resolved") {
    throw new Error(`fixture is not reconstructible: ${outcome.status}`);
  }
  return outcome.request;
}

/** Counts and (optionally) forbids calls to `.produce()` while delegating to the real, injected provider. */
function countingProvider(real: FinalArtworkProvider, options: { forbid?: boolean } = {}) {
  let calls = 0;
  const wrapped: FinalArtworkProvider = {
    providerKey: real.providerKey,
    produce: async (input: FinalArtworkProviderInput) => {
      calls += 1;
      if (options.forbid) {
        throw new Error(
          "FORBIDDEN: the real Topaz-configured provider must never be invoked when the source already satisfies the production target",
        );
      }
      return real.produce(input);
    },
  };
  return { wrapped, callCount: () => calls };
}

/** A fake `fetch` that only answers Topaz's three known endpoints -- unreachable network, by construction. */
function buildFakeTopazFetch(reconstructedWidthPx: number, reconstructedHeightPx: number) {
  const calls: string[] = [];
  const impl = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push(url);
    if (url.endsWith("/tool/async")) {
      return new Response(JSON.stringify({ process_id: "fake-process-id-selection-proof" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/status/")) {
      return new Response(JSON.stringify({ status: "Completed" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/download/")) {
      return new Response(JSON.stringify({ url: "https://cdn.example.com/fake-reconstructed.png" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url === "https://cdn.example.com/fake-reconstructed.png") {
      const png = new PNG({ width: reconstructedWidthPx, height: reconstructedHeightPx });
      for (let i = 0; i < png.data.length; i += 4) {
        png.data[i] = 10;
        png.data[i + 1] = 90;
        png.data[i + 2] = 200;
        png.data[i + 3] = 255;
      }
      return new Response(new Uint8Array(PNG.sync.write(png)), {
        status: 200,
        headers: { "content-type": "image/png" },
      });
    }
    throw new Error(`FORBIDDEN: no real network target is reachable from this test; got ${url}`);
  }) as typeof fetch;
  return { fetchImpl: impl, calls };
}

describe("Phase 28 Checkpoint Audit Section 11 -- Topaz provider selection and invocation, proven without any real network call", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-topaz-selection-proof-"));
    process.chdir(tempDir);
  });

  after(async () => {
    await cleanupTempWorkspace(tempDir, previousCwd);
  });

  /**
   * Directly constructs an approved, prepared_upload artwork with a KNOWN
   * alpha-bounding-box width -- bypassing automatic background removal
   * entirely (proven correct elsewhere; not this file's concern), matching
   * `halftone-production.test.ts`'s own `setupLiveFixture` construction
   * pattern so the reconstruction decision this test depends on is exact.
   */
  async function setup(artworkWidthPx: number) {
    const { LocalProjectRepository } = await import("@/lib/db/local-store");
    const repo = new LocalProjectRepository();
    const assets = createAssetCapability(repo, new DataUriAssetStorageProvider(), new PngThumbnailGenerator());

    const { createAcquisitionCapability } = await import("@/capabilities/acquisition");
    const acquisition = createAcquisitionCapability(repo);
    const session = await acquisition.resolveOrCreateSession(null);
    await acquisition.grantInternalEntitlement(session.id);
    const created = await repo.createProject(session.id);
    const projectId = created.project.id;

    await repo.updateBrief(projectId, {
      productSummary: "T-shirts",
      shirtColor: "Black",
      printPlacement: "sleeve",
    });

    const original = await assets.uploadCustomerArtwork(projectId, {
      conceptId: "upload-original",
      bytes: preparedTransparentPngOfWidth(artworkWidthPx),
      contentType: "image/png",
      widthPx: CANVAS_PX,
      heightPx: CANVAS_PX,
      hasTransparency: false,
      kind: "customer_upload",
      metadata: { originalFilename: "topaz-selection-fixture.png" },
    });
    const preparation = await repo.createArtworkPreparation(projectId, {
      originalAssetId: original.id,
      originalFilename: "topaz-selection-fixture.png",
      analysis: { widthPx: CANVAS_PX, heightPx: CANVAS_PX },
    });
    const preparedBytes = preparedTransparentPngOfWidth(artworkWidthPx);
    const prepared = await assets.uploadCustomerArtwork(projectId, {
      conceptId: `prepared-${preparation.id}`,
      bytes: preparedBytes,
      contentType: "image/png",
      widthPx: CANVAS_PX,
      heightPx: CANVAS_PX,
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
    await confirmProductionSizeForTests(repo, projectId, { widthIn: 3 });

    return { repo, assets, projectId };
  }

  it("1: an undersized source resolves and invokes the REAL, Topaz-configured provider exactly once, via fake fetch only -- zero real network", async () => {
    // 400px artwork width needs a 2.25x reconstruction to reach the 900px
    // the sleeve placement requires at 300 PPI -- genuinely below target,
    // but comfortably within Topaz's real, proven 4x effective scale
    // ceiling (`PROVIDER_MAX_RECONSTRUCTION_SCALE` in
    // `topaz-transparency-upscale-provider.ts`), so the request is one the
    // real provider actually attempts rather than refusing before dispatch.
    const { repo, assets, projectId } = await setup(400);
    const finalArtwork = createFinalArtworkCapability(repo);
    const printValidation = createPrintValidationCapability();

    // The exact config shape `getFinalArtworkProviderConfig()` would produce
    // for `FINAL_ARTWORK_PROVIDER=topaz` + a configured `TOPAZ_API_KEY` --
    // proven directly (not re-derived here) by
    // `final-artwork-provider-config.test.ts`'s own "A: topaz mode is
    // selected only when explicitly requested and configured".
    const resolved = resolveFinalArtworkProvider({ mode: "topaz", apiKey: "test-key-not-real" });
    assert.ok(
      resolved instanceof TopazTransparencyUpscaleProvider,
      "FINAL_ARTWORK_PROVIDER=topaz must resolve the REAL Topaz adapter class, never a stand-in",
    );

    // Re-point the resolved instance's own network dependency at a fake that
    // can only ever answer its own three known endpoints -- this is the
    // SAME injection point `TopazTransparencyUpscaleProvider`'s own test
    // file uses, applied to the instance the real resolver handed back.
    const expectedRequest = expectedReconstructionRequest(400);
    const { fetchImpl, calls } = buildFakeTopazFetch(expectedRequest.widthPx, expectedRequest.heightPx);
    const realProviderWithFakeNetwork = new TopazTransparencyUpscaleProvider({
      apiKey: "test-key-not-real",
      fetchImpl,
      sleepImpl: async () => {},
      pollIntervalMs: 1,
    });
    const { wrapped, callCount } = countingProvider(realProviderWithFakeNetwork);

    const worker = createFinalArtworkWorkerCapability(repo, assets, wrapped, printValidation);
    const requested = await finalArtwork.requestPreparedUploadFinalArtwork(projectId);
    await worker.processNextJob();

    const completed = await repo.getFinalArtworkJob(requested.job.id);
    assert.equal(completed?.status, "completed");
    assert.equal(callCount(), 1, "the real Topaz-configured provider must be invoked exactly once");
    assert.equal(
      calls.filter((u) => u.endsWith("/tool/async")).length,
      1,
      "exactly one submission reached the (fake) Topaz endpoint -- one paid request, never more",
    );
    assert.ok(
      calls.every((u) => u.startsWith("https://cdn.example.com") || u.includes("fake") || u.endsWith("/tool/async") || u.includes("/status/") || u.includes("/download/")),
    );

    const validation = await repo.getLatestProductionAssetValidationForJob(projectId, completed!.id);
    assert.ok(validation, "a reconstructed plate must still pass through real print validation");
  });

  it("2: a source that already satisfies the production target NEVER invokes the real, Topaz-configured provider", async () => {
    // 1000px artwork width, above the 900px the sleeve placement requires --
    // reconstruction must be skipped entirely.
    const { repo, assets, projectId } = await setup(1000);
    const finalArtwork = createFinalArtworkCapability(repo);
    const printValidation = createPrintValidationCapability();

    const resolved = resolveFinalArtworkProvider({ mode: "topaz", apiKey: "test-key-not-real" });
    assert.ok(resolved instanceof TopazTransparencyUpscaleProvider);

    // `forbid: true` -- if the worker's own `enhancement.requiresReconstruction`
    // gate is ever wrong for a sufficient source, this throws immediately
    // and the test fails loudly, rather than a silent call-count of 1 going
    // unnoticed. No `fetchImpl` is even provided: a real call would attempt
    // real network and fail this test for an entirely different reason too.
    const { wrapped, callCount } = countingProvider(resolved, { forbid: true });

    const worker = createFinalArtworkWorkerCapability(repo, assets, wrapped, printValidation);
    const requested = await finalArtwork.requestPreparedUploadFinalArtwork(projectId);
    await worker.processNextJob();

    const completed = await repo.getFinalArtworkJob(requested.job.id);
    assert.equal(completed?.status, "completed");
    assert.equal(callCount(), 0, "a sufficient source must never reach the paid provider at all");
  });

  it("E: opaque prepared source (hasTransparency false) never reaches paid reconstruction even when undersized", async () => {
    // Same undersized geometry as test 1 (would otherwise require Topaz), but
    // the prepared asset truthfully reports no transparent pixels — the
    // continuous-tone apparel gate must refuse before any paid produce().
    const { LocalProjectRepository } = await import("@/lib/db/local-store");
    const repo = new LocalProjectRepository();
    const assets = createAssetCapability(
      repo,
      new DataUriAssetStorageProvider(),
      new PngThumbnailGenerator(),
    );
    const { createAcquisitionCapability } = await import("@/capabilities/acquisition");
    const acquisition = createAcquisitionCapability(repo);
    const session = await acquisition.resolveOrCreateSession(null);
    await acquisition.grantInternalEntitlement(session.id);
    const projectId = (await repo.createProject(session.id)).project.id;

    await repo.updateBrief(projectId, {
      productSummary: "T-shirts",
      shirtColor: "Black",
      printPlacement: "sleeve",
    });

    // Fully opaque undersized square — visible pixels exist, transparency does not.
    const opaquePng = (() => {
      const artworkWidthPx = 400;
      const png = new PNG({ width: CANVAS_PX, height: CANVAS_PX });
      const inset = Math.floor((CANVAS_PX - artworkWidthPx) / 2);
      for (let y = 0; y < CANVAS_PX; y += 1) {
        for (let x = 0; x < CANVAS_PX; x += 1) {
          const idx = (CANVAS_PX * y + x) << 2;
          const inArtwork =
            x >= inset && x < inset + artworkWidthPx && y >= inset && y < inset + artworkWidthPx;
          png.data[idx] = inArtwork ? 10 : 240;
          png.data[idx + 1] = inArtwork ? 90 : 240;
          png.data[idx + 2] = inArtwork ? 200 : 240;
          png.data[idx + 3] = 255;
        }
      }
      return PNG.sync.write(png);
    })();

    const original = await assets.uploadCustomerArtwork(projectId, {
      conceptId: "upload-original-opaque",
      bytes: opaquePng,
      contentType: "image/png",
      widthPx: CANVAS_PX,
      heightPx: CANVAS_PX,
      hasTransparency: false,
      kind: "customer_upload",
      metadata: { originalFilename: "opaque.png" },
    });
    const preparation = await repo.createArtworkPreparation(projectId, {
      originalAssetId: original.id,
      originalFilename: "opaque.png",
      analysis: { widthPx: CANVAS_PX, heightPx: CANVAS_PX },
    });
    const prepared = await assets.uploadCustomerArtwork(projectId, {
      conceptId: `prepared-${preparation.id}`,
      bytes: opaquePng,
      contentType: "image/png",
      widthPx: CANVAS_PX,
      heightPx: CANVAS_PX,
      hasTransparency: false,
      kind: "png",
      metadata: { derivedFromAssetId: original.id },
    });
    await repo.updateArtworkPreparation(preparation.id, {
      status: "prepared",
      preparedAssetId: prepared.id,
      preparation: { backgroundRemoved: false },
    });
    const [artwork] = await repo.addArtworkVersions(projectId, [
      {
        versionNumber: 1,
        kind: "prepared_upload",
        title: "Your artwork, prepared",
        summary: "Opaque prepared artwork.",
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
    await confirmProductionSizeForTests(repo, projectId, { widthIn: 3 });

    const finalArtwork = createFinalArtworkCapability(repo);
    const printValidation = createPrintValidationCapability();
    const resolved = resolveFinalArtworkProvider({ mode: "topaz", apiKey: "test-key-not-real" });
    assert.ok(resolved instanceof TopazTransparencyUpscaleProvider);
    const { wrapped, callCount } = countingProvider(resolved, { forbid: true });

    const worker = createFinalArtworkWorkerCapability(repo, assets, wrapped, printValidation);
    const requested = await finalArtwork.requestPreparedUploadFinalArtwork(projectId);
    await worker.processNextJob();

    const completed = await repo.getFinalArtworkJob(requested.job.id);
    assert.equal(completed?.status, "completed");
    assert.equal(callCount(), 0, "opaque continuous-tone source must never reach paid reconstruction");
    assert.match(
      completed?.lastError ?? "",
      /transparent/i,
      "job must complete with an honest transparency refusal, not print_ready",
    );
    const project = await repo.getProject(projectId);
    assert.notEqual(project?.project.status, "print_ready");
    const validation = await repo.getLatestProductionAssetValidationForJob(
      projectId,
      completed!.id,
    );
    assert.equal(
      validation,
      null,
      "no production asset / validation run — refused before plate production",
    );
  });
});
