import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { OpenAIConceptEvaluationProvider } from "./openai-concept-evaluation-provider";
import { PlaceholderConceptEvaluationProvider } from "./placeholder-concept-evaluation-provider";
import { resolveConceptEvaluationProvider } from "./resolve-concept-evaluation-provider";

describe("resolveConceptEvaluationProvider", () => {
  it("resolves to the placeholder evaluator for mode: placeholder", () => {
    const provider = resolveConceptEvaluationProvider({
      mode: "placeholder",
      reason: "configured",
    });
    assert.ok(provider instanceof PlaceholderConceptEvaluationProvider);
  });

  it("resolves to the placeholder evaluator on a fallback reason too — never throws, never blocks", () => {
    const provider = resolveConceptEvaluationProvider({
      mode: "placeholder",
      reason: "fallback",
    });
    assert.ok(provider instanceof PlaceholderConceptEvaluationProvider);
  });

  it("resolves to the OpenAI evaluator for mode: openai", () => {
    const provider = resolveConceptEvaluationProvider({
      mode: "openai",
      apiKey: "sk-test",
      model: "gpt-4o-mini",
    });
    assert.ok(provider instanceof OpenAIConceptEvaluationProvider);
    assert.equal(provider.providerKey, "openai_vision_concept_evaluation");
  });

  it("provider replacement compatibility: both resolved providers satisfy the same ConceptEvaluationProvider shape", () => {
    const placeholder = resolveConceptEvaluationProvider({
      mode: "placeholder",
      reason: "configured",
    });
    const openai = resolveConceptEvaluationProvider({
      mode: "openai",
      apiKey: "sk-test",
      model: "gpt-4o-mini",
    });
    for (const provider of [placeholder, openai]) {
      assert.equal(typeof provider.providerKey, "string");
      assert.equal(typeof provider.evaluate, "function");
    }
    assert.notEqual(placeholder.providerKey, openai.providerKey);
  });
});
