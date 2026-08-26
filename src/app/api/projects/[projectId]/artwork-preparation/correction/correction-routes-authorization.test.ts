import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { solidBlackExteriorArtwork, toPngBytes } from "@/capabilities/artwork-preparation/artwork-fixtures";
import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";

/**
 * Phase 27E, item 11: the graduated correction workspace must preserve the
 * SAME internal-only entitlement the separation routes already prove
 * (`separation-routes-authorization.test.ts`) — this phase must not
 * accidentally widen who can reach manual correction. Same harness, same
 * behavioral proof style: invoke the real exported route handlers, not the
 * hidden React controls.
 */
describe("Correction routes — internal-only authorization (Phase 27E)", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-correction-routes-"));
    process.chdir(tempDir);
  });

  after(async () => {
    await cleanupTempWorkspace(tempDir, previousCwd);
  });

  async function seededProject(options: { internal: boolean }) {
    const { resetCapabilityGraphForTests, getCapabilityGraph } = await import("@/capabilities/composition");
    resetCapabilityGraphForTests();
    const graph = getCapabilityGraph();
    const { getProjectRepository } = await import("@/lib/db");
    const repo = getProjectRepository();

    const session = await graph.acquisition.resolveOrCreateSession(null);
    if (options.internal) {
      await repo.grantInternalEntitlement(session.id);
    }
    const created = await repo.createProject(session.id);
    const projectId = created.project.id;

    await graph.artworkPreparation.uploadOriginal(projectId, {
      bytes: toPngBytes(solidBlackExteriorArtwork()),
      declaredContentType: "image/png",
      filename: "artwork.png",
    });
    await graph.artworkPreparation.setProductionContext(projectId, {
      productSummary: "T-shirts",
      productColor: "Black",
      printPlacement: "full_front",
    });
    await graph.artworkPreparation.prepareBackground(projectId);

    return { graph, repo, projectId };
  }

  async function callRoutes(projectId: string) {
    const selectRoute = await import("./select/route");
    const applyRoute = await import("./apply/route");
    const undoRoute = await import("./undo/route");
    const resetRoute = await import("./reset/route");
    const originalRoute = await import("./original/route");
    const resultRoute = await import("./result/route");
    const finalizeRoute = await import("./finalize/route");
    const params = { params: Promise.resolve({ projectId }) };

    const clickBody = JSON.stringify({ clicks: [{ x: 5, y: 5 }], mode: "restore", toleranceLevel: "default" });

    const selectRes = await selectRoute.POST(
      new Request("http://localhost/x", { method: "POST", headers: { "Content-Type": "application/json" }, body: clickBody }),
      params,
    );
    const applyRes = await applyRoute.POST(
      new Request("http://localhost/x", { method: "POST", headers: { "Content-Type": "application/json" }, body: clickBody }),
      params,
    );
    const undoRes = await undoRoute.POST(new Request("http://localhost/x", { method: "POST" }), params);
    const resetRes = await resetRoute.POST(new Request("http://localhost/x", { method: "POST" }), params);
    const originalRes = await originalRoute.GET(new Request("http://localhost/x"), params);
    const resultRes = await resultRoute.GET(new Request("http://localhost/x"), params);
    const finalizeRes = await finalizeRoute.POST(new Request("http://localhost/x", { method: "POST" }), params);

    return { selectRes, applyRes, undoRes, resetRes, originalRes, resultRes, finalizeRes };
  }

  it("a public (non-internal) project is denied on every correction route with an uninformative 404", async () => {
    const { projectId } = await seededProject({ internal: false });
    const results = await callRoutes(projectId);
    for (const [name, res] of Object.entries(results)) {
      assert.equal(res.status, 404, `${name} must be 404 for a public project`);
      assert.equal(await res.text(), "Not found", `${name} must not reveal any detail beyond 'Not found'`);
    }
  });

  it("a public project's forged apply/finalize calls persist NOTHING", async () => {
    const { repo, projectId } = await seededProject({ internal: false });
    const before = await repo.getArtworkPreparation(projectId);
    await callRoutes(projectId);
    const after = await repo.getArtworkPreparation(projectId);
    assert.equal(after!.preparedAssetId, before!.preparedAssetId, "a denied apply/finalize must never repoint preparedAssetId");
    assert.equal(after!.status, before!.status);
  });

  it("an internal project: every correction route is reachable and functions", async () => {
    const { projectId } = await seededProject({ internal: true });
    const results = await callRoutes(projectId);
    assert.equal(results.selectRes.status, 200);
    assert.equal(results.applyRes.status, 200);
    assert.equal(results.undoRes.status, 200);
    assert.equal(results.resetRes.status, 200);
    assert.equal(results.originalRes.status, 200);
    assert.equal(results.resultRes.status, 200);
    // finalizeRes: by the time it runs, reset already cleared operations
    // back to zero for this same session -- finalize with zero ops is still
    // valid (a harmless "use as-is" outcome), so this must succeed too.
    assert.equal(results.finalizeRes.status, 200);
  });
});
