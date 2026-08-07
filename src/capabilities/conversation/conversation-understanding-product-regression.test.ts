import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { buildConversationWithFakeUnderstanding } from "@/test-support/build-conversation-with-fake-understanding";
import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";
import { whenMessageIs } from "@/test-support/fake-conversation-understanding-provider";
import type { ConversationUnderstandingResult } from "@/capabilities/conversation-understanding";

/**
 * Sprint 2L Phase 1A — live acceptance failure regression.
 *
 * The live failure: with a real semantic-understanding provider, the exact
 * opening message below resolved audience/purpose/required wording but
 * left Product unresolved, so the assistant re-asked "What product are we
 * printing on?" — a fact the customer had already stated ("team
 * t-shirts"). Root cause: the provider prompt gave detailed, worked
 * guidance for `requiredWording` but none for `product`, so a
 * conservative model omitted or under-confidenced an embedded product
 * mention. Fixed at the prompt layer (`openai-conversation-understanding-provider.ts`)
 * plus a field-specific grounding policy (`reconcile-understanding.ts`)
 * that accepts a canonicalized Product value ("T-shirt") grounded by a
 * recognized synonym in its evidence ("team t-shirts") rather than
 * requiring literal containment (which only ever applies to
 * `requiredWording`).
 *
 * These tests do not call a real provider (no network calls in automated
 * tests) — they drive the real `ConversationCapability` /
 * `IntentExtractionCapability` / `reconcile-understanding.ts` pipeline
 * with a scripted fixture representing exactly the well-formed result the
 * fixed prompt is now instructed to produce, proving the *pipeline* is
 * correct end to end once given that result.
 */
