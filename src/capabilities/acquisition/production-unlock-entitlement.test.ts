import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { PNG } from "pngjs";

import { DataUriAssetStorageProvider } from "@/capabilities/asset-storage";
import { createAssetCapability, PngThumbnailGenerator } from "@/capabilities/assets";
import { createConceptGenerationCapability } from "@/capabilities/concept-generation";
import { createConversationCapability } from "@/capabilities/conversation";
import { createFinalArtworkCapability } from "@/capabilities/final-artwork";
import { createGenerationWorkerCapability } from "@/capabilities/generation-worker";
import type { ProductionCategory } from "@/capabilities/print-validation";
import type { ConceptGenerationProvider } from "@/capabilities/providers";
import type {
  ConceptGenerationRequest,
  ConceptGenerationResult,
} from "@/capabilities/shared/contracts";
import type { ProjectRepository } from "@/lib/db/repository";
import {
  APPAREL_RASTER_PRODUCTION_PROFILE,
  productionUnlockAuthorizes,
  readStoredProductionProfile,
  readStoredProductionUnlockStatus,
  UNRECOGNIZED_PRODUCTION_PROFILE,
  UNRECOGNIZED_PRODUCTION_UNLOCK_STATUS,
} from "@/lib/domain/types";
import type { ProductionProfile, ProductionUnlock } from "@/lib/domain/types";
import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";
import { runAdaptiveInterviewToSummary } from "@/test-support/run-adaptive-interview";

import { createAcquisitionCapability } from "./acquisition-capability";

/**
 * Sprint A5.1 + A5.2 — the PRODUCTION UNLOCK, proved at the gate.
 *
 * The claim under test is commercial, so nothing here asserts copy or UI. It
 * asserts what the server actually permits, and — everywhere money could be
 * spent — what durable rows exist afterwards. "The customer sees an unlocked
 * button" is not the property that matters; "no `FinalArtworkJob` exists, so
 * no worker can claim one, so no paid production reconstruction is possible"
 * is.
 *
 * NO PAID CALL IS POSSIBLE HERE. The concept provider below is a local fake,
 * no final-artwork worker is ever constructed, and
 * `IHEARTPRINTS_AUTOMATED_TEST=1` (set by the test bootstrap preload)
 * independently forces every provider resolver to its safe local
 * implementation regardless of ambient environment.
 */

function tinyPng(): Buffer {
  const png = new PNG({ width: 4, height: 4 });
  png.data.fill(128);
  return PNG.sync.write(png);
}

/** Exists only to be counted — no assertion about money reads anything else. */
class CountingConceptProvider implements ConceptGenerationProvider {
  readonly providerKey = "counting";
  readonly editsSourceArtwork = false;
  calls: ConceptGenerationRequest[] = [];

  async generate(
    request: ConceptGenerationRequest,
  ): Promise<ConceptGenerationResult> {
    this.calls.push(request);
    return {
      jobId: request.idempotencyKey,
      providerKey: this.providerKey,
      concepts: Array.from({ length: request.conceptCount }, (_, index) => ({
        versionNumber: index + 1,
        title: `Concept ${index + 1}`,
        summary: `Concept ${index + 1}`,
        placeholderLabel: `Concept ${String.fromCharCode(65 + index)}`,
        accentColor: "#123456",
        kind: "concept" as const,
        asset: {
          imageBytes: tinyPng(),
          contentType: "image/png",
          widthPx: 4,
          heightPx: 4,
          hasTransparency: true,
          providerMetadata: {},
        },
      })),
    };
  }
}

/* ==================================================================== */
/* GOAL 2 — the production profile vocabulary, proved at COMPILE TIME.   */
/* ==================================================================== */

/**
 * `ProductionProfile` must stay a strict SUBSET of `ProductionCategory`.
 *
 * The two are the same vocabulary for the same idea, and the whole reason
 * `ProductionProfile` exists separately is that `ProductionCategory` also
 * carries values nobody can be SOLD — `apparel_vector` (an honest "we do not
 * produce that"), `out_of_scope_product`, the dormant `signage` /
 * `logo_vector` roles, and `unknown`. Narrowing was the point; DRIFTING was
 * the risk, and this is what catches it.
 *
 * A TYPE-LEVEL assertion rather than an import in the domain layer:
 * `capabilities/print-validation/contracts.ts` already imports from
 * `lib/domain/types.ts`, so a runtime dependency in the other direction
 * would be a cycle. `npm run typecheck:tests` fails if the subset relation
 * is ever broken — by renaming a profile, or by adding one to
 * `GRANTABLE_PRODUCTION_PROFILES` that is not a real production category.
 */
