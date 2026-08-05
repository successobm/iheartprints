import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";
import { runAdaptiveInterviewToSummary } from "@/test-support/run-adaptive-interview";

/**
 * Sprint 2D: exercises the same facade the API route calls, plus the request
 * validation schema used by that route. This repo has no HTTP test harness,
 * so route-level behavior is verified at the service facade + schema layer
 * (the route itself is a thin body-validation + status-mapping wrapper).
 */
describe("submitDesignBriefDecision (API facade)", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-decision-"));
    process.chdir(tempDir);
  });

  after(async () => {
    await cleanupTempWorkspace(tempDir, previousCwd);
  });

  it("succeeds from the expected state and reflects resume before approval", async () => {
    const { resetCapabilityGraphForTests } = await import(
      "@/capabilities/composition"
    );
    resetCapabilityGraphForTests();

    const {
      startConversation,
      handleUserMessage,
      submitDesignBriefDecision,
      getConversation,
    } = await import("./conversation-service");
    const { getCapabilityGraph } = await import("@/capabilities/composition");

    const { projectId } = await runAdaptiveInterviewToSummary({
      start: startConversation,
      handleUserMessage,
    });

    // Resume mid-gate, before any decision — simulates a reload.
    const beforeDecision = await getConversation(projectId);
    assert.equal(
      beforeDecision?.conversation.phase,
      "awaiting_summary_confirmation",
    );
    assert.equal(beforeDecision?.artworkVersions.length, 0);

    const enqueued = await submitDesignBriefDecision(projectId, "approve");
    // Sprint 2H Part 2A: generation is enqueued, not run synchronously —
    // the customer's request returns before any provider call happens.
    assert.equal(enqueued.conversation.phase, "generating");
    assert.equal(enqueued.artworkVersions.length, 0);

    await getCapabilityGraph().generationWorker.processNextJob();
    const approved = await getConversation(projectId);
    assert.equal(approved?.conversation.phase, "concepts_ready");
    assert.equal(approved?.artworkVersions.length, 3);

    const afterReload = await getConversation(projectId);
    assert.equal(afterReload?.conversation.phase, "concepts_ready");
    assert.equal(afterReload?.artworkVersions.length, 3);
  });

  it("fails when approval is requested from an invalid (still-interviewing) state", async () => {
    const { resetCapabilityGraphForTests } = await import(
      "@/capabilities/composition"
    );
    resetCapabilityGraphForTests();

    const { startConversation, submitDesignBriefDecision } = await import(
      "./conversation-service"
    );

    const created = await startConversation();

    await assert.rejects(() =>
      submitDesignBriefDecision(created.project.id, "approve"),
    );
  });
});

describe("brief decision request schema", () => {
  it("accepts approve, edit, and continue", async () => {
    const { briefDecisionBodySchema } = await import(
      "@/app/api/projects/[projectId]/brief/decision/schema"
    );

    for (const action of ["approve", "edit", "continue"]) {
      const result = briefDecisionBodySchema.safeParse({ action });
      assert.equal(result.success, true);
    }
  });

  it("rejects malformed actions", async () => {
    const { briefDecisionBodySchema } = await import(
      "@/app/api/projects/[projectId]/brief/decision/schema"
    );

    assert.equal(
      briefDecisionBodySchema.safeParse({ action: "generate" }).success,
      false,
    );
    assert.equal(briefDecisionBodySchema.safeParse({}).success, false);
    assert.equal(
      briefDecisionBodySchema.safeParse({ action: 123 }).success,
      false,
    );
    assert.equal(briefDecisionBodySchema.safeParse(null).success, false);
  });
});
