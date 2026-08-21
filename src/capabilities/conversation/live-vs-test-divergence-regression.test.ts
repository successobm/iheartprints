import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { buildConversationWithFakeUnderstanding } from "@/test-support/build-conversation-with-fake-understanding";
import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";
import { whenMessageIs } from "@/test-support/fake-conversation-understanding-provider";

/**
 * Sprint 2L Phase 1C — live-vs-test semantic divergence investigation.
 *
 * Root cause (see the Sprint 2L Phase 1C report for the full trace): the
 * live browser session that produced the corrupted transcript was running
 * with NO Conversation Understanding provider configured (the default,
 * `.env.local` never sets `CONVERSATION_UNDERSTANDING_PROVIDER`) —
 * exercising the deterministic-only fallback path for the entire
 * conversation, a path every previous Sprint 2L regression file left
 * essentially untested for this exact opener because they all inject a
 * scripted `ConversationUnderstandingProvider` that hands the pipeline
 * already-correct fields. Two independent, real bugs surfaced once that
 * path was actually exercised:
 *
 *   1. `extraction.ts`'s `ENTITY_NAME_PATTERNS` had no way to stop a
 *      capture group at a clause boundary in a punctuation-free run-on
 *      sentence, so "our team is called My 3 Sons help me create a
 *      design for team t-shirts" greedily captured everything after
 *      "called" into `exactText`. Fixed generally via
 *      `boundEntityCapture`/`CLAUSE_BOUNDARY_PATTERN` — see
 *      `intent-extraction-capability.test.ts`'s dedicated coverage.
 *   2. `naturalizeQuestion` (Sprint 2L Phase 1B) read the RAW
 *      `TShirtDesignBrief` field directly, bypassing `BriefEvaluation`'s
 *      quality gate — so even though the corrupted value correctly never
 *      reached the customer-facing Design Summary (quality-rejected,
 *      `resolution: "unknown"`), it still leaked into a naturalized
 *      question. Fixed by reading the already-quality-gated
 *      `DesignSummaryView` instead of the raw brief.
 *
 * This file deliberately covers BOTH the deterministic-only path (no
 * provider — proving the fixes hold even with nothing configured, exactly
 * the live browser's actual configuration) and the semantic-understanding
 * path (fake provider standing in for a real one — proving the two layers
 * still cooperate correctly). Per Sprint 2L Phase 1C Goal 5, these are
 * kept clearly distinguished: a passing test with the fake provider proves
 * pipeline correctness given good input, never that a real model produces
 * that input — see `openai-conversation-understanding-provider.test.ts`'s
 * provider-contract fixture test for the closest thing to that proof
 * without a live call, and the Phase 1C report for the actual live result.
 */
