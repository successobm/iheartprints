import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { removeTempDir } from "@/test-support/remove-temp-dir";

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
    process.chdir(previousCwd);
    const { resetCapabilityGraphForTests } = await import(
      "@/capabilities/composition"
    );
    resetCapabilityGraphForTests();
    await removeTempDir(tempDir);
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

    const created = await startConversation();
    const projectId = created.project.id;

    await handleUserMessage(projectId, "Camp shirts");
    await handleUserMessage(projectId, "A friendly bear logo");
    await handleUserMessage(projectId, "Navy");
    await handleUserMessage(projectId, "Camp Wildwood 2026");

    // Resume mid-gate, before any decision — simulates a reload.
    const beforeDecision = await getConversation(projectId);
    assert.equal(
      beforeDecision?.conversation.phase,
      "awaiting_summary_confirmation",
    );
    assert.equal(beforeDecision?.artworkVersions.length, 0);

    const approved = await submitDesignBriefDecision(projectId, "approve");
    assert.equal(approved.conversation.phase, "concepts_ready");
    assert.equal(approved.artworkVersions.length, 3);

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
