import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createConversationUnderstandingCapability } from "./conversation-understanding-capability";
import { EMPTY_UNDERSTANDING_RESULT } from "./contracts";
import type { ConversationUnderstandingProvider } from "./conversation-understanding-provider";
import type { BriefSectionKey } from "@/capabilities/shared/contracts";
import type { ConversationMessage } from "@/lib/domain/types";

function message(
  role: "user" | "assistant",
  content: string,
  overrides: Partial<ConversationMessage> = {},
): ConversationMessage {
  return {
    id: "m1",
    conversationId: "c1",
    projectId: "p1",
    role,
    content,
    metadata: { secret: "should never reach a provider" },
    createdAt: "2026-08-04T00:00:00.000Z",
    ...overrides,
  };
}

class RecordingProvider implements ConversationUnderstandingProvider {
  readonly providerKey = "recording";
  calls: unknown[] = [];
  constructor(private readonly result: unknown = EMPTY_UNDERSTANDING_RESULT) {}
  async interpret(request: unknown) {
    this.calls.push(request);
    return this.result as never;
  }
}

class ThrowingProvider implements ConversationUnderstandingProvider {
  readonly providerKey = "throwing";
  async interpret(): Promise<never> {
    throw new Error("simulated provider failure — network/timeout/etc.");
  }
}

const baseInput = {
  knownBrief: {},
  unresolvedSections: [] as BriefSectionKey[],
  pendingSection: null as BriefSectionKey | null,
  recentMessages: [] as ConversationMessage[],
};

describe("ConversationUnderstandingCapability — skip policy (Goal 12)", () => {
  it("skips the provider call for a single-word reply", async () => {
    const provider = new RecordingProvider();
    const capability = createConversationUnderstandingCapability(provider);
    const result = await capability.interpret({ ...baseInput, message: "black" });
    assert.equal(provider.calls.length, 0);
    assert.deepEqual(result, EMPTY_UNDERSTANDING_RESULT);
  });

  it("calls the provider for a multi-word reply", async () => {
    const provider = new RecordingProvider();
    const capability = createConversationUnderstandingCapability(provider);
    await capability.interpret({ ...baseInput, message: "black shirts please" });
    assert.equal(provider.calls.length, 1);
  });

  it("returns empty and never calls the provider for a blank message", async () => {
    const provider = new RecordingProvider();
    const capability = createConversationUnderstandingCapability(provider);
    const result = await capability.interpret({ ...baseInput, message: "   " });
    assert.equal(provider.calls.length, 0);
    assert.deepEqual(result, EMPTY_UNDERSTANDING_RESULT);
  });
});

describe("ConversationUnderstandingCapability — bounded, customer-safe request (Goal 4 / security)", () => {
  it("bounds recent messages to the last few turns, truncated, role+text only — no ids/metadata", async () => {
    const provider = new RecordingProvider();
    const capability = createConversationUnderstandingCapability(provider);

    const many = Array.from({ length: 20 }, (_, i) =>
      message(i % 2 === 0 ? "assistant" : "user", `turn ${i}`.repeat(50)),
    );

    await capability.interpret({
      ...baseInput,
      message: "a longer reply worth calling the provider for",
      recentMessages: many,
    });

    const request = provider.calls[0] as {
      recentTurns: Array<{ role: string; text: string }>;
    };
    assert.ok(request.recentTurns.length <= 6);
    for (const turn of request.recentTurns) {
      assert.ok(turn.text.length <= 300);
      assert.ok(["customer", "assistant"].includes(turn.role));
      assert.ok(!("id" in turn));
      assert.ok(!("metadata" in turn));
      assert.doesNotMatch(JSON.stringify(turn), /secret/);
    }
  });

  it("drops a system-role message from the bounded window", async () => {
    const provider = new RecordingProvider();
    const capability = createConversationUnderstandingCapability(provider);
    await capability.interpret({
      ...baseInput,
      message: "a longer reply worth calling the provider for",
      recentMessages: [message("user", "hi", { role: "system" as never })],
    });
    const request = provider.calls[0] as { recentTurns: unknown[] };
    assert.equal(request.recentTurns.length, 0);
  });
});

