import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { encodeRgbaToPng } from "@/capabilities/artwork-preparation/image-decode";
import { fillRect, makeImage, toPngBytes } from "@/capabilities/sign-preparation/sign-fixtures";
import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";

/**
 * Live REGENCY resume/routing defect (post-R6B-deployment production
 * acceptance): a project whose reconstruction had already been ACCEPTED and
 * whose geometry qualification had already been CONFIRMED (the customer
 * clicked "Looks good — continue" before this defect was found) still
 * rendered the SAME "Check the cleaned artwork" review card as actionable
 * every time the project was reopened/resumed — while the confirm action
 * itself correctly, separately refused with "This artwork has already been
 * reviewed." Two different reads of "is geometry review still pending"
 * disagreed with each other.
 *
 * Root cause: `resolveGeometryQualificationView` (`conversation-service.ts`)
 * independently re-derived "the current job"
 * (`RasterReconstructionCapability.getCurrentAcceptedMaster`) and asked
 * `ArtworkGeometryQualificationCapability.ensureQualification` for THAT
 * job specifically — a write-on-read operation, re-run on every snapshot
 * fetch — while `confirmQualification`/`rejectQualification` independently
 * re-derive the SAME "current" notion via `resolveCurrentQualification`
 * at click time. Nothing guaranteed the two calls, made at different
 * moments, would agree.
 *
 * Repair: `resolveGeometryQualificationView` now consults
 * `getCurrentProductionQualifiedMaster` — the SAME authoritative resolver
 * `confirmQualification`/`rejectQualification` already trust, and the SAME
 * one R6B's Signs effective-source resolution already trusts — FIRST, and
 * only falls through to the per-job `ensureQualification` read when no
 * confirmed master is current. This makes the two decisions structurally
 * unable to disagree, without touching `confirmQualification`'s own
 * fail-closed authority at all (no duplicate confirmation is ever
 * permitted; this is a VIEW fix only).
 *
 * This test proves the full required lifecycle end to end: reconstruction
 * accepted -> geometry qualification created -> geometry confirmed ->
 * conversation snapshot rebuilt from scratch (simulating project
 * reopen/resume) -> geometry confirmation is NOT presented as actionable
 * -> the current Production-Qualified Clean Master resolves -> the
 * workflow advances into Signs -> the Signs effective source is the
 * qualified master (never the historical original) -> the Signs plan is
 * generated against that master, with its own sourceAssetId/sourceSha256
 * proven to correspond to the master's actual bytes.
 */
