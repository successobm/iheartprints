import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { NoneConversationUnderstandingProvider } from "./none-conversation-understanding-provider";
import { OpenAIConversationUnderstandingProvider } from "./openai-conversation-understanding-provider";
import { resolveConversationUnderstandingProvider } from "./resolve-conversation-understanding-provider";

describe("resolveConversationUnderstandingProvider", () => {
  it("resolves to NoneConversationUnderstandingProvider for mode: none", () => {
    const provider = resolveConversationUnderstandingProvider({
      mode: "none",
      reason: "configured",
    });
    assert.ok(provider instanceof NoneConversationUnderstandingProvider);
  });

  it("resolves to NoneConversationUnderstandingProvider on a fallback reason too — never throws, never blocks", () => {
    const provider = resolveConversationUnderstandingProvider({
      mode: "none",
      reason: "fallback",
    });
    assert.ok(provider instanceof NoneConversationUnderstandingProvider);
  });

  it("resolves to the OpenAI provider for mode: openai", () => {
    const provider = resolveConversationUnderstandingProvider({
      mode: "openai",
      apiKey: "sk-test",
      model: "gpt-4o-mini",
    });
    assert.ok(provider instanceof OpenAIConversationUnderstandingProvider);
    assert.equal(provider.providerKey, "openai_conversation_understanding");
  });

  it("provider replacement compatibility: both resolved providers satisfy the same shape", () => {
    const none = resolveConversationUnderstandingProvider({
      mode: "none",
      reason: "configured",
    });
    const openai = resolveConversationUnderstandingProvider({
      mode: "openai",
      apiKey: "sk-test",
      model: "gpt-4o-mini",
    });
    for (const provider of [none, openai]) {
      assert.equal(typeof provider.providerKey, "string");
      assert.equal(typeof provider.interpret, "function");
    }
    assert.notEqual(none.providerKey, openai.providerKey);
  });
});