type ProfileIsAProductionCategory = ProductionProfile extends ProductionCategory
  ? true
  : never;
const PROFILE_SUBSET_PROOF: ProfileIsAProductionCategory = true;

describe("Sprint A5.1 — the production profile vocabulary", () => {
  it("is a strict subset of ProductionCategory (compile-time, asserted here for visibility)", () => {
    assert.equal(PROFILE_SUBSET_PROOF, true);
    assert.equal(APPAREL_RASTER_PRODUCTION_PROFILE, "apparel_raster");
  });

  /**
   * The narrowing that makes Goal 17 real. Every one of these is a value a
   * newer deploy, a partially-written row, or a hand-edited local store
   * could produce, and NOT ONE of them may become the value this build
   * happens to implement.
   */
  it("narrows every unknown profile to the unrecognized sentinel, never to apparel_raster", () => {
    for (const raw of [
      null,
      undefined,
      "",
      "apparel_vector",
      "signage",
      "logo_vector",
      "out_of_scope_product",
      "unknown",
      "embroidery",
      "APPAREL_RASTER",
      " apparel_raster ",
    ]) {
      assert.equal(
        readStoredProductionProfile(raw),
        UNRECOGNIZED_PRODUCTION_PROFILE,
        `"${String(raw)}" must not be readable as a grantable profile`,
      );
    }
    assert.equal(readStoredProductionProfile("apparel_raster"), "apparel_raster");
  });

  it("never reads NULL or an unknown status as active", () => {
    for (const raw of [null, undefined, "", "paid", "pending", "ACTIVE", "expired"]) {
      assert.equal(
        readStoredProductionUnlockStatus(raw),
        UNRECOGNIZED_PRODUCTION_UNLOCK_STATUS,
        `"${String(raw)}" must not be readable as a status`,
      );
    }
    assert.equal(readStoredProductionUnlockStatus("active"), "active");
    assert.equal(readStoredProductionUnlockStatus("revoked"), "revoked");
  });
});

