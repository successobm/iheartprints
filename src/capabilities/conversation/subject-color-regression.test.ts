import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";
import type { ConversationCapability } from "@/capabilities/conversation";
import type { BriefSectionKey } from "@/capabilities/shared/contracts";
import type { ProjectSnapshot, TShirtDesignBrief } from "@/lib/domain/types";

/**
 * A4 Funnel Correction B — the live Jeep conversation, end to end.
 *
 * THE SEQUENCE THAT FAILED
 *
 *   customer: "black 2010 jeep wrangler unlimited with full racks and a
 *              inspired overland roof top tent"
 *   assistant: "I have Black in the artwork…"          ← never asked for
 *   customer: (shirt color) "black"
 *   assistant: "The color you'd like for the design matches the shirt
 *               color…"                                 ← blocking clash
 *
 * The Jeep's color had been recorded as a global palette preference, so
 * Brief Evaluation correctly reported a clash against a preference the
 * customer never expressed and asked them to change their design.
 *
 * The extraction fix lives in `capabilities/intent-extraction`; this file
 * proves the four downstream consequences the customer actually
 * experienced. Deterministic — no provider, no network, no cost.
 */
describe("A4 Correction B regression — the black Jeep on a black shirt", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-subject-color-"));
    process.chdir(tempDir);
  });

  after(async () => {
    await cleanupTempWorkspace(tempDir, previousCwd);
  });

  const OPENER =
    "black 2010 jeep wrangler unlimited with full racks and a inspired overland roof top tent";

  async function freshConversation(): Promise<ConversationCapability> {
    const { resetCapabilityGraphForTests, getCapabilityGraph } = await import(
      "@/capabilities/composition"
    );
    resetCapabilityGraphForTests();
    return getCapabilityGraph().conversation;
  }

  const ANSWERS: Partial<Record<BriefSectionKey, string>> = {
    product: "T-shirts",
    graphics: OPENER,
    productColor: "black",
    requiredWording: "none",
  };
  const DEFAULT_REPLY = "You choose.";
  const MAX_TURNS = 20;

  /** Drives the real adaptive interview to the Design Summary gate. */
  async function driveToSummary(
    conversation: ConversationCapability,
    projectId: string,
    afterOpener: ProjectSnapshot,
  ): Promise<ProjectSnapshot> {
    let snapshot = afterOpener;
    for (let turn = 0; turn < MAX_TURNS; turn += 1) {
      if (snapshot.conversation.phase === "awaiting_summary_confirmation") {
        return snapshot;
      }
      const pending = snapshot.conversation.interviewState
        .pendingSection as BriefSectionKey | null;
      const reply = (pending && ANSWERS[pending]) || DEFAULT_REPLY;
      snapshot = await conversation.handleUserMessage(projectId, reply);
    }
    throw new Error(
      `Did not reach the Design Summary within ${MAX_TURNS} turns (phase ` +
        `"${snapshot.conversation.phase}", pending ` +
        `"${snapshot.conversation.interviewState.pendingSection}")`,
    );
  }

  function assistantText(snapshot: ProjectSnapshot): string {
    return snapshot.messages
      .filter((message) => message.role === "assistant")
      .map((message) => message.content)
      .join("\n");
  }

  it("Goal 11: the opener records no palette preference and the assistant never claims one", async () => {
    const conversation = await freshConversation();
    const started = await conversation.start();
    const projectId = started.project.id;

    const afterOpener = await conversation.handleUserMessage(projectId, OPENER);

    assert.deepEqual(afterOpener.brief.preferredColors, []);
    // Goal 17/J: the Jeep's color is not lost — it is a creative fact,
    // carried in the design description.
    assert.match(String(afterOpener.brief.designDescription), /black 2010 jeep/i);
    assert.doesNotMatch(assistantText(afterOpener), /in the artwork/i);
  });

  it("Goals 6+9: black Jeep + black shirt reaches an approvable summary with no color-clash question", async () => {
    const conversation = await freshConversation();
    const started = await conversation.start();
    const projectId = started.project.id;

    const afterOpener = await conversation.handleUserMessage(projectId, OPENER);
    const afterSummary = await driveToSummary(conversation, projectId, afterOpener);

    assert.equal(afterSummary.conversation.phase, "awaiting_summary_confirmation");
    assert.equal(afterSummary.brief.shirtColor, "Black");
    assert.deepEqual(afterSummary.brief.preferredColors, []);

    // The exact question the customer was wrongly asked.
    const text = assistantText(afterSummary);
    assert.doesNotMatch(text, /matches the shirt color/i);
    assert.doesNotMatch(text, /may not be visible when printed/i);
    assert.doesNotMatch(text, /in the artwork/i);

    // And Brief Evaluation itself reports nothing to raise.
    const { createBriefEvaluationCapability } = await import(
      "@/capabilities/brief-evaluation"
    );
    const evaluation = createBriefEvaluationCapability().evaluate(afterSummary.brief);
    assert.equal(
      evaluation.contradictions.some((conflict) => conflict.code === "color_clash"),
      false,
      `a color clash was raised from a palette the customer never expressed: ${JSON.stringify(evaluation.contradictions)}`,
    );
  });

  it("Goal 9: the generation prompt still draws a BLACK Jeep, without a global black palette", async () => {
    const conversation = await freshConversation();
    const started = await conversation.start();
    const projectId = started.project.id;

    const afterOpener = await conversation.handleUserMessage(projectId, OPENER);
    await driveToSummary(conversation, projectId, afterOpener);
    const approved = await conversation.submitDesignBriefDecision(projectId, "approve");

    const approvedVersion = approved.designBriefVersions.at(-1);
    assert.ok(approvedVersion);

    const { createPromptTranslationCapability } = await import(
      "@/capabilities/prompt-translation/prompt-translation-capability"
    );
    const { createInitialGenerationIntent } = await import(
      "@/capabilities/prompt-translation/generation-intent"
    );
    const request = createPromptTranslationCapability().translate(
      createInitialGenerationIntent(approvedVersion!.content),
    );

    // The subject keeps its color…
    assert.match(request.subject, /black/i);
    assert.match(request.subject, /jeep/i);
    assert.equal(request.productColor, "Black");
    // …and the palette stays the customer's to set.
    assert.deepEqual(request.colors, []);
  });

  it("Goal 7: an explicitly requested black artwork on a black shirt still clashes", async () => {
    // The bug was false palette inference, never the clash detector. A
    // customer who really does ask for black artwork must still be warned.
    const { createBriefEvaluationCapability } = await import(
      "@/capabilities/brief-evaluation"
    );
    const brief: TShirtDesignBrief = {
      id: "brief-1",
      projectId: "project-1",
      customerName: null,
      projectName: null,
      productSummary: "T-shirt",
      designDescription: "a solid black badge",
      exactText: null,
      shirtColor: "Black",
      printPlacement: null,
      intendedPrintWidthIn: null,
      requestedProductionOutput: null,
      preferredColors: ["Black"],
      designStyle: null,
      additionalInstructions: null,
      audience: null,
      purpose: null,
      exclusions: null,
      deferredSections: [],
      createdAt: "2026-08-15T00:00:00.000Z",
      updatedAt: "2026-08-15T00:00:00.000Z",
    };

    const evaluation = createBriefEvaluationCapability().evaluate(brief);
    const clash = evaluation.contradictions.find(
      (conflict) => conflict.code === "color_clash",
    );
    assert.ok(clash, "an explicitly requested black palette on a black shirt must still clash");
    assert.equal(clash!.severity, "blocking");
  });
});
