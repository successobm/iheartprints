import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { bowlingStyleArtwork, toPngBytes } from "@/capabilities/artwork-preparation/artwork-fixtures";
import { approvePreparedArtworkForTests } from "@/test-support/approve-prepared-artwork-for-tests";
import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";
import { continueAsInternalJob } from "@/capabilities/artwork-preparation/continue-as-internal-job";

/**
 * Phase 28P — "Continue as Internal Job": the capability-level proof.
 * Route-level authorization (which sessions may even call this) is proven
 * separately in `continue-as-internal-job-route.test.ts`. This file proves
 * what the operation itself actually does once authorized: it copies
 * exact pixels into a genuinely internal project, it never mutates the
 * source, and it is idempotent.
 */
describe("Phase 28P — continueAsInternalJob", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-continue-internal-job-"));
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

  /** An ordinary, non-internal customer project — never granted anything. */
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

  async function internalSession(graph: Awaited<ReturnType<typeof freshGraph>>["graph"], repo: Awaited<ReturnType<typeof freshGraph>>["repo"]) {
    const session = await graph.acquisition.resolveOrCreateSession(null);
    await repo.grantInternalEntitlement(session.id);
    return session.id;
  }

  function sha256(bytes: Buffer): string {
    return createHash("sha256").update(bytes).digest("hex");
  }

  it("(A) an internal session can continue an eligible ordinary project", async () => {
    const { graph, repo } = await freshGraph();
    const { projectId } = await ordinaryApprovedProject(graph, repo);
    const actingSessionId = await internalSession(graph, repo);

    const result = await continueAsInternalJob(
      { repo, assets: graph.assets, acquisition: graph.acquisition },
      { sourceProjectId: projectId, actingSessionId },
    );

    assert.equal(result.outcome, "created");
  });

  it("(F) the new project is genuinely internal", async () => {
    const { graph, repo } = await freshGraph();
    const { projectId } = await ordinaryApprovedProject(graph, repo);
    const actingSessionId = await internalSession(graph, repo);

    const result = await continueAsInternalJob(
      { repo, assets: graph.assets, acquisition: graph.acquisition },
      { sourceProjectId: projectId, actingSessionId },
    );
    assert.equal(result.outcome, "created");
    if (result.outcome !== "created") return;

    assert.equal(await graph.acquisition.isInternalProject(result.newProjectId), true);
  });

  it("(G) authorizeFinalization succeeds on the new project with zero production_unlock rows", async () => {
    const { graph, repo } = await freshGraph();
    const { projectId } = await ordinaryApprovedProject(graph, repo);
    const actingSessionId = await internalSession(graph, repo);

    const result = await continueAsInternalJob(
      { repo, assets: graph.assets, acquisition: graph.acquisition },
      { sourceProjectId: projectId, actingSessionId },
    );
    assert.equal(result.outcome, "created");
    if (result.outcome !== "created") return;

    const authorization = await graph.acquisition.authorizeFinalization(result.newProjectId);
    assert.equal(authorization.allowed, true);
  });

  it("(H) authorizeFinalization still fails on the untouched source customer project", async () => {
    const { graph, repo } = await freshGraph();
    const { projectId } = await ordinaryApprovedProject(graph, repo);
    const actingSessionId = await internalSession(graph, repo);

    await continueAsInternalJob(
      { repo, assets: graph.assets, acquisition: graph.acquisition },
      { sourceProjectId: projectId, actingSessionId },
    );

    const authorization = await graph.acquisition.authorizeFinalization(projectId);
    assert.equal(authorization.allowed, false);
  });

  it("pixel identity: the new internal project's prepared artwork is byte-for-byte identical to the source's", async () => {
    const { graph, repo } = await freshGraph();
    const { projectId } = await ordinaryApprovedProject(graph, repo);
    const actingSessionId = await internalSession(graph, repo);

    const sourcePreparation = await repo.getArtworkPreparation(projectId);
    const sourceBytes = await graph.assets.downloadAssetBytes(sourcePreparation!.preparedAssetId!);

    const result = await continueAsInternalJob(
      { repo, assets: graph.assets, acquisition: graph.acquisition },
      { sourceProjectId: projectId, actingSessionId },
    );
    assert.equal(result.outcome, "created");
    if (result.outcome !== "created") return;

    const newPreparation = await repo.getArtworkPreparation(result.newProjectId);
    const newBytes = await graph.assets.downloadAssetBytes(newPreparation!.preparedAssetId!);

    assert.equal(sha256(newBytes!.bytes), sha256(sourceBytes!.bytes));
  });

  it("correction lineage and approval state carry forward onto the new project's preparation", async () => {
    const { graph, repo } = await freshGraph();
    const { projectId } = await ordinaryApprovedProject(graph, repo);
    const actingSessionId = await internalSession(graph, repo);

    const result = await continueAsInternalJob(
      { repo, assets: graph.assets, acquisition: graph.acquisition },
      { sourceProjectId: projectId, actingSessionId },
    );
    assert.equal(result.outcome, "created");
    if (result.outcome !== "created") return;

    const newPreparation = await repo.getArtworkPreparation(result.newProjectId);
    assert.equal(newPreparation!.status, "approved");
    assert.ok(newPreparation!.approvedAt);
    const newAsset = await repo.getAssetById(newPreparation!.preparedAssetId!);
    const marker = (newAsset!.metadata as Record<string, unknown>).internalContinuation as {
      sourceProjectId: string;
    };
    assert.equal(marker.sourceProjectId, projectId);
  });

  it("production sizing is NOT carried forward — the new project's brief starts unconfirmed", async () => {
    const { graph, repo } = await freshGraph();
    const { projectId } = await ordinaryApprovedProject(graph, repo);
    const actingSessionId = await internalSession(graph, repo);

    const result = await continueAsInternalJob(
      { repo, assets: graph.assets, acquisition: graph.acquisition },
      { sourceProjectId: projectId, actingSessionId },
    );
    assert.equal(result.outcome, "created");
    if (result.outcome !== "created") return;

    const newSnapshot = await repo.getProject(result.newProjectId);
    assert.equal(newSnapshot!.brief.productionSizeConfirmedAt, null);
    assert.equal(newSnapshot!.brief.printPlacement, null);
  });

  it("(E) the source project is completely unchanged after continuation", async () => {
    const { graph, repo } = await freshGraph();
    const { projectId } = await ordinaryApprovedProject(graph, repo);
    const actingSessionId = await internalSession(graph, repo);

    const before = await repo.getProject(projectId);
    const beforePreparation = await repo.getArtworkPreparation(projectId);

    await continueAsInternalJob(
      { repo, assets: graph.assets, acquisition: graph.acquisition },
      { sourceProjectId: projectId, actingSessionId },
    );

    const after = await repo.getProject(projectId);
    const afterPreparation = await repo.getArtworkPreparation(projectId);

    assert.equal(after!.project.acquisitionSessionId, before!.project.acquisitionSessionId);
    assert.equal(after!.project.status, before!.project.status);
    assert.equal(after!.project.updatedAt, before!.project.updatedAt);
    assert.deepEqual(afterPreparation, beforePreparation);
  });

  it("(K) double-submit is idempotent — a second call returns the SAME new project, not a duplicate", async () => {
    const { graph, repo } = await freshGraph();
    const { projectId } = await ordinaryApprovedProject(graph, repo);
    const actingSessionId = await internalSession(graph, repo);

    const first = await continueAsInternalJob(
      { repo, assets: graph.assets, acquisition: graph.acquisition },
      { sourceProjectId: projectId, actingSessionId },
    );
    const second = await continueAsInternalJob(
      { repo, assets: graph.assets, acquisition: graph.acquisition },
      { sourceProjectId: projectId, actingSessionId },
    );

    assert.equal(first.outcome, "created");
    assert.equal(second.outcome, "already_continued");
    if (first.outcome === "created" && second.outcome === "already_continued") {
      assert.equal(second.newProjectId, first.newProjectId);
    }

    // Scoped to THIS test's own source project — the local store is shared
    // across every `it()` in this file (one `before`/`after` for the whole
    // suite), so a raw global project count would also see every other
    // test's fixtures. Counting continuations that actually name this
    // source project is what "not two" really means here.
    const allProjects = await repo.listProjects();
    let continuedFromThisSource = 0;
    for (const project of allProjects) {
      if (project.id === projectId) continue;
      const preparation = await repo.getArtworkPreparation(project.id);
      if (!preparation?.preparedAssetId) continue;
      const asset = await repo.getAssetById(preparation.preparedAssetId);
      const marker = (asset?.metadata as Record<string, unknown> | undefined)?.internalContinuation as
        | { sourceProjectId?: string }
        | undefined;
      if (marker?.sourceProjectId === projectId) continuedFromThisSource += 1;
    }
    assert.equal(continuedFromThisSource, 1, "exactly one new project should exist for this source, not two");
  });

  it("(I) two different source projects produce two independent continuations with no cross-contamination", async () => {
    const { graph, repo } = await freshGraph();
    const { projectId: projectA } = await ordinaryApprovedProject(graph, repo);
    const { projectId: projectB } = await ordinaryApprovedProject(graph, repo);
    const actingSessionId = await internalSession(graph, repo);

    const resultA = await continueAsInternalJob(
      { repo, assets: graph.assets, acquisition: graph.acquisition },
      { sourceProjectId: projectA, actingSessionId },
    );
    const resultB = await continueAsInternalJob(
      { repo, assets: graph.assets, acquisition: graph.acquisition },
      { sourceProjectId: projectB, actingSessionId },
    );

    assert.equal(resultA.outcome, "created");
    assert.equal(resultB.outcome, "created");
    if (resultA.outcome !== "created" || resultB.outcome !== "created") return;
    assert.notEqual(resultA.newProjectId, resultB.newProjectId);

    const prepA = await repo.getArtworkPreparation(resultA.newProjectId);
    const assetA = await repo.getAssetById(prepA!.preparedAssetId!);
    const markerA = (assetA!.metadata as Record<string, unknown>).internalContinuation as {
      sourceProjectId: string;
    };
    assert.equal(markerA.sourceProjectId, projectA);

    const prepB = await repo.getArtworkPreparation(resultB.newProjectId);
    const assetB = await repo.getAssetById(prepB!.preparedAssetId!);
    const markerB = (assetB!.metadata as Record<string, unknown>).internalContinuation as {
      sourceProjectId: string;
    };
    assert.equal(markerB.sourceProjectId, projectB);
  });

  it("(J) a project with no preparation at all is refused", async () => {
    const { graph, repo } = await freshGraph();
    const session = await graph.acquisition.resolveOrCreateSession(null);
    const created = await repo.createProject(session.id);
    const actingSessionId = await internalSession(graph, repo);

    const result = await continueAsInternalJob(
      { repo, assets: graph.assets, acquisition: graph.acquisition },
      { sourceProjectId: created.project.id, actingSessionId },
    );

    assert.equal(result.outcome, "ineligible");
  });

  it("(J) unapproved (merely 'prepared') artwork is refused", async () => {
    const { graph, repo } = await freshGraph();
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
    // Deliberately never approved — still has unresolved consequential
    // regions (bowlingStyleArtwork always does).

    const actingSessionId = await internalSession(graph, repo);
    const result = await continueAsInternalJob(
      { repo, assets: graph.assets, acquisition: graph.acquisition },
      { sourceProjectId: projectId, actingSessionId },
    );

    assert.equal(result.outcome, "ineligible");
  });

  it("a nonexistent source project id is reported as not found", async () => {
    const { graph, repo } = await freshGraph();
    const actingSessionId = await internalSession(graph, repo);

    const result = await continueAsInternalJob(
      { repo, assets: graph.assets, acquisition: graph.acquisition },
      { sourceProjectId: "00000000-0000-0000-0000-000000000000", actingSessionId },
    );

    assert.equal(result.outcome, "not_found");
  });
});
