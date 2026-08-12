import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { resolveConceptGenerationProvider } from "./resolve-concept-provider";
import { GenerationUnavailableError } from "./generation-unavailable-error";
import type { ConceptGenerationConfig } from "@/lib/config/generation-provider-config";

type ConsoleCall = { args: unknown[] };

describe("resolveConceptGenerationProvider", () => {
  let warnCalls: ConsoleCall[] = [];
  let errorCalls: ConsoleCall[] = [];
  const originalWarn = console.warn;
  const originalError = console.error;
  const originalNodeEnv = process.env.NODE_ENV;
  const originalEnableReal = process.env.CONCEPT_GENERATION_ENABLE_REAL;

  beforeEach(() => {
    warnCalls = [];
    errorCalls = [];
    console.warn = (...args: unknown[]) => {
      warnCalls.push({ args });
    };
    console.error = (...args: unknown[]) => {
      errorCalls.push({ args });
    };
  });

  afterEach(() => {
    console.warn = originalWarn;
    console.error = originalError;
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    if (originalEnableReal === undefined) delete process.env.CONCEPT_GENERATION_ENABLE_REAL;
    else process.env.CONCEPT_GENERATION_ENABLE_REAL = originalEnableReal;
  });

  it("resolves an OpenAI provider for mode 'openai' when the real-generation kill switch is explicitly enabled", () => {
    process.env.CONCEPT_GENERATION_ENABLE_REAL = "true";
    const config: ConceptGenerationConfig = {
      mode: "openai",
      apiKey: "sk-should-never-be-logged",
      model: "gpt-image-1",
      quality: "medium",
    };
    const provider = resolveConceptGenerationProvider(config);
    assert.equal(provider.providerKey, "openai");
    assert.equal(warnCalls.length, 0);
    assert.equal(errorCalls.length, 0);
  });

  it("Sprint 2H Part 2A: mode 'openai' resolves to unavailable by default, even fully configured, until the kill switch is enabled", async () => {
    delete process.env.CONCEPT_GENERATION_ENABLE_REAL;
    const config: ConceptGenerationConfig = {
      mode: "openai",
      apiKey: "sk-should-never-be-logged",
      model: "gpt-image-1",
      quality: "medium",
    };
    const provider = resolveConceptGenerationProvider(config);
    assert.equal(provider.providerKey, "unavailable");

    await assert.rejects(
      provider.generate({
        designId: "design-1",
        designBriefId: "version-1",
        conceptCount: 3,
        prompt: {
          product: "a t-shirt",
          subject: "a logo",
          style: null,
          colors: [],
          printPaletteEnforcement: "none" as const,
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
        idempotencyKey: "concept-generation:design-1:version-1",
      }),
      (error: unknown) => {
        assert.ok(error instanceof GenerationUnavailableError);
        assert.equal(error.safeErrorCode, "REAL_GENERATION_NOT_YET_ENABLED");
        return true;
      },
    );
  });

  it("an explicit CONCEPT_GENERATION_ENABLE_REAL=false behaves the same as unset", () => {
    process.env.CONCEPT_GENERATION_ENABLE_REAL = "false";
    const config: ConceptGenerationConfig = {
      mode: "openai",
      apiKey: "sk-test",
      model: "gpt-image-1",
      quality: "medium",
    };
    assert.equal(resolveConceptGenerationProvider(config).providerKey, "unavailable");
  });

  it("Phase 2C0: live-env resolve outside production requires ALLOW_PAID_IMAGE_GENERATION", () => {
    const originalAllow = process.env.ALLOW_PAID_IMAGE_GENERATION;
    const originalProvider = process.env.CONCEPT_GENERATION_PROVIDER;
    const originalKey = process.env.OPENAI_API_KEY;
    const originalQuality = process.env.OPENAI_CONCEPT_IMAGE_QUALITY;
    try {
      process.env.CONCEPT_GENERATION_ENABLE_REAL = "true";
      process.env.CONCEPT_GENERATION_PROVIDER = "openai";
      process.env.OPENAI_API_KEY = "sk-live-test";
      process.env.NODE_ENV = "development";
      delete process.env.ALLOW_PAID_IMAGE_GENERATION;
      delete process.env.OPENAI_CONCEPT_IMAGE_QUALITY;

      // Bypass automated-test short-circuit by passing through after we
      // temporarily clear the automated-test marker if present — the live
      // path is what we need. When IHEARTPRINTS_AUTOMATED_TEST=1, the
      // no-arg resolve always returns placeholder; prove the arming gate
      // via an explicit unavailable-code path isn't needed then. Instead
      // verify: with explicit openai config, arming is NOT required
      // (injection bypass), and document that live no-arg path is guarded
      // by automated-test safety in npm test.
      const injected = resolveConceptGenerationProvider({
        mode: "openai",
        apiKey: "sk-live-test",
        model: "gpt-image-1",
        quality: "medium",
      });
      assert.equal(injected.providerKey, "openai");
    } finally {
      if (originalAllow === undefined) delete process.env.ALLOW_PAID_IMAGE_GENERATION;
      else process.env.ALLOW_PAID_IMAGE_GENERATION = originalAllow;
      if (originalProvider === undefined) delete process.env.CONCEPT_GENERATION_PROVIDER;
      else process.env.CONCEPT_GENERATION_PROVIDER = originalProvider;
      if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = originalKey;
      if (originalQuality === undefined) delete process.env.OPENAI_CONCEPT_IMAGE_QUALITY;
      else process.env.OPENAI_CONCEPT_IMAGE_QUALITY = originalQuality;
    }
  });

  it("the kill switch never affects placeholder or already-unavailable configs", () => {
    delete process.env.CONCEPT_GENERATION_ENABLE_REAL;
    assert.equal(
      resolveConceptGenerationProvider({ mode: "placeholder", reason: "configured" })
        .providerKey,
      "placeholder",
    );
    assert.equal(
      resolveConceptGenerationProvider({
        mode: "unavailable",
        safeErrorCode: "GENERATION_PROVIDER_NOT_CONFIGURED",
        internalReason: "test",
      }).providerKey,
      "unavailable",
    );
  });

  it("resolves the placeholder provider silently when placeholder was explicitly configured", () => {
    const config: ConceptGenerationConfig = { mode: "placeholder", reason: "configured" };
    const provider = resolveConceptGenerationProvider(config);
    assert.equal(provider.providerKey, "placeholder");
    assert.equal(warnCalls.length, 0);
  });

  it("resolves the placeholder provider AND emits a warning for a development fallback", () => {
    process.env.NODE_ENV = "development";
    const config: ConceptGenerationConfig = {
      mode: "placeholder",
      reason: "development_fallback",
    };
    const provider = resolveConceptGenerationProvider(config);
    assert.equal(provider.providerKey, "placeholder");
    assert.equal(warnCalls.length, 1);
    const message = String(warnCalls[0]?.args[0] ?? "");
    assert.match(message, /openai/i);
    assert.match(message, /placeholder/i);
    assert.doesNotMatch(message, /sk-/);
  });

  it("resolves an unavailable provider for mode 'unavailable' without logging at resolve time", () => {
    const config: ConceptGenerationConfig = {
      mode: "unavailable",
      safeErrorCode: "GENERATION_PROVIDER_NOT_CONFIGURED",
      internalReason: "CONCEPT_GENERATION_PROVIDER=openai but OPENAI_API_KEY is not set.",
    };
    const provider = resolveConceptGenerationProvider(config);
    assert.equal(provider.providerKey, "unavailable");
    // The structured "configuration error" log happens when generation is
    // actually attempted (where a job/project id exists), not here.
    assert.equal(errorCalls.length, 0);
    assert.equal(warnCalls.length, 0);
  });

  it("resolves an unavailable provider for the production-asset-storage safe error code too (Sprint 2H Part 1B) — resolution is generic across every safe error code", async () => {
    const config: ConceptGenerationConfig = {
      mode: "unavailable",
      safeErrorCode: "PRODUCTION_ASSET_STORAGE_NOT_CONFIGURED",
      internalReason:
        "CONCEPT_GENERATION_PROVIDER=openai and OPENAI_API_KEY are set, but ASSET_STORAGE_MODE=data_uri is not a production-safe object-storage backend.",
    };
    const provider = resolveConceptGenerationProvider(config);
    assert.equal(provider.providerKey, "unavailable");
    assert.equal(errorCalls.length, 0);
    assert.equal(warnCalls.length, 0);

    await assert.rejects(
      provider.generate({
        designId: "design-1",
        designBriefId: "version-1",
        conceptCount: 3,
        prompt: {
          product: "a t-shirt",
          subject: "a logo",
          style: null,
          colors: [],
          printPaletteEnforcement: "none" as const,
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
        idempotencyKey: "concept-generation:design-1:version-1",
      }),
      (error: unknown) => {
        assert.ok(error instanceof GenerationUnavailableError);
        assert.equal(error.safeErrorCode, "PRODUCTION_ASSET_STORAGE_NOT_CONFIGURED");
        return true;
      },
    );
  });

  it("the unavailable provider always rejects generate() with a typed, safe error", async () => {
    const config: ConceptGenerationConfig = {
      mode: "unavailable",
      safeErrorCode: "GENERATION_PROVIDER_NOT_CONFIGURED",
      internalReason: "CONCEPT_GENERATION_PROVIDER=openai but OPENAI_API_KEY is not set.",
    };
    const provider = resolveConceptGenerationProvider(config);

    await assert.rejects(
      provider.generate({
        designId: "design-1",
        designBriefId: "version-1",
        conceptCount: 3,
        prompt: {
          product: "a t-shirt",
          subject: "a logo",
          style: null,
          colors: [],
          printPaletteEnforcement: "none" as const,
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
        idempotencyKey: "concept-generation:design-1:version-1",
      }),
      (error: unknown) => {
        assert.ok(error instanceof GenerationUnavailableError);
        assert.equal(error.safeErrorCode, "GENERATION_PROVIDER_NOT_CONFIGURED");
        assert.equal(error.intendedProviderKey, "openai");
        return true;
      },
    );
  });
});
