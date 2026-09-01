import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import {
  exactAspectSignArtwork,
  ruthLikeSignArtwork,
  toPngBytes,
} from "@/capabilities/sign-preparation/sign-fixtures";
import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";

/**
 * LIVE PRODUCT BLOCKER #4B: the operator's "Prepare artwork" action,
 * through the real route handler. Mirrors `sign-artwork/authorize/route
 * .test.ts` (operator variant)'s own session-gate proof; the authorization
 * gate itself (unauthorized/stale plan refusals) is `requestSignFinalArtwork`'s
 * own — already exhaustively proven in `sign-final-artwork.test.ts`'s
 * "enqueue gate" suite — this file proves the ROUTE wires to it correctly
 * and adds this phase's own new guarantees (idempotency through the HTTP
 * layer, and a full route→job→worker→download round trip). Local
 * persistence only; never the configured live project. Zero Topaz/OpenAI
 * calls — every fixture here needs no provider dispatch at all.
 */
describe("POST /api/internal/projects/[projectId]/sign-artwork/prepare", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-sign-prepare-"));
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

  it("unauthorized review_required plan cannot prepare — refused before any job exists", async () => {
    const { graph, repo } = await freshGraph();
    const projectId = (await repo.createProject()).project.id;
    await graph.signPreparation.uploadSignArtwork(projectId, {
      bytes: toPngBytes(ruthLikeSignArtwork()),
      declaredContentType: "image/png",
      filename: "sign.png",
    });
    await graph.signPreparation.confirmSignProductionSpec(projectId, 18, 24);
    const outcome = await graph.signPreparation.planSignRepair(projectId);
    assert.equal(outcome.result.plan!.overallRisk, "review_required");
    // Deliberately never authorized.

    const res = await post(projectId, await internalCookie(graph, repo));
    assert.equal(res.status, 409);

    const jobs = await repo.listFinalArtworkJobsForSignPreparation(projectId, outcome.preparation.id);
    assert.equal(jobs.length, 0, "no job was ever created for an unauthorized plan");
  });

  it("stale authorization (plan changed since it was authorized) cannot prepare", async () => {
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
    // A genuinely different ordered size re-plans this preparation — a new
    // planKey, with the OLD authorization now stale.
    await graph.signPreparation.confirmSignProductionSpec(projectId, 18, 24);
    await graph.signPreparation.planSignRepair(projectId);

    const res = await post(projectId, await internalCookie(graph, repo));
    assert.equal(res.status, 409);
  });

  it("a valid operator-authorized plan can request preparation", async () => {
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

    const res = await post(projectId, await internalCookie(graph, repo));
    assert.equal(res.status, 200);
    const body = (await res.json()) as { jobId: string; jobStatus: string; alreadyRequested: boolean };
    assert.ok(body.jobId);
    assert.equal(body.alreadyRequested, false);

    const project = await repo.getProject(projectId);
    assert.equal(project!.project.status, "finalizing");
  });

  it("double click / reload: reuses the SAME job — one FinalArtworkJob per (sign preparation, plan key)", async () => {
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

    const cookie = await internalCookie(graph, repo);
    const first = await post(projectId, cookie);
    const firstBody = (await first.json()) as { jobId: string; alreadyRequested: boolean };
    assert.equal(firstBody.alreadyRequested, false);

    const second = await post(projectId, cookie);
    assert.equal(second.status, 200);
    const secondBody = (await second.json()) as { jobId: string; alreadyRequested: boolean };
    assert.equal(secondBody.jobId, firstBody.jobId, "the exact same job — never a duplicate");
    assert.equal(secondBody.alreadyRequested, true);

    const preparation = await graph.signPreparation.getSignPreparation(projectId);
    const jobs = await repo.listFinalArtworkJobsForSignPreparation(projectId, preparation!.id);
    assert.equal(jobs.length, 1, "exactly one job exists for this preparation");
  });

  it("returns 404 for a project that does not exist", async () => {
    const { graph, repo } = await freshGraph();
    const res = await post("00000000-0000-0000-0000-000000000000", await internalCookie(graph, repo));
    assert.equal(res.status, 404);
  });

  it("END TO END: prepare → real worker batch → print_ready → the operator can download the ACTUAL corrected PNG", async () => {
    const { graph, repo } = await freshGraph();
    const projectId = (await repo.createProject()).project.id;
    // A genuine repair (aspect-mismatch canvas extension) — needs no
    // provider at all, so this proves the full real pipeline safely.
    const { uniformBackgroundSignArtwork } = await import("@/capabilities/sign-preparation/sign-fixtures");
    await graph.signPreparation.uploadSignArtwork(projectId, {
      bytes: toPngBytes(uniformBackgroundSignArtwork(1000, 1500)),
      declaredContentType: "image/png",
      filename: "customer-sign.png",
    });
    await graph.signPreparation.confirmSignProductionSpec(projectId, 8, 10);
    const outcome = await graph.signPreparation.planSignRepair(projectId);
    const plan = outcome.result.plan!;
    assert.deepEqual(plan.steps.map((s) => s.kind), ["extend_uniform_background"]);
    await graph.signPreparation.authorizeSignRepairPlan(projectId, { authorizedBy: "operator" });

    const cookie = await internalCookie(graph, repo);
    const prepareRes = await post(projectId, cookie);
    assert.equal(prepareRes.status, 200);

    // Interactive-dev's own real local trigger fires asynchronously (fire-
    // and-forget) — run the same scheduler synchronously here for a
    // deterministic test rather than racing it.
    await graph.finalArtworkScheduler.runBatch();

    const project = await repo.getProject(projectId);
    assert.equal(project!.project.status, "print_ready", "the real engine actually repaired this artwork");

    const { GET: downloadRoute } = await import("../download/route");
    const downloadRes = await downloadRoute(new Request("http://localhost/x", { headers: cookie }), {
      params: Promise.resolve({ projectId }),
    });
    assert.equal(downloadRes.status, 200);
    assert.equal(downloadRes.headers.get("content-type"), "image/png");
    assert.match(downloadRes.headers.get("content-disposition") ?? "", /attachment/);
    assert.match(downloadRes.headers.get("content-disposition") ?? "", /customer-sign/);

    const bytes = Buffer.from(await downloadRes.arrayBuffer());
    assert.ok(bytes.length > 0, "the actual corrected PNG bytes are downloadable");
    // The downloaded file's own dimensions are the REPAIRED geometry, not
    // the original 1000x1500 upload.
    const { PNG } = await import("pngjs");
    const decoded = PNG.sync.read(bytes);
    assert.equal(decoded.width, plan.expectedOutputWidthPx);
    assert.equal(decoded.height, plan.expectedOutputHeightPx);
  });
});
