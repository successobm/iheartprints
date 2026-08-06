import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { getConceptEvaluationConfig } from "./concept-evaluation-provider-config";

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

describe("getConceptEvaluationConfig", () => {
  it("defaults to the placeholder evaluator when nothing is configured", () => {
    withEnv(
      { CONCEPT_EVALUATION_PROVIDER: undefined, OPENAI_API_KEY: undefined },
      () => {
        const config = getConceptEvaluationConfig();
        assert.equal(config.mode, "placeholder");
        assert.equal((config as { reason: string }).reason, "configured");
      },
    );
  });

  it("selects openai when requested and an API key is present", () => {
    withEnv(
      {
        CONCEPT_EVALUATION_PROVIDER: "openai",
        OPENAI_API_KEY: "sk-test",
        OPENAI_EVALUATION_MODEL: undefined,
      },
      () => {
        const config = getConceptEvaluationConfig();
        assert.equal(config.mode, "openai");
        assert.equal((config as { apiKey: string }).apiKey, "sk-test");
        assert.equal((config as { model: string }).model, "gpt-4o-mini");
      },
    );
  });

  it("honors an explicit evaluation model override", () => {
    withEnv(
      {
        CONCEPT_EVALUATION_PROVIDER: "openai",
        OPENAI_API_KEY: "sk-test",
        OPENAI_EVALUATION_MODEL: "gpt-4o",
      },
      () => {
        const config = getConceptEvaluationConfig();
        assert.equal((config as { model: string }).model, "gpt-4o");
      },
    );
  });

  it("falls back to the placeholder evaluator — even in production — when openai is requested without a key", () => {
    withEnv(
      {
        CONCEPT_EVALUATION_PROVIDER: "openai",
        OPENAI_API_KEY: undefined,
        NODE_ENV: "production",
      },
      () => {
        const config = getConceptEvaluationConfig();
        assert.equal(config.mode, "placeholder");
        assert.equal((config as { reason: string }).reason, "fallback");
      },
    );
  });

  it("treats an unrecognized provider value as placeholder", () => {
    withEnv({ CONCEPT_EVALUATION_PROVIDER: "not-a-real-provider" }, () => {
      const config = getConceptEvaluationConfig();
      assert.equal(config.mode, "placeholder");
    });
  });
});
