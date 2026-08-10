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
    const { drainCapabilityGraphForTests } = await import(
      "@/capabilities/composition"
    );
    await drainCapabilityGraphForTests();
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
    // Automated tests remain isolated: the interactive-dev local trigger
    // must not start a batch here.
    assert.equal(enqueued.conversation.phase, "generating");
    assert.equal(enqueued.artworkVersions.length, 0);
    assert.equal(getCapabilityGraph().workerScheduler.hasActiveBatch(), false);
    const [job] = await (await import("@/lib/db")).getProjectRepository()
      .listGenerationJobs(projectId);
    assert.equal(job?.status, "queued");

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

/**
 * Live acceptance failure, 2026-08-08: a PostgREST rejection (a plain
 * object, not an `Error`) was reported to the customer as the generic
 * fallback and logged as an unlabelled object, so the actual cause — a
 * column missing from the database — was invisible from the browser.
 */
describe("brief decision failure classification", () => {
  it("names the real cause in the log, including a PostgREST code", async () => {
    const { describeDecisionFailure } = await import(
      "@/app/api/projects/[projectId]/brief/decision/decision-failure"
    );

    assert.equal(
      describeDecisionFailure({
        code: "PGRST204",
        message:
          "Could not find the 'target_artwork_version_id' column of 'generation_jobs' in the schema cache",
      }),
      "PGRST204: Could not find the 'target_artwork_version_id' column of 'generation_jobs' in the schema cache",
    );
    assert.equal(
      describeDecisionFailure(new Error("Project not found")),
      "Project not found",
    );
    assert.equal(
      describeDecisionFailure("something odd"),
      "Failed to submit decision",
    );
  });

  it("keeps infrastructure detail out of the customer's message", async () => {
    const { customerFacingDecisionMessage } = await import(
      "@/app/api/projects/[projectId]/brief/decision/decision-failure"
    );

    assert.equal(
      customerFacingDecisionMessage({
        code: "PGRST204",
        message: "Could not find the 'target_artwork_version_id' column",
      }),
      "Failed to submit decision",
    );
    assert.equal(
      customerFacingDecisionMessage(
        new Error("Design summary is not ready for approval"),
      ),
      "Design summary is not ready for approval",
    );
  });

  it("treats infrastructure failures as server faults, never client mistakes", async () => {
    const { decisionFailureStatus } = await import(
      "@/app/api/projects/[projectId]/brief/decision/decision-failure"
    );

    assert.equal(decisionFailureStatus(new Error("Project not found")), 404);
    assert.equal(
      decisionFailureStatus(new Error("Design summary is not ready for approval")),
      409,
    );
    assert.equal(
      decisionFailureStatus(new Error("Cannot edit the design brief from the current step")),
      409,
    );
    // A database rejection whose text contains a word the domain mapping
    // looks for must still be a 500 — retrying it is not the customer's
    // problem to solve.
    assert.equal(
      decisionFailureStatus({
        code: "PGRST205",
        message: "Could not find the table 'public.generation_jobs' — not found",
      }),
      500,
    );
  });
});

describe("brief decision request schema", () => {
  it("accepts approve and edit", async () => {
    const { briefDecisionBodySchema } = await import(
      "@/app/api/projects/[projectId]/brief/decision/schema"
    );

    for (const action of ["approve", "edit"]) {
      const result = briefDecisionBodySchema.safeParse({ action });
      assert.equal(result.success, true);
    }
  });

  it("rejects malformed actions, including the removed 'continue' action (Sprint 2L Phase 1B, Goal 12)", async () => {
    const { briefDecisionBodySchema } = await import(
      "@/app/api/projects/[projectId]/brief/decision/schema"
    );

    assert.equal(
      briefDecisionBodySchema.safeParse({ action: "generate" }).success,
      false,
    );
    assert.equal(
      briefDecisionBodySchema.safeParse({ action: "continue" }).success,
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
