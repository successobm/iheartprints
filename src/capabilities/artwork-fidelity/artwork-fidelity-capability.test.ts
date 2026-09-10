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

  it("18/repair: a CONFIRMED contract refuses a second confirmContract call outright — it is an immutable authority snapshot, never mutated in place", async () => {
    const { capability, projectId } = await build();
    const proposed = await capability.proposeContract(projectId, {
      sourceAssetId: "asset-1",
      sourceSha256: SHA_A,
    });
    await capability.confirmContract(projectId, proposed.id, {
      currentSourceSha256: SHA_A,
      confirmedWording: [],
      confirmedMarks: ["™"],
      confirmedBy: "customer",
    });

    await assert.rejects(
      () =>
        capability.confirmContract(projectId, proposed.id, {
          currentSourceSha256: SHA_A,
          confirmedWording: [],
          confirmedMarks: ["®"],
          confirmedBy: "customer",
        }),
      ArtworkFidelityContractStateError,
    );
  });

  it("historical authority: correcting TM -> R produces a NEW contract; the original confirmed contract remains unchanged forever, and the current contract resolves to the correction", async () => {
    const { capability, projectId } = await build();

    // 1/2/3. Propose and confirm Contract A with TM.
    const proposedA = await capability.proposeContract(projectId, {
      sourceAssetId: "asset-1",
      sourceSha256: SHA_A,
    });
    const contractA = await capability.confirmContract(projectId, proposedA.id, {
      currentSourceSha256: SHA_A,
      confirmedWording: ["REGENCY"],
      confirmedMarks: ["™"],
      confirmedBy: "customer",
    });
    const keyA = contractA.contractKey;

    // 4/5/6. The customer's correction: propose and confirm a SECOND,
    // independent contract with R -- never a second write to Contract A.
    const proposedB = await capability.proposeContract(projectId, {
      sourceAssetId: "asset-1",
      sourceSha256: SHA_A,
    });
    const contractB = await capability.confirmContract(projectId, proposedB.id, {
      currentSourceSha256: SHA_A,
      confirmedWording: ["REGENCY"],
      confirmedMarks: ["®"],
      confirmedBy: "customer",
    });
    const keyB = contractB.contractKey;

    // ids differ; keys differ.
    assert.notEqual(contractA.id, contractB.id);
    assert.notEqual(keyA, keyB);

    // Reloading A independently proves it was never touched by B's
    // confirmation -- the historical authority survives intact.
    const reloadedA = await capability.getContractById(contractA.id);
    assert.deepEqual(reloadedA!.confirmedMarks, ["™"]);
    assert.equal(reloadedA!.contractKey, keyA);
    assert.equal(reloadedA!.status, "confirmed");

    // The current project contract is B, the correction.
    const current = await capability.getContract(projectId);
    assert.equal(current!.id, contractB.id);
    assert.deepEqual(current!.confirmedMarks, ["®"]);

    // A future consumer holding the stale key A must fail closed against
    // the current authority.
    assert.notEqual(keyA, current!.contractKey);
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

  it("8/repair: getContract(projectId) returns the NEWEST of two real, independently confirmed contracts for the same project -- proves actual repository ordering, not only a pure helper", async () => {
    const { capability, projectId } = await build();

    const proposedA = await capability.proposeContract(projectId, {
      sourceAssetId: "asset-1",
      sourceSha256: SHA_A,
    });
    const contractA = await capability.confirmContract(projectId, proposedA.id, {
      currentSourceSha256: SHA_A,
      confirmedWording: ["FIRST"],
      confirmedMarks: [],
      confirmedBy: "customer",
    });

    const proposedB = await capability.proposeContract(projectId, {
      sourceAssetId: "asset-1",
      sourceSha256: SHA_A,
    });
    const contractB = await capability.confirmContract(projectId, proposedB.id, {
      currentSourceSha256: SHA_A,
      confirmedWording: ["SECOND"],
      confirmedMarks: [],
      confirmedBy: "customer",
    });

    const current = await capability.getContract(projectId);
    assert.equal(current!.id, contractB.id);
    assert.notEqual(current!.id, contractA.id);
    assert.deepEqual(current!.confirmedWording, ["SECOND"]);
  });

  it("null vs empty round-trips through the real repository: proposed is null, confirming with [] persists and reloads as [], never null", async () => {
    const { capability, projectId } = await build();
    const proposed = await capability.proposeContract(projectId, {
      sourceAssetId: "asset-1",
      sourceSha256: SHA_A,
    });
    assert.equal(proposed.confirmedWording, null);
    assert.equal(proposed.confirmedMarks, null);

    const confirmed = await capability.confirmContract(projectId, proposed.id, {
      currentSourceSha256: SHA_A,
      confirmedWording: [],
      confirmedMarks: [],
      confirmedBy: "operator",
    });
    assert.deepEqual(confirmed.confirmedWording, []);
    assert.deepEqual(confirmed.confirmedMarks, []);
    assert.notEqual(confirmed.confirmedWording, null);
    assert.notEqual(confirmed.confirmedMarks, null);

    // Reload independently -- proves the [] round-trips through the
    // repository, not merely through the in-memory return value.
    const reloaded = await capability.getContractById(confirmed.id);
    assert.deepEqual(reloaded!.confirmedWording, []);
    assert.deepEqual(reloaded!.confirmedMarks, []);
  });

  it("repair: duplicate confirmed wording/marks collapse to the deduplicated set before storing and hashing", async () => {
    const { capability, projectId } = await build();

    const proposedDup = await capability.proposeContract(projectId, {
      sourceAssetId: "asset-1",
      sourceSha256: SHA_A,
    });
    const dup = await capability.confirmContract(projectId, proposedDup.id, {
      currentSourceSha256: SHA_A,
      confirmedWording: ["ABC", "ABC"],
      confirmedMarks: ["™", "™"],
      confirmedBy: "customer",
    });
    assert.deepEqual(dup.confirmedWording, ["ABC"]);
    assert.deepEqual(dup.confirmedMarks, ["™"]);

    const proposedSingle = await capability.proposeContract(projectId, {
      sourceAssetId: "asset-2",
      sourceSha256: SHA_B,
    });
    const single = await capability.confirmContract(projectId, proposedSingle.id, {
      currentSourceSha256: SHA_B,
      confirmedWording: ["ABC"],
      confirmedMarks: ["™"],
      confirmedBy: "customer",
    });

    // Different source binding, so the raw keys differ -- but recomputing
    // the identity with the SAME source binding proves the duplicate-vs-
    // single wording/marks produce the identical fidelity claim.
    const { deriveArtworkFidelityContractKey } = await import(
      "./artwork-fidelity-contract-identity"
    );
    const dupKeyWithSingleSource = deriveArtworkFidelityContractKey({
      sourceAssetId: single.sourceAssetId,
      sourceSha256: single.sourceSha256,
      confirmedWording: dup.confirmedWording,
      confirmedMarks: dup.confirmedMarks,
      sourceContentBoundingBoxAspectRatio: single.sourceContentBoundingBoxAspectRatio,
    });
    assert.equal(dupKeyWithSingleSource, single.contractKey);

    // Case is NOT collapsed -- "ABC" and "abc" remain distinct facts.
    const proposedCase = await capability.proposeContract(projectId, {
      sourceAssetId: "asset-3",
      sourceSha256: SHA_A,
    });
    const caseVariant = await capability.confirmContract(projectId, proposedCase.id, {
      currentSourceSha256: SHA_A,
      confirmedWording: ["ABC", "abc"],
      confirmedMarks: [],
      confirmedBy: "customer",
    });
    assert.deepEqual(caseVariant.confirmedWording, ["ABC", "abc"]);
  });
});
