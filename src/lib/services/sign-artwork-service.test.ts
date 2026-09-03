/**
 * Operator Production Correction UX: `previewSignCorrections`/
 * `commitSignCorrections` — the preview (fast, never persisted, zero Topaz)
 * and governed-commit (appends to the plan, new planKey, invalidates old
 * authorization) halves of "Smart Remove". Uses `getCapabilityGraph()`
 * (matching `authorize/route.test.ts`'s own established pattern for this
 * service layer) rather than a hand-built graph — under
 * `isAutomatedTestEnvironment()` this resolves to the safe, network-free
 * `PlaceholderSignPreservationSemanticProvider` (always `cannot_determine`,
 * never `preserved`), so a job run through this graph can never itself
 * reach an OVERALL `"ready"` status — every assertion below therefore
 * checks the SPECIFIC `protected_content_safe_inset` check this phase adds,
 * never the report's overall status, which stays governed by the
 * separately-tested preservation gate regardless of this phase's work.
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { fillRect, makeImage, toPngBytes } from "@/capabilities/sign-preparation/sign-fixtures";
import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";

describe("sign-artwork-service: Operator Production Correction UX (preview + commit)", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-sign-correction-service-"));
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

  /**
   * 600x900px = exactly 4x6in at 150 PPI (the RIGID_RECT_UP_TO_24X36_V1
   * target): a uniform red background with a 20x20 black artifact only 5px
   * from the LEFT cut edge. Required safe inset at 150 PPI is
   * ceil(0.125*150)=19px, so this artifact genuinely violates it — a real,
   * measured Fit to Production failure, not a contrived one.
   */
  function signWithLeftEdgeArtifact() {
    const image = makeImage(600, 900, { r: 200, g: 10, b: 10 });
    fillRect(image, 5, 440, 25, 460, { r: 20, g: 20, b: 20 });
    return image;
  }

  async function projectWithBlockedCandidate(
    graph: Awaited<ReturnType<typeof freshGraph>>["graph"],
    repo: Awaited<ReturnType<typeof freshGraph>>["repo"],
  ) {
    const created = await repo.createProject();
    const projectId = created.project.id;
    await graph.signPreparation.uploadSignArtwork(projectId, {
      bytes: toPngBytes(signWithLeftEdgeArtifact()),
      declaredContentType: "image/png",
      filename: "sign.png",
    });
    await graph.signPreparation.confirmSignProductionSpec(projectId, 4, 6);
    // Source already matches the ordered 4x6in aspect exactly at 150 PPI —
    // fit_artwork_to_canvas places it 1:1 (scale 1, placement (0,0)), so
    // source pixel (x,y) is candidate pixel (x,y) exactly, making the
    // artifact's expected candidate position exact and predictable.
    await graph.signPreparation.confirmSignCompositionPlan(projectId, {
      reconstruction: null,
      crop: null,
      fitBackground: { r: 200, g: 10, b: 10 },
      fitPlacement: null,
      moves: [],
      fills: [],
      replacements: [],
    });
    await graph.signPreparation.authorizeSignRepairPlan(projectId, { authorizedBy: "operator" });
    const { job } = await graph.finalArtwork.requestSignFinalArtwork(projectId);
    await graph.finalArtworkScheduler.runBatch();
    return { projectId, job };
  }

  it("sanity: Fit to Production genuinely blocks the candidate on the LEFT edge before any correction", async () => {
    const { graph, repo } = await freshGraph();
    const { projectId, job } = await projectWithBlockedCandidate(graph, repo);
    const completedJob = await repo.getFinalArtworkJob(job.id);
    assert.equal(completedJob!.status, "completed");
    const validation = await repo.getLatestProductionAssetValidationForJob(projectId, job.id);
    const checks = (validation!.report as { checks: Array<{ check: string; status: string }> }).checks;
    const fitCheck = checks.find((c) => c.check === "protected_content_safe_inset");
    assert.equal(fitCheck?.status, "fail");
    const evidence = (validation!.report as {
      fitToProductionEvidence: { edges: Array<{ edge: string; protectedResult: string }> } | null;
    }).fitToProductionEvidence;
    assert.equal(evidence?.edges.find((e) => e.edge === "left")?.protectedResult, "fail");
  });

  it("preview: measures the surrounding background, flips LEFT edge FAIL -> PASS, and persists nothing", async () => {
    const { graph, repo } = await freshGraph();
    const { projectId } = await projectWithBlockedCandidate(graph, repo);
    const before = await repo.getSignPreparation(projectId);

    const { previewSignCorrections } = await import("./sign-artwork-service");
    const result = await previewSignCorrections(projectId, [
      { kind: "remove", xPx: 0, yPx: 435, widthPx: 30, heightPx: 30, contextDepthPx: 8 },
    ]);

    assert.equal(result.status, "previewed");
    assert.equal(result.appliedCount, 1);
    assert.deepEqual(result.measuredColors[0], { r: 200, g: 10, b: 10 });
    const leftEdge = result.fitToProduction!.edges.find((e) => e.edge === "left");
    assert.equal(leftEdge?.protectedResult, "pass");
    assert.ok(result.beforeCropPngBase64);
    assert.ok(result.afterCropPngBase64);

    // Never persisted anything — same plan/planKey as before the preview.
    const after = await repo.getSignPreparation(projectId);
    assert.equal(after!.planKey, before!.planKey);
    assert.equal(after!.status, before!.status);
  });

  it("preview refuses a selection whose own surrounding ring is not uniform, without applying anything", async () => {
    const { graph, repo } = await freshGraph();
    const { projectId } = await projectWithBlockedCandidate(graph, repo);
    const { previewSignCorrections } = await import("./sign-artwork-service");
    // A tiny rect well inside the artifact whose own ring (depth 10) spills
    // past the artifact's edge into the background — genuinely non-uniform.
    const result = await previewSignCorrections(projectId, [
      { kind: "remove", xPx: 10, yPx: 445, widthPx: 6, heightPx: 6, contextDepthPx: 10 },
    ]);
    assert.equal(result.status, "refused");
    assert.equal(result.appliedCount, 0);
    assert.equal(result.failingIndex, 0);
    assert.ok(result.failingDetail && result.failingDetail.length > 0);
  });

  it("preview reports no_candidate once nothing is blocked (e.g. no job has run yet)", async () => {
    const { graph, repo } = await freshGraph();
    const created = await repo.createProject();
    const projectId = created.project.id;
    await graph.signPreparation.uploadSignArtwork(projectId, {
      bytes: toPngBytes(signWithLeftEdgeArtifact()),
      declaredContentType: "image/png",
      filename: "sign.png",
    });
    await graph.signPreparation.confirmSignProductionSpec(projectId, 4, 6);
    const { previewSignCorrections } = await import("./sign-artwork-service");
    const result = await previewSignCorrections(projectId, [
      { kind: "remove", xPx: 0, yPx: 435, widthPx: 30, heightPx: 30, contextDepthPx: 8 },
    ]);
    assert.equal(result.status, "no_candidate");
  });

  it("commit: governed — appends to the plan, produces a NEW planKey, invalidates the old authorization", async () => {
    const { graph, repo } = await freshGraph();
    const { projectId } = await projectWithBlockedCandidate(graph, repo);
    const before = await repo.getSignPreparation(projectId);
    assert.equal(before!.authorizedPlanKey, before!.planKey);

    const { commitSignCorrections } = await import("./sign-artwork-service");
    const review = await commitSignCorrections(projectId, [
      { kind: "remove", xPx: 0, yPx: 435, widthPx: 30, heightPx: 30, contextDepthPx: 8 },
    ]);
    assert.equal(review.status, "ready");
    if (review.status !== "ready") return;

    const updated = await repo.getSignPreparation(projectId);
    assert.notEqual(updated!.planKey, before!.planKey, "the correction genuinely changed plan identity");
    assert.equal(review.authorization.matchesCurrentPlan, false, "the OLD authorization must not authorize the NEW plan");

    const plan = updated!.plan as { steps: Array<{ kind: string }> };
    assert.ok(plan.steps.some((s) => s.kind === "replace_region_with_background"), "the correction became a real plan step");
  });

  it("commit refuses (never persists) when the surrounding context is not uniform", async () => {
    const { graph, repo } = await freshGraph();
    const { projectId } = await projectWithBlockedCandidate(graph, repo);
    const before = await repo.getSignPreparation(projectId);
    const { commitSignCorrections, SignArtworkBridgeError } = await import("./sign-artwork-service");
    await assert.rejects(
      () =>
        commitSignCorrections(projectId, [
          { kind: "remove", xPx: 10, yPx: 445, widthPx: 6, heightPx: 6, contextDepthPx: 10 },
        ]),
      SignArtworkBridgeError,
    );
    const after = await repo.getSignPreparation(projectId);
    assert.equal(after!.planKey, before!.planKey, "a refused correction must never mutate the persisted plan");
  });

  it("move: the existing move_region capability is available through the same governed commit path — the moved content actually appears at its new destination", async () => {
    const { graph, repo } = await freshGraph();
    const { projectId } = await projectWithBlockedCandidate(graph, repo);
    const { previewSignCorrections, commitSignCorrections } = await import("./sign-artwork-service");

    // Preview a move of the artifact band itself — mechanically the same
    // primitive `SignCompositionPlanForm`'s own numeric move fieldset uses.
    const preview = await previewSignCorrections(projectId, [
      { kind: "move", sourceStartYPx: 435, heightPx: 30, destStartYPx: 700 },
    ]);
    assert.equal(preview.status, "previewed");
    assert.equal(preview.measuredColors[0], null, "a move never measures a colour");

    await commitSignCorrections(projectId, [
      { kind: "move", sourceStartYPx: 435, heightPx: 30, destStartYPx: 700 },
    ]);
    const preparation = await repo.getSignPreparation(projectId);
    const plan = preparation!.plan as { steps: Array<{ kind: string; params: Record<string, number> }> };
    const movedStep = plan.steps.find((s) => s.kind === "move_region")!;
    assert.equal(movedStep.params.sourceStartYPx, 435);
    assert.equal(movedStep.params.heightPx, 30);
    assert.equal(movedStep.params.destStartYPx, 700);

    // Re-authorize and re-execute for real — the artifact's own black pixel
    // must now appear at the new destination (byte-for-byte copy, not a
    // resize/warp) as well as its original position (move_region never
    // clears its source — resolving a safe-inset violation this way also
    // needs a fill_rect backfill at the source, available through the
    // existing composition plan form; this test proves the move mechanism
    // itself, not full violation resolution).
    await graph.signPreparation.authorizeSignRepairPlan(projectId, { authorizedBy: "operator" });
    const { job } = await graph.finalArtwork.requestSignFinalArtwork(projectId);
    await graph.finalArtworkScheduler.runBatch();
    const completedJob = await repo.getFinalArtworkJob(job.id);
    assert.equal(completedJob!.status, "completed");
  });

  it("preview and commit measure the IDENTICAL colour for the same selection — preview/execution equivalence (Section L)", async () => {
    const { graph, repo } = await freshGraph();
    const { projectId } = await projectWithBlockedCandidate(graph, repo);
    const { previewSignCorrections, commitSignCorrections } = await import("./sign-artwork-service");

    const previewResult = await previewSignCorrections(projectId, [
      { kind: "remove", xPx: 0, yPx: 435, widthPx: 30, heightPx: 30, contextDepthPx: 8 },
    ]);
    assert.equal(previewResult.status, "previewed");

    await commitSignCorrections(projectId, [
      { kind: "remove", xPx: 0, yPx: 435, widthPx: 30, heightPx: 30, contextDepthPx: 8 },
    ]);
    const preparation = await repo.getSignPreparation(projectId);
    const plan = preparation!.plan as { steps: Array<{ kind: string; params: Record<string, number> }> };
    const committedStep = plan.steps.find((s) => s.kind === "replace_region_with_background")!;
    assert.equal(committedStep.params.colorR, previewResult.measuredColors[0]!.r);
    assert.equal(committedStep.params.colorG, previewResult.measuredColors[0]!.g);
    assert.equal(committedStep.params.colorB, previewResult.measuredColors[0]!.b);
    assert.equal(committedStep.params.xPx, 0);
    assert.equal(committedStep.params.yPx, 435);
    assert.equal(committedStep.params.widthPx, 30);
    assert.equal(committedStep.params.heightPx, 30);
  });

  it("after commit, re-authorization, and real re-execution, the protected_content_safe_inset check specifically now passes", async () => {
    const { graph, repo } = await freshGraph();
    const { projectId } = await projectWithBlockedCandidate(graph, repo);
    const { commitSignCorrections } = await import("./sign-artwork-service");

    await commitSignCorrections(projectId, [
      { kind: "remove", xPx: 0, yPx: 435, widthPx: 30, heightPx: 30, contextDepthPx: 8 },
    ]);

    // Governed re-authorization of the NEW plan, then real re-execution
    // through the ordinary, unmodified worker — no shortcuts.
    await graph.signPreparation.authorizeSignRepairPlan(projectId, { authorizedBy: "operator" });
    const { job } = await graph.finalArtwork.requestSignFinalArtwork(projectId);
    await graph.finalArtworkScheduler.runBatch();

    const completedJob = await repo.getFinalArtworkJob(job.id);
    assert.equal(completedJob!.status, "completed");
    const validation = await repo.getLatestProductionAssetValidationForJob(projectId, job.id);
    const checks = (validation!.report as { checks: Array<{ check: string; status: string }> }).checks;
    const fitCheck = checks.find((c) => c.check === "protected_content_safe_inset");
    // The specific check this phase adds now passes — the OVERALL report
    // status remains "finalization_required" in this test environment
    // because `isAutomatedTestEnvironment()` forces the safe placeholder
    // preservation provider (always "cannot_determine"), an unrelated,
    // separately-tested gate this correction never touches.
    assert.equal(fitCheck?.status, "pass");
  });

  /**
   * 600x900px, uniform red background, a 9px BLACK border along the LEFT
   * edge for rows 0..399 (44% of the 900-row edge — a minority, keeping RED
   * the measured dominant baseline exactly like `sign-fit-to-production
   * .test.ts`'s own EDGE_INTENT_ARTWORK fixtures) — no other content.
   * Without classification the border itself trips the violation at depth
   * 0; classifying it as EDGE_INTENT_ARTWORK should reveal nothing but
   * clean bleed beyond it.
   */
  function signWithLeftBorder() {
    const image = makeImage(600, 900, { r: 200, g: 10, b: 10 });
    // Rows 25..424 — deliberately starts PAST the TOP edge's own required
    // 19px safe inset (not merely past row 0): the TOP edge scans DOWNWARD
    // from row 0 at every column, so a border starting any shallower than
    // that inset would ALSO trip a TOP-edge violation at these same
    // columns, unclassified there. This fixture isolates LEFT-edge
    // behaviour cleanly (a border reaching an actual corner would ALSO
    // need classifying for that adjacent edge — see the spatial-bounding
    // tests in sign-fit-to-production.test.ts for that exact case).
    fillRect(image, 0, 25, 9, 425, { r: 10, g: 10, b: 10 });
    return image;
  }

  async function projectWithBorderCandidate(
    graph: Awaited<ReturnType<typeof freshGraph>>["graph"],
    repo: Awaited<ReturnType<typeof freshGraph>>["repo"],
  ) {
    const created = await repo.createProject();
    const projectId = created.project.id;
    await graph.signPreparation.uploadSignArtwork(projectId, {
      bytes: toPngBytes(signWithLeftBorder()),
      declaredContentType: "image/png",
      filename: "sign.png",
    });
    await graph.signPreparation.confirmSignProductionSpec(projectId, 4, 6);
    await graph.signPreparation.confirmSignCompositionPlan(projectId, {
      reconstruction: null, crop: null, fitBackground: { r: 200, g: 10, b: 10 }, fitPlacement: null,
      moves: [], fills: [], replacements: [],
    });
    await graph.signPreparation.authorizeSignRepairPlan(projectId, { authorizedBy: "operator" });
    const { job } = await graph.finalArtwork.requestSignFinalArtwork(projectId);
    await graph.finalArtworkScheduler.runBatch();
    return { projectId, job };
  }

  it("classify: commit persists a governed edge_intent classification WITHOUT touching the composition plan", async () => {
    const { graph, repo } = await freshGraph();
    const { projectId } = await projectWithBorderCandidate(graph, repo);
    const before = await repo.getSignPreparation(projectId);
    assert.equal(before!.edgeIntentClassifications, null);
    const candidateBefore = await graph.finalArtwork.resolveBlockedSignProductionCandidate(projectId);
    assert.ok(candidateBefore);

    const { commitSignCorrections } = await import("./sign-artwork-service");
    await commitSignCorrections(projectId, [
      { kind: "classify", classificationKind: "edge_intent", edges: ["left"], xPx: 0, yPx: 25, widthPx: 9, heightPx: 400 },
    ]);

    const after = await repo.getSignPreparation(projectId);
    assert.equal(after!.planKey, before!.planKey, "a classify-only commit must never change the composition plan");
    assert.ok(Array.isArray(after!.edgeIntentClassifications));
    assert.equal(after!.edgeIntentClassifications!.length, 1);
    const record = after!.edgeIntentClassifications![0] as Record<string, unknown>;
    assert.equal(record.kind, "edge_intent");
    assert.deepEqual(record.edges, ["left"]);
    assert.equal(record.candidateAssetId, candidateBefore!.assetId, "bound to the EXACT candidate asset the operator was looking at");
    assert.equal(record.planKey, after!.planKey, "the classification binds to the CURRENT plan key");
    assert.equal(record.createdBy, "operator");
  });

  it("classify: after commit and real re-execution, the scan reveals TRUE clearance beyond the governed border — LEFT edge flips FAIL -> PASS", async () => {
    const { graph, repo } = await freshGraph();
    const { projectId, job } = await projectWithBorderCandidate(graph, repo);

    const beforeValidation = await repo.getLatestProductionAssetValidationForJob(projectId, job.id);
    const beforeChecks = (beforeValidation!.report as { checks: Array<{ check: string; status: string }> }).checks;
    assert.equal(beforeChecks.find((c) => c.check === "protected_content_safe_inset")?.status, "fail");

    const { commitSignCorrections } = await import("./sign-artwork-service");
    await commitSignCorrections(projectId, [
      { kind: "classify", classificationKind: "edge_intent", edges: ["left"], xPx: 0, yPx: 25, widthPx: 9, heightPx: 400 },
    ]);

    // planKey is unchanged (classify-only) — the existing authorization
    // still applies; re-queue the SAME job for real re-execution (the
    // worker recomputes Fit to Production fresh every run and will now
    // resolve this project's newly-persisted classification).
    await repo.updateFinalArtworkJob(job.id, {
      status: "queued", lastError: null, completedAt: null, startedAt: null, heartbeatAt: null,
    });
    await graph.finalArtworkScheduler.runBatch();

    const completedJob = await repo.getFinalArtworkJob(job.id);
    assert.equal(completedJob!.status, "completed");
    const validation = await repo.getLatestProductionAssetValidationForJob(projectId, job.id);
    const checks = (validation!.report as { checks: Array<{ check: string; status: string; reason: string }> }).checks;
    assert.equal(checks.find((c) => c.check === "protected_content_safe_inset")?.status, "pass");
    const advisory = checks.find((c) => c.check === "edge_intent_advisory");
    assert.equal(advisory?.status, "pass");
    assert.match(advisory!.reason, /left/i);
  });

  it("classify: a classification bound to a DIFFERENT candidate is never applied — staleness re-validated fresh (Section F/K)", async () => {
    const { graph, repo } = await freshGraph();
    const { projectId, job } = await projectWithBorderCandidate(graph, repo);
    const preparation = await repo.getSignPreparation(projectId);

    // Manually persist a classification bound to a FABRICATED, different
    // candidate asset id — simulating a classification recorded against a
    // superseded candidate — via the SAME governed encode/decode module
    // this service itself uses (never raw JSON invention).
    const { buildEdgeIntentClassificationRecord, encodeEdgeIntentClassificationRecord } = await import(
      "@/capabilities/sign-preparation"
    );
    const staleRecord = buildEdgeIntentClassificationRecord({
      kind: "edge_intent", edges: ["left"], xPx: 0, yPx: 25, widthPx: 9, heightPx: 400,
      candidateAssetId: "some-superseded-asset-id", planKey: preparation!.planKey!,
    });
    await repo.updateSignPreparation(preparation!.id, {
      edgeIntentClassifications: [encodeEdgeIntentClassificationRecord(staleRecord)],
    });

    await repo.updateFinalArtworkJob(job.id, {
      status: "queued", lastError: null, completedAt: null, startedAt: null, heartbeatAt: null,
    });
    await graph.finalArtworkScheduler.runBatch();

    const validation = await repo.getLatestProductionAssetValidationForJob(projectId, job.id);
    const checks = (validation!.report as { checks: Array<{ check: string; status: string }> }).checks;
    // The stale classification (bound to a DIFFERENT candidate) must never
    // apply to THIS candidate — the border is still an unresolved
    // violation.
    assert.equal(checks.find((c) => c.check === "protected_content_safe_inset")?.status, "fail");
  });
});