describe("ConversationUnderstandingCapability — malformed provider output is rejected (Goal 10)", () => {
  it("drops a proposed update for an unsupported section", async () => {
    const provider = new RecordingProvider({
      proposedUpdates: [
        { section: "references", value: "x", confidence: "explicit", evidence: "x", isCorrection: false },
        { section: "production", value: "x", confidence: "explicit", evidence: "x", isCorrection: false },
      ],
      deferrals: [],
      ambiguities: [],
      customerIntent: "provide_info",
      answeredPendingSection: null,
    });
    const capability = createConversationUnderstandingCapability(provider);
    const result = await capability.interpret({ ...baseInput, message: "some reply text" });
    assert.deepEqual(result.proposedUpdates, []);
  });

  it("drops a proposed update with an invalid confidence value", async () => {
    const provider = new RecordingProvider({
      proposedUpdates: [
        { section: "product", value: "T-shirt", confidence: "very_sure", evidence: "T-shirt", isCorrection: false },
      ],
      deferrals: [],
      ambiguities: [],
      customerIntent: "provide_info",
      answeredPendingSection: null,
    });
    const capability = createConversationUnderstandingCapability(provider);
    const result = await capability.interpret({ ...baseInput, message: "some reply text" });
    assert.deepEqual(result.proposedUpdates, []);
  });

  it("drops a non-string value", async () => {
    const provider = new RecordingProvider({
      proposedUpdates: [
        { section: "product", value: 42, confidence: "explicit", evidence: "x", isCorrection: false },
      ],
      deferrals: [],
      ambiguities: [],
      customerIntent: "provide_info",
      answeredPendingSection: null,
    });
    const capability = createConversationUnderstandingCapability(provider);
    const result = await capability.interpret({ ...baseInput, message: "some reply text" });
    assert.deepEqual(result.proposedUpdates, []);
  });

  it("falls back to 'unclear' for an invalid customerIntent and null for an unresolved answeredPendingSection", async () => {
    const provider = new RecordingProvider({
      proposedUpdates: [],
      deferrals: [],
      ambiguities: [],
      customerIntent: "does_not_exist",
      answeredPendingSection: "references",
    });
    const capability = createConversationUnderstandingCapability(provider);
    const result = await capability.interpret({ ...baseInput, message: "some reply text" });
    assert.equal(result.customerIntent, "unclear");
    assert.equal(result.answeredPendingSection, null);
  });

  it("caps oversized lists, evidence, and value strings", async () => {
    const provider = new RecordingProvider({
      proposedUpdates: Array.from({ length: 30 }, () => ({
        section: "product",
        value: "x".repeat(1000),
        confidence: "explicit",
        evidence: "y".repeat(1000),
        isCorrection: false,
      })),
      deferrals: [],
      ambiguities: [],
      customerIntent: "provide_info",
      answeredPendingSection: null,
    });
    const capability = createConversationUnderstandingCapability(provider);
    const result = await capability.interpret({ ...baseInput, message: "some reply text" });
    assert.ok(result.proposedUpdates.length <= 12);
    for (const update of result.proposedUpdates) {
      assert.ok(update.value.length <= 300);
      assert.ok(update.evidence.length <= 200);
    }
  });

  it("returns an empty result rather than throwing for a completely non-object provider response", async () => {
    const provider = new RecordingProvider(null);
    const capability = createConversationUnderstandingCapability(provider);
    const result = await capability.interpret({ ...baseInput, message: "some reply text" });
    assert.deepEqual(result, EMPTY_UNDERSTANDING_RESULT);
  });
});

describe("ConversationUnderstandingCapability — determinism and immutability", () => {
  it("produces byte-identical results for identical input, called twice", async () => {
    const provider = new RecordingProvider({
      proposedUpdates: [
        {
          section: "product",
          value: "T-shirt",
          confidence: "explicit",
          evidence: "team t-shirts",
          isCorrection: false,
        },
      ],
      deferrals: [],
      ambiguities: [],
      customerIntent: "provide_info",
      answeredPendingSection: null,
    });
    const capability = createConversationUnderstandingCapability(provider);
    const input = { ...baseInput, message: "team t-shirts please" };
    const first = await capability.interpret(input);
    const second = await capability.interpret(input);
    assert.deepEqual(first, second);
  });

  it("never mutates the input it was given", async () => {
    const provider = new RecordingProvider();
    const capability = createConversationUnderstandingCapability(provider);
    const recentMessages = [message("user", "hello there")];
    const input = { ...baseInput, message: "a real reply here", recentMessages };
    const snapshotBefore = JSON.stringify(input);
    await capability.interpret(input);
    assert.equal(JSON.stringify(input), snapshotBefore);
    assert.equal(input.recentMessages, recentMessages);
    assert.equal(recentMessages.length, 1);
  });
});

describe("ConversationUnderstandingCapability — no provider metadata / reasoning ever leaves the boundary", () => {
  it("the result contract carries no chain-of-thought, raw response, or numeric confidence fields", async () => {
    const provider = new RecordingProvider({
      proposedUpdates: [
        {
          section: "product",
          value: "T-shirt",
          confidence: "explicit",
          evidence: "team t-shirts",
          isCorrection: false,
        },
      ],
      deferrals: [],
      ambiguities: [],
      customerIntent: "provide_info",
      answeredPendingSection: null,
    });
    const capability = createConversationUnderstandingCapability(provider);
    const result = await capability.interpret({ ...baseInput, message: "team t-shirts please" });
    const serialized = JSON.stringify(result);
    assert.doesNotMatch(serialized, /reasoning|chain.?of.?thought|rawResponse|providerMetadata/i);
    // Confidence is always one of three coarse buckets, never a number.
    for (const update of result.proposedUpdates) {
      assert.ok(["explicit", "inferred", "ambiguous"].includes(update.confidence));
    }
  });
});

describe("ConversationUnderstandingCapability — provider failure degrades gracefully (Goal 10)", () => {
  it("never throws and returns the empty result when the provider throws", async () => {
    const capability = createConversationUnderstandingCapability(new ThrowingProvider());
    const result = await capability.interpret({ ...baseInput, message: "a real sentence here" });
    assert.deepEqual(result, EMPTY_UNDERSTANDING_RESULT);
  });

  it("exposes the underlying provider's key", () => {
    const capability = createConversationUnderstandingCapability(new ThrowingProvider());
    assert.equal(capability.providerKey, "throwing");
  });
});
