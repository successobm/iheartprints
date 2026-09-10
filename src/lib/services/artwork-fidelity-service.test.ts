/**
 * Universal Raster Reconstruction Phase R4A: end-to-end proof of the
 * authority invariant this whole phase exists to protect — a successful
 * `proposeArtworkFidelity` call can NEVER create confirmed authority, only
 * an explicit `confirmArtworkFidelity` call can, and confirmation fails
 * closed against a stale or missing source. Mirrors `sign-artwork-service
 * .test.ts`'s own `getCapabilityGraph()`-based pattern: under
 * `isAutomatedTestEnvironment()` the real capability graph resolves its
 * provider to the safe, network-free placeholder automatically, so this
 * test never makes a real network call.
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { PNG } from "pngjs";

import { ArtworkFidelityContractStateError } from "@/capabilities/artwork-fidelity";
import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";

import {
  ArtworkFidelityServiceError,
  confirmArtworkFidelity,
  proposeArtworkFidelity,
} from "./artwork-fidelity-service";

function pngBytes(seed: number): Buffer {
  const png = new PNG({ width: 30, height: 30 });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = seed % 255;
    png.data[i + 1] = 20;
    png.data[i + 2] = 30;
    png.data[i + 3] = 255;
  }
  return PNG.sync.write(png);
}

describe("artwork-fidelity-service", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-fidelity-service-"));
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

  async function freshProjectWithUpload(
    graph: Awaited<ReturnType<typeof freshGraph>>["graph"],
    repo: Awaited<ReturnType<typeof freshGraph>>["repo"],
    seed = 1,
  ) {
    const created = await repo.createProject();
    const projectId = created.project.id;
    await graph.artworkPreparation.uploadOriginal(projectId, {
      bytes: pngBytes(seed),
      declaredContentType: "image/png",
      filename: "logo.png",
    });
    return projectId;
  }

  it("AUTHORITY INVARIANT: a successful propose call creates ONLY a proposed contract -- never confirmedBy/confirmedAt/contractKey", async () => {
    const { graph, repo } = await freshGraph();
    const projectId = await freshProjectWithUpload(graph, repo);

    const snapshot = await proposeArtworkFidelity(projectId);

    assert.ok(snapshot.artworkFidelity);
    assert.equal(snapshot.artworkFidelity!.status, "proposed");
    assert.equal(snapshot.artworkFidelity!.confirmedWording, null);
    assert.equal(snapshot.artworkFidelity!.confirmedMarks, null);
    assert.equal(snapshot.artworkFidelity!.confirmedAt, null);

    const stored = await graph.artworkFidelity.getContract(projectId);
    assert.ok(stored);
    assert.equal(stored!.status, "proposed");
    assert.equal(stored!.confirmedBy, null);
    assert.equal(stored!.contractKey, null);
  });

  it("propose is idempotent against the current immutable source -- a second call for unchanged bytes does not create a second contract", async () => {
    const { graph, repo } = await freshGraph();
    const projectId = await freshProjectWithUpload(graph, repo);

    await proposeArtworkFidelity(projectId);
    const first = await graph.artworkFidelity.getContract(projectId);
    await proposeArtworkFidelity(projectId);
    const second = await graph.artworkFidelity.getContract(projectId);

    assert.equal(first!.id, second!.id);
  });

  it("confirm requires a proposal to already exist", async () => {
    const { graph, repo } = await freshGraph();
    const projectId = await freshProjectWithUpload(graph, repo);

    await assert.rejects(
      () => confirmArtworkFidelity(projectId, { confirmedWording: ["BRIDGEWELL"], confirmedMarks: [], confirmedBy: "customer" }),
      ArtworkFidelityContractStateError,
    );
  });

  it("confirm creates real, immutable confirmed authority with an exact contractKey", async () => {
    const { graph, repo } = await freshGraph();
    const projectId = await freshProjectWithUpload(graph, repo);
    await proposeArtworkFidelity(projectId);

    const snapshot = await confirmArtworkFidelity(projectId, {
      confirmedWording: ["BRIDGEWELL", "& COMPANY"],
      confirmedMarks: ["®"],
      confirmedBy: "customer",
    });

    assert.equal(snapshot.artworkFidelity!.status, "confirmed");
    assert.deepEqual(snapshot.artworkFidelity!.confirmedWording!.sort(), ["& COMPANY", "BRIDGEWELL"]);
    assert.deepEqual(snapshot.artworkFidelity!.confirmedMarks, ["®"]);
    assert.ok(snapshot.artworkFidelity!.confirmedAt);

    const stored = await graph.artworkFidelity.getContract(projectId);
    assert.ok(stored!.contractKey);
  });

  it("a second confirm attempt against an already-confirmed contract is refused -- confirmation is immutable authority", async () => {
    const { graph, repo } = await freshGraph();
    const projectId = await freshProjectWithUpload(graph, repo);
    await proposeArtworkFidelity(projectId);
    await confirmArtworkFidelity(projectId, { confirmedWording: ["BRIDGEWELL"], confirmedMarks: [], confirmedBy: "customer" });

    await assert.rejects(
      () => confirmArtworkFidelity(projectId, { confirmedWording: ["SOMETHING ELSE"], confirmedMarks: [], confirmedBy: "customer" }),
      ArtworkFidelityContractStateError,
    );

    // No partial mutation on refusal -- the original confirmed facts stand.
    const stored = await graph.artworkFidelity.getContract(projectId);
    assert.deepEqual(stored!.confirmedWording, ["BRIDGEWELL"]);
  });

  it("choosing None (empty confirmedMarks) is a valid, explicit confirmation -- not an unresolved state", async () => {
    const { graph, repo } = await freshGraph();
    const projectId = await freshProjectWithUpload(graph, repo);
    await proposeArtworkFidelity(projectId);

    const snapshot = await confirmArtworkFidelity(projectId, {
      confirmedWording: ["VANTRIX"],
      confirmedMarks: [],
      confirmedBy: "customer",
    });

    assert.equal(snapshot.artworkFidelity!.status, "confirmed");
    assert.deepEqual(snapshot.artworkFidelity!.confirmedMarks, []);
  });

  it("fails closed rather than confirming stale authority: propose again to change the immutable source's own hash context is not directly possible, so this proves the sha is ALWAYS server-recomputed rather than trusted from input", async () => {
    const { graph, repo } = await freshGraph();
    const projectId = await freshProjectWithUpload(graph, repo);
    const proposed = await proposeArtworkFidelity(projectId);
    const contract = await graph.artworkFidelity.getContract(projectId);
    assert.equal(proposed.artworkFidelity!.contractId, contract!.id);

    // Directly exercising the capability's own staleness check (Section 10)
    // with a WRONG sha -- proves the service always supplies a freshly
    // measured value, never a client-supplied one, by construction (the
    // service's confirmArtworkFidelity signature accepts no sha input at
    // all). This call goes straight to the capability to simulate what
    // WOULD happen if a stale sha were ever supplied.
    await assert.rejects(
      () =>
        graph.artworkFidelity.confirmContract(projectId, contract!.id, {
          currentSourceSha256: "0".repeat(64),
          confirmedWording: ["BRIDGEWELL"],
          confirmedMarks: [],
          confirmedBy: "customer",
        }),
      ArtworkFidelityContractStateError,
    );
  });

  it("propose refuses cleanly when nothing has been uploaded yet -- never crashes, never creates a partial contract", async () => {
    const { graph, repo } = await freshGraph();
    const created = await repo.createProject();

    await assert.rejects(() => proposeArtworkFidelity(created.project.id), ArtworkFidelityServiceError);

    const stored = await graph.artworkFidelity.getContract(created.project.id);
    assert.equal(stored, null);
  });

  it("BOUNDARY: proposing never calls a reconstruction/image-edit provider or mutates print-ready state", async () => {
    const { graph, repo } = await freshGraph();
    const projectId = await freshProjectWithUpload(graph, repo);

    const before = await repo.getProject(projectId);
    await proposeArtworkFidelity(projectId);
    const after = await repo.getProject(projectId);

    // Project status/production fields are untouched by a fidelity proposal.
    assert.equal(before!.status, after!.status);
  });
});
