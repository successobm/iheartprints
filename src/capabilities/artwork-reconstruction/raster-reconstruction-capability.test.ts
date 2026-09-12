import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import type { ProjectRepository } from "@/lib/db/repository";
import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";
import { createArtworkFidelityCapability } from "@/capabilities/artwork-fidelity";

import {
  ArtworkReconstructionAuthorityError,
  ArtworkReconstructionStateError,
  createRasterReconstructionCapability,
} from "./raster-reconstruction-capability";

/**
 * Phase R5: proves the AUTHORITY gate — the entire point of this
 * capability. A confirmed contract is required before a job may exist at
 * all; nothing here ever calls a provider (this capability has none).
 */
describe("RasterReconstructionCapability", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-reconstruction-capability-"));
    process.chdir(tempDir);
  });

  after(async () => {
    await cleanupTempWorkspace(tempDir, previousCwd);
  });

  async function build() {
    const { LocalProjectRepository } = await import("@/lib/db/local-store");
    const repo: ProjectRepository = new LocalProjectRepository();
    const fidelity = createArtworkFidelityCapability(repo);
    const reconstruction = createRasterReconstructionCapability(repo);
    const project = await repo.createProject();
    return { repo, fidelity, reconstruction, projectId: project.project.id };
  }

  const SHA_A = "a".repeat(64);
  const SHA_B = "b".repeat(64);

  async function proposeAndConfirm(
    fidelity: Awaited<ReturnType<typeof build>>["fidelity"],
    projectId: string,
    sourceAssetId: string,
    sha: string,
  ) {
    const proposed = await fidelity.proposeContract(projectId, {
      sourceAssetId,
      sourceSha256: sha,
    });
    return fidelity.confirmContract(projectId, proposed.id, {
      currentSourceSha256: sha,
      confirmedWording: ["REGENCY"],
      confirmedMarks: ["™"],
      confirmedBy: "customer",
    });
  }

  it("a PROPOSED (unconfirmed) contract cannot become reconstruction authority -- no job is ever created", async () => {
    const { fidelity, reconstruction, projectId } = await build();
    const proposed = await fidelity.proposeContract(projectId, {
      sourceAssetId: "asset-1",
      sourceSha256: SHA_A,
    });

    await assert.rejects(
      () =>
        reconstruction.requestReconstruction(projectId, {
          sourceAssetId: "asset-1",
          currentSourceSha256: SHA_A,
          fidelityContractId: proposed.id,
        }),
      ArtworkReconstructionAuthorityError,
    );
  });

  it("a CONFIRMED contract can become reconstruction authority -- a job is created, queued, and bound to it", async () => {
    const { fidelity, reconstruction, projectId } = await build();
    const contract = await proposeAndConfirm(fidelity, projectId, "asset-1", SHA_A);

    const job = await reconstruction.requestReconstruction(projectId, {
      sourceAssetId: "asset-1",
      currentSourceSha256: SHA_A,
      fidelityContractId: contract.id,
    });

    assert.equal(job.status, "queued");
    assert.equal(job.fidelityContractId, contract.id);
    assert.equal(job.contractKey, contract.contractKey);
    assert.equal(job.sourceAssetId, "asset-1");
    assert.equal(job.candidateAssetId, null);
    assert.equal(job.reviewStatus, null);
  });

  it("stale source SHA (the source changed since fidelity was confirmed) blocks BEFORE any job is created", async () => {
    const { fidelity, reconstruction, projectId } = await build();
    const contract = await proposeAndConfirm(fidelity, projectId, "asset-1", SHA_A);

    await assert.rejects(
      () =>
        reconstruction.requestReconstruction(projectId, {
          sourceAssetId: "asset-1",
          currentSourceSha256: SHA_B, // the CURRENT measured sha differs
          fidelityContractId: contract.id,
        }),
      ArtworkReconstructionAuthorityError,
    );
  });

  it("a contract bound to a DIFFERENT source asset is refused", async () => {
    const { fidelity, reconstruction, projectId } = await build();
    const contract = await proposeAndConfirm(fidelity, projectId, "asset-1", SHA_A);

    await assert.rejects(
      () =>
        reconstruction.requestReconstruction(projectId, {
          sourceAssetId: "asset-2",
          currentSourceSha256: SHA_A,
          fidelityContractId: contract.id,
        }),
      ArtworkReconstructionAuthorityError,
    );
  });

  it("a contract from a DIFFERENT project is refused (project-scoped)", async () => {
    const { repo, fidelity, reconstruction, projectId } = await build();
    const otherProject = await repo.createProject();
    const contract = await proposeAndConfirm(
      fidelity,
      otherProject.project.id,
      "asset-1",
      SHA_A,
    );

    await assert.rejects(
      () =>
        reconstruction.requestReconstruction(projectId, {
          sourceAssetId: "asset-1",
          currentSourceSha256: SHA_A,
          fidelityContractId: contract.id,
        }),
      ArtworkReconstructionAuthorityError,
    );
  });

  it("IDEMPOTENT: a second request for the same (source, confirmed contract) reuses the existing job -- never a second job/paid attempt", async () => {
    const { fidelity, reconstruction, projectId } = await build();
    const contract = await proposeAndConfirm(fidelity, projectId, "asset-1", SHA_A);

    const first = await reconstruction.requestReconstruction(projectId, {
      sourceAssetId: "asset-1",
      currentSourceSha256: SHA_A,
      fidelityContractId: contract.id,
    });
    const second = await reconstruction.requestReconstruction(projectId, {
      sourceAssetId: "asset-1",
      currentSourceSha256: SHA_A,
      fidelityContractId: contract.id,
    });

    assert.equal(second.id, first.id);
  });

  it("a NEW job is created (not reused) when a corrected contract supersedes the one an existing job was bound to", async () => {
    const { fidelity, reconstruction, projectId } = await build();
    const contractA = await proposeAndConfirm(fidelity, projectId, "asset-1", SHA_A);
    const jobA = await reconstruction.requestReconstruction(projectId, {
      sourceAssetId: "asset-1",
      currentSourceSha256: SHA_A,
      fidelityContractId: contractA.id,
    });

    // Correction: propose + confirm a NEW contract for the same source
    // (mirrors ArtworkFidelityCapability's own "propose again" correction
    // precedent).
    const proposedB = await fidelity.proposeContract(projectId, {
      sourceAssetId: "asset-1",
      sourceSha256: SHA_A,
    });
    const contractB = await fidelity.confirmContract(projectId, proposedB.id, {
      currentSourceSha256: SHA_A,
      confirmedWording: ["REGENCY"],
      confirmedMarks: ["®"], // corrected mark
      confirmedBy: "customer",
    });

    const jobB = await reconstruction.requestReconstruction(projectId, {
      sourceAssetId: "asset-1",
      currentSourceSha256: SHA_A,
      fidelityContractId: contractB.id,
    });

    assert.notEqual(jobB.id, jobA.id);
    assert.equal(jobB.contractKey, contractB.contractKey);
    assert.notEqual(jobB.contractKey, jobA.contractKey);
  });

  describe("approveCandidate / rejectCandidate", () => {
    async function buildCompletedJob() {
      const built = await build();
      const contract = await proposeAndConfirm(built.fidelity, built.projectId, "asset-1", SHA_A);
      const job = await built.reconstruction.requestReconstruction(built.projectId, {
        sourceAssetId: "asset-1",
        currentSourceSha256: SHA_A,
        fidelityContractId: contract.id,
      });
      // Simulate what the worker would do on success -- this capability
      // never calls a provider itself.
      await built.repo.updateArtworkReconstructionJob(job.id, {
        status: "completed",
        completedAt: new Date().toISOString(),
        candidateAssetId: "candidate-asset-1",
        wordingVerified: true,
        geometryStatus: "verified",
        reviewStatus: "pending_review",
      });
      return { ...built, jobId: job.id };
    }

    it("a job with no candidate yet cannot be approved", async () => {
      const { reconstruction, projectId } = await build();
      const contract = await proposeAndConfirm(
        (await build()).fidelity,
        projectId,
        "asset-1",
        SHA_A,
      );
      const job = await reconstruction.requestReconstruction(projectId, {
        sourceAssetId: "asset-1",
        currentSourceSha256: SHA_A,
        fidelityContractId: contract.id,
      });
      await assert.rejects(
        () => reconstruction.approveCandidate(projectId, job.id),
        ArtworkReconstructionStateError,
      );
    });

    it("approve transitions a pending-review candidate to approved -- never grants Print Ready or a production asset (this capability has no such concept)", async () => {
      const { reconstruction, projectId, jobId } = await buildCompletedJob();
      const approved = await reconstruction.approveCandidate(projectId, jobId);
      assert.equal(approved.reviewStatus, "approved");
      assert.ok(approved.reviewedAt);
    });

    it("reject transitions a pending-review candidate to rejected -- never accepts it", async () => {
      const { reconstruction, projectId, jobId } = await buildCompletedJob();
      const rejected = await reconstruction.rejectCandidate(projectId, jobId);
      assert.equal(rejected.reviewStatus, "rejected");
    });

    it("a candidate already approved cannot be approved or rejected again", async () => {
      const { reconstruction, projectId, jobId } = await buildCompletedJob();
      await reconstruction.approveCandidate(projectId, jobId);
      await assert.rejects(
        () => reconstruction.approveCandidate(projectId, jobId),
        ArtworkReconstructionStateError,
      );
      await assert.rejects(
        () => reconstruction.rejectCandidate(projectId, jobId),
        ArtworkReconstructionStateError,
      );
    });
  });
});
