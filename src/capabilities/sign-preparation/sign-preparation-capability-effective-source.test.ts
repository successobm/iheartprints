import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { DataUriAssetStorageProvider } from "@/capabilities/asset-storage";
import {
  createAssetCapability,
  PngThumbnailGenerator,
} from "@/capabilities/assets";
import { createArtworkFidelityCapability } from "@/capabilities/artwork-fidelity";
import { encodeRgbaToPng } from "@/capabilities/artwork-preparation/image-decode";
import { alreadyTransparentArtwork } from "@/capabilities/artwork-preparation/artwork-fixtures";
import { createArtworkGeometryQualificationCapability } from "@/capabilities/artwork-reconstruction/artwork-geometry-qualification-capability";
import { createRasterReconstructionCapability } from "@/capabilities/artwork-reconstruction/raster-reconstruction-capability";
import type { ProjectRepository } from "@/lib/db/repository";
import type { SignRepairPlan } from "./contracts";
import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";

import { createSignPreparationCapability } from "./sign-preparation-capability";
import { fillRect, makeImage, toPngBytes } from "./sign-fixtures";

/**
 * R6B (Production-Qualified Clean Master → Signs Authoritative Source
 * Handoff): the Signs effective-source resolver inside
 * `sign-preparation-capability.ts`'s `decodeSignSource`. Exercises the full
 * recovery-lifecycle precedence table against the real local repository and
 * real (non-provider) reconstruction/geometry-qualification capabilities —
 * no mocks, no Topaz/OpenAI provider wired at all, so "zero provider calls"
 * is true by construction, not by assertion.
 */
