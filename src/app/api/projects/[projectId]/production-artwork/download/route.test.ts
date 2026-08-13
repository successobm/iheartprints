import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { PNG } from "pngjs";

import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";

/**
 * Customer download boundary for print-ready production artwork.
 * Same authorization as the preview route; Content-Disposition must carry
 * a sanitized customer filename — never a storage path or internal id.
 */
describe("GET /api/projects/[projectId]/production-artwork/download", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-production-download-route-"));
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
      exactText: "1988 Toyota MR2",
      shirtColor: "Navy",
      // Sleeve: native 1024² already meets target → print_ready with local
      // raster (full_front would require interpolated upscale → needs_review).
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
    await repo.updateProject(projectId, { finalDirectionConfirmed: true });

    return { projectId, artworkId: artwork!.id, graph, repo };
  }

  it("returns 404 for a missing project", async () => {
    const { resetCapabilityGraphForTests } = await import("@/capabilities/composition");
    resetCapabilityGraphForTests();

    const { GET } = await import("./route");
    const response = await GET(new Request("http://localhost/x"), {
      params: Promise.resolve({ projectId: "00000000-0000-0000-0000-000000000000" }),
    });
    assert.equal(response.status, 404);
  });

  it("O/P: cross-project and pre-print_ready access are denied with generic 404", async () => {
    const { projectId, artworkId, graph } = await projectAtSelectedConcept();
    await graph.finalArtwork.requestFinalArtwork(projectId, artworkId);
    await graph.finalArtworkWorker.processNextJob();

    const { projectId: otherProjectId } = await projectAtSelectedConcept();
    const { GET } = await import("./route");

    const cross = await GET(new Request("http://localhost/x"), {
      params: Promise.resolve({ projectId: otherProjectId }),
    });
    assert.equal(cross.status, 404);

    const missing = await GET(new Request("http://localhost/x"), {
      params: Promise.resolve({ projectId: "11111111-1111-1111-1111-111111111111" }),
    });
    assert.equal(missing.status, 404);
  });

  it("streams bytes with a sanitized Content-Disposition filename and no internals", async () => {
    const { projectId, artworkId, graph, repo } = await projectAtSelectedConcept();
    await graph.finalArtwork.requestFinalArtwork(projectId, artworkId);
    await graph.finalArtworkWorker.processNextJob();

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
    assert.match(response.headers.get("content-type") ?? "", /image\/png/i);
    const disposition = response.headers.get("content-disposition") ?? "";
    assert.match(disposition, /attachment/);
    assert.match(disposition, /1988-toyota-mr2-print-ready\.png/);
    assert.doesNotMatch(disposition, /production\.png/);
    assert.doesNotMatch(disposition, new RegExp(productionAsset.id, "i"));
    assert.doesNotMatch(disposition, /design-assets|storageKey|topaz/i);

    const bodyText = await response.text();
    // Binary PNG — response should not be a JSON leak of internals.
    assert.doesNotMatch(bodyText, /"storageKey"|"assetId"|"providerKey"/);
  });

  it("M: reopening via supersede does not delete the completed production asset", async () => {
    const { projectId, artworkId, graph, repo } = await projectAtSelectedConcept();
    await graph.finalArtwork.requestFinalArtwork(projectId, artworkId);
    await graph.finalArtworkWorker.processNextJob();

    const before = (await repo.listAssets(projectId)).filter(
      (a) => a.productionRole === "production_png",
    );
    assert.equal(before.length, 1);

    // Simulate the revision-path supersession that Make Another Change
    // eventually triggers when the customer submits a real change — not
    // on page load, and not on the UI reopen flag alone.
    await repo.supersedeActiveFinalDirectionApproval(projectId);

    const after = (await repo.listAssets(projectId)).filter(
      (a) => a.productionRole === "production_png",
    );
    assert.equal(after.length, 1);
    assert.equal(after[0]!.id, before[0]!.id);
  });
});
