import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { exactAspectSignArtwork, toPngBytes } from "@/capabilities/sign-preparation/sign-fixtures";
import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";

/**
 * Post-Provider Resume Phase (real Signs acceptance incident): the
 * operator's "Resume from persisted intermediate" action, through the real
 * route handler. Deliberately narrower in scope than a full end-to-end
 * test — mirrors `resume-existing-result/route.test.ts`'s own identical
 * scope decision exactly: THIS route's genuinely new logic is the session
 * gate + precondition-refusal wiring (proven exhaustively here); the
 * capability's own reclaim/resume/zero-provider-contact behavior is already
 * exhaustively proven at the capability layer in
 * `post-provider-resume.test.ts`, which injects throwing provider doubles
 * — the REAL capability graph this route uses resolves its provider from
 * live configuration, so a genuinely successful "attempted" resume is not
 * exercised here. Zero Topaz/OpenAI calls — every case here is refused
 * before any provider is ever reached.
 */
describe("POST /api/internal/projects/[projectId]/sign-artwork/resume-from-intermediate", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-sign-resume-from-intermediate-"));
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

  async function internalCookie(graph: Awaited<ReturnType<typeof freshGraph>>["graph"], repo: Awaited<ReturnType<typeof freshGraph>>["repo"]) {
    const session = await graph.acquisition.resolveOrCreateSession(null);
    await repo.grantInternalEntitlement(session.id);
    return cookieHeaderFor(session.sessionToken);
  }

  async function post(projectId: string, headers?: Record<string, string>) {
    const route = await import("./route");
    return route.POST(
      new Request("http://localhost/x", { method: "POST", headers: headers ?? {} }),
      { params: Promise.resolve({ projectId }) },
    );
  }

  it("no cookie at all — 403, before the project is ever looked at", async () => {
    const { graph, repo } = await freshGraph();
    const projectId = (await repo.createProject()).project.id;
    await graph.signPreparation.uploadSignArtwork(projectId, {
      bytes: toPngBytes(exactAspectSignArtwork(1800, 2400)),
      declaredContentType: "image/png",
      filename: "sign.png",
    });

    const res = await post(projectId);
    assert.equal(res.status, 403);
  });

  it("no sign preparation for the project — refused with the exact reason, never a raw error", async () => {
    const { graph, repo } = await freshGraph();
    const projectId = (await repo.createProject()).project.id;

    const res = await post(projectId, await internalCookie(graph, repo));
    assert.equal(res.status, 409);
    const body = (await res.json()) as { outcome: string; reason: string };
    assert.equal(body.outcome, "refused");
    assert.equal(body.reason, "no_sign_preparation");
  });

  it("no plan yet — refused, never creates a job", async () => {
    const { graph, repo } = await freshGraph();
    const projectId = (await repo.createProject()).project.id;
    await graph.signPreparation.uploadSignArtwork(projectId, {
      bytes: toPngBytes(exactAspectSignArtwork(1800, 2400)),
      declaredContentType: "image/png",
      filename: "sign.png",
    });
    // Deliberately never confirmed a spec or planned.

    const res = await post(projectId, await internalCookie(graph, repo));
    assert.equal(res.status, 409);
    const body = (await res.json()) as { outcome: string; reason: string };
    assert.equal(body.outcome, "refused");
    assert.equal(body.reason, "no_plan");
  });

  it("a planned, authorized, but never-run preparation — refused (no matching job exists yet)", async () => {
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
    // Deliberately never called prepare/processNextJob — no FinalArtworkJob exists.

    const res = await post(projectId, await internalCookie(graph, repo));
    assert.equal(res.status, 409);
    const body = (await res.json()) as { outcome: string; reason: string };
    assert.equal(body.outcome, "refused");
    assert.equal(body.reason, "no_matching_job");
  });

  it("returns 409 for a project that does not exist (this route never creates anything, so this is a refusal, not a 404)", async () => {
    const { graph, repo } = await freshGraph();
    const res = await post("00000000-0000-0000-0000-000000000000", await internalCookie(graph, repo));
    assert.equal(res.status, 409);
    const body = (await res.json()) as { outcome: string; reason: string };
    assert.equal(body.outcome, "refused");
    assert.equal(body.reason, "no_sign_preparation");
  });

  it("a job that already completed successfully — refused (status is not reclaimable)", async () => {
    const { graph, repo } = await freshGraph();
    const projectId = (await repo.createProject()).project.id;
    const { uniformBackgroundSignArtwork } = await import("@/capabilities/sign-preparation/sign-fixtures");
    await graph.signPreparation.uploadSignArtwork(projectId, {
      bytes: toPngBytes(uniformBackgroundSignArtwork(1000, 1500)),
      declaredContentType: "image/png",
      filename: "customer-sign.png",
    });
    await graph.signPreparation.confirmSignProductionSpec(projectId, 8, 10);
    await graph.signPreparation.planSignRepair(projectId);
    await graph.signPreparation.authorizeSignRepairPlan(projectId, { authorizedBy: "operator" });

    const cookie = await internalCookie(graph, repo);
    const prepareRoute = await import("../prepare/route");
    await prepareRoute.POST(new Request("http://localhost/x", { method: "POST", headers: cookie }), {
      params: Promise.resolve({ projectId }),
    });
    await graph.finalArtworkScheduler.runBatch();

    const project = await repo.getProject(projectId);
    assert.equal(project!.project.status, "print_ready", "sanity: this fixture needs no provider and genuinely completes");

    const res = await post(projectId, cookie);
    assert.equal(res.status, 409);
    const body = (await res.json()) as { outcome: string; reason: string };
    assert.equal(body.outcome, "refused");
    assert.equal(body.reason, "job_status_not_reclaimable");
  });
});
