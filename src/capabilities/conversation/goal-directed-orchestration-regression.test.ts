import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { buildConversationWithFakeUnderstanding } from "@/test-support/build-conversation-with-fake-understanding";
import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";
import { whenMessageIs } from "@/test-support/fake-conversation-understanding-provider";
import type { ConversationCapability } from "@/capabilities/conversation";
import type { ConversationUnderstandingResult } from "@/capabilities/conversation-understanding";

/**
 * Sprint 2L Phase 1B — goal-directed conversation orchestration regression
 * scenarios A–J, plus a question-budget test and a summary-synthesis
 * quality test.
 *
 * These scenarios prove the *orchestration* change (Generation Readiness
 * ≠ Brief Completeness; purpose/audience/style/artwork-colors are
 * optional-tier and never proactively asked — see
 * `interview-coverage-policy.ts`) end to end through the real
 * `ConversationCapability`, with a scripted `ConversationUnderstandingProvider`
 * standing in for a real LLM (no network calls). Every fixture plays the
 * role of a well-formed, already-parsed provider response — proving the
 * pipeline behaves correctly given good input, exactly like the Sprint 2L
 * Phase 1 / 1A regression suites.
 */
describe("Sprint 2L Phase 1B — goal-directed orchestration regression scenarios", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-goal-directed-"));
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

  /**
   * Collects every act section the assistant asked/clarified about across
   * the transcript, EXCLUDING the very first greeting ("What are we
   * printing today?", asked before the customer has said anything at
   * all) — asking Product once, with nothing yet known, is the correct
   * opening move, not a re-ask; what these tests actually guard against
   * is asking about the same (or a now-unnecessary) section again *after*
   * the customer has already established it.
   */
  function askedSections(snapshot: Awaited<ReturnType<ConversationCapability["start"]>>): string[] {
    return snapshot.messages
      .slice(1)
      .filter((m) => m.role === "assistant" && (m.metadata.act === "ask" || m.metadata.act === "clarify"))
      .map((m) => String(m.metadata.section));
  }

  it("Scenario A — My 3 Sons: reaches Design Summary in exactly four customer turns, never separately asking purpose, audience, or artwork colors, never re-asking product/wording/audience", async () => {
    const opener =
      "I'm in a bowling league and our team is called My 3 Sons help me create a design for team t-shirts";
    const designTurn =
      "this is a take on the old sitcom my 3 sons, so i want to create a team logo but bowling themed, with that retro vibe";

    const { conversation } = await conversationWithFakeUnderstanding([
      whenMessageIs(opener, {
        proposedUpdates: [
          { section: "product", value: "T-shirt", confidence: "explicit", evidence: "team t-shirts", isCorrection: false },
          { section: "requiredWording", value: "My 3 Sons", confidence: "explicit", evidence: "our team is called My 3 Sons", isCorrection: false },
          { section: "audience", value: "Bowling team", confidence: "inferred", evidence: "I'm in a bowling league", isCorrection: false },
          { section: "purpose", value: "Bowling league team apparel", confidence: "inferred", evidence: "I'm in a bowling league", isCorrection: false },
        ],
        deferrals: [],
        ambiguities: [],
        customerIntent: "provide_info",
        answeredPendingSection: null,
      }),
      whenMessageIs(designTurn, {
        proposedUpdates: [
          {
            section: "graphics",
            value: "Retro bowling team logo inspired by a classic sitcom-era aesthetic",
            confidence: "explicit",
            evidence: "team logo but bowling themed, with that retro vibe",
            isCorrection: false,
          },
          {
            section: "style",
            value: "Retro / mid-century",
            confidence: "explicit",
            evidence: "that retro vibe",
            isCorrection: false,
          },
        ],
        deferrals: [],
        ambiguities: [],
        customerIntent: "provide_info",
        answeredPendingSection: "graphics",
      }),
    ]);

    const started = await conversation.start();
    const projectId = started.project.id;

    const t1 = await conversation.handleUserMessage(projectId, opener);
    assert.equal(t1.brief.productSummary, "T-shirt");
    assert.equal(t1.brief.exactText, "My 3 Sons");
    assert.equal(t1.brief.audience, "Bowling team");
    assert.equal(t1.conversation.interviewState.pendingSection, "graphics");

    const t2 = await conversation.handleUserMessage(projectId, designTurn);
    assert.match(t2.brief.designDescription ?? "", /retro bowling team logo/i);
    assert.match(t2.brief.designStyle ?? "", /retro/i);
    // productColor is the only required section left.
    assert.equal(t2.conversation.interviewState.pendingSection, "productColor");

    const t3 = await conversation.handleUserMessage(projectId, "black");
    assert.equal(t3.brief.shirtColor, "Black");
    assert.equal(t3.conversation.interviewState.pendingSection, "printLocation");

    const t4 = await conversation.handleUserMessage(projectId, "full back");
    assert.equal(t4.brief.printPlacement, "full_back");
    assert.equal(t4.conversation.phase, "awaiting_summary_confirmation");

    // Question budget: purpose/audience/colors were never asked at all —
    // they were resolved (or left designer-determined) without a
    // dedicated question, and product/requiredWording/audience were never
    // re-asked after turn 1.
    const asked = askedSections(t4);
    for (const forbidden of ["purpose", "audience", "colors", "product", "requiredWording"]) {
      assert.ok(!asked.includes(forbidden), `should never have asked about "${forbidden}"; asked: ${asked.join(", ")}`);
    }
    assert.deepEqual(asked, ["graphics", "productColor", "printLocation"]);
  });

  it("Scenario B — a complete first message reaches the Design Summary immediately with no purpose/audience ever established", async () => {
    const opener =
      "I need a retro full-back design for black T-shirts for our bowling team My 3 Sons. Use bowling pins and a mid-century look.";

    const { conversation } = await conversationWithFakeUnderstanding([
      whenMessageIs(opener, {
        proposedUpdates: [
          { section: "product", value: "T-shirt", confidence: "explicit", evidence: "black T-shirts", isCorrection: false },
          { section: "productColor", value: "Black", confidence: "explicit", evidence: "black T-shirts", isCorrection: false },
          { section: "printLocation", value: "full back", confidence: "explicit", evidence: "full-back design", isCorrection: false },
          { section: "requiredWording", value: "My 3 Sons", confidence: "explicit", evidence: "our bowling team My 3 Sons", isCorrection: false },
          { section: "graphics", value: "Bowling pins, mid-century look", confidence: "explicit", evidence: "Use bowling pins and a mid-century look", isCorrection: false },
        ],
        deferrals: [],
        ambiguities: [],
        customerIntent: "provide_info",
        answeredPendingSection: null,
      }),
    ]);

    const started = await conversation.start();
    const projectId = started.project.id;
    const afterOpener = await conversation.handleUserMessage(projectId, opener);

    // Ready immediately — purpose/audience/style/colors were never
    // required to reach this state (Goal 3: Brief Completeness ≠
    // Generation Readiness). The understanding fixture deliberately
    // proposes neither; readiness does not depend on whether the
    // deterministic safety net happens to pick up a purpose/audience
    // fragment from the same text — only on the blocking fields + print
    // location being resolved.
    assert.equal(afterOpener.conversation.phase, "awaiting_summary_confirmation");
    assert.equal(afterOpener.brief.productSummary, "T-shirt");
    assert.equal(afterOpener.brief.shirtColor, "Black");
    assert.equal(afterOpener.brief.printPlacement, "full_back");
    assert.equal(afterOpener.brief.exactText, "My 3 Sons");
  });

  it("Scenario C — a genuinely incomplete message still asks about Product (a real blocking gap, not a questionnaire artifact)", async () => {
    const opener = "I need something cool for our bowling league.";

    const { conversation } = await conversationWithFakeUnderstanding([
      whenMessageIs(opener, {
        proposedUpdates: [
          { section: "audience", value: "Bowling league", confidence: "inferred", evidence: "our bowling league", isCorrection: false },
        ],
        deferrals: [],
        ambiguities: [{ section: "product", note: "No garment/product was named." }],
        customerIntent: "provide_info",
        answeredPendingSection: null,
      }),
    ]);

    const started = await conversation.start();
    const projectId = started.project.id;
    const afterOpener = await conversation.handleUserMessage(projectId, opener);

    assert.equal(afterOpener.brief.productSummary, null);
    assert.equal(afterOpener.messages.at(-1)?.metadata.act, "ask");
    assert.equal(afterOpener.messages.at(-1)?.metadata.section, "product");
  });

  it("Scenario D — an ambiguous name is never assumed to be required wording (Goal 6)", async () => {
    const opener = "Make something cool for My 3 Sons.";

    const { conversation } = await conversationWithFakeUnderstanding([
      whenMessageIs(opener, {
        proposedUpdates: [],
        deferrals: [],
        ambiguities: [
          { section: "requiredWording", note: "Unclear whether 'My 3 Sons' must appear as printed text." },
        ],
        customerIntent: "provide_info",
        answeredPendingSection: null,
      }),
    ]);

    const started = await conversation.start();
    const projectId = started.project.id;
    const afterOpener = await conversation.handleUserMessage(projectId, opener);

    assert.equal(afterOpener.brief.exactText, null);
  });

  it("Scenario E — business shirts: reaches the Design Summary from one message without asking audience/purpose/artwork colors", async () => {
    const opener =
      "We need black staff shirts for Rivera Plumbing. Vintage badge logo on the back.";

    const { conversation } = await conversationWithFakeUnderstanding([
      whenMessageIs(opener, {
        proposedUpdates: [
          { section: "product", value: "T-shirt", confidence: "explicit", evidence: "staff shirts", isCorrection: false },
          { section: "productColor", value: "Black", confidence: "explicit", evidence: "black staff shirts", isCorrection: false },
          { section: "printLocation", value: "full back", confidence: "explicit", evidence: "logo on the back", isCorrection: false },
          { section: "graphics", value: "Vintage badge logo", confidence: "explicit", evidence: "Vintage badge logo", isCorrection: false },
          { section: "style", value: "Vintage", confidence: "explicit", evidence: "Vintage badge logo", isCorrection: false },
          { section: "requiredWording", value: "Rivera Plumbing", confidence: "inferred", evidence: "for Rivera Plumbing", isCorrection: false },
          { section: "audience", value: "Staff", confidence: "explicit", evidence: "staff shirts", isCorrection: false },
        ],
        deferrals: [],
        ambiguities: [],
        customerIntent: "provide_info",
        answeredPendingSection: null,
      }),
    ]);

    const started = await conversation.start();
    const projectId = started.project.id;
    const afterOpener = await conversation.handleUserMessage(projectId, opener);

    assert.equal(afterOpener.conversation.phase, "awaiting_summary_confirmation");
    assert.equal(askedSections(afterOpener).length, 0);
  });

  it("Scenario F — family reunion: purpose/audience are never asked, but a genuinely unresolved print location still is", async () => {
    const opener =
      "Family reunion shirts for Johnson Family Reunion 2026. Outdoors/camping theme, navy shirts.";

    const { conversation } = await conversationWithFakeUnderstanding([
      whenMessageIs(opener, {
        proposedUpdates: [
          { section: "product", value: "T-shirt", confidence: "explicit", evidence: "reunion shirts", isCorrection: false },
          { section: "productColor", value: "Navy", confidence: "explicit", evidence: "navy shirts", isCorrection: false },
          { section: "requiredWording", value: "Johnson Family Reunion 2026", confidence: "explicit", evidence: "Johnson Family Reunion 2026", isCorrection: false },
          { section: "graphics", value: "Outdoors and camping theme", confidence: "explicit", evidence: "Outdoors/camping theme", isCorrection: false },
          { section: "purpose", value: "Family reunion", confidence: "explicit", evidence: "Family reunion shirts", isCorrection: false },
        ],
        deferrals: [],
        ambiguities: [],
        customerIntent: "provide_info",
        answeredPendingSection: null,
      }),
    ]);

    const started = await conversation.start();
    const projectId = started.project.id;
    const afterOpener = await conversation.handleUserMessage(projectId, opener);

    assert.equal(afterOpener.brief.purpose, "Family reunion");
    assert.equal(afterOpener.brief.audience, null); // never established, never blocked anything
    // printLocation genuinely was never mentioned — a real, materially
    // important gap, so it's the one thing still asked about.
    assert.equal(afterOpener.messages.at(-1)?.metadata.act, "ask");
    assert.equal(afterOpener.messages.at(-1)?.metadata.section, "printLocation");
    assert.ok(!askedSections(afterOpener).includes("purpose"));
    assert.ok(!askedSections(afterOpener).includes("audience"));
  });

  it("Scenario G — school event: audience/purpose are never asked when the rest of the message makes them unnecessary", async () => {
    const opener =
      "Create tees for Lincoln Elementary's fun run. Bright energetic design with a running shoe.";

    const { conversation } = await conversationWithFakeUnderstanding([
      whenMessageIs(opener, {
        proposedUpdates: [
          { section: "product", value: "T-shirt", confidence: "explicit", evidence: "tees", isCorrection: false },
          { section: "graphics", value: "Running shoe, bright and energetic", confidence: "explicit", evidence: "Bright energetic design with a running shoe", isCorrection: false },
          { section: "purpose", value: "School fun run", confidence: "explicit", evidence: "Lincoln Elementary's fun run", isCorrection: false },
          { section: "audience", value: "Lincoln Elementary", confidence: "inferred", evidence: "Lincoln Elementary's fun run", isCorrection: false },
        ],
        deferrals: [],
        ambiguities: [],
        customerIntent: "provide_info",
        answeredPendingSection: null,
      }),
    ]);

    const started = await conversation.start();
    const projectId = started.project.id;
    const afterOpener = await conversation.handleUserMessage(projectId, opener);

    // requiredWording and productColor genuinely remain unknown — real
    // gaps, not questionnaire artifacts — so the next question addresses
    // one of those, never audience/purpose (already resolved) or colors
    // (optional, never asked).
    const nextSection = afterOpener.messages.at(-1)?.metadata.section;
    assert.ok(["requiredWording", "productColor"].includes(String(nextSection)), String(nextSection));
    assert.ok(!askedSections(afterOpener).includes("audience"));
    assert.ok(!askedSections(afterOpener).includes("purpose"));
    assert.ok(!askedSections(afterOpener).includes("colors"));
  });

  it("Scenario H — designer discretion: an unprompted 'whatever you think looks best' defers artwork colors and it is never asked again", async () => {
    const { conversation } = await conversationWithFakeUnderstanding([
      whenMessageIs("Use whatever colors you think look best.", {
        proposedUpdates: [],
        deferrals: [{ section: "colors", evidence: "whatever colors you think look best" }],
        ambiguities: [],
        customerIntent: "defer",
        answeredPendingSection: null,
      }),
    ]);

    const started = await conversation.start();
    const projectId = started.project.id;
    await conversation.handleUserMessage(projectId, "T-shirt");
    await conversation.handleUserMessage(projectId, "A friendly logo");
    await conversation.handleUserMessage(projectId, "Camp Wildwood");
    await conversation.handleUserMessage(projectId, "Navy");
    const afterDefer = await conversation.handleUserMessage(
      projectId,
      "Use whatever colors you think look best.",
    );

    assert.ok(afterDefer.brief.deferredSections.includes("colors"));
    assert.deepEqual(afterDefer.brief.preferredColors, []);
    assert.ok(!askedSections(afterDefer).includes("colors"));
  });

  it("Scenario I — an explicit correction updates Product Color without reopening already-resolved fields", async () => {
    const { conversation } = await conversationWithFakeUnderstanding([
      whenMessageIs("Actually make the shirts navy.", {
        proposedUpdates: [
          { section: "productColor", value: "Navy", confidence: "explicit", evidence: "make the shirts navy", isCorrection: true },
        ],
        deferrals: [],
        ambiguities: [],
        customerIntent: "correct",
        answeredPendingSection: null,
      }),
    ]);

    const started = await conversation.start();
    const projectId = started.project.id;
    await conversation.handleUserMessage(projectId, "T-shirt");
    await conversation.handleUserMessage(projectId, "A friendly logo");
    await conversation.handleUserMessage(projectId, "Camp Wildwood");
    const beforeCorrection = await conversation.handleUserMessage(projectId, "Black");
    assert.equal(beforeCorrection.brief.shirtColor, "Black");

    const afterCorrection = await conversation.handleUserMessage(
      projectId,
      "Actually make the shirts navy.",
    );

    assert.equal(afterCorrection.brief.shirtColor, "Navy");
    assert.equal(afterCorrection.brief.productSummary, "T-shirt");
    assert.equal(afterCorrection.brief.designDescription, "A friendly logo");
    assert.equal(afterCorrection.brief.exactText, "Camp Wildwood");
  });

  it("Scenario J — a provider failure still works via the deterministic fallback, no crash, no provider terminology", async () => {
    const { conversation } = await conversationWithFakeUnderstanding([], {
      failWith: new Error("simulated provider outage"),
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

  it("Summary quality — Scenario A's Design Summary reads as synthesized design language, never raw fragments", async () => {
    const opener =
      "I'm in a bowling league and our team is called My 3 Sons help me create a design for team t-shirts";
    const designTurn =
      "this is a take on the old sitcom my 3 sons, so i want to create a team logo but bowling themed, with that retro vibe";

    const understandingByMessage: Record<string, ConversationUnderstandingResult> = {
      [opener]: {
        proposedUpdates: [
          { section: "product", value: "T-shirt", confidence: "explicit", evidence: "team t-shirts", isCorrection: false },
          { section: "requiredWording", value: "My 3 Sons", confidence: "explicit", evidence: "our team is called My 3 Sons", isCorrection: false },
          { section: "audience", value: "Bowling team", confidence: "inferred", evidence: "I'm in a bowling league", isCorrection: false },
          { section: "purpose", value: "Bowling league team apparel", confidence: "inferred", evidence: "I'm in a bowling league", isCorrection: false },
        ],
        deferrals: [],
        ambiguities: [],
        customerIntent: "provide_info",
        answeredPendingSection: null,
      },
      [designTurn]: {
        proposedUpdates: [
          {
            section: "graphics",
            value: "Retro bowling team logo inspired by a classic sitcom-era aesthetic",
            confidence: "explicit",
            evidence: "team logo but bowling themed, with that retro vibe",
            isCorrection: false,
          },
          { section: "style", value: "Retro / mid-century", confidence: "explicit", evidence: "that retro vibe", isCorrection: false },
        ],
        deferrals: [],
        ambiguities: [],
        customerIntent: "provide_info",
        answeredPendingSection: "graphics",
      },
    };

    const { conversation } = await conversationWithFakeUnderstanding(
      Object.entries(understandingByMessage).map(([message, result]) => whenMessageIs(message, result)),
    );

    const started = await conversation.start();
    const projectId = started.project.id;
    await conversation.handleUserMessage(projectId, opener);
    await conversation.handleUserMessage(projectId, designTurn);
    await conversation.handleUserMessage(projectId, "Black");
    const afterSummary = await conversation.handleUserMessage(projectId, "Full back");

    assert.equal(afterSummary.conversation.phase, "awaiting_summary_confirmation");
    const summary = afterSummary.messages.at(-1)?.metadata.summary as
      | Record<string, unknown>
      | undefined;
    assert.ok(summary);

    assert.equal(summary!.audience, "Bowling team");
    assert.equal(summary!.purpose, "Bowling league team apparel");
    assert.match(String(summary!.graphics), /retro bowling team logo/i);
    assert.match(String(summary!.style), /retro/i);
    assert.equal(summary!.requiredWording, "My 3 Sons");

    // Never the raw, low-quality fragments a terse direct answer to a
    // separately-asked question would have produced.
    assert.notEqual(summary!.audience, "my team");
    assert.notEqual(summary!.purpose, "bowling league");
    assert.notEqual(summary!.graphics, "that retro vibe");
  });
});