describe("Sprint 2L Phase 1A — live acceptance failure regression (Product resolution)", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-understanding-1a-"));
    process.chdir(tempDir);
  });

  after(async () => {
    await cleanupTempWorkspace(tempDir, previousCwd);
  });

  async function conversationWithFakeUnderstanding(
    ...args: Parameters<typeof buildConversationWithFakeUnderstanding>
  ) {
    const { resetCapabilityGraphForTests } = await import("@/capabilities/composition");
    const { resetProjectRepositoryForTests } = await import("@/lib/db");
    resetCapabilityGraphForTests();
    resetProjectRepositoryForTests();
    return buildConversationWithFakeUnderstanding(...args);
  }

  const BOWLING_OPENER =
    "I'm in a bowling league and our team is called My 3 Sons help me create a design for team t-shirts";

  function bowlingOpenerResult(): ConversationUnderstandingResult {
    return {
      proposedUpdates: [
        {
          section: "product",
          value: "T-shirt",
          confidence: "explicit",
          evidence: "team t-shirts",
          isCorrection: false,
        },
        {
          section: "requiredWording",
          value: "My 3 Sons",
          confidence: "explicit",
          evidence: "our team is called My 3 Sons",
          isCorrection: false,
        },
        {
          section: "audience",
          value: "Bowling team",
          confidence: "inferred",
          evidence: "I'm in a bowling league",
          isCorrection: false,
        },
        {
          section: "purpose",
          value: "Bowling league team apparel",
          confidence: "inferred",
          evidence: "I'm in a bowling league",
          isCorrection: false,
        },
      ],
      deferrals: [],
      ambiguities: [],
      customerIntent: "provide_info",
      answeredPendingSection: null,
    };
  }

  it("resolves product, required wording, audience, and purpose from the exact live opener — Product is never re-asked", async () => {
    const { conversation } = await conversationWithFakeUnderstanding([
      whenMessageIs(BOWLING_OPENER, bowlingOpenerResult()),
    ]);

    const started = await conversation.start();
    const projectId = started.project.id;
    const afterOpener = await conversation.handleUserMessage(projectId, BOWLING_OPENER);

    assert.equal(afterOpener.brief.productSummary, "T-shirt");
    assert.equal(afterOpener.brief.exactText, "My 3 Sons");
    assert.equal(afterOpener.brief.audience, "Bowling team");
    assert.match(afterOpener.brief.purpose ?? "", /bowling/i);

    const pending = afterOpener.conversation.interviewState.pendingSection;
    assert.notEqual(pending, "product");
    assert.notEqual(pending, "requiredWording");
    assert.notEqual(pending, "audience");

    const lastMessage = afterOpener.messages.at(-1);
    assert.equal(lastMessage?.metadata.act, "ask");
    assert.doesNotMatch(String(lastMessage?.content), /what product are we printing/i);

    // Acknowledgement must mention only fields that were actually applied,
    // never the generic "I've made those changes" that misled the
    // customer into thinking everything (including Product) was captured.
    assert.doesNotMatch(String(lastMessage?.content), /I've made those changes/i);
    assert.match(String(lastMessage?.content), /T-shirt/i);
    assert.match(String(lastMessage?.content), /My 3 Sons/i);
    assert.match(String(lastMessage?.content), /bowling team/i);
  });

  const domainCases: Array<{
    message: string;
    result: ConversationUnderstandingResult;
    expectProductSummary: string;
    expectWording?: string;
  }> = [
    {
      message: "We need staff hoodies for Rivera Plumbing.",
      result: {
        proposedUpdates: [
          { section: "product", value: "Hoodie", confidence: "explicit", evidence: "staff hoodies", isCorrection: false },
          { section: "audience", value: "Staff", confidence: "explicit", evidence: "staff hoodies", isCorrection: false },
          { section: "requiredWording", value: "Rivera Plumbing", confidence: "inferred", evidence: "for Rivera Plumbing", isCorrection: false },
        ],
        deferrals: [],
        ambiguities: [],
        customerIntent: "provide_info",
        answeredPendingSection: null,
      },
      expectProductSummary: "Hoodie",
      expectWording: "Rivera Plumbing",
    },
    {
      message: "Create school fun run tees for Lincoln Elementary.",
      result: {
        proposedUpdates: [
          { section: "product", value: "T-shirt", confidence: "explicit", evidence: "fun run tees", isCorrection: false },
          { section: "purpose", value: "School fun run", confidence: "explicit", evidence: "school fun run", isCorrection: false },
          { section: "audience", value: "Lincoln Elementary", confidence: "inferred", evidence: "for Lincoln Elementary", isCorrection: false },
        ],
        deferrals: [],
        ambiguities: [],
        customerIntent: "provide_info",
        answeredPendingSection: null,
      },
      expectProductSummary: "T-shirt",
    },
    {
      message: "Family reunion shirts for the Johnson Family Reunion 2026.",
      result: {
        proposedUpdates: [
          { section: "product", value: "T-shirt", confidence: "explicit", evidence: "reunion shirts", isCorrection: false },
          { section: "requiredWording", value: "Johnson Family Reunion 2026", confidence: "explicit", evidence: "the Johnson Family Reunion 2026", isCorrection: false },
          { section: "purpose", value: "Family reunion", confidence: "explicit", evidence: "Family reunion shirts", isCorrection: false },
        ],
        deferrals: [],
        ambiguities: [],
        customerIntent: "provide_info",
        answeredPendingSection: null,
      },
      expectProductSummary: "T-shirt",
      expectWording: "Johnson Family Reunion 2026",
    },
    {
      message: "Company polos for Tony's Pizza.",
      result: {
        proposedUpdates: [
          { section: "product", value: "Polo", confidence: "explicit", evidence: "Company polos", isCorrection: false },
          { section: "requiredWording", value: "Tony's Pizza", confidence: "inferred", evidence: "for Tony's Pizza", isCorrection: false },
        ],
        deferrals: [],
        ambiguities: [],
        customerIntent: "provide_info",
        answeredPendingSection: null,
      },
      expectProductSummary: "Polo",
      expectWording: "Tony's Pizza",
    },
  ];

  for (const { message, result, expectProductSummary, expectWording } of domainCases) {
    it(`resolves Product from a non-bowling message: "${message}"`, async () => {
      const { conversation } = await conversationWithFakeUnderstanding([
        whenMessageIs(message, result),
      ]);

      const started = await conversation.start();
      const projectId = started.project.id;
      const afterOpener = await conversation.handleUserMessage(projectId, message);

      assert.equal(afterOpener.brief.productSummary, expectProductSummary);
      assert.notEqual(afterOpener.conversation.interviewState.pendingSection, "product");
      if (expectWording) {
        assert.equal(afterOpener.brief.exactText, expectWording);
      }
    });
  }

  it("a rejected (ungrounded) Product proposal never appears in the acknowledgement, and Product is still asked about", async () => {
    const message = "Something fun for the crew, whatever you think.";
    const { conversation } = await conversationWithFakeUnderstanding([
      whenMessageIs(message, {
        proposedUpdates: [
          // Evidence has no relationship to "Hoodie" at all — must be
          // rejected by reconciliation's grounding check.
          {
            section: "product",
            value: "Hoodie",
            confidence: "explicit",
            evidence: "something fun for the crew",
            isCorrection: false,
          },
          {
            section: "audience",
            value: "The crew",
            confidence: "explicit",
            evidence: "for the crew",
            isCorrection: false,
          },
        ],
        deferrals: [],
        ambiguities: [],
        customerIntent: "provide_info",
        answeredPendingSection: null,
      }),
    ]);

    const started = await conversation.start();
    const projectId = started.project.id;
    const afterReply = await conversation.handleUserMessage(projectId, message);

    assert.equal(afterReply.brief.productSummary, null);
    assert.equal(afterReply.conversation.interviewState.pendingSection, "product");

    const lastMessage = afterReply.messages.at(-1);
    assert.doesNotMatch(String(lastMessage?.content), /hoodie/i);
  });

  it("provider failure still falls back to deterministic extraction, and the acknowledgement never overclaims", async () => {
    const { conversation } = await conversationWithFakeUnderstanding([], {
      failWith: new Error("simulated network failure"),
    });

    const started = await conversation.start();
    const projectId = started.project.id;
    const afterReply = await conversation.handleUserMessage(
      projectId,
      "A T-shirt for the school fair",
    );

    assert.equal(afterReply.brief.productSummary, "A T-shirt for the school fair");
    const lastMessage = afterReply.messages.at(-1);
    assert.doesNotMatch(
      String(lastMessage?.content),
      /openai|provider|json|parse|network|timeout|unavailable|failed/i,
    );
  });
});
