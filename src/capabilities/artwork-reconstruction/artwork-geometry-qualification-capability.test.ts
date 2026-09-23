import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import type { ProjectRepository } from "@/lib/db/repository";
import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";
import { createArtworkFidelityCapability } from "@/capabilities/artwork-fidelity";
import { createAssetCapability, PngThumbnailGenerator } from "@/capabilities/assets";
import { DataUriAssetStorageProvider } from "@/capabilities/asset-storage";
import {
  alreadyTransparentArtwork,
  whiteBackgroundArtwork,
} from "@/capabilities/artwork-preparation/artwork-fixtures";
import { encodeRgbaToPng } from "@/capabilities/artwork-preparation/image-decode";

import { createRasterReconstructionCapability } from "./raster-reconstruction-capability";
import {
  ArtworkGeometryQualificationAuthorityError,
  ArtworkGeometryQualificationStateError,
  createArtworkGeometryQualificationCapability,
} from "./artwork-geometry-qualification-capability";

/**
 * Phase R6A (Geometry-Qualified Clean Master v1): the persistence/authority
 * layer around the pure `qualifyReconstructionGeometry` engine. Mirrors
 * `raster-reconstruction-capability.test.ts`'s own fixture/setup style
 * exactly.
 */
describe("ArtworkGeometryQualificationCapability", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-geometry-qualification-capability-"));
    process.chdir(tempDir);
  });

  after(async () => {
    await cleanupTempWorkspace(tempDir, previousCwd);
  });

  const SHA_A = "a".repeat(64);

  async function build() {
    const { LocalProjectRepository } = await import("@/lib/db/local-store");
    const repo: ProjectRepository = new LocalProjectRepository();
    const fidelity = createArtworkFidelityCapability(repo);
    const reconstruction = createRasterReconstructionCapability(repo);
    const assets = createAssetCapability(repo, new DataUriAssetStorageProvider(), new PngThumbnailGenerator());
    const qualification = createArtworkGeometryQualificationCapability(repo, assets, reconstruction);
    const project = await repo.createProject();
    return { repo, fidelity, reconstruction, assets, qualification, projectId: project.project.id };
  }

  /** A real, downloadable candidate asset — QUALIFIABLE (opaque white background, dark subject, well inside the canvas). */
  async function uploadQualifiableCandidate(
    assets: Awaited<ReturnType<typeof build>>["assets"],
    projectId: string,
  ) {
    const bytes = encodeRgbaToPng(whiteBackgroundArtwork());
    const uploaded = await assets.uploadConceptImage(projectId, {
      conceptId: "candidate-fixture",
      bytes,
      contentType: "image/png",
      widthPx: 120,
      heightPx: 120,
      hasTransparency: false,
      providerKey: "test",
      generationJobId: null,
      metadata: {},
    });
    return uploaded.primary.id;
  }

  /** A real, downloadable candidate asset — UNQUALIFIABLE (already transparent; the classifier abstains). */
  async function uploadUnqualifiableCandidate(
    assets: Awaited<ReturnType<typeof build>>["assets"],
    projectId: string,
  ) {
    const bytes = encodeRgbaToPng(alreadyTransparentArtwork());
    const uploaded = await assets.uploadConceptImage(projectId, {
      conceptId: "candidate-fixture-unqualifiable",
      bytes,
      contentType: "image/png",
      widthPx: 120,
      heightPx: 120,
      hasTransparency: true,
      providerKey: "test",
      generationJobId: null,
      metadata: {},
    });
    return uploaded.primary.id;
  }

  async function buildApprovedJob(
    built: Awaited<ReturnType<typeof build>>,
    candidateAssetId: string,
  ) {
    const proposed = await built.fidelity.proposeContract(built.projectId, {
      sourceAssetId: "source-1",
      sourceSha256: SHA_A,
    });
    const contract = await built.fidelity.confirmContract(built.projectId, proposed.id, {
      currentSourceSha256: SHA_A,
      confirmedWording: ["REGENCY"],
      confirmedMarks: [],
      confirmedBy: "customer",
    });
    const job = await built.reconstruction.requestReconstruction(built.projectId, {
      sourceAssetId: "source-1",
      currentSourceSha256: SHA_A,
      fidelityContractId: contract.id,
    });
    await built.repo.updateArtworkReconstructionJob(job.id, {
      status: "completed",
      completedAt: new Date().toISOString(),
      candidateAssetId,
      wordingVerified: true,
      geometryStatus: "review_required",
      reviewStatus: "pending_review",
    });
    const approved = await built.reconstruction.approveCandidate(built.projectId, job.id, {
      confirmedBy: "customer",
    });
    return { job: approved, contract };
  }

  // A/C: qualification row creation + normalized derivative linkage.
  it("A/C: qualifies an approved candidate, creating a normalized derivative and a pending-confirmation row", async () => {
    const built = await build();
    const candidateAssetId = await uploadQualifiableCandidate(built.assets, built.projectId);
    const { job } = await buildApprovedJob(built, candidateAssetId);

    const qualification = await built.qualification.ensureQualification(built.projectId, job.id);
    assert.equal(qualification.qualificationStatus, "normalized_pending_confirmation");
    assert.equal(qualification.reconstructionJobId, job.id);
    assert.equal(qualification.candidateAssetId, candidateAssetId);
    assert.ok(qualification.derivedAssetId, "a derivative asset must be created");
    assert.notEqual(qualification.derivedAssetId, candidateAssetId);
    assert.ok(qualification.contentBounds);
    assert.ok(qualification.normalizedWidthPx! > 0);
    assert.ok(qualification.normalizedHeightPx! > 0);

    const derivative = await built.assets.downloadAssetBytes(qualification.derivedAssetId!);
    assert.ok(derivative, "the derivative asset must actually be downloadable");
  });

  // Unusable path: deterministic qualification abstains -> no derivative, never consumable.
  it("classifier abstention persists as 'unusable' with no derivative asset", async () => {
    const built = await build();
    const candidateAssetId = await uploadUnqualifiableCandidate(built.assets, built.projectId);
    const { job } = await buildApprovedJob(built, candidateAssetId);

    const qualification = await built.qualification.ensureQualification(built.projectId, job.id);
    assert.equal(qualification.qualificationStatus, "unusable");
    assert.equal(qualification.derivedAssetId, null);
    assert.equal(qualification.contentBounds, null);
  });

  // H/I: pending/rejected reconstruction cannot be qualified.
  it("H: a reconstruction job that is not yet approved refuses qualification", async () => {
    const built = await build();
    const proposed = await built.fidelity.proposeContract(built.projectId, {
      sourceAssetId: "source-1",
      sourceSha256: SHA_A,
    });
    const contract = await built.fidelity.confirmContract(built.projectId, proposed.id, {
      currentSourceSha256: SHA_A,
      confirmedWording: ["REGENCY"],
      confirmedMarks: [],
      confirmedBy: "customer",
    });
    const job = await built.reconstruction.requestReconstruction(built.projectId, {
      sourceAssetId: "source-1",
      currentSourceSha256: SHA_A,
      fidelityContractId: contract.id,
    });

    await assert.rejects(
      () => built.qualification.ensureQualification(built.projectId, job.id),
      ArtworkGeometryQualificationStateError,
    );
  });

  it("I: a REJECTED reconstruction candidate refuses qualification", async () => {
    const built = await build();
    const candidateAssetId = await uploadQualifiableCandidate(built.assets, built.projectId);
    const proposed = await built.fidelity.proposeContract(built.projectId, {
      sourceAssetId: "source-1",
      sourceSha256: SHA_A,
    });
    const contract = await built.fidelity.confirmContract(built.projectId, proposed.id, {
      currentSourceSha256: SHA_A,
      confirmedWording: ["REGENCY"],
      confirmedMarks: [],
      confirmedBy: "customer",
    });
    const job = await built.reconstruction.requestReconstruction(built.projectId, {
      sourceAssetId: "source-1",
      currentSourceSha256: SHA_A,
      fidelityContractId: contract.id,
    });
    await built.repo.updateArtworkReconstructionJob(job.id, {
      status: "completed",
      completedAt: new Date().toISOString(),
      candidateAssetId,
      wordingVerified: true,
      geometryStatus: "review_required",
      reviewStatus: "pending_review",
    });
    await built.reconstruction.rejectCandidate(built.projectId, job.id);

    await assert.rejects(
      () => built.qualification.ensureQualification(built.projectId, job.id),
      ArtworkGeometryQualificationStateError,
    );
  });

  // M: project mismatch.
  it("M: a job from a DIFFERENT project is refused", async () => {
    const built = await build();
    const candidateAssetId = await uploadQualifiableCandidate(built.assets, built.projectId);
    const { job } = await buildApprovedJob(built, candidateAssetId);

    const otherProject = await built.repo.createProject();
    await assert.rejects(
      () => built.qualification.ensureQualification(otherProject.project.id, job.id),
      ArtworkGeometryQualificationStateError,
    );
  });

  // J: superseded contract cannot be qualified.
  it("J: a job bound to a contract superseded before qualification runs is refused", async () => {
    const built = await build();
    const candidateAssetId = await uploadQualifiableCandidate(built.assets, built.projectId);
    const { job } = await buildApprovedJob(built, candidateAssetId);

    // Correction supersedes the bound contract.
    const proposedB = await built.fidelity.proposeContract(built.projectId, {
      sourceAssetId: "source-1",
      sourceSha256: SHA_A,
    });
    await built.fidelity.confirmContract(built.projectId, proposedB.id, {
      currentSourceSha256: SHA_A,
      confirmedWording: ["REGENCY"],
      confirmedMarks: ["®"],
      confirmedBy: "customer",
    });

    await assert.rejects(
      () => built.qualification.ensureQualification(built.projectId, job.id),
      ArtworkGeometryQualificationAuthorityError,
    );
  });

  // B/Q/R/U: idempotency -- repeated calls converge on one row, one derivative.
  describe("idempotency", () => {
    it("B/Q/R/U: a second ensureQualification call returns the SAME row, never re-creating a derivative", async () => {
      const built = await build();
      const candidateAssetId = await uploadQualifiableCandidate(built.assets, built.projectId);
      const { job } = await buildApprovedJob(built, candidateAssetId);

      const first = await built.qualification.ensureQualification(built.projectId, job.id);
      const second = await built.qualification.ensureQualification(built.projectId, job.id);

      assert.equal(second.id, first.id);
      assert.equal(second.derivedAssetId, first.derivedAssetId);
    });

    it("concurrent ensureQualification calls for the same job converge on exactly one row", async () => {
      const built = await build();
      const candidateAssetId = await uploadQualifiableCandidate(built.assets, built.projectId);
      const { job } = await buildApprovedJob(built, candidateAssetId);

      const [a, b] = await Promise.all([
        built.qualification.ensureQualification(built.projectId, job.id),
        built.qualification.ensureQualification(built.projectId, job.id),
      ]);
      assert.equal(a.id, b.id);

      const byJob = await built.qualification.getQualificationByJob(job.id);
      assert.equal(byJob!.id, a.id);
    });
  });

  // S: candidate immutability.
  it("S: qualifying a candidate never mutates its own bytes", async () => {
    const built = await build();
    const candidateAssetId = await uploadQualifiableCandidate(built.assets, built.projectId);
    const before = await built.assets.downloadAssetBytes(candidateAssetId);

    const { job } = await buildApprovedJob(built, candidateAssetId);
    await built.qualification.ensureQualification(built.projectId, job.id);

    const after = await built.assets.downloadAssetBytes(candidateAssetId);
    assert.equal(Buffer.compare(before!.bytes, after!.bytes), 0);
  });

  describe("confirmQualification / rejectQualification / getCurrentProductionQualifiedMaster", () => {
    async function buildQualified(built: Awaited<ReturnType<typeof build>>) {
      const candidateAssetId = await uploadQualifiableCandidate(built.assets, built.projectId);
      const { job } = await buildApprovedJob(built, candidateAssetId);
      const qualification = await built.qualification.ensureQualification(built.projectId, job.id);
      return { job, qualification };
    }

    // D: pending cannot resolve.
    it("D: a pending-confirmation qualification does not resolve as the production-qualified master", async () => {
      const built = await build();
      await buildQualified(built);
      assert.equal(await built.qualification.getCurrentProductionQualifiedMaster(built.projectId), null);
    });

    // E: confirmed resolves.
    it("E: a confirmed qualification resolves as the production-qualified master", async () => {
      const built = await build();
      await buildQualified(built);
      const confirmed = await built.qualification.confirmQualification(built.projectId, "customer");
      assert.equal(confirmed.qualificationStatus, "confirmed");
      assert.ok(confirmed.confirmedAt);
      assert.equal(confirmed.confirmedBy, "customer");

      const master = await built.qualification.getCurrentProductionQualifiedMaster(built.projectId);
      assert.equal(master!.id, confirmed.id);
    });

    // F: rejected cannot resolve.
    it("F: a rejected qualification never resolves as the production-qualified master", async () => {
      const built = await build();
      await buildQualified(built);
      const rejected = await built.qualification.rejectQualification(built.projectId);
      assert.equal(rejected.qualificationStatus, "rejected");
      assert.equal(await built.qualification.getCurrentProductionQualifiedMaster(built.projectId), null);
    });

    // G: unusable cannot resolve.
    it("G: an 'unusable' qualification never resolves as the production-qualified master", async () => {
      const built = await build();
      const candidateAssetId = await uploadUnqualifiableCandidate(built.assets, built.projectId);
      const { job } = await buildApprovedJob(built, candidateAssetId);
      await built.qualification.ensureQualification(built.projectId, job.id);

      assert.equal(await built.qualification.getCurrentProductionQualifiedMaster(built.projectId), null);
      await assert.rejects(
        () => built.qualification.confirmQualification(built.projectId, "customer"),
        ArtworkGeometryQualificationStateError,
      );
    });

    it("a qualification that is already confirmed/rejected cannot be confirmed or rejected again", async () => {
      const built = await build();
      await buildQualified(built);
      await built.qualification.confirmQualification(built.projectId, "customer");

      await assert.rejects(
        () => built.qualification.confirmQualification(built.projectId, "customer"),
        ArtworkGeometryQualificationStateError,
      );
      await assert.rejects(
        () => built.qualification.rejectQualification(built.projectId),
        ArtworkGeometryQualificationStateError,
      );
    });

    // K: newer reconstruction supersedes old qualification.
    it("K: a NEWER accepted reconstruction's qualification supersedes an older confirmed one", async () => {
      const built = await build();
      const { qualification: firstQualification } = await buildQualified(built);
      await built.qualification.confirmQualification(built.projectId, "customer");
      assert.ok(await built.qualification.getCurrentProductionQualifiedMaster(built.projectId));

      // A brand-new "Rebuild my artwork" against the SAME still-current
      // contract creates a genuinely new job (mirrors
      // `requestReconstruction`'s own "Try again" precedent) -- reject the
      // first candidate is not required; a second reconstruction can be
      // requested and approved independently once the first job/candidate
      // has been superseded by contract correction, so simulate the
      // realistic case: contract correction, then a fresh candidate.
      const proposedB = await built.fidelity.proposeContract(built.projectId, {
        sourceAssetId: "source-1",
        sourceSha256: SHA_A,
      });
      const contractB = await built.fidelity.confirmContract(built.projectId, proposedB.id, {
        currentSourceSha256: SHA_A,
        confirmedWording: ["REGENCY"],
        confirmedMarks: ["®"],
        confirmedBy: "customer",
      });
      const candidateB = await uploadQualifiableCandidate(built.assets, built.projectId);
      const jobB = await built.reconstruction.requestReconstruction(built.projectId, {
        sourceAssetId: "source-1",
        currentSourceSha256: SHA_A,
        fidelityContractId: contractB.id,
      });
      await built.repo.updateArtworkReconstructionJob(jobB.id, {
        status: "completed",
        completedAt: new Date().toISOString(),
        candidateAssetId: candidateB,
        wordingVerified: true,
        geometryStatus: "review_required",
        reviewStatus: "pending_review",
      });
      await built.reconstruction.approveCandidate(built.projectId, jobB.id, {
        protectedMarksConfirmed: true,
        confirmedBy: "customer",
      });
      const qualificationB = await built.qualification.ensureQualification(built.projectId, jobB.id);

      // The OLD qualification is no longer current (superseded contract).
      assert.notEqual(qualificationB.id, firstQualification.id);
      const master = await built.qualification.getCurrentProductionQualifiedMaster(built.projectId);
      // Not confirmed yet -- must be null, and specifically must NOT
      // resolve to the OLD (now-stale) confirmed qualification.
      assert.equal(master, null);

      await built.qualification.confirmQualification(built.projectId, "customer");
      const newMaster = await built.qualification.getCurrentProductionQualifiedMaster(built.projectId);
      assert.equal(newMaster!.id, qualificationB.id);
    });

    // N/O/P: CAS / concurrency.
    describe("concurrency", () => {
      it("N/O/P: concurrent confirm + reject resolve to exactly one winner", async () => {
        const built = await build();
        await buildQualified(built);

        const confirm = built.qualification.confirmQualification(built.projectId, "customer");
        const reject = built.qualification.rejectQualification(built.projectId);

        const results = await Promise.allSettled([confirm, reject]);
        const fulfilled = results.filter((r) => r.status === "fulfilled");
        const rejected = results.filter((r) => r.status === "rejected");
        assert.equal(fulfilled.length, 1, "exactly one of the two racing decisions must succeed");
        assert.equal(rejected.length, 1);
      });

      it("the reverse ordering (reject started first) also resolves to exactly one winner", async () => {
        const built = await build();
        await buildQualified(built);

        const reject = built.qualification.rejectQualification(built.projectId);
        const confirm = built.qualification.confirmQualification(built.projectId, "customer");

        const results = await Promise.allSettled([reject, confirm]);
        assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
        assert.equal(results.filter((r) => r.status === "rejected").length, 1);
      });
    });
  });

  // X: REGENCY-shaped backfill path, no provider anywhere in this capability.
  it("X: an already-approved candidate (backfill scenario) can be qualified through the normal runtime path, no provider call anywhere in this capability", async () => {
    const built = await build();
    const candidateAssetId = await uploadQualifiableCandidate(built.assets, built.projectId);
    const { job } = await buildApprovedJob(built, candidateAssetId);

    // Simulates a project loading long after approval, with no
    // qualification yet -- the exact REGENCY backfill shape.
    const qualification = await built.qualification.ensureQualification(built.projectId, job.id);
    assert.equal(qualification.qualificationStatus, "normalized_pending_confirmation");
  });
});
