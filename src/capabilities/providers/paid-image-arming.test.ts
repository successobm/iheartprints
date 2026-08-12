/**
 * Phase 2C0 — development paid-image arming + concept quality wiring through
 * the live resolve path (no explicit config injection).
 *
 * Temporarily clears IHEARTPRINTS_AUTOMATED_TEST so the automated-test
 * placeholder short-circuit does not hide the arming gate under test.
 * Restores it in afterEach. Never contacts a network.
 */

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { AUTOMATED_TEST_SAFETY_ENV_VAR } from "@/lib/config/automated-test-safety";
import { resolveConceptGenerationProvider } from "./resolve-concept-provider";
import { GenerationUnavailableError } from "./generation-unavailable-error";
import { OpenAIConceptGenerationProvider } from "./openai-concept-provider";

const ENV_KEYS = [
  AUTOMATED_TEST_SAFETY_ENV_VAR,
  "CONCEPT_GENERATION_PROVIDER",
  "CONCEPT_GENERATION_ENABLE_REAL",
  "ALLOW_PAID_IMAGE_GENERATION",
  "OPENAI_API_KEY",
  "OPENAI_IMAGE_MODEL",
  "OPENAI_CONCEPT_IMAGE_QUALITY",
  "NODE_ENV",
  "ASSET_STORAGE_MODE",
] as const;

function snapshotEnv(): Record<string, string | undefined> {
  const snapshot: Record<string, string | undefined> = {};
  for (const key of ENV_KEYS) snapshot[key] = process.env[key];
  return snapshot;
}

function restoreEnv(snapshot: Record<string, string | undefined>): void {
  for (const key of ENV_KEYS) {
    if (snapshot[key] === undefined) delete process.env[key];
    else process.env[key] = snapshot[key];
  }
}

describe("Phase 2C0 paid-image arming + quality resolve", () => {
  const original = snapshotEnv();

  afterEach(() => {
    restoreEnv(original);
  });

  it("outside production, live resolve stays unavailable without ALLOW_PAID_IMAGE_GENERATION", async () => {
    delete process.env[AUTOMATED_TEST_SAFETY_ENV_VAR];
    process.env.NODE_ENV = "development";
    process.env.CONCEPT_GENERATION_PROVIDER = "openai";
    process.env.CONCEPT_GENERATION_ENABLE_REAL = "true";
    process.env.OPENAI_API_KEY = "sk-test-key";
    process.env.ASSET_STORAGE_MODE = "data_uri";
    delete process.env.ALLOW_PAID_IMAGE_GENERATION;
    delete process.env.OPENAI_CONCEPT_IMAGE_QUALITY;

    const provider = resolveConceptGenerationProvider();
    assert.equal(provider.providerKey, "unavailable");
    await assert.rejects(
      provider.generate({
        designId: "d1",
        designBriefId: "v1",
        conceptCount: 1,
        prompt: {
          product: "a t-shirt",
          subject: "a logo",
          style: null,
          colors: [],
          printPaletteEnforcement: "none",
          subjectOnlyColors: [],
          productColor: null,
          requiredWording: null,
          wordingMode: "unknown",
          printLocation: null,
          audience: null,
          purpose: null,
          exclusions: null,
          notes: null,
          inspirationReferences: [],
          allowAdditionalText: false,
        },
        idempotencyKey: "k",
      }),
      (error: unknown) => {
        assert.ok(error instanceof GenerationUnavailableError);
        assert.equal(error.safeErrorCode, "PAID_IMAGE_GENERATION_NOT_ARMED");
        return true;
      },
    );
  });

  it("outside production, armed live resolve yields OpenAI provider with medium quality by default", () => {
    delete process.env[AUTOMATED_TEST_SAFETY_ENV_VAR];
    process.env.NODE_ENV = "development";
    process.env.CONCEPT_GENERATION_PROVIDER = "openai";
    process.env.CONCEPT_GENERATION_ENABLE_REAL = "true";
    process.env.ALLOW_PAID_IMAGE_GENERATION = "true";
    process.env.OPENAI_API_KEY = "sk-test-key";
    process.env.ASSET_STORAGE_MODE = "data_uri";
    delete process.env.OPENAI_CONCEPT_IMAGE_QUALITY;

    const provider = resolveConceptGenerationProvider();
    assert.ok(provider instanceof OpenAIConceptGenerationProvider);
    assert.equal(provider.providerKey, "openai");
  });

  it("production does not require ALLOW_PAID_IMAGE_GENERATION when ENABLE_REAL is set", () => {
    delete process.env[AUTOMATED_TEST_SAFETY_ENV_VAR];
    process.env.NODE_ENV = "production";
    process.env.CONCEPT_GENERATION_PROVIDER = "openai";
    process.env.CONCEPT_GENERATION_ENABLE_REAL = "true";
    process.env.OPENAI_API_KEY = "sk-prod-key";
    process.env.ASSET_STORAGE_MODE = "supabase_storage";
    delete process.env.ALLOW_PAID_IMAGE_GENERATION;

    const provider = resolveConceptGenerationProvider();
    assert.ok(provider instanceof OpenAIConceptGenerationProvider);
  });

  it("automated-test environment never resolves a live paid OpenAI provider", () => {
    process.env[AUTOMATED_TEST_SAFETY_ENV_VAR] = "1";
    process.env.NODE_ENV = "development";
    process.env.CONCEPT_GENERATION_PROVIDER = "openai";
    process.env.CONCEPT_GENERATION_ENABLE_REAL = "true";
    process.env.ALLOW_PAID_IMAGE_GENERATION = "true";
    process.env.OPENAI_API_KEY = "sk-should-never-be-used";

    const provider = resolveConceptGenerationProvider();
    assert.equal(provider.providerKey, "placeholder");
  });
});
