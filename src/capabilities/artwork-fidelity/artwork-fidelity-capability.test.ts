import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import type { ProjectRepository } from "@/lib/db/repository";
import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";

import {
  createArtworkFidelityCapability,
  ArtworkFidelityContractStateError,
} from "./artwork-fidelity-capability";

/**
 * Universal Raster Reconstruction Phase R3B — durable foundation only.
 * Proves the propose/confirm authority split, provenance rules, exact-
 * wording/protected-mark preservation, and staleness behavior this phase
 * establishes. No reconstruction, no provider, no vision, no OCR — none of
 * that exists here to test.
 */
describe("ArtworkFidelityCapability", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-fidelity-contract-"));
    process.chdir(tempDir);
  });

  after(async () => {
    await cleanupTempWorkspace(tempDir, previousCwd);
  });

  async function build() {
    const { LocalProjectRepository } = await import("@/lib/db/local-store");
    const repo: ProjectRepository = new LocalProjectRepository();
    const capability = createArtworkFidelityCapability(repo);
    const project = await repo.createProject();
    return { repo, capability, projectId: project.project.id };
  }

  const SHA_A = "a".repeat(64);
  const SHA_B = "b".repeat(64);

  it("1: a proposed contract cannot satisfy confirmed authority — status stays 'proposed' and contractKey stays null until confirmed", async () => {
    const { capability, projectId } = await build();
    const contract = await capability.proposeContract(projectId, {
      sourceAssetId: "asset-1",
      sourceSha256: SHA_A,
      proposedFacts: { wording: ["ESTABLISHED PROVISIONS"] },
    });
    assert.equal(contract.status, "proposed");
    assert.equal(contract.contractKey, null);
    assert.equal(contract.confirmedWording, null);
    assert.equal(contract.confirmedMarks, null);
    assert.equal(contract.confirmedBy, null);
  });

  it("2: customer confirmation produces a confirmed contract with a real contractKey", async () => {
    const { capability, projectId } = await build();
    const proposed = await capability.proposeContract(projectId, {
      sourceAssetId: "asset-1",
      sourceSha256: SHA_A,
    });
    const confirmed = await capability.confirmContract(projectId, proposed.id, {
      currentSourceSha256: SHA_A,
      confirmedWording: ["ESTABLISHED PROVISIONS"],
      confirmedMarks: ["™"],
      confirmedBy: "customer",
    });
    assert.equal(confirmed.status, "confirmed");
    assert.equal(confirmed.confirmedBy, "customer");
    assert.ok(confirmed.contractKey);
    assert.deepEqual(confirmed.confirmedWording, ["ESTABLISHED PROVISIONS"]);
    assert.deepEqual(confirmed.confirmedMarks, ["™"]);
  });

  it("3: operator confirmation produces a confirmed contract", async () => {
    const { capability, projectId } = await build();
    const proposed = await capability.proposeContract(projectId, {
      sourceAssetId: "asset-1",
      sourceSha256: SHA_A,
    });
    const confirmed = await capability.confirmContract(projectId, proposed.id, {
      currentSourceSha256: SHA_A,
      confirmedWording: [],
      confirmedMarks: [],
      confirmedBy: "operator",
    });
    assert.equal(confirmed.status, "confirmed");
    assert.equal(confirmed.confirmedBy, "operator");
  });

  it("4: a model proposal never counts as confirmation — proposedFacts alone never flips status, and confirmContract refuses an unrecognized actor", async () => {
    const { repo, capability, projectId } = await build();
    const proposed = await capability.proposeContract(projectId, {
      sourceAssetId: "asset-1",
      sourceSha256: SHA_A,
      proposedFacts: { wording: ["ESTABLISHED PROVISIONS"], marks: ["™"] },
    });
    // Merely proposing rich facts never changes status.
    const reloaded = await repo.getArtworkFidelityContractById(proposed.id);
    assert.equal(reloaded!.status, "proposed");

    await assert.rejects(
      () =>
        capability.confirmContract(projectId, proposed.id, {
          currentSourceSha256: SHA_A,
          confirmedWording: ["ESTABLISHED PROVISIONS"],
          confirmedMarks: ["™"],
          // @ts-expect-error -- deliberately invalid actor, proving the runtime guard (not just the type) refuses it
          confirmedBy: "model",
        }),
      ArtworkFidelityContractStateError,
    );
  });

  it("5/6: exact wording preserves capitalization and punctuation verbatim, never normalized at rest", async () => {
    const { capability, projectId } = await build();
    const proposed = await capability.proposeContract(projectId, {
      sourceAssetId: "asset-1",
      sourceSha256: SHA_A,
    });
    const confirmed = await capability.confirmContract(projectId, proposed.id, {
      currentSourceSha256: SHA_A,
      confirmedWording: ["Bridgewell & Company", "ESTABLISHED PROVISIONS."],
      confirmedMarks: [],
      confirmedBy: "customer",
    });
    assert.deepEqual(confirmed.confirmedWording, [
      "Bridgewell & Company",
      "ESTABLISHED PROVISIONS.",
    ]);
  });

  it("7: PROVISIONS != PRODUCTS — distinct confirmed strings persist distinctly and never collapse", async () => {
    const { capability, projectId } = await build();
    const a = await capability.proposeContract(projectId, {
      sourceAssetId: "asset-1",
      sourceSha256: SHA_A,
    });
    const confirmedA = await capability.confirmContract(projectId, a.id, {
      currentSourceSha256: SHA_A,
      confirmedWording: ["ESTABLISHED PROVISIONS"],
      confirmedMarks: [],
      confirmedBy: "customer",
    });

    const b = await capability.proposeContract(projectId, {
      sourceAssetId: "asset-2",
      sourceSha256: SHA_B,
    });
    const confirmedB = await capability.confirmContract(projectId, b.id, {
      currentSourceSha256: SHA_B,
      confirmedWording: ["ESTABLISHED PRODUCTS"],
      confirmedMarks: [],
      confirmedBy: "customer",
    });

    assert.notEqual(confirmedA.confirmedWording![0], confirmedB.confirmedWording![0]);
    assert.notEqual(confirmedA.contractKey, confirmedB.contractKey);
  });

  it("8/9/10: TM, R, and C are three distinct, non-equivalent protected marks end to end", async () => {
    const { capability, projectId } = await build();

    async function confirmWithMark(mark: "™" | "®" | "©") {
      const proposed = await capability.proposeContract(projectId, {
        sourceAssetId: `asset-${mark}`,
        sourceSha256: SHA_A,
      });
      return capability.confirmContract(projectId, proposed.id, {
        currentSourceSha256: SHA_A,
        confirmedWording: [],
        confirmedMarks: [mark],
        confirmedBy: "customer",
      });
    }

    const tm = await confirmWithMark("™");
    const r = await confirmWithMark("®");
    const c = await confirmWithMark("©");

    assert.deepEqual(tm.confirmedMarks, ["™"]);
    assert.deepEqual(r.confirmedMarks, ["®"]);
    assert.deepEqual(c.confirmedMarks, ["©"]);
    assert.notEqual(tm.confirmedMarks![0], r.confirmedMarks![0]);
    assert.notEqual(tm.confirmedMarks![0], c.confirmedMarks![0]);
    assert.notEqual(r.confirmedMarks![0], c.confirmedMarks![0]);
    assert.notEqual(tm.contractKey, r.contractKey);
    assert.notEqual(tm.contractKey, c.contractKey);
    assert.notEqual(r.contractKey, c.contractKey);
  });

  it("18: a stale expected contractKey fails closed — recomputing after a confirmed fact changes no longer matches the earlier key", async () => {
    const { capability, projectId } = await build();
    const proposed = await capability.proposeContract(projectId, {
      sourceAssetId: "asset-1",
      sourceSha256: SHA_A,
    });
    const v1 = await capability.confirmContract(projectId, proposed.id, {
      currentSourceSha256: SHA_A,
      confirmedWording: [],
      confirmedMarks: ["™"],
      confirmedBy: "customer",
    });
    const expectedKeyFromV1 = v1.contractKey;

    // Customer corrects TM -> R (the exact R2 regression case).
    const v2 = await capability.confirmContract(projectId, proposed.id, {
      currentSourceSha256: SHA_A,
      confirmedWording: [],
      confirmedMarks: ["®"],
      confirmedBy: "customer",
    });

    assert.notEqual(v2.contractKey, expectedKeyFromV1);
    // A future consumer holding the v1 key must fail closed — it no
    // longer matches the contract's current, authoritative key.
    assert.notEqual(v2.contractKey, expectedKeyFromV1);
    assert.equal(v2.id, v1.id, "the same durable row is updated, not duplicated");
  });

  it("confirmContract refuses when the source has changed underneath the contract (source SHA binding)", async () => {
    const { capability, projectId } = await build();
    const proposed = await capability.proposeContract(projectId, {
      sourceAssetId: "asset-1",
      sourceSha256: SHA_A,
    });
    await assert.rejects(
      () =>
        capability.confirmContract(projectId, proposed.id, {
          currentSourceSha256: SHA_B, // the caller's CURRENT measured sha differs
          confirmedWording: ["X"],
          confirmedMarks: [],
          confirmedBy: "customer",
        }),
      ArtworkFidelityContractStateError,
    );
  });

  it("getContract/getContractById are project-scoped — a cross-project id resolves to not-found", async () => {
    const { repo, capability, projectId } = await build();
    const otherProject = await repo.createProject();
    const proposed = await capability.proposeContract(projectId, {
      sourceAssetId: "asset-1",
      sourceSha256: SHA_A,
    });
    await assert.rejects(
      () =>
        capability.confirmContract(otherProject.project.id, proposed.id, {
          currentSourceSha256: SHA_A,
          confirmedWording: [],
          confirmedMarks: [],
          confirmedBy: "customer",
        }),
      ArtworkFidelityContractStateError,
    );
  });

  it("getContract returns the latest proposed-or-confirmed contract for a project", async () => {
    const { capability, projectId } = await build();
    assert.equal(await capability.getContract(projectId), null);
    const proposed = await capability.proposeContract(projectId, {
      sourceAssetId: "asset-1",
      sourceSha256: SHA_A,
    });
    const latest = await capability.getContract(projectId);
    assert.equal(latest!.id, proposed.id);
  });
});
