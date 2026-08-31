import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { exactAspectSignArtwork, toPngBytes } from "@/capabilities/sign-preparation/sign-fixtures";
import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";

/**
 * LIVE PRODUCT BLOCKER #4A: the operator-only artwork preview. Mirrors
 * `sign-artwork/authorize/route.test.ts` (operator variant)'s own gate
 * proof exactly — this route gates on the REQUESTER'S OWN session being
 * verified internal, never on the project.
 */
describe("GET /api/internal/projects/[projectId]/sign-artwork/original-image", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-sign-original-image-"));
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

  async function projectWithArtwork(
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
    return { projectId };
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

  it("no cookie at all — knowing a real project id is insufficient", async () => {
    const { graph, repo } = await freshGraph();
    const { projectId } = await projectWithArtwork(graph, repo);

    const res = await get(projectId);
    assert.equal(res.status, 403);
  });

  it("an unrecognized/forged session token is refused identically", async () => {
    const { graph, repo } = await freshGraph();
    const { projectId } = await projectWithArtwork(graph, repo);

    const res = await get(projectId, cookieHeaderFor("not-a-real-token"));
    assert.equal(res.status, 403);
  });

  it("an ordinary customer session cannot view the artwork through this route", async () => {
    const { graph, repo } = await freshGraph();
    const { projectId } = await projectWithArtwork(graph, repo);
    const ordinarySession = await graph.acquisition.resolveOrCreateSession(null);

    const res = await get(projectId, cookieHeaderFor(ordinarySession.sessionToken));
    assert.equal(res.status, 403);
  });

  it("a valid internal session receives the actual original bytes", async () => {
    const { graph, repo } = await freshGraph();
    const { projectId } = await projectWithArtwork(graph, repo);
    const internalSession = await graph.acquisition.resolveOrCreateSession(null);
    await repo.grantInternalEntitlement(internalSession.id);

    const res = await get(projectId, cookieHeaderFor(internalSession.sessionToken));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("Content-Type"), "image/png");

    const expected = toPngBytes(exactAspectSignArtwork(1800, 2400));
    const actual = Buffer.from(await res.arrayBuffer());
    assert.ok(actual.equals(expected), "served bytes must be the exact uploaded original");
  });

  it("a project with no sign preparation is a real 404, not a leak", async () => {
    const { graph, repo } = await freshGraph();
    const created = await repo.createProject();
    const internalSession = await graph.acquisition.resolveOrCreateSession(null);
    await repo.grantInternalEntitlement(internalSession.id);

    const res = await get(created.project.id, cookieHeaderFor(internalSession.sessionToken));
    assert.equal(res.status, 404);
  });

  it("an internal session cannot reach another project's data by forging the id — a garbage id is 404", async () => {
    const { graph, repo } = await freshGraph();
    await projectWithArtwork(graph, repo);
    const internalSession = await graph.acquisition.resolveOrCreateSession(null);
    await repo.grantInternalEntitlement(internalSession.id);

    const res = await get("00000000-0000-0000-0000-000000000000", cookieHeaderFor(internalSession.sessionToken));
    assert.equal(res.status, 404);
  });
});