describe("Live REGENCY resume/routing defect: confirmed geometry review must never re-render as actionable on resume", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-geometry-resume-routing-"));
    process.chdir(tempDir);
  });

  after(async () => {
    const { drainCapabilityGraphForTests } = await import("@/capabilities/composition");
    await drainCapabilityGraphForTests();
    await cleanupTempWorkspace(tempDir, previousCwd);
  });

  const SHA_A = "a".repeat(64);
  const RECOVERY_SOURCE_ASSET_ID = "recovery-source-1";

  function regencyOriginalBytes(): Buffer {
    const image = makeImage(1000, 344, { r: 250, g: 250, b: 250 });
    fillRect(image, 60, 40, 940, 300, { r: 20, g: 20, b: 20 });
    return toPngBytes(image);
  }

  function regencyCandidateBytes(): Buffer {
    const image = makeImage(900, 300, { r: 255, g: 255, b: 255 });
    fillRect(image, 41, 42, 860, 259, { r: 20, g: 90, b: 160 });
    return encodeRgbaToPng(image);
  }

  it("REGENCY resume regression: reopening the project after geometry confirmation advances past review_geometry and into a correctly master-sourced Signs plan", async () => {
    const { resetCapabilityGraphForTests, getCapabilityGraph } = await import(
      "@/capabilities/composition"
    );
    resetCapabilityGraphForTests();
    const { startConversation, getConversation } = await import("./conversation-service");
    const { getProjectRepository } = await import("@/lib/db");

    const { project } = await startConversation();
    const projectId = project.id;
    const graph = getCapabilityGraph();
    const repo = getProjectRepository();

    // 1: reconstruction accepted.
    const contractProposed = await graph.artworkFidelity.proposeContract(projectId, {
      sourceAssetId: RECOVERY_SOURCE_ASSET_ID,
      sourceSha256: SHA_A,
    });
    const contract = await graph.artworkFidelity.confirmContract(projectId, contractProposed.id, {
      currentSourceSha256: SHA_A,
      confirmedWording: ["REGENCY"],
      confirmedMarks: [],
      confirmedBy: "customer",
    });
    const job = await graph.artworkReconstruction.requestReconstruction(projectId, {
      sourceAssetId: RECOVERY_SOURCE_ASSET_ID,
      currentSourceSha256: SHA_A,
      fidelityContractId: contract.id,
    });
    const candidateAssetId = (
      await graph.assets.uploadConceptImage(projectId, {
        conceptId: "regency-candidate",
        bytes: regencyCandidateBytes(),
        contentType: "image/png",
        widthPx: 900,
        heightPx: 300,
        hasTransparency: false,
        providerKey: "test",
        generationJobId: null,
        metadata: {},
      })
    ).primary.id;
    await repo.updateArtworkReconstructionJob(job.id, {
      status: "completed",
      completedAt: new Date().toISOString(),
      candidateAssetId,
      wordingVerified: true,
      geometryStatus: "review_required",
      reviewStatus: "pending_review",
    });
    const approved = await graph.artworkReconstruction.approveCandidate(projectId, job.id, {
      confirmedBy: "customer",
    });

    // 2: geometry qualification created. (Note: `resolveGeometryQualificationView`'s
    // existing, unchanged fallthrough path itself calls `ensureQualification`
    // as part of assembling ANY snapshot for an approved-but-not-yet-qualified
    // job — so simply fetching a snapshot at this point would already
    // materialize a "normalized_pending_confirmation" row. The explicit call
    // below is the same operation the customer's own "Check my artwork"
    // moment triggers; calling it directly here just makes the step explicit.)
    const qualification = await graph.artworkGeometryQualification.ensureQualification(
      projectId,
      approved.id,
    );
    assert.equal(qualification.qualificationStatus, "normalized_pending_confirmation");

    // Sanity: while genuinely pending, the snapshot correctly reports it as
    // such — this is the customer's real "Check the cleaned artwork" moment,
    // and it is legitimately actionable here.
    const pendingSnapshot = await getConversation(projectId);
    assert.equal(pendingSnapshot!.geometryQualification!.status, "normalized_pending_confirmation");

    // 3: geometry confirmed — "Looks good — continue".
    const confirmed = await graph.artworkGeometryQualification.confirmQualification(
      projectId,
      "customer",
    );
    assert.equal(confirmed.qualificationStatus, "confirmed");

    // 4: project/session is reloaded / conversation snapshot rebuilt — a
    // BRAND NEW call, exactly like reopening the project fresh, never
    // reusing anything from the confirm action's own response.
    const resumedSnapshot = await getConversation(projectId);

    // 5: geometry confirmation is NOT presented as actionable. This is the
    // exact field `geometryReviewIsUnresolved` (`uploaded-artwork-flow.ts`)
    // keys on to decide whether to render "Check the cleaned artwork" —
    // proving this field is "confirmed" here is what keeps the live defect
    // (rendering it as actionable while the server had already terminally
    // confirmed it) from recurring.
    assert.ok(resumedSnapshot!.geometryQualification, "a geometry qualification view must still exist");
    assert.equal(resumedSnapshot!.geometryQualification!.status, "confirmed");
    assert.notEqual(resumedSnapshot!.geometryQualification!.status, "normalized_pending_confirmation");

    // A second, later reload is exactly as stable — never a one-time fluke,
    // never itself creating a new competing qualification row.
    const resumedAgain = await getConversation(projectId);
    assert.equal(resumedAgain!.geometryQualification!.status, "confirmed");
    assert.equal(resumedAgain!.geometryQualification!.qualificationId, confirmed.id);

    // The confirmation mutation itself remains fail-closed: a second,
    // duplicate confirmation attempt must still be refused exactly as
    // before — this repair never weakens that authority to work around the
    // UI defect.
    await assert.rejects(() => graph.artworkGeometryQualification.confirmQualification(projectId, "customer"));

    // 6: the current Production-Qualified Clean Master resolves.
    const master = await graph.artworkGeometryQualification.getCurrentProductionQualifiedMaster(projectId);
    assert.ok(master);
    assert.equal(master!.id, confirmed.id);
    assert.ok(master!.derivedAssetId);

    // 7/8/9: the workflow advances into Signs, and the Signs plan is
    // generated against the CURRENT master — never the historical original
    // — with its own sourceAssetId/sourceSha256 proven to correspond to the
    // master's actual bytes.
    const uploaded = await graph.signPreparation.uploadSignArtwork(projectId, {
      bytes: regencyOriginalBytes(),
      declaredContentType: "image/png",
      filename: "regency-original.png",
    });
    await graph.signPreparation.confirmSignProductionSpec(projectId, 48, 24);
    const outcome = await graph.signPreparation.planSignRepair(projectId);
    assert.equal(outcome.result.status, "planned");
    const plan = outcome.result.plan!;
    assert.equal(plan.sourceAssetId, master!.derivedAssetId);
    assert.notEqual(plan.sourceAssetId, uploaded.originalAssetId);

    const finalSnapshot = await getConversation(projectId);
    assert.equal(finalSnapshot!.signArtwork!.plan!.artworkWidthPx, master!.normalizedWidthPx);
    assert.equal(finalSnapshot!.signArtwork!.plan!.artworkHeightPx, master!.normalizedHeightPx);

    // Historical original provenance untouched throughout.
    const finalPreparation = await graph.signPreparation.getSignPreparation(projectId);
    assert.equal(finalPreparation!.originalAssetId, uploaded.originalAssetId);
  });

  it("no regression: a GENUINELY newer reconstruction that supersedes an already-confirmed master still shows as pending, never silently suppressed by the precedence fix", async () => {
    const { resetCapabilityGraphForTests, getCapabilityGraph } = await import(
      "@/capabilities/composition"
    );
    resetCapabilityGraphForTests();
    const { startConversation, getConversation } = await import("./conversation-service");
    const { getProjectRepository } = await import("@/lib/db");

    const { project } = await startConversation();
    const projectId = project.id;
    const graph = getCapabilityGraph();
    const repo = getProjectRepository();

    async function acceptAndQualify(candidateConceptId: string, contractId: string) {
      const job = await graph.artworkReconstruction.requestReconstruction(projectId, {
        sourceAssetId: RECOVERY_SOURCE_ASSET_ID,
        currentSourceSha256: SHA_A,
        fidelityContractId: contractId,
      });
      const candidateAssetId = (
        await graph.assets.uploadConceptImage(projectId, {
          conceptId: candidateConceptId,
          bytes: regencyCandidateBytes(),
          contentType: "image/png",
          widthPx: 900,
          heightPx: 300,
          hasTransparency: false,
          providerKey: "test",
          generationJobId: null,
          metadata: {},
        })
      ).primary.id;
      await repo.updateArtworkReconstructionJob(job.id, {
        status: "completed",
        completedAt: new Date().toISOString(),
        candidateAssetId,
        wordingVerified: true,
        geometryStatus: "review_required",
        reviewStatus: "pending_review",
      });
      return graph.artworkReconstruction.approveCandidate(projectId, job.id, {
        confirmedBy: "customer",
        protectedMarksConfirmed: true,
      });
    }

    // First lifecycle: proposed, confirmed, accepted, qualified, CONFIRMED.
    const contractAProposed = await graph.artworkFidelity.proposeContract(projectId, {
      sourceAssetId: RECOVERY_SOURCE_ASSET_ID,
      sourceSha256: SHA_A,
    });
    const contractA = await graph.artworkFidelity.confirmContract(projectId, contractAProposed.id, {
      currentSourceSha256: SHA_A,
      confirmedWording: ["REGENCY"],
      confirmedMarks: [],
      confirmedBy: "customer",
    });
    const approvedA = await acceptAndQualify("candidate-a", contractA.id);
    await graph.artworkGeometryQualification.ensureQualification(projectId, approvedA.id);
    const confirmedA = await graph.artworkGeometryQualification.confirmQualification(projectId, "customer");
    assert.ok(await getConversation(projectId).then((s) => s!.geometryQualification!.status === "confirmed"));

    // A genuinely new "Rebuild my artwork" cycle: a corrected fidelity
    // contract (mirrors `artwork-geometry-qualification-capability.test.ts`'s
    // own "K" scenario exactly), a new job, approved, but its geometry has
    // NOT been reviewed/confirmed yet — this is a real, legitimate,
    // currently-pending review, and the precedence fix must never suppress
    // it just because an OLDER master was once confirmed.
    const contractBProposed = await graph.artworkFidelity.proposeContract(projectId, {
      sourceAssetId: RECOVERY_SOURCE_ASSET_ID,
      sourceSha256: SHA_A,
    });
    const contractB = await graph.artworkFidelity.confirmContract(projectId, contractBProposed.id, {
      currentSourceSha256: SHA_A,
      confirmedWording: ["REGENCY"],
      confirmedMarks: ["®"],
      confirmedBy: "customer",
    });
    const approvedB = await acceptAndQualify("candidate-b", contractB.id);

    // The OLD master is no longer current once a newer contract exists.
    const masterAfterB = await graph.artworkGeometryQualification.getCurrentProductionQualifiedMaster(projectId);
    assert.equal(masterAfterB, null, "the superseded master must not resolve as current anymore");

    const snapshotDuringNewReview = await getConversation(projectId);
    assert.ok(snapshotDuringNewReview!.geometryQualification, "the new, genuinely pending review must be visible");
    assert.equal(
      snapshotDuringNewReview!.geometryQualification!.status,
      "normalized_pending_confirmation",
      "a genuinely new recovery attempt must still be shown as actionable, never silently hidden",
    );
    assert.notEqual(snapshotDuringNewReview!.geometryQualification!.qualificationId, confirmedA.id);

    // Confirming the NEW one works exactly as before.
    const confirmedB = await graph.artworkGeometryQualification.confirmQualification(projectId, "customer");
    assert.equal(confirmedB.qualificationStatus, "confirmed");
    const finalSnapshot = await getConversation(projectId);
    assert.equal(finalSnapshot!.geometryQualification!.status, "confirmed");
    assert.equal(finalSnapshot!.geometryQualification!.qualificationId, confirmedB.id);
  });
});
