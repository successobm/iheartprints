import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { exactAspectSignArtwork, toPngBytes } from "@/capabilities/sign-preparation/sign-fixtures";
import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";

/**
 * Signs QR Visual Revision Acceptance: "Approve revised artwork" — the
 * server-side gate. Mirrors `download/route.test.ts` and `authorize/route
 * .test.ts`'s own established patterns exactly: the requester's OWN
 * session must be verified internal right now, and no client input other
 * than the project id in the URL is ever accepted (no request body is even
 * read — see `sign-candidate-visual-acceptance-service.test.ts`... this
 * file's sibling coverage for the identity-resolution proof; here only the
 * route-level session gate and error-status mapping are proven).
 */
describe("POST /api/internal/projects/[projectId]/sign-artwork/visual-acceptance", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-sign-visual-acceptance-route-"));
    process.chdir(tempDir);
  });

  after(async () => {
    await cleanupTempWorkspace(tempDir, previousCwd);
  });

  async function freshGraph() {
    const { resetCapabilityGraphForTests, getCapabilityGraph } = await import("@/capabilities/composition");
    resetCapabilityGraphForTests();
    const graph = getCapabilityGraph();
    const { getProjectRepository } = await import("@/lib/db");
    return { graph, repo: getProjectRepository() };
  }

  function cookieHeaderFor(sessionToken: string): { cookie: string } {
    return { cookie: `ihp_as=${sessionToken}` };
  }

  async function post(projectId: string, headers?: Record<string, string>) {
    const route = await import("./route");
    return route.POST(new Request("http://localhost/x", { method: "POST", headers: headers ?? {} }), {
      params: Promise.resolve({ projectId }),
    });
  }

  async function internalSessionHeaders(graph: Awaited<ReturnType<typeof freshGraph>>["graph"], repo: Awaited<ReturnType<typeof freshGraph>>["repo"]) {
    const session = await graph.acquisition.resolveOrCreateSession(null);
    await repo.grantInternalEntitlement(session.id);
    return cookieHeaderFor(session.sessionToken);
  }

  it("no cookie at all — 403", async () => {
    const { repo } = await freshGraph();
    const projectId = (await repo.createProject()).project.id;
    const res = await post(projectId);
    assert.equal(res.status, 403);
  });

  it("an ordinary (non-internal) session — 403", async () => {
    const { graph, repo } = await freshGraph();
    const projectId = (await repo.createProject()).project.id;
    const customerSession = await graph.acquisition.resolveOrCreateSession(null);
    const res = await post(projectId, cookieHeaderFor(customerSession.sessionToken));
    assert.equal(res.status, 403);
  });

  it("a valid internal session, but no sign artwork uploaded at all for this project — 404", async () => {
    const { graph, repo } = await freshGraph();
    const projectId = (await repo.createProject()).project.id;
    const headers = await internalSessionHeaders(graph, repo);
    const res = await post(projectId, headers);
    assert.equal(res.status, 404);
  });

  it("a valid internal session, sign artwork exists but nothing has ever required visual acceptance — 409, never invents an identity to approve", async () => {
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
    const headers = await internalSessionHeaders(graph, repo);

    const res = await post(projectId, headers);
    assert.equal(res.status, 409);
  });

  it("a valid internal session with a genuine QR-replaced candidate pending — 200, approves the exact current candidate", async () => {
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

    const preparation = await repo.getSignPreparation(projectId);
    const jobs = await repo.listFinalArtworkJobsForSignPreparation(projectId, preparation!.id);
    const job = jobs[0]!;
    const baseValidation = await repo.getLatestProductionAssetValidationForJob(projectId, job.id);
    assert.ok(baseValidation);

    const qrAsset = await graph.assets.uploadProductionAsset(projectId, {
      conceptId: `sign-${job.id}-qr-replaced-synthetic`,
      bytes: toPngBytes(exactAspectSignArtwork(1800, 2400)),
      contentType: "image/png",
      widthPx: 1800,
      heightPx: 2400,
      hasTransparency: false,
      finalArtworkJobId: job.id,
      productionRole: "production_png",
      metadata: {
        qrRestoration: {
          restoredFromAssetId: baseValidation!.assetId,
          sourceAssetId: preparation!.originalAssetId,
          planKey: preparation!.planKey,
          restoredCount: 1,
          placementValidated: true,
        },
      },
    });
    await repo.createProductionAssetValidation(projectId, {
      finalArtworkJobId: job.id,
      assetId: qrAsset.id,
      status: baseValidation!.status,
      report: { ...(baseValidation!.report as Record<string, unknown>) },
    });

    const headers = await internalSessionHeaders(graph, repo);
    const res = await post(projectId, headers);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { assetId: string; alreadyAccepted: boolean };
    assert.equal(body.assetId, qrAsset.id);
    assert.equal(body.alreadyAccepted, false);

    // Server-side authority actually changed, not just the HTTP response.
    const acceptance = await repo.getSignCandidateVisualAcceptance(projectId, qrAsset.id);
    assert.ok(acceptance);

    // Repeated approval through the SAME route is idempotent.
    const second = await post(projectId, headers);
    assert.equal(second.status, 200);
    const secondBody = (await second.json()) as { assetId: string; alreadyAccepted: boolean };
    assert.equal(secondBody.assetId, qrAsset.id);
    assert.equal(secondBody.alreadyAccepted, true);
  });

  it("an internal session cannot reach another project's pending candidate by forging the id — a garbage id is 404, not a leak", async () => {
    const { graph, repo } = await freshGraph();
    const headers = await internalSessionHeaders(graph, repo);
    const res = await post("00000000-0000-0000-0000-000000000000", headers);
    assert.equal(res.status, 404);
  });
});