describe("Sprint 2L Phase 1C — live-vs-test semantic divergence regression", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-live-vs-test-"));
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

  const OPENER =
    "I'm in a bowling league and our team is called My 3 Sons help me create a design for team t-shirts";

  describe("deterministic-only path (no provider configured — the live browser's actual configuration)", () => {
    it("resolves Required Wording to exactly 'My 3 Sons' on the opener alone, and never leaks the greedy clause into any message", async () => {
      // No rules at all — every provider call (if any were even attempted)
      // returns the empty result, exactly like `NoneConversationUnderstandingProvider`.
      const { conversation } = await conversationWithFakeUnderstanding([]);

      const started = await conversation.start();
      const projectId = started.project.id;
      const afterOpener = await conversation.handleUserMessage(projectId, OPENER);

      assert.equal(afterOpener.brief.exactText, "My 3 Sons");

      // The specific live corruption: no ASSISTANT message may ever
      // contain the greedy run-on capture. (The customer's own message is
      // naturally excluded — echoing back the customer's own words as
      // their own chat bubble is normal and expected, not a leak.)
      for (const message of afterOpener.messages) {
        if (message.role !== "assistant") continue;
        assert.doesNotMatch(
          message.content,
          /My 3 Sons help me create/i,
          `corrupted clause leaked into an assistant message: "${message.content}"`,
        );
      }
    });

    it("Product genuinely cannot be cleanly parsed from this exact punctuation-free sentence without semantic help — the raw field may still hold the whole sentence (a pre-existing, quality-netted deterministic limitation), but it is never treated as resolved and never leaks into customer-facing text", async () => {
      const { conversation } = await conversationWithFakeUnderstanding([]);
      const started = await conversation.start();
      const projectId = started.project.id;
      const afterOpener = await conversation.handleUserMessage(projectId, OPENER);

      // Documented limitation (Sprint 2L Phase 1C report): deterministic
      // extraction's Sprint-1-parity "single clause → keep the whole
      // reply" rule means the raw `productSummary` field can still hold
      // the entire punctuation-free sentence — exactly like `exactText`
      // could before this phase's fix, except here `checkProductQuality`
      // (word-count ceiling) is the safety net rather than a clause
      // boundary. The important guarantees, both upheld here: (a) Brief
      // Evaluation never treats it as resolved, so the interview
      // correctly asks about Product again rather than silently
      // accepting garbage; (b) nothing customer-facing ever displays it
      // (proven by the next test) — the raw field is safety-netted, not
      // corrected, and that safety net is what matters.
      assert.equal(afterOpener.messages.at(-1)?.metadata.act, "ask");
      assert.equal(afterOpener.messages.at(-1)?.metadata.section, "product");
    });

    it("never renders a naturalized question using a quality-rejected raw field value", async () => {
      const { conversation } = await conversationWithFakeUnderstanding([]);
      const started = await conversation.start();
      const projectId = started.project.id;
      const afterOpener = await conversation.handleUserMessage(projectId, OPENER);

      // Whatever question comes next, it must never quote the corrupted
      // raw sentence — `naturalizeQuestion` only ever reads the
      // already-quality-gated `DesignSummaryView`, never the raw brief.
      assert.doesNotMatch(String(afterOpener.messages.at(-1)?.content), /help me create/i);
    });
  });

  describe("semantic-understanding-active path (fake provider standing in for a real one)", () => {
    function bowlingOpenerResult() {
      return {
        proposedUpdates: [
          { section: "product" as const, value: "T-shirt", confidence: "explicit" as const, evidence: "team t-shirts", isCorrection: false },
          { section: "requiredWording" as const, value: "My 3 Sons", confidence: "explicit" as const, evidence: "our team is called My 3 Sons", isCorrection: false },
          { section: "audience" as const, value: "Bowling team", confidence: "inferred" as const, evidence: "I'm in a bowling league", isCorrection: false },
          { section: "purpose" as const, value: "Bowling league team apparel", confidence: "inferred" as const, evidence: "I'm in a bowling league", isCorrection: false },
        ],
        deferrals: [],
        ambiguities: [],
        customerIntent: "provide_info" as const,
        answeredPendingSection: null,
      };
    }

    it("resolves product/requiredWording/audience/purpose from the opener; Product is never re-asked; purpose/audience/colors are never asked at all", async () => {
      const { conversation } = await conversationWithFakeUnderstanding([
        whenMessageIs(OPENER, bowlingOpenerResult()),
      ]);
      const started = await conversation.start();
      const projectId = started.project.id;
      const afterOpener = await conversation.handleUserMessage(projectId, OPENER);

      assert.equal(afterOpener.brief.productSummary, "T-shirt");
      assert.equal(afterOpener.brief.exactText, "My 3 Sons");
      assert.equal(afterOpener.brief.audience, "Bowling team");

      const pending = afterOpener.conversation.interviewState.pendingSection;
      assert.notEqual(pending, "product");
      assert.notEqual(pending, "requiredWording");
      assert.notEqual(pending, "purpose");
      assert.notEqual(pending, "audience");
      assert.notEqual(pending, "colors");

      assert.doesNotMatch(String(afterOpener.messages.at(-1)?.content), /what product are we printing/i);
    });

    it("the stale generic acknowledgement ('Got it — I've made those changes.') never appears on the semantic-success path", async () => {
      const { conversation } = await conversationWithFakeUnderstanding([
        whenMessageIs(OPENER, bowlingOpenerResult()),
      ]);
      const started = await conversation.start();
      const projectId = started.project.id;
      const afterOpener = await conversation.handleUserMessage(projectId, OPENER);

      for (const message of afterOpener.messages) {
        assert.doesNotMatch(message.content, /I've made those changes/i);
      }
    });

    it("does not re-ask Required Wording once the opener establishes it, and the next question is a genuinely unresolved design question — never containing the raw opener text", async () => {
      const { conversation } = await conversationWithFakeUnderstanding([
        whenMessageIs(OPENER, bowlingOpenerResult()),
      ]);
      const started = await conversation.start();
      const projectId = started.project.id;
      const afterOpener = await conversation.handleUserMessage(projectId, OPENER);

      assert.equal(afterOpener.messages.at(-1)?.metadata.section, "graphics");
      assert.doesNotMatch(String(afterOpener.messages.at(-1)?.content), /help me create a design for team t-shirts/i);
    });
  });

  describe("approval copy (Phase 8: no phantom 'Continue' action)", () => {
    it("the Design Summary's customer-facing prose never mentions a third 'continue' action, and matches the two actual buttons (Approve, Edit)", async () => {
      const { createDesignSummaryCapability } = await import(
        "@/capabilities/design-summary"
      );
      const { createBriefEvaluationCapability } = await import(
        "@/capabilities/brief-evaluation"
      );
      const designSummary = createDesignSummaryCapability();
      const briefEvaluation = createBriefEvaluationCapability();

      const brief = {
        id: "b1",
        projectId: "p1",
        customerName: null,
        projectName: null,
        productSummary: "T-shirt",
        designDescription: "A friendly logo",
        exactText: "Camp Wildwood",
        shirtColor: "Navy",
        printPlacement: "full_front" as const,
        intendedPrintWidthIn: null,
        garmentSizeClass: null,
        productionSizeConfirmedAt: null,
        productionSizeConfirmedWidthIn: null,
        productionSizeConfirmedMaxHeightIn: null,
        requestedProductionOutput: null,
        preferredColors: [],
        designStyle: null,
        additionalInstructions: null,
        audience: null,
        purpose: null,
        exclusions: null,
        deferredSections: [],
        createdAt: "2026-08-04T00:00:00.000Z",
        updatedAt: "2026-08-04T00:00:00.000Z",
      };

      const evaluation = briefEvaluation.evaluate(brief);
      const summary = designSummary.createSummary(brief, evaluation);
      const content = designSummary.formatForCustomer(summary, []);

      assert.doesNotMatch(content, /continue/i);
      assert.match(content, /approve/i);
      assert.match(content, /edit/i);
    });
  });

  describe("fresh-project state integrity (Phase 9)", () => {
    it("two consecutive fresh conversations never share pending section, brief fields, or messages", async () => {
      const { conversation } = await conversationWithFakeUnderstanding([
        whenMessageIs("A T-shirt for the school fair", {
          proposedUpdates: [],
          deferrals: [],
          ambiguities: [],
          customerIntent: "provide_info",
          answeredPendingSection: null,
        }),
      ]);

      const projectA = await conversation.start();
      const afterA = await conversation.handleUserMessage(
        projectA.project.id,
        "A T-shirt for the school fair",
      );
      // Canonical product value (Live Acceptance Corrective Pass), not the raw sentence.
      assert.equal(afterA.brief.productSummary, "T-shirt");

      // A second, genuinely fresh project — never touched by the first
      // conversation's turn.
      const projectB = await conversation.start();
      assert.notEqual(projectB.project.id, projectA.project.id);
      assert.equal(projectB.brief.productSummary, null);
      assert.equal(projectB.brief.exactText, null);
      assert.equal(projectB.conversation.interviewState.pendingSection, "product");
      assert.equal(projectB.conversation.interviewState.askCounts.product, 1);
      assert.deepEqual(projectB.conversation.interviewState.dismissedAdvisories, []);
      assert.equal(projectB.conversation.interviewState.lastRevision, null);
      // Exactly one message — the opening greeting — never anything
      // inherited from project A's conversation.
      assert.equal(projectB.messages.length, 1);
      assert.equal(projectB.messages[0]?.metadata.section, "product");
    });
  });
});
