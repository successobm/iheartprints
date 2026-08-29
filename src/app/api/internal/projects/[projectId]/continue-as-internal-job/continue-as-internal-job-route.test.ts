import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { bowlingStyleArtwork, toPngBytes } from "@/capabilities/artwork-preparation/artwork-fixtures";
import { approvePreparedArtworkForTests } from "@/test-support/approve-prepared-artwork-for-tests";
import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";

/**
 * Phase 28P — route-level authorization proof for `POST
 * /api/internal/projects/[projectId]/continue-as-internal-job`.
 *
 * This deliberately checks the REQUESTER'S OWN session, not
 * `isInternalProject(projectId)` — see the route's own doc comment for why
 * those are different questions and why only the former is correct here.
 * Capability-level behavior (pixel copy, lineage, idempotency,
 * authorizeFinalization on both projects) is proven in
 * `continue-as-internal-job.test.ts` and is not repeated here.
 */
describe("POST /api/internal/projects/[projectId]/continue-as-internal-job — authorization", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-continue-route-"));
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

  async function ordinaryApprovedProject(graph: Awaited<ReturnType<typeof freshGraph>>["graph"], repo: Awaited<ReturnType<typeof freshGraph>>["repo"]) {
    const session = await graph.acquisition.resolveOrCreateSession(null);
    const created = await repo.createProject(session.id);
    const projectId = created.project.id;
    await graph.artworkPreparation.uploadOriginal(projectId, {
      bytes: toPngBytes(bowlingStyleArtwork()),
      declaredContentType: "image/png",
      filename: "artwork.png",
    });
    await graph.artworkPreparation.setProductionContext(projectId, {
      productSummary: "T-shirts",
      productColor: "Black",
      printPlacement: "full_front",
    });
    await graph.artworkPreparation.prepareBackground(projectId);
    await approvePreparedArtworkForTests(graph.artworkPreparation, projectId);
    return { projectId, sessionId: session.id };
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

  it("(D) no cookie at all — knowing a real project id is insufficient", async () => {
    const { graph, repo } = await freshGraph();
    const { projectId } = await ordinaryApprovedProject(graph, repo);

    const res = await post(projectId);
    assert.equal(res.status, 403);
  });

  it("(C) an unrecognized/forged session token is refused identically", async () => {
    const { graph, repo } = await freshGraph();
    const { projectId } = await ordinaryApprovedProject(graph, repo);

    const res = await post(projectId, cookieHeaderFor("not-a-real-token"));
    assert.equal(res.status, 403);
  });

  it("(B) an ordinary customer session cannot call this action, even on their own eligible project", async () => {
    const { graph, repo } = await freshGraph();
    const { projectId, sessionId } = await ordinaryApprovedProject(graph, repo);
    const ordinarySession = await repo.getAcquisitionSession(sessionId);
    const beforeCount = (await repo.listProjects()).length;

    const res = await post(projectId, cookieHeaderFor(ordinarySession!.sessionToken));
    assert.equal(res.status, 403);

    // And nothing new was created by this call specifically (the local
    // store is shared across every `it()` in this file, so only a
    // before/after delta within this test is meaningful).
    const afterCount = (await repo.listProjects()).length;
    assert.equal(afterCount, beforeCount, "no second project should have been created");
  });

  it("a valid internal session succeeds and creates exactly one new internal project", async () => {
    const { graph, repo } = await freshGraph();
    const { projectId } = await ordinaryApprovedProject(graph, repo);

    const internalSession = await graph.acquisition.resolveOrCreateSession(null);
    await repo.grantInternalEntitlement(internalSession.id);

    const res = await post(projectId, cookieHeaderFor(internalSession.sessionToken));
    assert.equal(res.status, 200);
    const body = (await res.json()) as { newProjectId: string; created: boolean };
    assert.equal(body.created, true);
    assert.equal(await graph.acquisition.isInternalProject(body.newProjectId), true);
  });

  it("(I) an internal session cannot be used to reach another project's data by forging the id — a garbage id is 404, not a leak", async () => {
    const { graph, repo } = await freshGraph();
    await ordinaryApprovedProject(graph, repo);

    const internalSession = await graph.acquisition.resolveOrCreateSession(null);
    await repo.grantInternalEntitlement(internalSession.id);

    const res = await post("00000000-0000-0000-0000-000000000000", cookieHeaderFor(internalSession.sessionToken));
    assert.equal(res.status, 404);
  });
});
