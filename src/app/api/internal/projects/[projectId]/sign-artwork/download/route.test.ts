import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { exactAspectSignArtwork, toPngBytes } from "@/capabilities/sign-preparation/sign-fixtures";
import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";

/**
 * LIVE PRODUCT BLOCKER #4B: the operator download for the real,
 * authoritative corrected PNG. The positive, full round-trip case (prepare
 * → real worker → print_ready → download the actual repaired bytes) is
 * proven end-to-end in `../prepare/route.test.ts` — this file focuses on
 * the gate and the "nothing to download yet" refusals.
 */
describe("GET /api/internal/projects/[projectId]/sign-artwork/download", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-sign-download-"));
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

  it("no cookie at all — 403", async () => {
    const { repo } = await freshGraph();
    const projectId = (await repo.createProject()).project.id;
    const res = await get(projectId);
    assert.equal(res.status, 403);
  });

  it("an ordinary customer session cannot download through this route", async () => {
    const { graph, repo } = await freshGraph();
    const projectId = (await repo.createProject()).project.id;
    const ordinarySession = await graph.acquisition.resolveOrCreateSession(null);

    const res = await get(projectId, cookieHeaderFor(ordinarySession.sessionToken));
    assert.equal(res.status, 403);
  });

  it("no sign preparation at all: a valid internal session still gets a plain 404, not a leak", async () => {
    const { graph, repo } = await freshGraph();
    const projectId = (await repo.createProject()).project.id;
    const internalSession = await graph.acquisition.resolveOrCreateSession(null);
    await repo.grantInternalEntitlement(internalSession.id);

    const res = await get(projectId, cookieHeaderFor(internalSession.sessionToken));
    assert.equal(res.status, 404);
  });

  it("planned, authorized, but never prepared: 404 — no job, nothing to download", async () => {
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

    const internalSession = await graph.acquisition.resolveOrCreateSession(null);
    await repo.grantInternalEntitlement(internalSession.id);
    const res = await get(projectId, cookieHeaderFor(internalSession.sessionToken));
    assert.equal(res.status, 404);
  });

  it("prepared but still in flight (never claimed): 404 — never serves a partially-produced file", async () => {
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
    await graph.finalArtwork.requestSignFinalArtwork(projectId);
    // Deliberately never run the worker/scheduler.

    const internalSession = await graph.acquisition.resolveOrCreateSession(null);
    await repo.grantInternalEntitlement(internalSession.id);
    const res = await get(projectId, cookieHeaderFor(internalSession.sessionToken));
    assert.equal(res.status, 404);
  });

  it("an internal session cannot reach another project's data by forging the id — a garbage id is 404", async () => {
    const { graph, repo } = await freshGraph();
    const internalSession = await graph.acquisition.resolveOrCreateSession(null);
    await repo.grantInternalEntitlement(internalSession.id);

    const res = await get("00000000-0000-0000-0000-000000000000", cookieHeaderFor(internalSession.sessionToken));
    assert.equal(res.status, 404);
  });

  it("prepared and genuinely print-ready (all required checks present and passing): 200, real bytes served", async () => {
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
    await graph.finalArtwork.requestSignFinalArtwork(projectId);
    await graph.finalArtworkScheduler.runBatch();
    const project = await repo.getProject(projectId);
    assert.equal(project!.project.status, "print_ready", "sanity: this fixture must genuinely reach print_ready");

    const internalSession = await graph.acquisition.resolveOrCreateSession(null);
    await repo.grantInternalEntitlement(internalSession.id);
    const res = await get(projectId, cookieHeaderFor(internalSession.sessionToken));
    assert.equal(res.status, 200);
    const bytes = Buffer.from(await res.arrayBuffer());
    assert.ok(bytes.length > 0, "must actually serve real bytes, not an empty body");
  });

  it("Sign Production Review Print-Ready Authority Repair: a validation whose status literally reads \"ready\" but is missing a currently-required check (the real historical Get Hibachi shape) fails closed — 404, never serves the stale-ready file", async () => {
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
    const { job } = await graph.finalArtwork.requestSignFinalArtwork(projectId);
    await graph.finalArtworkScheduler.runBatch();
    const project = await repo.getProject(projectId);
    assert.equal(project!.project.status, "print_ready", "sanity: must genuinely reach print_ready first");

    const validation = await repo.getLatestProductionAssetValidationForJob(projectId, job.id);
    assert.ok(validation);
    const checks = (validation!.report as { checks: Array<Record<string, unknown>> }).checks;
    const staleChecks = checks.filter((c) => c.check !== "physical_resolution_metadata");
    await repo.createProductionAssetValidation(projectId, {
      finalArtworkJobId: job.id,
      assetId: validation!.assetId,
      status: "ready",
      report: { ...validation!.report, checks: staleChecks },
    });

    const internalSession = await graph.acquisition.resolveOrCreateSession(null);
    await repo.grantInternalEntitlement(internalSession.id);
    const res = await get(projectId, cookieHeaderFor(internalSession.sessionToken));
    assert.equal(res.status, 404, "a stale 'ready' validation missing a currently-required check must never be served as print-ready");
  });

  it("candidate changed after a previously-passing validation: a newer, never-validated asset on the same job never becomes the download — the OLD validated bytes keep serving", async () => {
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
    const { job } = await graph.finalArtwork.requestSignFinalArtwork(projectId);
    await graph.finalArtworkScheduler.runBatch();
    const validation = await repo.getLatestProductionAssetValidationForJob(projectId, job.id);
    assert.ok(validation);
    const originalBytes = await graph.assets.downloadAssetBytes(validation!.assetId);
    assert.ok(originalBytes);

    await graph.assets.uploadProductionAsset(projectId, {
      conceptId: `sign-${job.id}-candidate-changed-${Date.now()}`,
      bytes: toPngBytes(exactAspectSignArtwork(1800, 2400)),
      contentType: "image/png",
      widthPx: 1800,
      heightPx: 2400,
      hasTransparency: false,
      finalArtworkJobId: job.id,
      productionRole: "production_png",
      metadata: {},
    });

    const internalSession = await graph.acquisition.resolveOrCreateSession(null);
    await repo.grantInternalEntitlement(internalSession.id);
    const res = await get(projectId, cookieHeaderFor(internalSession.sessionToken));
    assert.equal(res.status, 200);
    const servedBytes = Buffer.from(await res.arrayBuffer());
    assert.ok(servedBytes.equals(originalBytes!.bytes), "must keep serving the OLD validated bytes, never the newer unvalidated candidate");
  });
});
