import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { getConversationUnderstandingConfig } from "./conversation-understanding-provider-config";

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const previous: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) {
    previous[key] = process.env[key];
    if (vars[key] === undefined) delete process.env[key];
    else process.env[key] = vars[key];
  }
  try {
    return fn();
  } finally {
    for (const key of Object.keys(vars)) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

describe("getConversationUnderstandingConfig", () => {
  it("defaults to 'none' (deterministic-only) when nothing is configured", () => {
    withEnv(
      { CONVERSATION_UNDERSTANDING_PROVIDER: undefined, OPENAI_API_KEY: undefined },
      () => {
        const config = getConversationUnderstandingConfig();
        assert.equal(config.mode, "none");
        assert.equal((config as { reason: string }).reason, "configured");
      },
    );
  });

  it("selects openai when requested and an API key is present", () => {
    withEnv(
      {
        CONVERSATION_UNDERSTANDING_PROVIDER: "openai",
        OPENAI_API_KEY: "sk-test",
        CONVERSATION_UNDERSTANDING_MODEL: undefined,
      },
      () => {
        const config = getConversationUnderstandingConfig();
        assert.equal(config.mode, "openai");
        assert.equal((config as { apiKey: string }).apiKey, "sk-test");
        assert.equal((config as { model: string }).model, "gpt-4o-mini");
      },
    );
  });

  it("honors an explicit model override", () => {
    withEnv(
      {
        CONVERSATION_UNDERSTANDING_PROVIDER: "openai",
        OPENAI_API_KEY: "sk-test",
        CONVERSATION_UNDERSTANDING_MODEL: "gpt-4o",
      },
      () => {
        const config = getConversationUnderstandingConfig();
        assert.equal((config as { model: string }).model, "gpt-4o");
      },
    );
  });

  it("falls back to 'none' — even in production — when openai is requested without a key", () => {
    withEnv(
      {
        CONVERSATION_UNDERSTANDING_PROVIDER: "openai",
        OPENAI_API_KEY: undefined,
        NODE_ENV: "production",
      },
      () => {
        const config = getConversationUnderstandingConfig();
        assert.equal(config.mode, "none");
        assert.equal((config as { reason: string }).reason, "fallback");
      },
    );
  });

  it("treats an unrecognized provider value as 'none'", () => {
    withEnv({ CONVERSATION_UNDERSTANDING_PROVIDER: "not-a-real-provider" }, () => {
      const config = getConversationUnderstandingConfig();
      assert.equal(config.mode, "none");
    });
  });

  it("is independent of CONCEPT_GENERATION_ENABLE_REAL (Goal 11)", () => {
    withEnv(
      {
        CONVERSATION_UNDERSTANDING_PROVIDER: "openai",
        OPENAI_API_KEY: "sk-test",
        CONCEPT_GENERATION_ENABLE_REAL: "false",
      },
      () => {
        const config = getConversationUnderstandingConfig();
        assert.equal(config.mode, "openai");
      },
    );
  });
});
