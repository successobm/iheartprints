import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { PNG } from "pngjs";

import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";

/**
 * Sprint 2M Phase 2C, Goal 14/19V: the secure production-asset read
 * boundary. Must never mint a URL before `PrintProject.status ===
 * "print_ready"`, must never leak an asset id, job id, or storage key, and
 * must return the same generic 404 for every miss.
 */
describe("GET /api/projects/[projectId]/production-artwork/image (Sprint 2M Phase 2C)", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-production-artwork-route-"));
    process.chdir(tempDir);
  });

  after(async () => {
    await cleanupTempWorkspace(tempDir, previousCwd);
  });

  function buildFixturePng(size = 1024): Buffer {
    const png = new PNG({ width: size, height: size });
    const margin = Math.floor(size * 0.1);
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const idx = (size * y + x) << 2;
        const inside = x >= margin && x < size - margin && y >= margin && y < size - margin;
        png.data[idx] = 5;
        png.data[idx + 1] = 5;
        png.data[idx + 2] = 5;
        png.data[idx + 3] = inside ? 255 : 0;
      }
    }
    return PNG.sync.write(png);
  }

  async function projectAtSelectedConcept() {
    const { resetCapabilityGraphForTests, getCapabilityGraph } = await import(
      "@/capabilities/composition"
    );
    resetCapabilityGraphForTests();
    const graph = getCapabilityGraph();
    const { getProjectRepository } = await import("@/lib/db");
    const repo = getProjectRepository();
    const { createDesignBriefCapability } = await import("@/capabilities/design-brief");

    const created = await repo.createProject();
    const projectId = created.project.id;
    await repo.updateBrief(projectId, {
      productSummary: "T-shirt",
      designDescription: "A bear mascot",
      exactText: "Camp Wildwood 2026",
      shirtColor: "Navy",
      printPlacement: "sleeve",
    });
    const designBrief = createDesignBriefCapability(repo);
    const version = await designBrief.approveWorkingBrief(projectId);

    const { primary } = await graph.assets.uploadConceptImage(projectId, {
      conceptId: "concept-test",
      bytes: buildFixturePng(1024),
      contentType: "image/png",
      widthPx: 1024,
      heightPx: 1024,
      hasTransparency: true,
      providerKey: "test",
      generationJobId: null,
      metadata: {},
    });

    const [artwork] = await repo.addArtworkVersions(projectId, [
      {
        versionNumber: 1,
        kind: "concept",
        title: "Concept 1",
        summary: "x",
        placeholderLabel: "Concept 1",
        accentColor: "#000000",
        designBriefVersionId: version.id,
        primaryAssetId: primary.id,
        evaluationStatus: "passed",
        evaluation: {
          overallScore: 90,
          passed: true,
          confidence: 90,
          criteria: [
            { key: "required_wording", score: 100, passed: true, confidence: 90, notes: null },
          ],
          warnings: [],
          recommendations: [],
          missingRequirements: [],
          matchedRequirements: [],
          providerMetadata: {},
        },
        evaluationEvaluatedAt: new Date().toISOString(),
        evaluationProviderKey: "test",
      },
    ]);
    await repo.selectArtworkVersion(projectId, artwork!.id);
    // Live Acceptance Corrective Pass (Section 2): selection alone is
    // never final approval — confirm by default here.
    await repo.updateProject(projectId, { finalDirectionConfirmed: true });

    return { projectId, artworkId: artwork!.id, graph };
  }

  it("returns 404 for a project that doesn't exist", async () => {
    const { resetCapabilityGraphForTests } = await import("@/capabilities/composition");
    resetCapabilityGraphForTests();

    const { GET } = await import("./route");
    const response = await GET(new Request("http://localhost/x"), {
      params: Promise.resolve({ projectId: "00000000-0000-0000-0000-000000000000" }),
    });

    assert.equal(response.status, 404);
    assert.deepEqual(Object.keys(await response.json()), ["error"]);
  });

  it("returns 404 while merely 'preparing' (finalizing) — never exposes a URL before print_ready", async () => {
    const { projectId, artworkId, graph } = await projectAtSelectedConcept();
    const { job } = await graph.finalArtwork.requestFinalArtwork(projectId, artworkId);

    const { GET } = await import("./route");
    const response = await GET(new Request("http://localhost/x"), {
      params: Promise.resolve({ projectId }),
    });
    assert.equal(response.status, 404);

    // Cleanup only: the final-artwork worker claims the globally oldest
    // queued job (by design). Leaving this job queued would let a later
    // test's worker claim it instead of its own newly-created job, since
    // every test in this file shares one on-disk local store.
    const { getProjectRepository } = await import("@/lib/db");
    await getProjectRepository().updateFinalArtworkJob(job.id, { status: "cancelled" });
  });

  it("mints a signed URL once print-ready, and it never contains a raw asset id, job id, or storage key", async () => {
    const { projectId, artworkId, graph } = await projectAtSelectedConcept();
    await graph.finalArtwork.requestFinalArtwork(projectId, artworkId);
    await graph.finalArtworkWorker.processNextJob();

    const { getProjectRepository } = await import("@/lib/db");
    const repo = getProjectRepository();
    const project = await repo.getProject(projectId);
    assert.equal(project?.project.status, "print_ready");

    const productionAsset = (await repo.listAssets(projectId)).find(
      (a) => a.productionRole === "production_png",
    )!;

    const { GET } = await import("./route");
    const response = await GET(new Request("http://localhost/x"), {
      params: Promise.resolve({ projectId }),
    });

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(
      Object.keys(body).sort(),
      [
        "designLabel",
        // Live Acceptance Cleanup (Issue 5): the plate's own physical size
        // and resolution. Customer-safe figures read off the production
        // normalization record — still no asset id, job id, or storage key.
        "dpi",
        "filename",
        "heightIn",
        "heightPx",
        "mimeType",
        "placementLabel",
        "transparent",
        "url",
        "widthIn",
        "widthPx",
      ].sort(),
    );
    assert.equal(typeof body.url, "string");
    assert.ok(body.url.length > 0);
    assert.equal(body.mimeType, "image/png");
    assert.equal(typeof body.filename, "string");
    assert.match(body.filename, /print-ready\.png$/);
    assert.doesNotMatch(body.filename, /production\.png/);
    assert.doesNotMatch(
      JSON.stringify(body),
      /topaz|storageKey|FinalArtworkJob|providerRequest/i,
    );
    // Never the raw asset id as a discoverable identifier in the response
    // (mirrors the concept-image route's equivalent check). The storage
    // key itself is deliberately not asserted here: in the default
    // `data_uri` dev/test storage mode, the "signed URL" and the "object
    // key" are the same string by design (see
    // `DataUriAssetStorageProvider`'s doc comment) — that equivalence is
    // only ever a real leak with a production-safe backend
    // (`filesystem`/`supabase_storage`), where `getSignedUrl` returns a
    // distinct, expiring URL.
    assert.equal(body.url.includes(productionAsset.id), false);
    assert.equal(JSON.stringify(body).includes(productionAsset.id), false);
  });

  it("a different project cannot resolve another project's production artwork", async () => {
    const { projectId, artworkId, graph } = await projectAtSelectedConcept();
    await graph.finalArtwork.requestFinalArtwork(projectId, artworkId);
    await graph.finalArtworkWorker.processNextJob();

    const { projectId: otherProjectId } = await projectAtSelectedConcept();

    const { GET } = await import("./route");
    const response = await GET(new Request("http://localhost/x"), {
      params: Promise.resolve({ projectId: otherProjectId }),
    });
    assert.equal(response.status, 404);
  });
});
