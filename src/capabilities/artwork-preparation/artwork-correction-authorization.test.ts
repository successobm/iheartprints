import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";
import { isAuthorizedForArtworkCorrection } from "./artwork-correction-authorization";

/**
 * Phase 28K: unit-level proof of the narrow authorization predicate itself,
 * isolated from any specific route. The behavioral, route-level proof lives
 * in `separation-routes-authorization.test.ts` and
 * `correction-routes-authorization.test.ts`.
 */
describe("isAuthorizedForArtworkCorrection (Phase 28K)", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-artwork-correction-auth-"));
    process.chdir(tempDir);
  });

  after(async () => {
    await cleanupTempWorkspace(tempDir, previousCwd);
  });

  async function harness() {
    const { resetCapabilityGraphForTests, getCapabilityGraph } = await import("@/capabilities/composition");
    resetCapabilityGraphForTests();
    const graph = getCapabilityGraph();
    const { getProjectRepository } = await import("@/lib/db");
    const repo = getProjectRepository();
    return { graph, repo };
  }

  it("1: an internal (staff) project is authorized", async () => {
    const { graph, repo } = await harness();
    const session = await graph.acquisition.resolveOrCreateSession(null);
    await repo.grantInternalEntitlement(session.id);
    const created = await repo.createProject(session.id);

    assert.equal(
      await isAuthorizedForArtworkCorrection(graph.acquisition, repo, created.project.id),
      true,
    );
  });

  it("2: an ordinary (non-internal) project's own owner is authorized -- the Phase 28K fix itself", async () => {
    const { graph, repo } = await harness();
    const session = await graph.acquisition.resolveOrCreateSession(null);
    const created = await repo.createProject(session.id);

    assert.equal(
      await isAuthorizedForArtworkCorrection(graph.acquisition, repo, created.project.id),
      true,
    );
  });

  it("3: a project id that does not resolve to any real project is denied", async () => {
    const { graph, repo } = await harness();
    assert.equal(
      await isAuthorizedForArtworkCorrection(graph.acquisition, repo, "00000000-0000-0000-0000-000000000000"),
      false,
    );
  });

  it("4: two ordinary owners' projects are each independently authorized -- one owner's access never depends on or leaks into another's", async () => {
    const { graph, repo } = await harness();
    const sessionA = await graph.acquisition.resolveOrCreateSession(null);
    const createdA = await repo.createProject(sessionA.id);
    const sessionB = await graph.acquisition.resolveOrCreateSession(null);
    const createdB = await repo.createProject(sessionB.id);

    assert.equal(await isAuthorizedForArtworkCorrection(graph.acquisition, repo, createdA.project.id), true);
    assert.equal(await isAuthorizedForArtworkCorrection(graph.acquisition, repo, createdB.project.id), true);
    // Neither project's existence is contingent on the other -- deleting the
    // authorization question for B was never coupled to A's session at all.
  });
});
