import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { encodeRgbaToPng } from "@/capabilities/artwork-preparation/image-decode";
import { fillRect, makeImage, toPngBytes } from "@/capabilities/sign-preparation/sign-fixtures";
import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";

/**
 * R6B (Production-Qualified Clean Master → Signs Authoritative Source
 * Handoff) — Section 33's own REGENCY REGRESSION acceptance test, at the
 * `conversation-service.ts` VIEW boundary rather than the capability layer
 * (`sign-preparation-capability-effective-source.test.ts` already covers the
 * capability's own precedence table exhaustively). Reproduces the exact
 * live defect: a Signs plan formulated against the degraded original must
 * never be shown as current once a later Production-Qualified Clean Master
 * is confirmed — the customer-facing snapshot must replan and show analysis
 * from the master instead.
 */
describe("Signs Production-Qualified Clean Master handoff — conversation-service view boundary (R6B Section 33)", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-sign-view-handoff-"));
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

  it("REGENCY REGRESSION: the customer snapshot must not show the stale 1000x344 original-bound plan once a geometry-confirmed master exists — it must replan and show the master's own dimensions", async () => {
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

    const uploaded = await graph.signPreparation.uploadSignArtwork(projectId, {
      bytes: regencyOriginalBytes(),
      declaredContentType: "image/png",
      filename: "regency-original.png",
    });
    await graph.signPreparation.confirmSignProductionSpec(projectId, 48, 24);
    const firstOutcome = await graph.signPreparation.planSignRepair(projectId);
    assert.equal(firstOutcome.result.status, "planned");

    // Sanity: before recovery, the snapshot's Signs view reports the
    // degraded original's own dimensions — reproducing the exact
    // pre-fix/live-regression state.
    const beforeSnapshot = await getConversation(projectId);
    assert.equal(beforeSnapshot!.signArtwork!.plan!.artworkWidthPx, 1000);
    assert.equal(beforeSnapshot!.signArtwork!.plan!.artworkHeightPx, 344);

    // Full recovery lineage: propose/confirm fidelity, request/approve
    // reconstruction, qualify + confirm geometry.
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
    const qualification = await graph.artworkGeometryQualification.ensureQualification(
      projectId,
      approved.id,
    );
    const confirmed = await graph.artworkGeometryQualification.confirmQualification(
      projectId,
      "customer",
    );
    assert.equal(qualification.id, confirmed.id);

    // The customer returns ("Looks good — continue") and reloads the
    // snapshot WITHOUT any explicit "Check my artwork" click — R6B's own
    // hard requirement is that the VIEW itself must never surface the
    // stale 1000x344 analysis at this point.
    const afterSnapshot = await getConversation(projectId);
    const plan = afterSnapshot!.signArtwork!.plan!;
    assert.notEqual(plan.artworkWidthPx, 1000, "must not show the stale original width");
    assert.notEqual(plan.artworkHeightPx, 344, "must not show the stale original height");
    assert.equal(plan.artworkWidthPx, confirmed.normalizedWidthPx);
    assert.equal(plan.artworkHeightPx, confirmed.normalizedHeightPx);

    // The durable row itself was actually replanned (not merely a
    // one-response override), and the immutable original is untouched.
    const reloaded = await graph.signPreparation.getSignPreparation(projectId);
    assert.equal(reloaded!.originalAssetId, uploaded.originalAssetId);
    assert.equal(await graph.signPreparation.isSignPlanCurrent(projectId), true);
  });
});
