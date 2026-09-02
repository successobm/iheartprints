import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { exactAspectSignArtwork, toPngBytes } from "@/capabilities/sign-preparation/sign-fixtures";
import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";

/**
 * Blocked Production Candidate Inspection Phase (real Signs acceptance
 * incident): the operator-only route for inspecting a NOT-print-ready sign
 * production candidate. Deliberately mirrors
 * `../download/route.test.ts`'s own gate/refusal coverage exactly, plus
 * the success case that route can never reach (a blocked, not-ready
 * validation) and a direct cross-check that the certified download route
 * stays refused for the identical state this route serves.
 */
describe("GET /api/internal/projects/[projectId]/sign-artwork/production-candidate", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-sign-blocked-candidate-route-"));
    process.chdir(tempDir);
  });

  after(async () => {
    await cleanupTempWorkspace(tempDir, previousCwd);
  });

  async function freshGraph() {
    const { resetCapabilityGraphForTests, getCapabilityGraph } = await import(
      "@/capabilities/composition"
    );
    resetCapabilityGraphForTests();
    const graph = getCapabilityGraph();
    const { getProjectRepository } = await import("@/lib/db");
    return { graph, repo: getProjectRepository() };
  }

  function cookieHeaderFor(sessionToken: string): { cookie: string } {
    return { cookie: `ihp_as=${sessionToken}` };
  }

  async function get(projectId: string, headers?: Record<string, string>) {
    const route = await import("./route");
    return route.GET(new Request("http://localhost/x", { headers: headers ?? {} }), {
      params: Promise.resolve({ projectId }),
    });
  }

  async function internalCookie(graph: Awaited<ReturnType<typeof freshGraph>>["graph"], repo: Awaited<ReturnType<typeof freshGraph>>["repo"]) {
    const session = await graph.acquisition.resolveOrCreateSession(null);
    await repo.grantInternalEntitlement(session.id);
    return cookieHeaderFor(session.sessionToken);
  }

  async function planAndAuthorize(
    graph: Awaited<ReturnType<typeof freshGraph>>["graph"],
    projectId: string,
  ) {
    await graph.signPreparation.uploadSignArtwork(projectId, {
      bytes: toPngBytes(exactAspectSignArtwork(1800, 2400)),
      declaredContentType: "image/png",
      filename: "sign.png",
    });
    await graph.signPreparation.confirmSignProductionSpec(projectId, 12, 16);
    await graph.signPreparation.planSignRepair(projectId);
    await graph.signPreparation.authorizeSignRepairPlan(projectId, { authorizedBy: "operator" });
    const { job } = await graph.finalArtwork.requestSignFinalArtwork(projectId);
    return job;
  }

  it("no cookie at all — 403, before the project is ever looked at", async () => {
    const { repo } = await freshGraph();
    const projectId = (await repo.createProject()).project.id;
    const res = await get(projectId);
    assert.equal(res.status, 403);
  });

  it("an ordinary customer session cannot inspect through this route", async () => {
    const { graph, repo } = await freshGraph();
    const projectId = (await repo.createProject()).project.id;
    const ordinarySession = await graph.acquisition.resolveOrCreateSession(null);
    const res = await get(projectId, cookieHeaderFor(ordinarySession.sessionToken));
    assert.equal(res.status, 403);
  });

  it("no sign preparation at all: a valid internal session still gets a plain 404, not a leak", async () => {
    const { graph, repo } = await freshGraph();
    const projectId = (await repo.createProject()).project.id;
    const res = await get(projectId, await internalCookie(graph, repo));
    assert.equal(res.status, 404);
  });

  it("no job yet: 404", async () => {
    const { graph, repo } = await freshGraph();
    const projectId = (await repo.createProject()).project.id;
    await graph.signPreparation.uploadSignArtwork(projectId, {
      bytes: toPngBytes(exactAspectSignArtwork(1800, 2400)),
      declaredContentType: "image/png",
      filename: "sign.png",
    });
    await graph.signPreparation.confirmSignProductionSpec(projectId, 12, 16);
    await graph.signPreparation.planSignRepair(projectId);
    await graph.signPreparation.authorizeSignRepairPlan(projectId, { authorizedBy: "operator" });

    const res = await get(projectId, await internalCookie(graph, repo));
    assert.equal(res.status, 404);
  });

  it("a job with a READY validation: 404 — a certified asset is never served through this route", async () => {
    const { graph, repo } = await freshGraph();
    const projectId = (await repo.createProject()).project.id;
    const job = await planAndAuthorize(graph, projectId);
    const asset = await graph.assets.uploadProductionAsset(projectId, {
      conceptId: `sign-${job.id}-ready`,
      bytes: toPngBytes(exactAspectSignArtwork(1800, 2400)),
      contentType: "image/png",
      widthPx: 1800,
      heightPx: 2400,
      hasTransparency: false,
      finalArtworkJobId: job.id,
      productionRole: "production_png",
      metadata: {},
    });
    await repo.createProductionAssetValidation(projectId, {
      finalArtworkJobId: job.id,
      assetId: asset.id,
      status: "ready",
      report: {},
    });
    await repo.updateFinalArtworkJob(job.id, { status: "completed", completedAt: new Date(0).toISOString() });

    const res = await get(projectId, await internalCookie(graph, repo));
    assert.equal(res.status, 404);
  });

  it("a job with a blocking validation: 200, exact bytes, blocked headers/filename, no state mutation", async () => {
    const { graph, repo } = await freshGraph();
    const projectId = (await repo.createProject()).project.id;
    const job = await planAndAuthorize(graph, projectId);
    const bytes = toPngBytes(exactAspectSignArtwork(1800, 2400));
    const blockedAsset = await graph.assets.uploadProductionAsset(projectId, {
      conceptId: `sign-${job.id}-blocked`,
      bytes,
      contentType: "image/png",
      widthPx: 1800,
      heightPx: 2400,
      hasTransparency: false,
      finalArtworkJobId: job.id,
      productionRole: "production_png",
      metadata: {},
    });
    await repo.createProductionAssetValidation(projectId, {
      finalArtworkJobId: job.id,
      assetId: blockedAsset.id,
      status: "finalization_required",
      report: {},
    });
    await repo.updateFinalArtworkJob(job.id, { status: "completed", completedAt: new Date(0).toISOString() });

    const beforeJob = await repo.getFinalArtworkJob(job.id);
    const beforeProject = await repo.getProject(projectId);

    const res = await get(projectId, await internalCookie(graph, repo));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-iheartprints-production-status"), "blocked_requires_review");
    assert.equal(res.headers.get("cache-control"), "no-store");
    const disposition = res.headers.get("content-disposition") ?? "";
    assert.match(disposition, /BLOCKED-NOT-PRINT-READY-/, "filename must carry the required blocked prefix");
    // The only "print ready"-shaped substring allowed anywhere in the
    // filename is as part of the negation "NOT-PRINT-READY" itself.
    assert.doesNotMatch(
      disposition.replace(/BLOCKED-NOT-PRINT-READY-/g, ""),
      /print-ready/i,
      "must never carry filename language implying Print Ready outside the required negation",
    );

    const served = Buffer.from(await res.arrayBuffer());
    assert.ok(served.equals(bytes), "served bytes are exactly the blocked candidate's real bytes");

    const afterJob = await repo.getFinalArtworkJob(job.id);
    const afterProject = await repo.getProject(projectId);
    assert.deepEqual(afterJob, beforeJob, "no job mutation from viewing the candidate");
    assert.deepEqual(afterProject, beforeProject, "no project mutation from viewing the candidate");
  });

  it("the certified download route stays refused for the identical state this route serves", async () => {
    const { graph, repo } = await freshGraph();
    const projectId = (await repo.createProject()).project.id;
    const job = await planAndAuthorize(graph, projectId);
    const blockedAsset = await graph.assets.uploadProductionAsset(projectId, {
      conceptId: `sign-${job.id}-blocked-cross-check`,
      bytes: toPngBytes(exactAspectSignArtwork(1800, 2400)),
      contentType: "image/png",
      widthPx: 1800,
      heightPx: 2400,
      hasTransparency: false,
      finalArtworkJobId: job.id,
      productionRole: "production_png",
      metadata: {},
    });
    await repo.createProductionAssetValidation(projectId, {
      finalArtworkJobId: job.id,
      assetId: blockedAsset.id,
      status: "finalization_required",
      report: {},
    });
    await repo.updateFinalArtworkJob(job.id, { status: "completed", completedAt: new Date(0).toISOString() });

    const cookie = await internalCookie(graph, repo);
    const blockedRes = await get(projectId, cookie);
    assert.equal(blockedRes.status, 200);

    const downloadRoute = await import("../download/route");
    const certifiedRes = await downloadRoute.GET(new Request("http://localhost/x", { headers: cookie }), {
      params: Promise.resolve({ projectId }),
    });
    assert.equal(certifiedRes.status, 404, "the certified route never serves a blocked candidate");
  });

  it("an internal session cannot reach another project's data by forging the id — a garbage id is 404", async () => {
    const { graph, repo } = await freshGraph();
    const res = await get("00000000-0000-0000-0000-000000000000", await internalCookie(graph, repo));
    assert.equal(res.status, 404);
  });
});
