import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { solidBlackExteriorArtwork, toPngBytes } from "@/capabilities/artwork-preparation/artwork-fixtures";
import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";

/**
 * Phase 27E, item 11 / Phase 28K CORRECTION.
 *
 * This file originally proved manual correction ("Edit Artwork") was
 * internal-staff-only, mirroring the separation routes' own (then-)identical
 * gate. Phase 28K's real acceptance-run audit found the same impossible
 * gate here: "Edit Artwork" is mounted directly in the ordinary customer
 * flow (`UploadedArtworkPanel.tsx`), unconditionally, as a customer action —
 * but every route behind it was denied to any non-internal owner. Phase 28K
 * widened the gate to "internal staff OR this exact project's own owner" —
 * see `isAuthorizedForArtworkCorrection`'s doc comment. This file now
 * proves both halves: an ordinary owner succeeds on their OWN project,
 * while a project id naming nothing real is still denied.
 */
describe("Correction routes — internal-staff-or-owner authorization (Phase 27E / Phase 28K)", () => {
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

  it("a project id naming nothing real is denied on every correction route with an uninformative 404", async () => {
    const nonexistentProjectId = "00000000-0000-0000-0000-000000000000";
    const results = await callRoutes(nonexistentProjectId);
    for (const [name, res] of Object.entries(results)) {
      assert.equal(res.status, 404, `${name} must be 404 for a project id naming nothing real`);
      assert.equal(await res.text(), "Not found", `${name} must not reveal any detail beyond 'Not found'`);
    }
  });

  it("Phase 28K FIX: an ordinary (non-internal) project's own owner reaches every correction route and 'Edit Artwork' functions -- the impossible gate, resolved", async () => {
    const { projectId } = await seededProject({ internal: false });
    const results = await callRoutes(projectId);
    assert.equal(results.selectRes.status, 200, "'Edit Artwork' must be usable by the owner of the artwork being edited");
    assert.equal(results.applyRes.status, 200);
    assert.equal(results.undoRes.status, 200);
    assert.equal(results.resetRes.status, 200);
    assert.equal(results.originalRes.status, 200);
    assert.equal(results.resultRes.status, 200);
    assert.equal(results.finalizeRes.status, 200);
  });

  it("two ordinary owners' correction sessions never cross-contaminate", async () => {
    const { repo: repoA, projectId: projectA } = await seededProject({ internal: false });
    const { projectId: projectB } = await seededProject({ internal: false });

    await callRoutes(projectA);

    // B's own preparation is untouched by A's correction session.
    const preparationB = await repoA.getArtworkPreparation(projectB);
    const preparationA = await repoA.getArtworkPreparation(projectA);
    assert.notEqual(preparationB!.id, preparationA!.id);
    assert.notEqual(preparationB!.preparedAssetId, null);
    // A's finalize (from callRoutes) actually repointed A's own preparedAssetId;
    // B's remains whatever its own automatic preparation produced, never A's.
    assert.notEqual(preparationB!.preparedAssetId, preparationA!.preparedAssetId);
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
