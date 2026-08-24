import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { denseBlackCompositionArtwork, toPngBytes } from "@/capabilities/artwork-preparation/artwork-fixtures";
import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";

/**
 * PHASE 16: complex-background → operator separation routing.
 *
 * The production defect this phase fixes: `prepareBackground` THROWS for
 * any artwork `classifyRepairability` marks `NEEDS_REVIEW` (a complex/
 * ambiguous background) — so a project stuck in that classification NEVER
 * gets a `preparedAssetId`, and the OLD UI-orchestration bug meant
 * `SeparationReviewPanel` was only ever mounted once one existed. This file
 * proves, at the REAL route layer (not a UI mock), that the backend has
 * ALWAYS been able to serve `getSeparationReview` for exactly this artwork
 * with NO prepared asset ever created — deliberately never calling
 * `prepareBackground` at all, mirroring the real production sequence byte
 * for byte. The fix (Phase 16) is client-side orchestration only; this file
 * is the server-side half of the proof that the orchestration change is
 * actually landing on solid ground.
 */
describe("Phase 16: complex-background artwork reaches separation review without a prepared asset", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-phase16-routing-"));
    process.chdir(tempDir);
  });

  after(async () => {
    await cleanupTempWorkspace(tempDir, previousCwd);
  });

  async function seededComplexBackgroundProject(options: { internal: boolean }) {
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
      bytes: toPngBytes(denseBlackCompositionArtwork()),
      declaredContentType: "image/png",
      filename: "complex-background.png",
    });
    await graph.artworkPreparation.setProductionContext(projectId, {
      productSummary: "T-shirts",
      productColor: "White",
      printPlacement: "full_front",
    });

    // Deliberately NOT calling prepareBackground — it would throw for this
    // classification (canPrepareAutomatically === false), and never doing
    // so is exactly the real production sequence this defect occurred in.

    return { graph, repo, projectId };
  }

  it("H0: this fixture genuinely classifies NEEDS_REVIEW with no prepared asset — the exact stuck state the defect describes", async () => {
    const { graph, projectId } = await seededComplexBackgroundProject({ internal: true });
    const view = await graph.artworkPreparation.getPreparation(projectId);
    assert.ok(view);
    assert.equal(view!.classification, "NEEDS_REVIEW");
    assert.equal(view!.customer.canPrepare, false);
    assert.equal(view!.customer.prepareActionLabel, null);
    assert.equal(view!.hasPreparedArtwork, false);
    assert.match(
      view!.customer.backgroundMessage,
      /Your background is complex/,
    );
  });

  it("D0: prepareBackground still throws for this artwork — Phase 16 does not weaken that refusal", async () => {
    const { graph, projectId } = await seededComplexBackgroundProject({ internal: true });
    await assert.rejects(() => graph.artworkPreparation.prepareBackground(projectId));
  });

  it("A: an INTERNAL project reaches a real, presentable separation review — review_required, consequential regions present, with NO prepared asset ever created", async () => {
    const { projectId } = await seededComplexBackgroundProject({ internal: true });
    const getRoute = await import("./route");
    const params = { params: Promise.resolve({ projectId }) };

    const res = await getRoute.GET(new Request("http://localhost/x"), params);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      state: string;
      regionMap: { consequentialRegions: Array<{ regionId: number }> };
    };
    assert.equal(body.state, "review_required");
    assert.equal(body.regionMap.consequentialRegions.length, 2, "the disconnected ellipse and the enclosed hole");
  });

  it("B: a PUBLIC (non-internal) project with the identical artwork gets the same uninformative 404 — existing conservative behavior is unchanged", async () => {
    const { projectId } = await seededComplexBackgroundProject({ internal: false });
    const getRoute = await import("./route");
    const params = { params: Promise.resolve({ projectId }) };

    const res = await getRoute.GET(new Request("http://localhost/x"), params);
    assert.equal(res.status, 404);
    assert.equal(await res.text(), "Not found");
  });

  it("H: entering separation review never itself submits a decision or writes anything — repeated GETs return an identical, still-pristine view", async () => {
    const { projectId } = await seededComplexBackgroundProject({ internal: true });
    const getRoute = await import("./route");
    const params = { params: Promise.resolve({ projectId }) };

    const first = await (await getRoute.GET(new Request("http://localhost/x"), params)).json();
    const second = await (await getRoute.GET(new Request("http://localhost/x"), params)).json();
    assert.deepEqual(first, second);
    assert.equal((first as { decisions: unknown[] }).decisions.length, 0);
    assert.equal((first as { pendingRegionIds: number[] }).pendingRegionIds.length, 2);
  });

  it("I: entering separation review never itself approves anything — isProductionAuthoritative stays false with zero decisions made", async () => {
    const { projectId } = await seededComplexBackgroundProject({ internal: true });
    const getRoute = await import("./route");
    const params = { params: Promise.resolve({ projectId }) };
    const view = (await (await getRoute.GET(new Request("http://localhost/x"), params)).json()) as {
      isProductionAuthoritative: boolean;
      approvedAt: string | null;
    };
    assert.equal(view.isProductionAuthoritative, false);
    assert.equal(view.approvedAt, null);
  });
});
