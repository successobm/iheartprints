import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { buildConversationWithFakeUnderstanding } from "@/test-support/build-conversation-with-fake-understanding";
import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";
import { whenMessageIs } from "@/test-support/fake-conversation-understanding-provider";
import type { ConversationCapability } from "@/capabilities/conversation";
import type { BriefSectionKey } from "@/capabilities/shared/contracts";
import type { ProjectSnapshot } from "@/lib/domain/types";

/**
 * Sprint 2L Phase 1 — end-to-end regression scenarios A–J from the sprint
 * brief, driven through the real `ConversationCapability` with a scripted
 * `ConversationUnderstandingProvider` standing in for a real LLM (no
 * network calls in automated tests). Every fixture below plays the role a
 * real provider's *parsed, already-JSON* response would — the scenario is
 * proven by what the pipeline does with that structured input, not by any
 * actual language understanding happening inside the test.
 */
describe("Sprint 2L Phase 1 — Conversation Understanding regression scenarios", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-understanding-"));
    process.chdir(tempDir);
  });

  after(async () => {
    await cleanupTempWorkspace(tempDir, previousCwd);
  });

  /** Builds a full ConversationCapability from real peer capabilities, swapping in a scripted understanding provider — everything else is the genuine production pipeline. */
  async function conversationWithFakeUnderstanding(
    ...args: Parameters<typeof buildConversationWithFakeUnderstanding>
  ) {
    const { resetCapabilityGraphForTests } = await import("@/capabilities/composition");
    const { resetProjectRepositoryForTests } = await import("@/lib/db");
    resetCapabilityGraphForTests();
    resetProjectRepositoryForTests();
    return buildConversationWithFakeUnderstanding(...args);
  }

  /** Drives turns using `answers` keyed by pending section (falling back to a safe deferral) until `pendingSection === target` or the phase leaves interviewing. */
  async function driveUntilPending(
    conversation: ConversationCapability,
    projectId: string,
    start: ProjectSnapshot,
    target: BriefSectionKey,
    answers: Partial<Record<BriefSectionKey, string>>,
  ): Promise<ProjectSnapshot> {
    let snapshot = start;
    for (let turn = 0; turn < 20; turn += 1) {
      const pending = snapshot.conversation.interviewState.pendingSection as
        | BriefSectionKey
        | null;
      if (pending === target) return snapshot;
      if (snapshot.conversation.phase !== "interviewing") return snapshot;
      const reply = (pending && answers[pending]) || "You choose.";
      snapshot = await conversation.handleUserMessage(projectId, reply);
    }
    throw new Error(
      `Never reached pending section "${target}" (stuck at "${snapshot.conversation.interviewState.pendingSection}")`,
    );
  }

  async function driveToSummary(
    conversation: ConversationCapability,
    projectId: string,
    start: ProjectSnapshot,
    answers: Partial<Record<BriefSectionKey, string>>,
  ): Promise<ProjectSnapshot> {
    let snapshot = start;
    for (let turn = 0; turn < 20; turn += 1) {
      if (snapshot.conversation.phase === "awaiting_summary_confirmation") return snapshot;
      const pending = snapshot.conversation.interviewState.pendingSection as
        | BriefSectionKey
        | null;
      const reply = (pending && answers[pending]) || "You choose.";
      snapshot = await conversation.handleUserMessage(projectId, reply);
    }
    throw new Error(
      `Did not reach the Design Summary (stuck in "${snapshot.conversation.phase}", pending ` +
        `"${snapshot.conversation.interviewState.pendingSection}")`,
    );
  }

  it("Scenario A — bowling team opener resolves product, required wording, audience, and purpose from one message; none are re-asked", async () => {
    const opener =
      "I'm in a bowling league and our team is called My 3 Sons help me create a design for team t-shirts";

    const { conversation } = await conversationWithFakeUnderstanding([
      whenMessageIs(opener, {
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
      }),
    ]);

    const started = await conversation.start();
    const projectId = started.project.id;
    const afterOpener = await conversation.handleUserMessage(projectId, opener);

    assert.equal(afterOpener.brief.productSummary, "T-shirt");
    assert.equal(afterOpener.brief.exactText, "My 3 Sons");
    assert.equal(afterOpener.brief.audience, "Bowling team");
    assert.equal(afterOpener.brief.purpose, "Bowling league team apparel");

    // The next question must be about something still genuinely unknown
    // (graphics/productColor/etc.) — never product, wording, or audience
    // again.
    const pending = afterOpener.conversation.interviewState.pendingSection;
    assert.ok(pending);
    assert.ok(!["product", "requiredWording", "audience"].includes(pending as string));

    // Drive the rest of the way and confirm the resolved fields survive
    // untouched all the way to the Design Summary.
    const afterSummary = await driveToSummary(conversation, projectId, afterOpener, {
      graphics: "A retro bowling design",
      productColor: "Black",
      printLocation: "Full back",
    });
    assert.equal(afterSummary.conversation.phase, "awaiting_summary_confirmation");
    assert.equal(afterSummary.brief.productSummary, "T-shirt");
    assert.equal(afterSummary.brief.exactText, "My 3 Sons");
    assert.equal(afterSummary.brief.audience, "Bowling team");
  });

  it("Scenario B — a complete first message goes straight to the Design Summary", async () => {
    const opener =
      "I need a retro full-back design for black T-shirts for our bowling team My 3 Sons. Use bowling pins and a mid-century look. You choose the artwork colors.";

    const { conversation } = await conversationWithFakeUnderstanding([
      whenMessageIs(opener, {
        proposedUpdates: [
          { section: "product", value: "T-shirt", confidence: "explicit", evidence: "black T-shirts", isCorrection: false },
          { section: "productColor", value: "Black", confidence: "explicit", evidence: "black T-shirts", isCorrection: false },
          { section: "printLocation", value: "full back", confidence: "explicit", evidence: "full-back design", isCorrection: false },
          { section: "requiredWording", value: "My 3 Sons", confidence: "explicit", evidence: "our bowling team My 3 Sons", isCorrection: false },
          { section: "audience", value: "Bowling team", confidence: "explicit", evidence: "our bowling team", isCorrection: false },
          { section: "purpose", value: "Bowling team apparel", confidence: "inferred", evidence: "our bowling team My 3 Sons", isCorrection: false },
          { section: "graphics", value: "Bowling pins", confidence: "explicit", evidence: "Use bowling pins", isCorrection: false },
          { section: "style", value: "Retro, mid-century", confidence: "explicit", evidence: "retro ... mid-century look", isCorrection: false },
        ],
        deferrals: [{ section: "colors", evidence: "You choose the artwork colors" }],
        ambiguities: [],
        customerIntent: "provide_info",
        answeredPendingSection: null,
      }),
    ]);

    const started = await conversation.start();
    const projectId = started.project.id;
    const afterOpener = await conversation.handleUserMessage(projectId, opener);

    // Every required + high-value section resolved (or explicitly
    // deferred) from one message — Interview Intelligence has nothing left
    // to ask, so it moves straight to the Design Summary.
    assert.equal(afterOpener.conversation.phase, "awaiting_summary_confirmation");

    const lastMessage = afterOpener.messages.at(-1);
    const summary = lastMessage?.metadata.summary as Record<string, unknown> | undefined;
    assert.ok(summary);
    assert.match(String(summary?.product), /t-?shirt/i);
    assert.equal(summary?.productColor, "Black");
    assert.match(String(summary?.printLocation), /full back/i);
    assert.equal(summary?.requiredWording, "My 3 Sons");
    assert.match(String(summary?.graphics), /bowling pins/i);
    assert.match(String(summary?.style), /retro/i);

    const deferredDecisions = (lastMessage?.metadata.deferredDecisions ?? []) as Array<{
      section: string;
    }>;
    assert.ok(deferredDecisions.some((d) => d.section === "colors"));
  });

  it("Scenario C — a genuinely incomplete message never invents Product; the system still asks", async () => {
    const opener = "I need a design for our bowling league.";

    const { conversation } = await conversationWithFakeUnderstanding([
      whenMessageIs(opener, {
        proposedUpdates: [
          {
            section: "audience",
            value: "Bowling league",
            confidence: "inferred",
            evidence: "our bowling league",
            isCorrection: false,
          },
        ],
        deferrals: [],
        ambiguities: [{ section: "product", note: "Product/garment was not mentioned." }],
        customerIntent: "provide_info",
        answeredPendingSection: null,
      }),
    ]);

    const started = await conversation.start();
    const projectId = started.project.id;
    const afterOpener = await conversation.handleUserMessage(projectId, opener);

    assert.equal(afterOpener.brief.productSummary, null);
    const lastMessage = afterOpener.messages.at(-1);
    assert.equal(lastMessage?.metadata.act, "ask");
  });

  it("Scenario D — an explicit correction overwrites the prior product color", async () => {
    const { conversation } = await conversationWithFakeUnderstanding([
      whenMessageIs("Black shirts.", {
        proposedUpdates: [
          { section: "productColor", value: "Black", confidence: "explicit", evidence: "Black shirts", isCorrection: false },
        ],
        deferrals: [],
        ambiguities: [],
        customerIntent: "provide_info",
        answeredPendingSection: "productColor",
      }),
      whenMessageIs("Actually make the shirts navy.", {
        proposedUpdates: [
          {
            section: "productColor",
            value: "Navy",
            confidence: "explicit",
            evidence: "make the shirts navy",
            isCorrection: true,
          },
        ],
        deferrals: [],
        ambiguities: [],
        customerIntent: "correct",
        answeredPendingSection: null,
      }),
    ]);

    const started = await conversation.start();
    const projectId = started.project.id;
    await conversation.handleUserMessage(projectId, "Black shirts.");
    const afterCorrection = await conversation.handleUserMessage(
      projectId,
      "Actually make the shirts navy.",
    );

    assert.equal(afterCorrection.brief.shirtColor, "Navy");
  });

  it("Scenario E — an exact-wording correction replaces the prior required wording, verbatim", async () => {
    const { conversation } = await conversationWithFakeUnderstanding([
      whenMessageIs("Our team is My 3 Sons.", {
        proposedUpdates: [
          {
            section: "requiredWording",
            value: "My 3 Sons",
            confidence: "explicit",
            evidence: "Our team is My 3 Sons",
            isCorrection: false,
          },
        ],
        deferrals: [],
        ambiguities: [],
        customerIntent: "provide_info",
        answeredPendingSection: null,
      }),
      whenMessageIs("Actually spell it My 3 Sonz.", {
        proposedUpdates: [
          {
            section: "requiredWording",
            value: "My 3 Sonz",
            confidence: "explicit",
            evidence: "spell it My 3 Sonz",
            isCorrection: true,
          },
        ],
        deferrals: [],
        ambiguities: [],
        customerIntent: "correct",
        answeredPendingSection: null,
      }),
    ]);

    const started = await conversation.start();
    const projectId = started.project.id;
    await conversation.handleUserMessage(projectId, "Our team is My 3 Sons.");
    const afterCorrection = await conversation.handleUserMessage(
      projectId,
      "Actually spell it My 3 Sonz.",
    );

    assert.equal(afterCorrection.brief.exactText, "My 3 Sonz");
  });

  it("Scenario F — an ambiguous name is never assumed to be required wording without evidence", async () => {
    const opener = "Make something cool for My 3 Sons.";

    const { conversation } = await conversationWithFakeUnderstanding([
      whenMessageIs(opener, {
        proposedUpdates: [],
        deferrals: [],
        ambiguities: [
          {
            section: "requiredWording",
            note: "Unclear whether 'My 3 Sons' must appear as printed text or is just context.",
          },
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

  it("Scenario G — a deferred creative decision resolves to designer-determined colors, never asked at all (Sprint 2L Phase 1B: colors is optional-tier, so this is a spontaneous, unprompted deferral)", async () => {
    const { conversation } = await conversationWithFakeUnderstanding([
      whenMessageIs("No preference, choose whatever colors work best.", {
        proposedUpdates: [],
        deferrals: [{ section: "colors", evidence: "choose whatever colors work best" }],
        ambiguities: [],
        customerIntent: "defer",
        answeredPendingSection: null,
      }),
    ]);

    const started = await conversation.start();
    const projectId = started.project.id;
    // printLocation is the only section left that the system would ever
    // proactively ask about — colors is never pending, so this deferral is
    // volunteered mid-conversation while a *different* question is pending,
    // exactly like a customer would do unprompted.
    const atPrintLocation = await driveUntilPending(
      conversation,
      projectId,
      started,
      "printLocation",
      {
        product: "T-shirt",
        graphics: "A friendly logo",
        requiredWording: "Camp Wildwood",
        productColor: "Navy",
      },
    );
    assert.equal(atPrintLocation.conversation.interviewState.pendingSection, "printLocation");

    const afterDefer = await conversation.handleUserMessage(
      projectId,
      "No preference, choose whatever colors work best.",
    );

    assert.deepEqual(afterDefer.brief.preferredColors, []);
    assert.ok(afterDefer.brief.deferredSections.includes("colors"));
    // No duplicate — understanding and the deterministic engine both agree
    // on the same deferral; the union must not double-count it.
    assert.equal(
      afterDefer.brief.deferredSections.filter((s) => s === "colors").length,
      1,
    );
    // printLocation was NOT accidentally deferred by this reply — the
    // explicit "colors" mention wins over the ambient pending section
    // (extraction.ts precedence fix, Sprint 2L Phase 1B).
    assert.equal(afterDefer.conversation.interviewState.pendingSection, "printLocation");
  });

  it("Scenario H — one rich reply to a single question resolves multiple sections at once", async () => {
    const reply = "Retro badge, bowling ball and three pins, cream and orange, full back.";

    const { conversation } = await conversationWithFakeUnderstanding([
      whenMessageIs(reply, {
        proposedUpdates: [
          { section: "style", value: "Retro badge", confidence: "explicit", evidence: "Retro badge", isCorrection: false },
          { section: "graphics", value: "Bowling ball and three pins", confidence: "explicit", evidence: "bowling ball and three pins", isCorrection: false },
          { section: "colors", value: "Cream and orange", confidence: "explicit", evidence: "cream and orange", isCorrection: false },
          { section: "printLocation", value: "full back", confidence: "explicit", evidence: "full back", isCorrection: false },
        ],
        deferrals: [],
        ambiguities: [],
        customerIntent: "provide_info",
        answeredPendingSection: "graphics",
      }),
    ]);

    const started = await conversation.start();
    const projectId = started.project.id;
    const atGraphics = await driveUntilPending(conversation, projectId, started, "graphics", {
      product: "T-shirt",
      productColor: "Black",
      requiredWording: "Camp Wildwood",
    });
    assert.equal(atGraphics.conversation.interviewState.pendingSection, "graphics");

    const afterReply = await conversation.handleUserMessage(projectId, reply);

    assert.match(afterReply.brief.designStyle ?? "", /retro/i);
    assert.match(afterReply.brief.designDescription ?? "", /bowling ball/i);
    assert.ok(
      afterReply.brief.preferredColors.map((c) => c.toLowerCase()).includes("cream"),
    );
    assert.equal(afterReply.brief.printPlacement, "full_back");

    const pending = afterReply.conversation.interviewState.pendingSection;
    assert.ok(!["style", "graphics", "colors", "printLocation"].includes(pending as string));
  });

  it("Scenario I — a provider failure degrades gracefully; the conversation keeps working with no provider/error terminology", async () => {
    const { conversation } = await conversationWithFakeUnderstanding([], {
      failWith: new Error("simulated network failure"),
    });

    const started = await conversation.start();
    const projectId = started.project.id;

    const afterReply = await conversation.handleUserMessage(
      projectId,
      "A T-shirt for the school fair",
    );

    // Deterministic extraction alone still resolves the reply.
    assert.equal(afterReply.brief.productSummary, "A T-shirt for the school fair");
    assert.equal(afterReply.conversation.phase, "interviewing");

    const lastMessage = afterReply.messages.at(-1);
    assert.ok(lastMessage);
    assert.doesNotMatch(
      lastMessage!.content,
      /openai|provider|json|parse|network|timeout|unavailable|failed/i,
    );
  });

  it("Scenario J — an unrelated later noun never overwrites an already-resolved Product (Sprint 2L Phase 1B: purpose is optional/never pending, so this is volunteered mid-conversation)", async () => {
    const { conversation } = await conversationWithFakeUnderstanding([
      // The provider stays silent on `product` here — it must never be
      // reinterpreted from "shirts" appearing inside the purpose answer.
      whenMessageIs("bowling league team shirts", {
        proposedUpdates: [
          {
            section: "purpose",
            value: "Bowling league team apparel",
            confidence: "explicit",
            evidence: "bowling league team shirts",
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
    const atPrintLocation = await driveUntilPending(
      conversation,
      projectId,
      started,
      "printLocation",
      {
        product: "T-shirt",
        graphics: "A friendly logo",
        requiredWording: "Camp Wildwood",
        productColor: "Navy",
      },
    );
    assert.equal(atPrintLocation.brief.productSummary, "T-shirt");
    assert.equal(atPrintLocation.conversation.interviewState.pendingSection, "printLocation");

    const afterReply = await conversation.handleUserMessage(
      projectId,
      "bowling league team shirts",
    );

    assert.equal(afterReply.brief.productSummary, "T-shirt");
    assert.equal(afterReply.brief.purpose, "Bowling league team apparel");
  });

  it("customer snapshot never carries raw provider evidence/confidence/reasoning (security boundary)", async () => {
    const opener =
      "I'm in a bowling league and our team is called My 3 Sons help me create a design for team t-shirts";

    const { conversation } = await conversationWithFakeUnderstanding([
      whenMessageIs(opener, {
        proposedUpdates: [
          {
            section: "requiredWording",
            value: "My 3 Sons",
            confidence: "explicit",
            evidence: "our team is called My 3 Sons — internal-only evidence text",
            isCorrection: false,
          },
        ],
        deferrals: [],
        ambiguities: [
          { section: "general", note: "internal-only ambiguity note, never customer-facing" },
        ],
        customerIntent: "provide_info",
        answeredPendingSection: null,
      }),
    ]);

    const started = await conversation.start();
    const projectId = started.project.id;
    const afterOpener = await conversation.handleUserMessage(projectId, opener);

    const serializedSnapshot = JSON.stringify(afterOpener);
    assert.doesNotMatch(serializedSnapshot, /internal-only/);
    assert.doesNotMatch(serializedSnapshot, /"confidence"/);
    assert.doesNotMatch(serializedSnapshot, /"evidence"/);
    assert.doesNotMatch(serializedSnapshot, /"proposedUpdates"/);
    assert.doesNotMatch(serializedSnapshot, /"providerMetadata"/);
    assert.doesNotMatch(serializedSnapshot, /openai|gpt-/i);
  });
});