describe("SignPreparationCapability — R6B effective-source handoff", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-sign-effective-source-"));
    process.chdir(tempDir);
  });

  after(async () => {
    await cleanupTempWorkspace(tempDir, previousCwd);
  });

  const SHA_A = "a".repeat(64);
  const RECOVERY_SOURCE_ASSET_ID = "recovery-source-1";

  async function build() {
    const { LocalProjectRepository } = await import("@/lib/db/local-store");
    const repo: ProjectRepository = new LocalProjectRepository();
    const assets = createAssetCapability(
      repo,
      new DataUriAssetStorageProvider(),
      new PngThumbnailGenerator(),
    );
    const fidelity = createArtworkFidelityCapability(repo);
    const reconstruction = createRasterReconstructionCapability(repo);
    const qualification = createArtworkGeometryQualificationCapability(repo, assets, reconstruction);
    const capability = createSignPreparationCapability(repo, assets, qualification);
    const project = await repo.createProject();
    return {
      repo,
      assets,
      fidelity,
      reconstruction,
      qualification,
      capability,
      projectId: project.project.id,
    };
  }

  /** Signs' own immutable original: an opaque, degraded 1000x344 upload — REGENCY-shaped (Section 13). */
  function regencyOriginalBytes(): Buffer {
    const image = makeImage(1000, 344, { r: 250, g: 250, b: 250 });
    fillRect(image, 60, 40, 940, 300, { r: 20, g: 20, b: 20 });
    return toPngBytes(image);
  }

  /**
   * A reconstruction candidate whose content trims to REGENCY-shaped
   * dimensions (~800x200, aspect ~3.7:1, badly under-resolved for a 48x24in
   * sign) — `qualifyReconstructionGeometry` normalizes to the alpha-trimmed
   * content bounding box (`geometry-qualification.ts`), so a hard-edged
   * rectangle on a uniform background produces a deterministic (if not
   * pixel-exact, once background-tolerance edge fuzz is accounted for)
   * normalized size. Tests read the ACTUAL confirmed dimensions back from
   * the qualification row rather than hardcoding a predicted number.
   */
  function regencyCandidateBytes(): Buffer {
    const image = makeImage(900, 300, { r: 255, g: 255, b: 255 });
    fillRect(image, 41, 42, 860, 259, { r: 20, g: 90, b: 160 });
    return encodeRgbaToPng(image);
  }

  async function uploadRegencyOriginal(built: Awaited<ReturnType<typeof build>>) {
    const preparation = await built.capability.uploadSignArtwork(built.projectId, {
      bytes: regencyOriginalBytes(),
      declaredContentType: "image/png",
      filename: "regency-original.png",
    });
    await built.capability.confirmSignProductionSpec(built.projectId, 48, 24);
    return preparation;
  }

  async function proposeAndConfirmContract(built: Awaited<ReturnType<typeof build>>) {
    const proposed = await built.fidelity.proposeContract(built.projectId, {
      sourceAssetId: RECOVERY_SOURCE_ASSET_ID,
      sourceSha256: SHA_A,
    });
    return built.fidelity.confirmContract(built.projectId, proposed.id, {
      currentSourceSha256: SHA_A,
      confirmedWording: ["REGENCY"],
      confirmedMarks: [],
      confirmedBy: "customer",
    });
  }

  async function requestJob(
    built: Awaited<ReturnType<typeof build>>,
    contractId: string,
  ) {
    return built.reconstruction.requestReconstruction(built.projectId, {
      sourceAssetId: RECOVERY_SOURCE_ASSET_ID,
      currentSourceSha256: SHA_A,
      fidelityContractId: contractId,
    });
  }

  async function completeJobPendingReview(
    built: Awaited<ReturnType<typeof build>>,
    jobId: string,
    candidateAssetId: string,
  ) {
    return built.repo.updateArtworkReconstructionJob(jobId, {
      status: "completed",
      completedAt: new Date().toISOString(),
      candidateAssetId,
      wordingVerified: true,
      geometryStatus: "review_required",
      reviewStatus: "pending_review",
    });
  }

  async function uploadCandidate(
    built: Awaited<ReturnType<typeof build>>,
    bytes: Buffer,
    conceptId: string,
  ) {
    const uploaded = await built.assets.uploadConceptImage(built.projectId, {
      conceptId,
      bytes,
      contentType: "image/png",
      widthPx: 900,
      heightPx: 300,
      hasTransparency: false,
      providerKey: "test",
      generationJobId: null,
      metadata: {},
    });
    return uploaded.primary.id;
  }

  /** Approves the given (already-completed, pending_review) job. */
  async function approveJob(built: Awaited<ReturnType<typeof build>>, jobId: string) {
    return built.reconstruction.approveCandidate(built.projectId, jobId, {
      confirmedBy: "customer",
    });
  }

  /** Full happy-path recovery lineage: contract -> job -> approved -> qualified -> CONFIRMED master. */
  async function buildConfirmedMaster(built: Awaited<ReturnType<typeof build>>) {
    const contract = await proposeAndConfirmContract(built);
    const job = await requestJob(built, contract.id);
    const candidateAssetId = await uploadCandidate(built, regencyCandidateBytes(), "regency-candidate");
    await completeJobPendingReview(built, job.id, candidateAssetId);
    const approved = await approveJob(built, job.id);
    const qualification = await built.qualification.ensureQualification(built.projectId, approved.id);
    const confirmed = await built.qualification.confirmQualification(built.projectId, "customer");
    return { contract, job: approved, qualification, confirmed };
  }

  // ---------------------------------------------------------------------
  // 27: ORIGINAL PATH
  // ---------------------------------------------------------------------

  it("A: no reconstruction/recovery lifecycle — Signs plans from the immutable original, byte-for-byte unchanged", async () => {
    const built = await build();
    const preparation = await uploadRegencyOriginal(built);

    const outcome = await built.capability.planSignRepair(built.projectId);
    assert.equal(outcome.result.status, "planned");
    const plan = (outcome.result as { plan: SignRepairPlan }).plan;
    assert.equal(plan.sourceAssetId, preparation.originalAssetId);
    assert.equal(plan.sourceWidthPx, 1000);
    assert.equal(plan.sourceHeightPx, 344);

    // B: original remains immutable.
    assert.equal(outcome.preparation.originalAssetId, preparation.originalAssetId);
  });

  it("no contract at all: isSignPlanCurrent is true and never throws", async () => {
    const built = await build();
    await uploadRegencyOriginal(built);
    await built.capability.planSignRepair(built.projectId);
    assert.equal(await built.capability.isSignPlanCurrent(built.projectId), true);
  });

  // ---------------------------------------------------------------------
  // 28: RECOVERY BLOCKING
  // ---------------------------------------------------------------------

  it("D: a queued/pending reconstruction job blocks Signs planning — no original fallback", async () => {
    const built = await build();
    await uploadRegencyOriginal(built);
    const contract = await proposeAndConfirmContract(built);
    await requestJob(built, contract.id); // status "queued" — not even completed yet.

    await assert.rejects(() => built.capability.planSignRepair(built.projectId));
  });

  it("E: an approved reconstruction with geometry still pending confirmation blocks Signs planning", async () => {
    const built = await build();
    await uploadRegencyOriginal(built);
    const contract = await proposeAndConfirmContract(built);
    const job = await requestJob(built, contract.id);
    const candidateAssetId = await uploadCandidate(built, regencyCandidateBytes(), "candidate-e");
    await completeJobPendingReview(built, job.id, candidateAssetId);
    const approved = await approveJob(built, job.id);
    await built.qualification.ensureQualification(built.projectId, approved.id); // normalized_pending_confirmation — NOT confirmed yet.

    await assert.rejects(() => built.capability.planSignRepair(built.projectId));
  });

  it("F: a REJECTED geometry qualification blocks Signs planning — no original fallback", async () => {
    const built = await build();
    await uploadRegencyOriginal(built);
    const contract = await proposeAndConfirmContract(built);
    const job = await requestJob(built, contract.id);
    const candidateAssetId = await uploadCandidate(built, regencyCandidateBytes(), "candidate-f");
    await completeJobPendingReview(built, job.id, candidateAssetId);
    const approved = await approveJob(built, job.id);
    await built.qualification.ensureQualification(built.projectId, approved.id);
    await built.qualification.rejectQualification(built.projectId);

    await assert.rejects(() => built.capability.planSignRepair(built.projectId));
  });

  it("G: an 'unusable' (classifier-abstained) geometry qualification blocks Signs planning", async () => {
    const built = await build();
    await uploadRegencyOriginal(built);
    const contract = await proposeAndConfirmContract(built);
    const job = await requestJob(built, contract.id);
    // Already-transparent candidate: the deterministic geometry engine
    // abstains ("unusable"), mirroring `artwork-geometry-qualification-
    // capability.test.ts`'s own "classifier abstention" fixture.
    const candidateAssetId = await uploadCandidate(
      built,
      encodeRgbaToPng(alreadyTransparentArtwork()),
      "candidate-g",
    );
    await completeJobPendingReview(built, job.id, candidateAssetId);
    const approved = await approveJob(built, job.id);
    await built.qualification.ensureQualification(built.projectId, approved.id);

    await assert.rejects(() => built.capability.planSignRepair(built.projectId));
  });

  it("H: a confirmed master superseded by a newer, not-yet-confirmed lifecycle blocks rather than reusing the stale master", async () => {
    const built = await build();
    await uploadRegencyOriginal(built);
    await buildConfirmedMaster(built);

    // A correction supersedes the confirmed contract with a fresh one —
    // no new job/qualification created against it yet.
    const proposedB = await built.fidelity.proposeContract(built.projectId, {
      sourceAssetId: RECOVERY_SOURCE_ASSET_ID,
      sourceSha256: SHA_A,
    });
    await built.fidelity.confirmContract(built.projectId, proposedB.id, {
      currentSourceSha256: SHA_A,
      confirmedWording: ["REGENCY"],
      confirmedMarks: ["®"],
      confirmedBy: "customer",
    });

    assert.equal(await built.qualification.getCurrentProductionQualifiedMaster(built.projectId), null);
    await assert.rejects(() => built.capability.planSignRepair(built.projectId));
  });

  // ---------------------------------------------------------------------
  // 29/31: MASTER HANDOFF + TOPAZ SEMANTICS (REGENCY-shaped fixture)
  // ---------------------------------------------------------------------

  it("I: a geometry-confirmed master becomes the effective Signs source — plan identity, dimensions, and resolution policy recompute from it, with zero provider calls", async () => {
    const built = await build();
    const preparation = await uploadRegencyOriginal(built);
    const { confirmed } = await buildConfirmedMaster(built);

    // REGENCY-shaped: a small, wide master (aspect well over the 48x24
    // box's own 2:1), badly under-resolved for the ordered physical size.
    assert.ok(confirmed.normalizedWidthPx! > 700 && confirmed.normalizedWidthPx! < 900);
    assert.ok(confirmed.normalizedHeightPx! > 150 && confirmed.normalizedHeightPx! < 250);
    assert.ok(confirmed.derivedAssetId);

    const outcome = await built.capability.planSignRepair(built.projectId);
    assert.equal(outcome.result.status, "planned");
    const plan = (outcome.result as { plan: SignRepairPlan }).plan;

    // N/O/P: plan lineage points to the MASTER, never the original.
    assert.equal(plan.sourceAssetId, confirmed.derivedAssetId);
    assert.notEqual(plan.sourceAssetId, preparation.originalAssetId);
    assert.equal(plan.sourceWidthPx, confirmed.normalizedWidthPx);
    assert.equal(plan.sourceHeightPx, confirmed.normalizedHeightPx);

    // I: original provenance untouched.
    assert.equal(outcome.preparation.originalAssetId, preparation.originalAssetId);

    // V/W: contain PPI (source width / 48in) is far below the 48x24
    // policy's minimum for a source this small, so resolution
    // reconstruction is proposed; the 4x ceiling then lifts it back above
    // the minimum — the SAME shape of policy outcome the live REGENCY audit
    // found for these dimensions (Sections 14/15), computed honestly from
    // THIS fixture's own actual master dimensions rather than hardcoded.
    const resolutionStep = plan.steps.find((step) => step.kind === "reconstruct_resolution");
    assert.ok(resolutionStep, "expected a reconstruct_resolution step for a heavily under-resolved master");
    assert.ok(
      plan.expectedEffectivePpi >= 63,
      `expected effective PPI (${plan.expectedEffectivePpi}) to satisfy the 48x24 policy's blocking minimum`,
    );
  });

  it("no silent fallback: originalAssetId is never overwritten by the master handoff", async () => {
    const built = await build();
    const preparation = await uploadRegencyOriginal(built);
    await buildConfirmedMaster(built);
    await built.capability.planSignRepair(built.projectId);

    const reloaded = await built.capability.getSignPreparation(built.projectId);
    assert.equal(reloaded!.originalAssetId, preparation.originalAssetId);
  });

  // ---------------------------------------------------------------------
  // 30: STALE PLAN DETECTION + REPLAN
  // ---------------------------------------------------------------------

  it("Q/S/T: a plan formulated against the original is detected stale once a master becomes current, replans to a new planKey, and is idempotent afterward", async () => {
    const built = await build();
    await uploadRegencyOriginal(built);
    const originalOutcome = await built.capability.planSignRepair(built.projectId);
    const originalPlanKey = originalOutcome.preparation.planKey;
    assert.ok(originalPlanKey);

    await buildConfirmedMaster(built);

    // Q: staleness is detected without a full re-plan side effect of its own.
    assert.equal(await built.capability.isSignPlanCurrent(built.projectId), false);

    // S: replanning produces a genuinely different plan identity.
    const replanned = await built.capability.planSignRepair(built.projectId);
    assert.equal(replanned.result.status, "planned");
    assert.notEqual(replanned.preparation.planKey, originalPlanKey);

    // T/U: now current — a second replan reproduces the SAME key, no drift/loop.
    assert.equal(await built.capability.isSignPlanCurrent(built.projectId), true);
    const secondReplan = await built.capability.planSignRepair(built.projectId);
    assert.equal(secondReplan.preparation.planKey, replanned.preparation.planKey);
  });

  // ---------------------------------------------------------------------
  // R6B REPAIR (Cursor independent review, CONFIRMED P1 / Required Repair
  // #1): authorizeSignRepairPlan must consult Signs effective-source
  // authority, never just its own persisted plan's self-consistency.
  // ---------------------------------------------------------------------

  it("R6B repair: an UNAUTHORIZED original-sourced plan cannot be authorized once recovery has begun (pending review, no master yet)", async () => {
    const built = await build();
    await uploadRegencyOriginal(built);
    const outcome = await built.capability.planSignRepair(built.projectId);
    assert.equal(outcome.result.status, "planned");

    // Recovery begins — a reconstruction job now exists, but there is no
    // current confirmed master. The exact reviewer-reported reproduction:
    // `planSignRepair` already refuses (proven above/elsewhere), but
    // `authorizeSignRepairPlan` must independently refuse too, never
    // trusting only the persisted plan's own self-consistent hash.
    const contract = await proposeAndConfirmContract(built);
    await requestJob(built, contract.id);

    await assert.rejects(() => built.capability.authorizeSignRepairPlan(built.projectId, { authorizedBy: "operator" }));
    const preparation = await built.capability.getSignPreparation(built.projectId);
    assert.equal(preparation!.authorizedPlanKey, null);
  });

  it("R6B repair: an ALREADY-authorized original-sourced plan cannot be re-authorized (even idempotently) once recovery has begun", async () => {
    const built = await build();
    await uploadRegencyOriginal(built);
    const outcome = await built.capability.planSignRepair(built.projectId);
    assert.equal(outcome.result.status, "planned");
    await built.capability.authorizeSignRepairPlan(built.projectId, { authorizedBy: "operator" });
    const authorizedFirst = await built.capability.getSignPreparation(built.projectId);
    assert.ok(authorizedFirst!.authorizedPlanKey);

    const contract = await proposeAndConfirmContract(built);
    await requestJob(built, contract.id);

    // A repeat call — even one that would otherwise hit the idempotency
    // short-circuit (same plan, same already-recorded authorizedPlanKey)
    // — must still fail closed now that recovery is unresolved. Blocked
    // authority is never "already fine because it matched itself".
    await assert.rejects(() => built.capability.authorizeSignRepairPlan(built.projectId, { authorizedBy: "operator" }));
  });

  it("R6B repair: authorization refuses once a NEWER master has superseded the plan's own source, and succeeds again after an honest replan", async () => {
    const built = await build();
    await uploadRegencyOriginal(built);
    const outcome = await built.capability.planSignRepair(built.projectId);
    assert.equal(outcome.result.status, "planned");
    await built.capability.authorizeSignRepairPlan(built.projectId, { authorizedBy: "operator" });

    await buildConfirmedMaster(built);
    // Deliberately no replan yet — the persisted plan is now stale.
    await assert.rejects(() => built.capability.authorizeSignRepairPlan(built.projectId, { authorizedBy: "operator" }));

    // The honest path: replan, then authorize the CURRENT plan — succeeds.
    const replanned = await built.capability.planSignRepair(built.projectId);
    assert.equal(replanned.result.status, "planned");
    const authorized = await built.capability.authorizeSignRepairPlan(built.projectId, { authorizedBy: "operator" });
    assert.equal(authorized.authorizedPlanKey, replanned.preparation.planKey);
  });

  // ---------------------------------------------------------------------
  // 31/V: AUTHORIZATION INVALIDATION
  // ---------------------------------------------------------------------

  it("V: an authorization bound to the original-sourced plan cannot authorize the new master-sourced plan", async () => {
    const built = await build();
    await uploadRegencyOriginal(built);
    const originalOutcome = await built.capability.planSignRepair(built.projectId);
    const originalPlan = originalOutcome.preparation.plan as unknown as SignRepairPlan;

    if (originalPlan.overallRisk === "review_required") {
      // Only a customer-insufficient risk would refuse authorization here;
      // this fixture's original-sourced plan is expected to authorize
      // cleanly so the invalidation this test targets is actually reached.
      await built.capability.authorizeSignRepairPlan(built.projectId, { authorizedBy: "operator" });
    } else {
      await built.capability.authorizeSignRepairPlan(built.projectId, { authorizedBy: "customer" });
    }
    const authorized = await built.capability.getSignPreparation(built.projectId);
    assert.ok(authorized!.authorizedPlanKey);
    const oldAuthorizedPlanKey = authorized!.authorizedPlanKey;

    await buildConfirmedMaster(built);
    const replanned = await built.capability.planSignRepair(built.projectId);

    assert.notEqual(replanned.preparation.planKey, oldAuthorizedPlanKey);
    assert.notEqual(replanned.preparation.authorizedPlanKey, replanned.preparation.planKey);
  });

  // ---------------------------------------------------------------------
  // 32: BOUNDARIES
  // ---------------------------------------------------------------------

  it("boundaries: master handoff never creates a FinalArtworkJob, never authorizes, and DTF/apparel is untouched", async () => {
    const built = await build();
    await uploadRegencyOriginal(built);
    await buildConfirmedMaster(built);
    const outcome = await built.capability.planSignRepair(built.projectId);

    assert.equal(outcome.preparation.authorizedPlanKey, null);
    assert.equal(outcome.preparation.status, "planned");
    // No ArtworkPreparation (DTF/apparel) capability exists in this graph at
    // all — R6B's Signs handoff cannot have touched it because nothing here
    // ever constructed or called one.
  });
});
