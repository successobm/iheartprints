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
 * LIVE PRODUCT BLOCKER #4: the ONE place a `review_required` rigid-sign
 * plan may be authorized for production. Mirrors `continue-as-internal-job
 * -route.test.ts`'s own authorization proof exactly — this route gates on
 * the REQUESTER'S OWN session being verified internal, not on the project.
 */
describe("POST /api/internal/projects/[projectId]/sign-artwork/authorize", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-sign-authorize-operator-"));
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

  async function reviewRequiredProject(
    graph: Awaited<ReturnType<typeof freshGraph>>["graph"],
    repo: Awaited<ReturnType<typeof freshGraph>>["repo"],
  ) {
    const created = await repo.createProject();
    const projectId = created.project.id;
    await graph.signPreparation.uploadSignArtwork(projectId, {
      bytes: toPngBytes(ruthLikeSignArtwork()),
      declaredContentType: "image/png",
      filename: "sign.png",
    });
    await graph.signPreparation.confirmSignProductionSpec(projectId, 18, 24);
    const outcome = await graph.signPreparation.planSignRepair(projectId);
    assert.equal(outcome.result.plan!.overallRisk, "review_required");
    return { projectId };
  }

  async function autoSafeProject(
    graph: Awaited<ReturnType<typeof freshGraph>>["graph"],
    repo: Awaited<ReturnType<typeof freshGraph>>["repo"],
  ) {
    const created = await repo.createProject();
    const projectId = created.project.id;
    await graph.signPreparation.uploadSignArtwork(projectId, {
      bytes: toPngBytes(exactAspectSignArtwork(1800, 2400)),
      declaredContentType: "image/png",
      filename: "sign.png",
    });
    await graph.signPreparation.confirmSignProductionSpec(projectId, 12, 16);
    const outcome = await graph.signPreparation.planSignRepair(projectId);
    assert.equal(outcome.result.plan!.overallRisk, "auto_safe");
    return { projectId };
  }

  function cookieHeaderFor(sessionToken: string): { cookie: string } {
    return { cookie: `ihp_as=${sessionToken}` };
  }

  async function post(projectId: string, headers?: Record<string, string>) {
    const route = await import("./route");
    return route.POST(
      new Request("http://localhost/x", { method: "POST", headers: headers ?? {} }),
      { params: Promise.resolve({ projectId }) },
    );
  }

  it("no cookie at all — knowing a real project id is insufficient", async () => {
    const { graph, repo } = await freshGraph();
    const { projectId } = await reviewRequiredProject(graph, repo);

    const res = await post(projectId);
    assert.equal(res.status, 403);
  });

  it("an unrecognized/forged session token is refused identically", async () => {
    const { graph, repo } = await freshGraph();
    const { projectId } = await reviewRequiredProject(graph, repo);

    const res = await post(projectId, cookieHeaderFor("not-a-real-token"));
    assert.equal(res.status, 403);
  });

  it("an ordinary customer session cannot authorize a review_required plan through this route", async () => {
    const { graph, repo } = await freshGraph();
    const { projectId } = await reviewRequiredProject(graph, repo);
    const ordinarySession = await graph.acquisition.resolveOrCreateSession(null);

    const res = await post(projectId, cookieHeaderFor(ordinarySession.sessionToken));
    assert.equal(res.status, 403);

    const preparation = await repo.getSignPreparation(projectId);
    assert.equal(preparation!.authorizedBy, null);
  });

  it("a valid internal session authorizes a review_required plan", async () => {
    const { graph, repo } = await freshGraph();
    const { projectId } = await reviewRequiredProject(graph, repo);
    const internalSession = await graph.acquisition.resolveOrCreateSession(null);
    await repo.grantInternalEntitlement(internalSession.id);

    const res = await post(projectId, cookieHeaderFor(internalSession.sessionToken));
    assert.equal(res.status, 200);

    const preparation = await repo.getSignPreparation(projectId);
    assert.equal(preparation!.authorizedBy, "operator");
    assert.equal(preparation!.authorizedPlanKey, preparation!.planKey);
  });

  it("a valid internal session also authorizes an auto_safe plan (operator is sufficient for every risk class)", async () => {
    const { graph, repo } = await freshGraph();
    const { projectId } = await autoSafeProject(graph, repo);
    const internalSession = await graph.acquisition.resolveOrCreateSession(null);
    await repo.grantInternalEntitlement(internalSession.id);

    const res = await post(projectId, cookieHeaderFor(internalSession.sessionToken));
    assert.equal(res.status, 200);
  });

  it("an internal session cannot reach another project's data by forging the id — a garbage id is 404, not a leak", async () => {
    const { graph, repo } = await freshGraph();
    await reviewRequiredProject(graph, repo);
    const internalSession = await graph.acquisition.resolveOrCreateSession(null);
    await repo.grantInternalEntitlement(internalSession.id);

    const res = await post(
      "00000000-0000-0000-0000-000000000000",
      cookieHeaderFor(internalSession.sessionToken),
    );
    assert.equal(res.status, 404);
  });
});