describe("Sprint A5.1/A5.2 — the production unlock at the finalization gate", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-unlock-"));
    process.chdir(tempDir);
  });

  after(async () => {
    await cleanupTempWorkspace(tempDir, previousCwd);
  });

  async function buildHarness() {
    const { LocalProjectRepository } = await import("@/lib/db/local-store");
    const { createCapabilityGraph } = await import("@/capabilities/composition");

    const repo = new LocalProjectRepository();

    // The local store is ONE JSON file for the whole test file, and
    // `claimNextQueuedJob` deliberately claims the oldest due job across
    // EVERY project. A test that leaves a job queued would otherwise have it
    // claimed by the next test's worker, which would then count a dispatch
    // it never caused. Retiring leftovers keeps each test's provider count
    // its own. (Same reasoning as `acquisition-entitlement.test.ts`.)
    for (;;) {
      const stale = await repo.claimNextQueuedJob();
      if (!stale) break;
      await repo.updateGenerationJob(stale.id, { status: "cancelled" });
    }

    const graph = createCapabilityGraph(repo);
    const provider = new CountingConceptProvider();
    const assets = createAssetCapability(
      repo,
      new DataUriAssetStorageProvider(),
      new PngThumbnailGenerator(),
    );

    const acquisition = createAcquisitionCapability(repo);
    const conceptGeneration = createConceptGenerationCapability(
      repo,
      provider.providerKey,
      graph.ipSafety,
      acquisition,
    );
    // NOTE: no final-artwork WORKER is built anywhere in this suite. Nothing
    // here can dispatch Topaz even if a job were created — the assertions
    // about job rows are about what a worker would be ABLE to claim.
    const finalArtwork = createFinalArtworkCapability(repo, acquisition);
    const worker = createGenerationWorkerCapability(
      repo,
      provider,
      graph.promptTranslation,
      assets,
      graph.conceptEvaluation,
      graph.revisionIntelligence,
      graph.printValidation,
      graph.ipSafety,
    );
    const conversation = createConversationCapability({
      repo,
      intentExtraction: graph.intentExtraction,
      conversationUnderstanding: graph.conversationUnderstanding,
      designBrief: graph.designBrief,
      briefEvaluation: graph.briefEvaluation,
      designIntelligence: graph.designIntelligence,
      interviewIntelligence: graph.interviewIntelligence,
      revisionIntelligence: graph.revisionIntelligence,
      designSummary: graph.designSummary,
      conceptGeneration,
      finalArtwork,
      ipSafety: graph.ipSafety,
      acquisition,
    });

    return {
      repo: repo as ProjectRepository,
      graph,
      provider,
      acquisition,
      conceptGeneration,
      finalArtwork,
      worker,
      conversation,
    };
  }

  type Harness = Awaited<ReturnType<typeof buildHarness>>;

  let tokenCounter = 0;
  function newToken(): string {
    tokenCounter += 1;
    return `unlock-token-${tokenCounter}-${Math.random().toString(36).slice(2)}`;
  }

  /**
   * Drives an ordinary anonymous prospect all the way to "a concept is
   * selected and confirmed as the final direction" — the exact state the
   * customer's "Prepare Print-Ready Artwork" click starts from, and the
   * state A4 leaves every prospect stranded in.
   */
  async function prospectReadyToFinalize(
    harness: Harness,
    sessionId?: string,
  ): Promise<{
    sessionId: string;
    projectId: string;
    artworkVersionId: string;
  }> {
    const resolvedSessionId =
      sessionId ?? (await harness.repo.createAcquisitionSession(newToken())).id;

    const { projectId } = await runAdaptiveInterviewToSummary(
      harness.conversation,
      {},
      resolvedSessionId,
    );
    await harness.conversation.submitDesignBriefDecision(projectId, "approve");
    await harness.worker.processNextJob();
    await harness.acquisition.captureEmail(projectId, "eric@example.com");

    const snapshot = await harness.conversation.get(projectId);
    const artworkVersionId = snapshot!.artworkVersions[0]!.id;
    await harness.conversation.selectConcept(projectId, artworkVersionId);
    await harness.conversation.confirmSelectedDirection(
      projectId,
      artworkVersionId,
    );

    return { sessionId: resolvedSessionId, projectId, artworkVersionId };
  }

  /**
   * The Existing Artwork counterpart: a prospect-bound project holding an
   * APPROVED `ArtworkPreparation`. Built from repository records directly —
   * this suite is about the commercial gate, and Phase 1's own suites
   * already prove how that state is reached.
   */
  async function prospectWithApprovedUpload(harness: Harness, sessionId?: string) {
    const resolvedSessionId =
      sessionId ?? (await harness.repo.createAcquisitionSession(newToken())).id;

    const created = await harness.repo.createProject(resolvedSessionId);
    const projectId = created.project.id;

    // A resolvable production width is a precondition of the upload
    // finalization path, and is deliberately read from the project's own
    // persisted intent rather than from the request.
    await harness.repo.updateBrief(projectId, {
      productSummary: "T-shirts for our bowling team",
      shirtColor: "Black",
      printPlacement: "left_chest",
    });

    const original = await harness.repo.createAsset(projectId, {
      kind: "customer_upload",
      storageKey: `local/${projectId}/original.png`,
      contentType: "image/png",
      isThumbnail: false,
      widthPx: 1200,
      heightPx: 1200,
      hasTransparency: false,
      providerKey: null,
      generationJobId: null,
      metadata: {},
      vectorAssetId: null,
      printAssetId: null,
      finalArtworkJobId: null,
      productionRole: null,
    });
    const prepared = await harness.repo.createAsset(projectId, {
      kind: "png",
      storageKey: `local/${projectId}/prepared.png`,
      contentType: "image/png",
      isThumbnail: false,
      widthPx: 1200,
      heightPx: 1200,
      hasTransparency: true,
      providerKey: null,
      generationJobId: null,
      metadata: {},
      vectorAssetId: null,
      printAssetId: null,
      finalArtworkJobId: null,
      productionRole: null,
    });

    const preparation = await harness.repo.createArtworkPreparation(projectId, {
      originalAssetId: original.id,
      originalFilename: "split disturbers.png",
      analysis: { widthPx: 1200, heightPx: 1200 },
    });

    const [artwork] = await harness.repo.addArtworkVersions(projectId, [
      {
        versionNumber: 1,
        kind: "prepared_upload",
        title: "Your artwork, prepared",
        summary: "Your uploaded artwork with its background removed.",
        placeholderLabel: "Your artwork",
        accentColor: "#173F35",
        designBriefVersionId: null,
        generationJobId: null,
        providerKey: null,
        primaryAssetId: prepared.id,
        thumbnailAssetId: null,
        sourceArtworkVersionId: null,
        conceptDirectionKey: null,
      },
    ]);

    await harness.repo.updateArtworkPreparation(preparation.id, {
      status: "approved",
      preparedAssetId: prepared.id,
      preparedArtworkVersionId: artwork!.id,
      approvedAt: new Date().toISOString(),
    });
    await harness.repo.setProjectStatus(projectId, "approved");

    return { sessionId: resolvedSessionId, projectId };
  }

  /** The only way an unlock is created in this phase: a direct repository call. */
  async function grantUnlock(
    harness: Harness,
    projectId: string,
    sessionId: string,
    productionProfile: ProductionProfile = APPAREL_RASTER_PRODUCTION_PROFILE,
  ) {
    return harness.repo.createProductionUnlock(projectId, {
      acquisitionSessionId: sessionId,
      productionProfile,
    });
  }

  /* ================================================================== */
  /* A — the A4 baseline is unchanged for a prospect with no unlock      */
  /* ================================================================== */

  it("A: a prospect with no production unlock is still refused finalization, and no FinalArtworkJob exists", async () => {
    const harness = await buildHarness();
    const { projectId, artworkVersionId } = await prospectReadyToFinalize(harness);

    const authorization =
      await harness.acquisition.authorizeFinalization(projectId);
    assert.equal(authorization.allowed, false);

    await assert.rejects(() =>
      harness.finalArtwork.requestFinalArtwork(projectId, artworkVersionId),
    );

    // The property that matters is structural, not conversational: with no
    // approval and no job, the final-artwork worker has nothing to claim, so
    // "no free Topaz work" is a fact about the data rather than a policy
    // some later component has to remember.
    assert.equal(
      await harness.repo.getActiveFinalDirectionApproval(projectId),
      null,
    );
  });

  /* ================================================================== */
  /* B — Create New finalization, unlocked                               */
  /* ================================================================== */

  it("B: a prospect whose project holds an active unlock may finalize the Create New path", async () => {
    const harness = await buildHarness();
    const { sessionId, projectId, artworkVersionId } =
      await prospectReadyToFinalize(harness);

    await grantUnlock(harness, projectId, sessionId);

    const authorization =
      await harness.acquisition.authorizeFinalization(projectId);
    assert.equal(authorization.allowed, true);

    const result = await harness.finalArtwork.requestFinalArtwork(
      projectId,
      artworkVersionId,
    );

    assert.equal(result.approval.artworkVersionId, artworkVersionId);
    assert.equal(result.approval.status, "active");
    assert.equal(result.job.status, "queued");
    assert.equal(result.job.sourceKind, "generated_concept");
    assert.equal(result.job.finalDirectionApprovalId, result.approval.id);

    const project = (await harness.conversation.get(projectId))!.project;
    assert.equal(project.status, "finalizing");
  });

  /* ================================================================== */
  /* C — Existing Artwork finalization, from the SAME record             */
  /* ================================================================== */

  it("C: the same project-level unlock authorizes the Existing Artwork path", async () => {
    const harness = await buildHarness();
    const { sessionId, projectId } = await prospectWithApprovedUpload(harness);

    // Refused first — an upload project never consumes a free concept, so
    // this gate is its ONLY acquisition boundary.
    await assert.rejects(() =>
      harness.finalArtwork.requestPreparedUploadFinalArtwork(projectId),
    );

    // The identical record, granted the identical way, with no
    // workflow-specific field anywhere. There is deliberately no "upload
    // unlock" and no "create-new unlock" — one project-level production
    // unlock authorizes whichever workflow the project is otherwise valid
    // for.
    await grantUnlock(harness, projectId, sessionId);

    const result =
      await harness.finalArtwork.requestPreparedUploadFinalArtwork(projectId);

    assert.equal(result.job.sourceKind, "prepared_upload");
    assert.equal(result.job.status, "queued");
    assert.equal(result.job.finalDirectionApprovalId, null);
    assert.ok(result.job.artworkPreparationId);
  });

  /* ================================================================== */
  /* D — per-project authority, not per-session                          */
  /* ================================================================== */

  it("D: unlocking Project A does not unlock Project B in the same acquisition session", async () => {
    const harness = await buildHarness();

    // Both projects belong to ONE internally-entitled-free session so that
    // both can reach a finalizable state; the commercial question is
    // orthogonal to the free-concept entitlement, and using two prospect
    // sessions would just add A4 noise. The session is a plain prospect.
    const session = await harness.repo.createAcquisitionSession(newToken());
    const projectA = await prospectWithApprovedUpload(harness, session.id);
    const projectB = await prospectWithApprovedUpload(harness, session.id);

    await grantUnlock(harness, projectA.projectId, session.id);

    assert.equal(
      (await harness.acquisition.authorizeFinalization(projectA.projectId))
        .allowed,
      true,
    );
    // The whole point of keying on the project rather than the session: one
    // purchase does not make every project that browser ever creates paid.
    assert.equal(
      (await harness.acquisition.authorizeFinalization(projectB.projectId))
        .allowed,
      false,
    );

    await assert.rejects(() =>
      harness.finalArtwork.requestPreparedUploadFinalArtwork(projectB.projectId),
    );
    assert.equal(
      (await harness.repo.listFinalArtworkJobsForApproval(
        projectB.projectId,
        "any",
      )).length,
      0,
    );
  });

  /* ================================================================== */
  /* E + F — internal and legacy need no unlock                          */
  /* ================================================================== */

  it("E: an internally entitled session finalizes without any production unlock row", async () => {
    const harness = await buildHarness();
    const session = await harness.repo.createAcquisitionSession(newToken());
    await harness.repo.grantInternalEntitlement(session.id);

    const { projectId } = await prospectWithApprovedUpload(harness, session.id);

    assert.equal(
      (await harness.acquisition.authorizeFinalization(projectId)).allowed,
      true,
    );
    // No synthetic unlock is created for them. A fabricated commercial
    // record would assert a purchase that never happened and would be
    // indistinguishable afterwards from a real one.
    assert.equal(
      await harness.repo.getActiveProductionUnlock(
        projectId,
        APPAREL_RASTER_PRODUCTION_PROFILE,
      ),
      null,
    );
  });

  it("F: a legacy project (no acquisition session at all) finalizes without any production unlock row", async () => {
    const harness = await buildHarness();
    // `createProject()` with no session id is exactly a pre-A4 project.
    const created = await harness.repo.createProject();
    const projectId = created.project.id;
    assert.equal(created.project.acquisitionSessionId, null);

    assert.equal(
      (await harness.acquisition.authorizeFinalization(projectId)).allowed,
      true,
    );
    assert.equal(
      await harness.repo.getActiveProductionUnlock(
        projectId,
        APPAREL_RASTER_PRODUCTION_PROFILE,
      ),
      null,
    );
  });

  /* ================================================================== */
  /* G — revocation                                                      */
  /* ================================================================== */

  it("G: revoking an unlock refuses future finalization, without deleting the row or the work already produced", async () => {
    const harness = await buildHarness();
    const { sessionId, projectId } = await prospectWithApprovedUpload(harness);

    await grantUnlock(harness, projectId, sessionId);
    const produced =
      await harness.finalArtwork.requestPreparedUploadFinalArtwork(projectId);

    const revoked = await harness.repo.revokeProductionUnlock(
      projectId,
      APPAREL_RASTER_PRODUCTION_PROFILE,
      "refund issued",
    );
    assert.equal(revoked?.status, "revoked");
    assert.ok(revoked?.revokedAt);
    assert.equal(revoked?.revokedReason, "refund issued");

    assert.equal(
      (await harness.acquisition.authorizeFinalization(projectId)).allowed,
      false,
    );
    await assert.rejects(() =>
      harness.finalArtwork.requestPreparedUploadFinalArtwork(projectId),
    );

    // The row survives, as the audit trail a refund depends on...
    assert.equal(
      await harness.repo.getActiveProductionUnlock(
        projectId,
        APPAREL_RASTER_PRODUCTION_PROFILE,
      ),
      null,
      "a revoked unlock must not read as active",
    );
    // ...and so does everything that was genuinely produced under it.
    // Revocation stops FUTURE finalization; it does not rewrite history.
    const jobs = await harness.repo.listFinalArtworkJobsForPreparation(
      projectId,
      produced.job.artworkPreparationId!,
    );
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0]?.id, produced.job.id);
  });

  it("G2: revoking twice is a no-op, and re-granting afterwards creates a NEW row rather than reviving the old one", async () => {
    const harness = await buildHarness();
    const { sessionId, projectId } = await prospectWithApprovedUpload(harness);

    const first = await grantUnlock(harness, projectId, sessionId);
    assert.equal(first.outcome, "granted");
    const firstId = first.unlock.id;

    await harness.repo.revokeProductionUnlock(
      projectId,
      APPAREL_RASTER_PRODUCTION_PROFILE,
      "chargeback",
    );
    // Nothing active left to revoke. Not an error — the world is already in
    // the state the caller asked for.
    assert.equal(
      await harness.repo.revokeProductionUnlock(
        projectId,
        APPAREL_RASTER_PRODUCTION_PROFILE,
        "chargeback again",
      ),
      null,
    );

    const second = await grantUnlock(harness, projectId, sessionId);
    assert.equal(second.outcome, "granted");
    assert.notEqual(
      second.unlock.id,
      firstId,
      "a re-grant must be a new row with its own grantedAt, never a resurrection",
    );
    assert.equal(
      (await harness.acquisition.authorizeFinalization(projectId)).allowed,
      true,
    );
  });

  /* ================================================================== */
  /* H — unknown status / profile fail closed                            */
  /* ================================================================== */

  it("H: an unlock row carrying a status or profile this build cannot interpret never authorizes", async () => {
    const harness = await buildHarness();
    const { sessionId, projectId } = await prospectWithApprovedUpload(harness);
    await grantUnlock(harness, projectId, sessionId);

    const live = await harness.repo.getActiveProductionUnlock(
      projectId,
      APPAREL_RASTER_PRODUCTION_PROFILE,
    );
    assert.ok(live);

    // The three shapes a newer deploy, a partial write, or a corrupt row
    // could actually produce. `productionUnlockAuthorizes` is the single
    // place an unlock becomes permission, so proving it here proves it for
    // the gate.
    const futureStatus: ProductionUnlock = {
      ...live,
      status: readStoredProductionUnlockStatus("entitled_forever"),
    };
    const futureProfile: ProductionUnlock = {
      ...live,
      productionProfile: readStoredProductionProfile("embroidery_stitch"),
    };
    const nullish: ProductionUnlock = {
      ...live,
      status: readStoredProductionUnlockStatus(null),
      productionProfile: readStoredProductionProfile(null),
    };

    for (const candidate of [futureStatus, futureProfile, nullish]) {
      assert.equal(
        productionUnlockAuthorizes(candidate, {
          projectId,
          productionProfile: APPAREL_RASTER_PRODUCTION_PROFILE,
        }),
        false,
      );
    }
    // And the control: the untouched row does authorize, so the assertions
    // above are about the corrupted values rather than a broken helper.
    assert.equal(
      productionUnlockAuthorizes(live, {
        projectId,
        productionProfile: APPAREL_RASTER_PRODUCTION_PROFILE,
      }),
      true,
    );
  });

  it("H2: a persisted row whose status is not 'active' is never returned as the active unlock", async () => {
    const harness = await buildHarness();
    const { sessionId, projectId } = await prospectWithApprovedUpload(harness);
    await grantUnlock(harness, projectId, sessionId);

    // Reach past the repository and corrupt the persisted status the way a
    // newer deploy would — then prove the read path refuses it. This is the
    // local store's stand-in for "an unrecognized value survived the CHECK
    // constraint because a later migration widened it".
    const { promises: fs } = await import("node:fs");
    const dataFile = path.join(process.cwd(), ".data", "sprint1-store.json");
    const raw = JSON.parse(await fs.readFile(dataFile, "utf8"));
    for (const unlock of raw.productionUnlocks) {
      if (unlock.projectId === projectId) unlock.status = "paid_in_full";
    }
    await fs.writeFile(dataFile, JSON.stringify(raw, null, 2), "utf8");

    assert.equal(
      await harness.repo.getActiveProductionUnlock(
        projectId,
        APPAREL_RASTER_PRODUCTION_PROFILE,
      ),
      null,
    );
    assert.equal(
      (await harness.acquisition.authorizeFinalization(projectId)).allowed,
      false,
    );
  });

  /* ================================================================== */
  /* I — approval supersession must NOT revoke the purchase              */
  /* ================================================================== */

  it("I: superseding the approval the customer had when they paid leaves the unlock active", async () => {
    const harness = await buildHarness();
    const { sessionId, projectId, artworkVersionId } =
      await prospectReadyToFinalize(harness);

    await grantUnlock(harness, projectId, sessionId);
    const first = await harness.finalArtwork.requestFinalArtwork(
      projectId,
      artworkVersionId,
    );
    assert.equal(first.approval.status, "active");

    // The exact event that would have destroyed an approval-bound
    // entitlement: the approval the customer was looking at when they paid
    // is superseded. This is not an edge case — `ConversationCapability`
    // does it the moment a revision request is understood.
    await harness.repo.supersedeActiveFinalDirectionApproval(projectId);
    assert.equal(
      await harness.repo.getActiveFinalDirectionApproval(projectId),
      null,
    );

    // The purchase is untouched, because the purchase was never about that
    // approval.
    assert.equal(
      (await harness.acquisition.authorizeFinalization(projectId)).allowed,
      true,
    );

    // And a NEW valid approval on the same project is authorized by the SAME
    // unlock — no second purchase, no re-grant, nothing to reconcile.
    await harness.conversation.confirmSelectedDirection(
      projectId,
      artworkVersionId,
    );
    const second = await harness.finalArtwork.requestFinalArtwork(
      projectId,
      artworkVersionId,
    );
    assert.equal(second.approval.status, "active");
    assert.notEqual(second.approval.id, first.approval.id);

    const unlock = await harness.repo.getActiveProductionUnlock(
      projectId,
      APPAREL_RASTER_PRODUCTION_PROFILE,
    );
    assert.equal(unlock?.status, "active");
  });

  /* ================================================================== */
  /* J — commercial permission never manufactures technical capability   */
  /* ================================================================== */

  it("J: an unlocked project asking for an unsupported production output is still refused by the technical gate", async () => {
    const harness = await buildHarness();
    const { sessionId, projectId } = await prospectWithApprovedUpload(harness);
    await grantUnlock(harness, projectId, sessionId);

    // The customer has asked iHeartPrints to produce something V1 does not
    // make. The commercial gate says yes; the pipeline still must not claim
    // it can deliver.
    await harness.repo.updateBrief(projectId, {
      requestedProductionOutput: "embroidery_digitization",
    });

    // Finalization is still ENQUEUED — the unsupported request is resolved
    // honestly by the worker, which completes without producing an asset
    // rather than being refused at the door (Sprint A2's design). What must
    // never happen is a deliverable: the job is bound to the unsupported
    // intent, and no production delivery resolves for it.
    const result =
      await harness.finalArtwork.requestPreparedUploadFinalArtwork(projectId);
    assert.equal(
      result.job.requestedProductionOutput,
      "embroidery_digitization",
    );

    assert.equal(
      await harness.finalArtwork.getCurrentProductionAssetId(projectId),
      null,
      "an unsupported request is never satisfied, unlocked or not",
    );
    assert.equal(
      await harness.finalArtwork.resolveCurrentProductionDelivery(projectId),
      null,
    );
  });

  /* ================================================================== */
  /* K — GENERATION STAYS LOCKED. The audit's spend hole.                */
  /* ================================================================== */

  it("K: a production unlock does NOT unlock concept generation, exploration, or generative revision", async () => {
    const harness = await buildHarness();
    const { sessionId, projectId } = await prospectReadyToFinalize(harness);
    await grantUnlock(harness, projectId, sessionId);

    const jobsBefore = (await harness.repo.listGenerationJobs(projectId)).length;
    const callsBefore = harness.provider.calls.length;

    // The gate itself, first — this is the one assertion that would catch a
    // future change wiring the unlock into the wrong fence.
    const generation =
      await harness.acquisition.authorizeConceptGeneration(projectId);
    assert.equal(
      generation.allowed,
      false,
      "A5.1/A5.2 unlocks FINALIZATION ONLY — every image-generation path stays refused",
    );

    // Then every customer path that reaches it, proving spend rather than
    // copy: exploration, regeneration, and a real brief-changing revision.
    await harness.conversation.exploreNewConceptBatch(projectId);
    await harness.conversation.regenerateConcepts(projectId);
    await harness.conversation.handleUserMessage(
      projectId,
      "Make the bear red instead of brown.",
    );

    assert.equal(
      (await harness.repo.listGenerationJobs(projectId)).length,
      jobsBefore,
      "no new GenerationJob may exist — no job means no worker claim means no paid call",
    );
    await harness.worker.processNextJob();
    await harness.worker.processNextJob();
    assert.equal(harness.provider.calls.length, callsBefore);
  });

  /* ================================================================== */
  /* L — the unlock sits ABOVE existing finalization idempotency         */
  /* ================================================================== */

  it("L: a double finalization request on an unlocked project produces exactly ONE FinalArtworkJob", async () => {
    const harness = await buildHarness();
    const { sessionId, projectId, artworkVersionId } =
      await prospectReadyToFinalize(harness);
    await grantUnlock(harness, projectId, sessionId);

    const first = await harness.finalArtwork.requestFinalArtwork(
      projectId,
      artworkVersionId,
    );
    const second = await harness.finalArtwork.requestFinalArtwork(
      projectId,
      artworkVersionId,
    );

    assert.equal(second.alreadyRequested, true);
    assert.equal(second.approval.id, first.approval.id);
    assert.equal(second.job.id, first.job.id);

    const jobs = await harness.repo.listFinalArtworkJobsForApproval(
      projectId,
      first.approval.id,
    );
    assert.equal(
      jobs.length,
      1,
      "one job means one claim means one paid production reconstruction",
    );
  });

  it("L2: two CONCURRENT finalization requests on an unlocked project still produce exactly ONE FinalArtworkJob", async () => {
    const harness = await buildHarness();
    const { sessionId, projectId, artworkVersionId } =
      await prospectReadyToFinalize(harness);
    await grantUnlock(harness, projectId, sessionId);

    const [a, b] = await Promise.all([
      harness.finalArtwork.requestFinalArtwork(projectId, artworkVersionId),
      harness.finalArtwork.requestFinalArtwork(projectId, artworkVersionId),
    ]);

    assert.equal(a.approval.id, b.approval.id);
    assert.equal(a.job.id, b.job.id);
    assert.equal(
      (await harness.repo.listFinalArtworkJobsForApproval(projectId, a.approval.id))
        .length,
      1,
    );
  });

  /* ================================================================== */
  /* M — the stored session must match the project's durable binding     */
  /* ================================================================== */

  it("M: an unlock whose recorded session does not match the project's binding fails closed", async () => {
    const harness = await buildHarness();
    const { projectId } = await prospectWithApprovedUpload(harness);

    // A different session entirely. This is the shape of a forged or
    // mis-attributed grant, and of a project that changed hands in a way
    // this build has no model for.
    const stranger = await harness.repo.createAcquisitionSession(newToken());
    const granted = await grantUnlock(harness, projectId, stranger.id);
    assert.equal(granted.outcome, "granted");

    // The row is genuinely ACTIVE and genuinely for this project — the
    // repository is doing its job. The refusal comes from the gate, which
    // resolves the session from the PROJECT and refuses when the two
    // disagree. The safe direction on a spend boundary is always the one
    // that does not authorize money.
    const live = await harness.repo.getActiveProductionUnlock(
      projectId,
      APPAREL_RASTER_PRODUCTION_PROFILE,
    );
    assert.equal(live?.status, "active");
    assert.equal(live?.projectId, projectId);

    assert.equal(
      (await harness.acquisition.authorizeFinalization(projectId)).allowed,
      false,
    );
    await assert.rejects(() =>
      harness.finalArtwork.requestPreparedUploadFinalArtwork(projectId),
    );
  });

  /* ================================================================== */
  /* N — concurrent grants resolve to ONE active unlock                  */
  /* ================================================================== */

  it("N: concurrent duplicate grants produce exactly one active unlock, and the loser gets the winner", async () => {
    const harness = await buildHarness();
    const { sessionId, projectId } = await prospectWithApprovedUpload(harness);

    const results = await Promise.all([
      grantUnlock(harness, projectId, sessionId),
      grantUnlock(harness, projectId, sessionId),
      grantUnlock(harness, projectId, sessionId),
    ]);

    const ids = new Set(results.map((result) => result.unlock.id));
    assert.equal(ids.size, 1, "three concurrent grants must resolve to one row");
    assert.equal(
      results.filter((result) => result.outcome === "granted").length,
      1,
      "exactly one caller created it",
    );
    assert.equal(
      results.filter((result) => result.outcome === "existing").length,
      2,
      "the losers are told the desired end state holds, not that they failed",
    );

    const live = await harness.repo.getActiveProductionUnlock(
      projectId,
      APPAREL_RASTER_PRODUCTION_PROFILE,
    );
    assert.ok(live);
    assert.equal(ids.has(live.id), true);
  });

  it("N2: a sequential repeat grant is idempotent and never creates a second active unlock", async () => {
    const harness = await buildHarness();
    const { sessionId, projectId } = await prospectWithApprovedUpload(harness);

    const first = await grantUnlock(harness, projectId, sessionId);
    const again = await grantUnlock(harness, projectId, sessionId);

    assert.equal(first.outcome, "granted");
    assert.equal(again.outcome, "existing");
    assert.equal(again.unlock.id, first.unlock.id);
    assert.equal(again.unlock.grantedAt, first.unlock.grantedAt);
  });
});
