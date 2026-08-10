import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";
import { runAdaptiveInterviewToSummary } from "@/test-support/run-adaptive-interview";
import { acknowledgeRequestedChanges } from "@/capabilities/shared/question-phrasing";
import { splitRequestedChanges } from "@/capabilities/shared/revision-delta";

/**
 * True Source-Image Targeted Revision (Section 7 — revision acknowledgement).
 *
 * The live defect: a customer asked for a visual change and got back
 * "Got it — I have Red in the artwork and the design direction." That
 * describes the brief fields extraction happened to touch, not the change
 * they asked for, and reads as a misunderstanding.
 *
 * A revision acknowledgement is a promise about the ARTWORK, so it must
 * restate the requested delta and the preservation guarantee. No extra
 * paid model call is involved — the phrasing is built from the customer's
 * own already-parsed instruction.
 */
describe("revision acknowledgement — describes the requested delta", () => {
  it("summarizes a two-part change as both changes", () => {
    const ack = acknowledgeRequestedChanges(
      splitRequestedChanges("make the border red and change it to a shield"),
    );

    assert.ok(ack);
    assert.match(ack!, /make the border red/);
    assert.match(ack!, /change it to a shield/);
    assert.match(ack!, /rest of the design|everything else/i);
  });

  it("summarizes a single change", () => {
    const ack = acknowledgeRequestedChanges(splitRequestedChanges("make the car larger"));

    assert.ok(ack);
    assert.match(ack!, /I'll make the car larger/);
    assert.match(ack!, /Everything else in the design stays the same/i);
  });

  it("reflects BOTH changes when the customer asks for two unrelated things", () => {
    const ack = acknowledgeRequestedChanges(
      splitRequestedChanges("change the font to something more retro and remove the sunset"),
    );

    assert.ok(ack);
    assert.match(ack!, /change the font to something more retro/);
    assert.match(ack!, /remove the sunset/);
  });

  it("never reports brief field names or extracted values", () => {
    const ack = acknowledgeRequestedChanges(
      splitRequestedChanges("make the border red and change it to a shield"),
    );

    assert.ok(ack);
    assert.doesNotMatch(ack!, /I have Red in the artwork/i);
    assert.doesNotMatch(ack!, /the design direction/i);
    assert.doesNotMatch(ack!, /shirt color|print location|required wording/i);
  });

  it("declines (so callers fall back) when the message is not an instruction to change something", () => {
    assert.equal(acknowledgeRequestedChanges([]), null);
    assert.equal(
      acknowledgeRequestedChanges(splitRequestedChanges("that looks great")),
      null,
    );
  });

  it("never promises that generation has started", () => {
    const ack = acknowledgeRequestedChanges(splitRequestedChanges("make the car larger"));

    assert.ok(ack);
    // The "I'm updating the concept now" claim belongs to the enqueue
    // announcement, which is only written once the job is durable.
    assert.doesNotMatch(ack!, /updating|generating|working on it/i);
  });
});

describe("ConversationCapability — a revision turn acknowledges the change, not the fields", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-revision-ack-"));
    process.chdir(tempDir);
  });

  after(async () => {
    await cleanupTempWorkspace(tempDir, previousCwd);
  });

  async function freshConversation() {
    const { resetCapabilityGraphForTests, getCapabilityGraph } = await import(
      "@/capabilities/composition"
    );
    resetCapabilityGraphForTests();
    return getCapabilityGraph().conversation;
  }

  async function runToRevisionReady() {
    const conversation = await freshConversation();
    const { getCapabilityGraph } = await import("@/capabilities/composition");
    const { projectId } = await runAdaptiveInterviewToSummary(conversation);
    await conversation.submitDesignBriefDecision(projectId, "approve");

    // The local store is shared across tests in this temp workspace and
    // `processNextJob` claims the oldest due job, which may belong to an
    // earlier test — drain until THIS project actually has its concepts.
    const worker = getCapabilityGraph().generationWorker;
    let approved = await conversation.get(projectId);
    for (let i = 0; i < 10 && (approved?.artworkVersions.length ?? 0) === 0; i += 1) {
      await worker.processNextJob();
      approved = await conversation.get(projectId);
    }

    assert.ok(approved);
    assert.equal(approved.artworkVersions.length, 3);
    const first = approved.artworkVersions[0]!;
    await conversation.selectConcept(projectId, first.id);
    return { conversation, projectId };
  }

  it("acknowledges the customer's requested change and the preservation promise", async () => {
    const { conversation, projectId } = await runToRevisionReady();

    const after = await conversation.handleUserMessage(
      projectId,
      "Make the border red and change it to a shield.",
    );

    // The acknowledgement is the assistant message carrying `act:
    // "acknowledge"` for this revision turn.
    const ack = [...after.messages]
      .reverse()
      .find((message) => message.metadata?.act === "acknowledge");
    assert.ok(ack, "a revision turn must acknowledge");

    assert.match(ack!.content, /border red/i);
    assert.match(ack!.content, /shield/i);
    assert.match(ack!.content, /everything else|rest of the design/i);
    // The old field-reporting behavior must not come back.
    assert.doesNotMatch(ack!.content, /I have Red in the artwork/i);
  });

  it("acknowledges two simultaneous requested changes", async () => {
    const { conversation, projectId } = await runToRevisionReady();

    const after = await conversation.handleUserMessage(
      projectId,
      "Change the font to something more retro and remove the sunset.",
    );

    const ack = [...after.messages]
      .reverse()
      .find((message) => message.metadata?.act === "acknowledge");
    assert.ok(ack);
    assert.match(ack!.content, /retro/i);
    assert.match(ack!.content, /sunset/i);
  });
});
