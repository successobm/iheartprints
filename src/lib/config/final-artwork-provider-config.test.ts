import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { getFinalArtworkProviderConfig } from "./final-artwork-provider-config";

describe("getFinalArtworkProviderConfig (Sprint 2M Phase 2E)", () => {
  it("A: defaults to local when FINAL_ARTWORK_PROVIDER is unset", () => {
    const original = { ...process.env };
    delete process.env.FINAL_ARTWORK_PROVIDER;
    delete process.env.TOPAZ_API_KEY;
    try {
      const config = getFinalArtworkProviderConfig();
      assert.deepEqual(config, { mode: "local" });
    } finally {
      process.env = original;
    }
  });

  it("A: an unrecognized value also falls back to local, never throws", () => {
    const original = { ...process.env };
    process.env.FINAL_ARTWORK_PROVIDER = "some-typo";
    try {
      const config = getFinalArtworkProviderConfig();
      assert.deepEqual(config, { mode: "local" });
    } finally {
      process.env = original;
    }
  });

  it("A: topaz mode is selected only when explicitly requested and configured", () => {
    const original = { ...process.env };
    process.env.FINAL_ARTWORK_PROVIDER = "topaz";
    process.env.TOPAZ_API_KEY = "test-key-not-real";
    try {
      const config = getFinalArtworkProviderConfig();
      assert.equal(config.mode, "topaz");
      assert.equal(config.mode === "topaz" && config.apiKey, "test-key-not-real");
    } finally {
      process.env = original;
    }
  });

  it("B: FINAL_ARTWORK_PROVIDER=topaz without TOPAZ_API_KEY resolves unavailable, never silently falls back to local", () => {
    const original = { ...process.env };
    process.env.FINAL_ARTWORK_PROVIDER = "topaz";
    delete process.env.TOPAZ_API_KEY;
    try {
      const config = getFinalArtworkProviderConfig();
      assert.equal(config.mode, "unavailable");
      assert.equal(
        config.mode === "unavailable" && config.safeErrorCode,
        "FINAL_ARTWORK_PROVIDER_NOT_CONFIGURED",
      );
    } finally {
      process.env = original;
    }
  });

  it("is never coupled to OPENAI_API_KEY / CONCEPT_GENERATION_* / CONVERSATION_UNDERSTANDING_PROVIDER", () => {
    const original = { ...process.env };
    delete process.env.FINAL_ARTWORK_PROVIDER;
    delete process.env.TOPAZ_API_KEY;
    process.env.OPENAI_API_KEY = "unrelated-key";
    process.env.CONCEPT_GENERATION_PROVIDER = "openai";
    process.env.CONCEPT_GENERATION_ENABLE_REAL = "true";
    process.env.CONVERSATION_UNDERSTANDING_PROVIDER = "openai";
    try {
      const config = getFinalArtworkProviderConfig();
      // Still local — none of the above provider boundaries influence this
      // one at all (Goal 1's explicit non-coupling requirement).
      assert.deepEqual(config, { mode: "local" });
    } finally {
      process.env = original;
    }
  });
});
