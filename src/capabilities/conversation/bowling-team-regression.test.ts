import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";
import type { ConversationCapability } from "@/capabilities/conversation";
import type { BriefSectionKey, DesignSummaryView } from "@/capabilities/shared/contracts";
import type { ProjectSnapshot } from "@/lib/domain/types";

/**
 * Sprint 2K Phase 2 — Workstream F.
 *
 * Permanent regression test for the live bowling-team conversation that
 * exposed the Sprint 2K Phase 1 extraction/validation/rendering defects.
 * Drives the same customer opener used throughout this sprint's manual
 * testing ("create a design for my bowling team name My 3 Sons") through
 * the real adaptive interview and asserts the resulting Design Brief
 * matches the expected shape, deterministically, with no LLM in the loop.
 *
 * This does not (and cannot, without a real image model) assert on
 * generated pixels. What it *does* prove end-to-end and deterministically:
 *   - the opening message alone yields clean, unabsorbed Audience and
 *     Required Wording (Workstream A)
 *   - "no" to an artwork-colors question never becomes a literal color
 *     (Workstream A/B)
 *   - the confirmed Design Summary contains exactly the fields the
 *     customer actually resolved — no corrupted/paragraph-shaped values
 *     (Workstream B)
 *   - the approved brief snapshot, translated through
 *     PromptTranslationCapability (the actual input to image generation),
 *     carries "My 3 Sons", the bowling/retro design description, and the
 *     product color through untouched and without invented wording
 *     (ties Workstream A/C forward into what the provider is actually
 *     asked to draw)
 */
describe("Regression — bowling team ('My 3 Sons') conversation (Workstream F)", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-bowling-regression-"));
    process.chdir(tempDir);
  });

  after(async () => {
    await cleanupTempWorkspace(tempDir, previousCwd);
  });

  async function freshConversation(): Promise<ConversationCapability> {
    const { resetCapabilityGraphForTests, getCapabilityGraph } = await import(
      "@/capabilities/composition"
    );
    resetCapabilityGraphForTests();
    return getCapabilityGraph().conversation;
  }

  /** Scenario-specific answers; anything else is explicitly deferred. */
  const ANSWERS: Partial<Record<BriefSectionKey, string>> = {
    product: "T-shirts",
    graphics: "A retro bowling logo inspired by an old sitcom",
    productColor: "Black",
    purpose: "Team apparel",
    printLocation: "Full back",
    colors: "no",
  };
  const DEFAULT_REPLY = "You choose.";
  const MAX_TURNS = 20;

  async function driveToSummary(
    conversation: ConversationCapability,
    projectId: string,
    snapshotAfterOpener: ProjectSnapshot,
  ): Promise<ProjectSnapshot> {
    let snapshot = snapshotAfterOpener;
    for (let turn = 0; turn < MAX_TURNS; turn += 1) {
      if (snapshot.conversation.phase === "awaiting_summary_confirmation") {
        return snapshot;
      }
      const pending = snapshot.conversation.interviewState.pendingSection as
        | BriefSectionKey
        | null;
      const reply = (pending && ANSWERS[pending]) || DEFAULT_REPLY;
      snapshot = await conversation.handleUserMessage(projectId, reply);
    }
    throw new Error(
      `Did not reach the Design Summary within ${MAX_TURNS} turns (stuck in ` +
        `"${snapshot.conversation.phase}", pending "${snapshot.conversation.interviewState.pendingSection}")`,
    );
  }

  it("the opening message alone yields clean audience + required wording (Workstream A)", async () => {
    const conversation = await freshConversation();
    const started = await conversation.start();
    const projectId = started.project.id;

    const afterOpener = await conversation.handleUserMessage(
      projectId,
      "create a design for my bowling team name My 3 Sons",
    );

    assert.equal(afterOpener.brief.audience, "bowling team");
    assert.equal(afterOpener.brief.exactText, "My 3 Sons");
    // No product word was said — must stay unresolved, not become the
    // whole opening sentence.
    assert.equal(afterOpener.brief.productSummary, null);
  });

  it("reaches an approvable Design Summary matching the expected brief, with 'no' resolving to designer-determined colors", async () => {
    const conversation = await freshConversation();
    const started = await conversation.start();
    const projectId = started.project.id;

    const afterOpener = await conversation.handleUserMessage(
      projectId,
      "create a design for my bowling team name My 3 Sons",
    );
    const afterSummary = await driveToSummary(conversation, projectId, afterOpener);

    assert.equal(afterSummary.conversation.phase, "awaiting_summary_confirmation");

    const lastMessage = afterSummary.messages.at(-1);
    assert.equal(lastMessage?.role, "assistant");
    const summary = lastMessage?.metadata.summary as DesignSummaryView | undefined;
    assert.ok(summary);

    // --- Expected Design Brief (Workstream F) ---------------------------
    assert.match(summary!.product ?? "", /t-?shirts?/i);
    assert.equal(afterSummary.brief.audience, "bowling team");
    assert.equal(afterSummary.brief.purpose, "Team apparel");
    assert.equal(summary!.requiredWording, "My 3 Sons");
    assert.match(summary!.graphics ?? "", /retro bowling logo/i);
    assert.equal(summary!.productColor, "Black");
    assert.match(summary!.printLocation ?? "", /full back/i);

    // "no" to artwork colors must never appear as a literal color — it
    // must resolve to the deferred "designer determined" state instead
    // (Workstream A/B), never show up in the regular field list, and
    // never leak the literal word "no" anywhere in the summary text.
    assert.equal(summary!.colors, undefined);
    const deferredDecisions = (lastMessage?.metadata.deferredDecisions ?? []) as Array<{
      section: string;
      label: string;
    }>;
    assert.ok(deferredDecisions.some((d) => d.section === "colors"));
    assert.deepEqual(afterSummary.brief.preferredColors, []);

    // No malformed/paragraph-shaped values anywhere in the confirmed brief
    // (Workstream B would have downgraded these back to "unknown" instead
    // of letting them reach the summary at all).
    for (const value of Object.values(summary!)) {
      if (typeof value !== "string") continue;
      assert.doesNotMatch(value, /\bno\b$/i, `field leaked a literal "no": "${value}"`);
    }
  });

  it("the approved brief translates into a generation request carrying the exact required wording and design intent through untouched (feeds Workstream E)", async () => {
    const conversation = await freshConversation();
    const started = await conversation.start();
    const projectId = started.project.id;

    const afterOpener = await conversation.handleUserMessage(
      projectId,
      "create a design for my bowling team name My 3 Sons",
    );
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
    const translation = createPromptTranslationCapability();
    const request = translation.translate(
      createInitialGenerationIntent(approvedVersion!.content),
    );

    assert.equal(request.requiredWording, "My 3 Sons");
    assert.match(request.subject, /bowling/i);
    assert.match(request.subject, /retro/i);
    assert.equal(request.productColor, "Black");
    assert.equal(request.printLocation, "full_back");
    // Colors were deferred, never a literal "no".
    assert.deepEqual(request.colors, []);
  });
});
