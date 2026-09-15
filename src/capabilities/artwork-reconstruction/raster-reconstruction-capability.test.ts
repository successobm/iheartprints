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

  /** Approves with an explicit, valid attestation -- the shape every legitimate call site actually sends. */
  const VALID_APPROVAL = { protectedMarksConfirmed: true, confirmedBy: "customer" as const };

  describe("approveCandidate / rejectCandidate", () => {
    async function buildCompletedJob(
      confirmedMarks: ("™" | "®" | "©")[] = ["™"],
    ) {
      const built = await build();
      const proposed = await built.fidelity.proposeContract(built.projectId, {
        sourceAssetId: "asset-1",
        sourceSha256: SHA_A,
      });
      const contract = await built.fidelity.confirmContract(built.projectId, proposed.id, {
        currentSourceSha256: SHA_A,
        confirmedWording: ["REGENCY"],
        confirmedMarks,
        confirmedBy: "customer",
      });
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
      return { ...built, jobId: job.id, contract };
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
        () => reconstruction.approveCandidate(projectId, job.id, VALID_APPROVAL),
        ArtworkReconstructionStateError,
      );
    });

    it("approve transitions a pending-review candidate to approved -- never grants Print Ready or a production asset (this capability has no such concept)", async () => {
      const { reconstruction, projectId, jobId } = await buildCompletedJob();
      const approved = await reconstruction.approveCandidate(projectId, jobId, VALID_APPROVAL);
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
      await reconstruction.approveCandidate(projectId, jobId, VALID_APPROVAL);
      await assert.rejects(
        () => reconstruction.approveCandidate(projectId, jobId, VALID_APPROVAL),
        ArtworkReconstructionStateError,
      );
      await assert.rejects(
        () => reconstruction.rejectCandidate(projectId, jobId),
        ArtworkReconstructionStateError,
      );
    });

    /**
     * Phase R5-R (independent-review repair, BLOCKER 2): the exact
     * independently-proven regression. Reconstruct against contract A,
     * let contract B supersede it, then attempt to approve the OLD
     * candidate -- must be refused, and must NOT become the current
     * accepted master.
     */
    describe("STALE-CANDIDATE REGRESSION (Blocker 2)", () => {
      it("T0-T3: approving a candidate after its contract was superseded is REFUSED", async () => {
        const { fidelity, reconstruction, projectId, jobId } = await buildCompletedJob(["™"]);

        // T2: a correction supersedes the bound contract.
        const proposedB = await fidelity.proposeContract(projectId, {
          sourceAssetId: "asset-1",
          sourceSha256: SHA_A,
        });
        await fidelity.confirmContract(projectId, proposedB.id, {
          currentSourceSha256: SHA_A,
          confirmedWording: ["REGENCY"],
          confirmedMarks: ["®"],
          confirmedBy: "customer",
        });

        // T3: attempt to approve the OLD candidate.
        await assert.rejects(
          () => reconstruction.approveCandidate(projectId, jobId, VALID_APPROVAL),
          ArtworkReconstructionAuthorityError,
        );

        const reloaded = await reconstruction.getJob(jobId);
        assert.equal(reloaded!.reviewStatus, "pending_review", "must NOT become approved");
        assert.equal(
          await reconstruction.getCurrentAcceptedMaster(projectId, "asset-1"),
          null,
          "the stale candidate must not be reachable as the current accepted master",
        );
      });

      it("a candidate reconstructed against the CURRENT (never superseded) contract may still be approved normally", async () => {
        const { reconstruction, projectId, jobId } = await buildCompletedJob(["™"]);
        const approved = await reconstruction.approveCandidate(projectId, jobId, VALID_APPROVAL);
        assert.equal(approved.reviewStatus, "approved");
      });

      it("a fresh candidate reconstructed against the NEW current contract (B) can proceed and become the accepted master", async () => {
        const { fidelity, reconstruction, repo, projectId } = await buildCompletedJob(["™"]);

        const proposedB = await fidelity.proposeContract(projectId, {
          sourceAssetId: "asset-1",
          sourceSha256: SHA_A,
        });
        const contractB = await fidelity.confirmContract(projectId, proposedB.id, {
          currentSourceSha256: SHA_A,
          confirmedWording: ["REGENCY"],
          confirmedMarks: ["®"],
          confirmedBy: "customer",
        });
        const jobB = await reconstruction.requestReconstruction(projectId, {
          sourceAssetId: "asset-1",
          currentSourceSha256: SHA_A,
          fidelityContractId: contractB.id,
        });
        await repo.updateArtworkReconstructionJob(jobB.id, {
          status: "completed",
          completedAt: new Date().toISOString(),
          candidateAssetId: "candidate-b",
          wordingVerified: true,
          geometryStatus: "verified",
          reviewStatus: "pending_review",
        });

        const approvedB = await reconstruction.approveCandidate(projectId, jobB.id, {
          protectedMarksConfirmed: true,
          confirmedBy: "customer",
        });
        assert.equal(approvedB.reviewStatus, "approved");

        const master = await reconstruction.getCurrentAcceptedMaster(projectId, "asset-1");
        assert.equal(master!.id, jobB.id);
      });
    });

    /**
     * Phase R5-R (independent-review repair, BLOCKER 1): a missing or
     * false protected-mark attestation must be refused SERVER-SIDE, never
     * merely by a UI checkbox.
     */
    describe("MARK BYPASS (Blocker 1)", () => {
      it("a contract confirming a protected mark REFUSES approval with no attestation supplied", async () => {
        const { reconstruction, projectId, jobId } = await buildCompletedJob(["™"]);
        await assert.rejects(
          () =>
            reconstruction.approveCandidate(projectId, jobId, {
              confirmedBy: "customer",
            } as never),
          ArtworkReconstructionStateError,
        );
        const reloaded = await reconstruction.getJob(jobId);
        assert.equal(reloaded!.reviewStatus, "pending_review");
      });

      it("a contract confirming a protected mark REFUSES approval with protectedMarksConfirmed: false", async () => {
        const { reconstruction, projectId, jobId } = await buildCompletedJob(["™"]);
        await assert.rejects(
          () =>
            reconstruction.approveCandidate(projectId, jobId, {
              protectedMarksConfirmed: false,
              confirmedBy: "customer",
            }),
          ArtworkReconstructionStateError,
        );
      });

      it("a contract confirming a protected mark APPROVES with an explicit true attestation, and durably records the review", async () => {
        const { reconstruction, projectId, jobId } = await buildCompletedJob(["™"]);
        const approved = await reconstruction.approveCandidate(projectId, jobId, VALID_APPROVAL);
        assert.equal(approved.reviewStatus, "approved");
        assert.equal(approved.protectedMarksReviewed, true);
        assert.ok(approved.protectedMarksReviewedAt);
        assert.equal(approved.protectedMarksReviewedBy, "customer");
      });

      it("a contract confirming NO protected marks does not require an attestation at all", async () => {
        const { reconstruction, projectId, jobId } = await buildCompletedJob([]);
        const approved = await reconstruction.approveCandidate(projectId, jobId, {
          confirmedBy: "customer",
        });
        assert.equal(approved.reviewStatus, "approved");
        // Nothing to attest to -- never persisted for a mark-free contract.
        assert.equal(approved.protectedMarksReviewed, null);
        assert.equal(approved.protectedMarksReviewedAt, null);
        assert.equal(approved.protectedMarksReviewedBy, null);
      });
    });

    /**
     * Phase R5-R (independent-review repair, BLOCKER 3): true concurrent
     * approve + reject must resolve to exactly one winner, never a silent
     * overwrite.
     */
    describe("CONCURRENT APPROVE/REJECT (Blocker 3)", () => {
      it("approve and reject racing the same pending_review job resolve to exactly one winner", async () => {
        const { reconstruction, projectId, jobId } = await buildCompletedJob(["™"]);

        const approve = reconstruction.approveCandidate(projectId, jobId, VALID_APPROVAL);
        const reject = reconstruction.rejectCandidate(projectId, jobId);

        const results = await Promise.allSettled([approve, reject]);
        const fulfilled = results.filter((r) => r.status === "fulfilled");
        const rejected = results.filter((r) => r.status === "rejected");

        assert.equal(fulfilled.length, 1, "exactly one of the two racing decisions must succeed");
        assert.equal(
          rejected.length,
          1,
          "exactly one of the two racing decisions must be refused as a conflict",
        );
        assert.ok((rejected[0] as PromiseRejectedResult).reason instanceof ArtworkReconstructionStateError);

        const reloaded = await reconstruction.getJob(jobId);
        assert.ok(reloaded!.reviewStatus === "approved" || reloaded!.reviewStatus === "rejected");
        const winnerStatus = (
          fulfilled[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof reconstruction.approveCandidate>>>
        ).value.reviewStatus;
        assert.equal(reloaded!.reviewStatus, winnerStatus, "durable state equals exactly the winner's outcome");
      });

      it("the reverse ordering (reject started first) also resolves to exactly one winner", async () => {
        const { reconstruction, projectId, jobId } = await buildCompletedJob(["™"]);

        const reject = reconstruction.rejectCandidate(projectId, jobId);
        const approve = reconstruction.approveCandidate(projectId, jobId, VALID_APPROVAL);

        const results = await Promise.allSettled([reject, approve]);
        assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
        assert.equal(results.filter((r) => r.status === "rejected").length, 1);
      });
    });
  });

  /**
   * Phase R5-R (independent-review repair): "the latest job" and "the
   * current accepted clean master" are NOT the same question.
   */
  describe("getCurrentAcceptedMaster", () => {
    it("null when nothing has ever been approved", async () => {
      const { reconstruction, projectId } = await build();
      assert.equal(await reconstruction.getCurrentAcceptedMaster(projectId, "asset-1"), null);
    });

    it("finds the approved job even after a NEWER pending/rejected job exists for the same still-current authority", async () => {
      const { fidelity, reconstruction, repo, projectId } = await build();
      const contract = await proposeAndConfirm(fidelity, projectId, "asset-1", SHA_A);
      const job1 = await reconstruction.requestReconstruction(projectId, {
        sourceAssetId: "asset-1",
        currentSourceSha256: SHA_A,
        fidelityContractId: contract.id,
      });
      await repo.updateArtworkReconstructionJob(job1.id, {
        status: "completed",
        completedAt: new Date().toISOString(),
        candidateAssetId: "candidate-1",
        wordingVerified: true,
        geometryStatus: "verified",
        reviewStatus: "pending_review",
      });
      const approved = await reconstruction.approveCandidate(projectId, job1.id, VALID_APPROVAL);
      assert.equal(approved.reviewStatus, "approved");

      const master = await reconstruction.getCurrentAcceptedMaster(projectId, "asset-1");
      assert.equal(master!.id, job1.id);
      assert.equal(master!.candidateAssetId, "candidate-1");
    });

    it("a previously-approved master bound to a SUPERSEDED contract is never returned once a correction becomes current", async () => {
      const { fidelity, reconstruction, repo, projectId } = await build();
      const contractA = await proposeAndConfirm(fidelity, projectId, "asset-1", SHA_A);
      const jobA = await reconstruction.requestReconstruction(projectId, {
        sourceAssetId: "asset-1",
        currentSourceSha256: SHA_A,
        fidelityContractId: contractA.id,
      });
      await repo.updateArtworkReconstructionJob(jobA.id, {
        status: "completed",
        completedAt: new Date().toISOString(),
        candidateAssetId: "candidate-a",
        wordingVerified: true,
        geometryStatus: "verified",
        reviewStatus: "pending_review",
      });
      await reconstruction.approveCandidate(projectId, jobA.id, VALID_APPROVAL);

      // Correction supersedes contract A.
      const proposedB = await fidelity.proposeContract(projectId, {
        sourceAssetId: "asset-1",
        sourceSha256: SHA_A,
      });
      await fidelity.confirmContract(projectId, proposedB.id, {
        currentSourceSha256: SHA_A,
        confirmedWording: ["REGENCY"],
        confirmedMarks: ["®"],
        confirmedBy: "customer",
      });

      assert.equal(await reconstruction.getCurrentAcceptedMaster(projectId, "asset-1"), null);
    });
  });

  /**
   * Phase R5-R (independent-review repair): the paid-duplicate-request
   * race — two concurrent explicit requests for the identical (project,
   * source, current-contract) binding must never create two payable jobs.
   */
  describe("DUPLICATE PAID-REQUEST RACE", () => {
    it("two concurrent requestReconstruction calls for the same current authority create exactly one job", async () => {
      const { fidelity, reconstruction, projectId } = await build();
      const contract = await proposeAndConfirm(fidelity, projectId, "asset-1", SHA_A);

      const input = {
        sourceAssetId: "asset-1",
        currentSourceSha256: SHA_A,
        fidelityContractId: contract.id,
      };
      const [jobA, jobB] = await Promise.all([
        reconstruction.requestReconstruction(projectId, input),
        reconstruction.requestReconstruction(projectId, input),
      ]);

      assert.equal(jobA.id, jobB.id, "both concurrent requests must resolve to the SAME job");
    });

    it("an explicit later 'Try again' after rejection creates a genuinely NEW job, never reuses the rejected one", async () => {
      const { fidelity, reconstruction, repo, projectId } = await build();
      const contract = await proposeAndConfirm(fidelity, projectId, "asset-1", SHA_A);
      const job1 = await reconstruction.requestReconstruction(projectId, {
        sourceAssetId: "asset-1",
        currentSourceSha256: SHA_A,
        fidelityContractId: contract.id,
      });
      await repo.updateArtworkReconstructionJob(job1.id, {
        status: "completed",
        completedAt: new Date().toISOString(),
        candidateAssetId: "candidate-1",
        wordingVerified: true,
        geometryStatus: "verified",
        reviewStatus: "pending_review",
      });
      await reconstruction.rejectCandidate(projectId, job1.id);

      const job2 = await reconstruction.requestReconstruction(projectId, {
        sourceAssetId: "asset-1",
        currentSourceSha256: SHA_A,
        fidelityContractId: contract.id,
      });

      assert.notEqual(job2.id, job1.id, "a fresh job must be created for the retry");
      assert.equal(job2.status, "queued");
      assert.equal(job2.reviewStatus, null);
    });
  });
});
