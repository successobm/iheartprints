import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

const ENV_KEYS = [
  "CONCEPT_GENERATION_PROVIDER",
  "OPENAI_API_KEY",
  "OPENAI_IMAGE_MODEL",
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

describe("getConceptGenerationConfig", () => {
  const originalEnv = snapshotEnv();

  afterEach(() => {
    restoreEnv(originalEnv);
  });

  it("defaults to placeholder ('configured') when nothing is requested", async () => {
    restoreEnv({});
    const { getConceptGenerationConfig } = await import(
      "./generation-provider-config"
    );
    assert.deepEqual(getConceptGenerationConfig(), {
      mode: "placeholder",
      reason: "configured",
    });
  });

  it("selects openai when explicitly configured with a key present", async () => {
    process.env.CONCEPT_GENERATION_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "sk-test-key";
    const { getConceptGenerationConfig } = await import(
      "./generation-provider-config"
    );
    const config = getConceptGenerationConfig();
    assert.equal(config.mode, "openai");
    assert.equal(config.mode === "openai" && config.apiKey, "sk-test-key");
  });

  it("is case-insensitive and tolerant of surrounding whitespace in the provider name", async () => {
    process.env.CONCEPT_GENERATION_PROVIDER = "  OpenAI  ";
    process.env.OPENAI_API_KEY = "sk-test-key";
    const { getConceptGenerationConfig } = await import(
      "./generation-provider-config"
    );
    assert.equal(getConceptGenerationConfig().mode, "openai");
  });

  it("falls back to placeholder for an unrecognized provider key, in any environment", async () => {
    process.env.CONCEPT_GENERATION_PROVIDER = "recraft";
    process.env.NODE_ENV = "production";
    const { getConceptGenerationConfig } = await import(
      "./generation-provider-config"
    );
    assert.deepEqual(getConceptGenerationConfig(), {
      mode: "placeholder",
      reason: "configured",
    });
  });

  it("defaults the OpenAI model when not overridden, and honors an override", async () => {
    process.env.CONCEPT_GENERATION_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "sk-test-key";
    const { getConceptGenerationConfig } = await import(
      "./generation-provider-config"
    );
    let config = getConceptGenerationConfig();
    assert.equal(config.mode === "openai" && config.model, "gpt-image-1");

    process.env.OPENAI_IMAGE_MODEL = "dall-e-3";
    config = getConceptGenerationConfig();
    assert.equal(config.mode === "openai" && config.model, "dall-e-3");
  });

  describe("outside production (development / test / unset)", () => {
    for (const env of ["development", "test", undefined]) {
      it(`falls back to placeholder with reason "development_fallback" when openai is requested without a key (NODE_ENV=${env})`, async () => {
        process.env.CONCEPT_GENERATION_PROVIDER = "openai";
        delete process.env.OPENAI_API_KEY;
        if (env === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = env;

        const { getConceptGenerationConfig } = await import(
          "./generation-provider-config"
        );
        assert.deepEqual(getConceptGenerationConfig(), {
          mode: "placeholder",
          reason: "development_fallback",
        });
      });
    }

    it("treats a blank (whitespace-only) API key the same as a missing one", async () => {
      process.env.CONCEPT_GENERATION_PROVIDER = "openai";
      process.env.OPENAI_API_KEY = "   ";
      process.env.NODE_ENV = "development";
      const { getConceptGenerationConfig } = await import(
        "./generation-provider-config"
      );
      assert.deepEqual(getConceptGenerationConfig(), {
        mode: "placeholder",
        reason: "development_fallback",
      });
    });
  });

  describe("production", () => {
    it("reports 'unavailable' with a safe error code when openai is requested without a key", async () => {
      process.env.CONCEPT_GENERATION_PROVIDER = "openai";
      delete process.env.OPENAI_API_KEY;
      process.env.NODE_ENV = "production";
      const { getConceptGenerationConfig } = await import(
        "./generation-provider-config"
      );
      const config = getConceptGenerationConfig();
      assert.equal(config.mode, "unavailable");
      assert.equal(
        config.mode === "unavailable" && config.safeErrorCode,
        "GENERATION_PROVIDER_NOT_CONFIGURED",
      );
    });

    it("never leaks a secret into internalReason", async () => {
      process.env.CONCEPT_GENERATION_PROVIDER = "openai";
      delete process.env.OPENAI_API_KEY;
      process.env.NODE_ENV = "production";
      const { getConceptGenerationConfig } = await import(
        "./generation-provider-config"
      );
      const config = getConceptGenerationConfig();
      assert.equal(config.mode, "unavailable");
      const reason = config.mode === "unavailable" ? config.internalReason : "";
      assert.doesNotMatch(reason, /sk-|api[_-]?key\s*=|Bearer/i);
    });

    it("treats a blank API key as unavailable, not as configured", async () => {
      process.env.CONCEPT_GENERATION_PROVIDER = "openai";
      process.env.OPENAI_API_KEY = "   ";
      process.env.NODE_ENV = "production";
      const { getConceptGenerationConfig } = await import(
        "./generation-provider-config"
      );
      assert.equal(getConceptGenerationConfig().mode, "unavailable");
    });

    it("selects openai in production when a real key is present AND a production-safe asset backend is configured", async () => {
      process.env.CONCEPT_GENERATION_PROVIDER = "openai";
      process.env.OPENAI_API_KEY = "sk-real-key";
      process.env.NODE_ENV = "production";
      process.env.ASSET_STORAGE_MODE = "s3";
      const { getConceptGenerationConfig } = await import(
        "./generation-provider-config"
      );
      assert.equal(getConceptGenerationConfig().mode, "openai");
    });

    it("allows placeholder in production when explicitly configured", async () => {
      process.env.CONCEPT_GENERATION_PROVIDER = "placeholder";
      process.env.NODE_ENV = "production";
      const { getConceptGenerationConfig } = await import(
        "./generation-provider-config"
      );
      assert.deepEqual(getConceptGenerationConfig(), {
        mode: "placeholder",
        reason: "configured",
      });
    });

    it("allows placeholder in production via the unset default", async () => {
      delete process.env.CONCEPT_GENERATION_PROVIDER;
      process.env.NODE_ENV = "production";
      const { getConceptGenerationConfig } = await import(
        "./generation-provider-config"
      );
      assert.deepEqual(getConceptGenerationConfig(), {
        mode: "placeholder",
        reason: "configured",
      });
    });

    describe("production-safe asset storage gate (Sprint 2H Part 1B)", () => {
      it("blocks openai in production when a real key is present but ASSET_STORAGE_MODE is still data_uri (the current default)", async () => {
        process.env.CONCEPT_GENERATION_PROVIDER = "openai";
        process.env.OPENAI_API_KEY = "sk-real-key";
        process.env.NODE_ENV = "production";
        delete process.env.ASSET_STORAGE_MODE; // defaults to data_uri
        const { getConceptGenerationConfig } = await import(
          "./generation-provider-config"
        );
        const config = getConceptGenerationConfig();
        assert.equal(config.mode, "unavailable");
        assert.equal(
          config.mode === "unavailable" && config.safeErrorCode,
          "PRODUCTION_ASSET_STORAGE_NOT_CONFIGURED",
        );
      });

      it("blocks openai in production when ASSET_STORAGE_MODE is explicitly data_uri", async () => {
        process.env.CONCEPT_GENERATION_PROVIDER = "openai";
        process.env.OPENAI_API_KEY = "sk-real-key";
        process.env.NODE_ENV = "production";
        process.env.ASSET_STORAGE_MODE = "data_uri";
        const { getConceptGenerationConfig } = await import(
          "./generation-provider-config"
        );
        assert.equal(getConceptGenerationConfig().mode, "unavailable");
      });

      it("never leaks a secret into the asset-storage-blocked internalReason", async () => {
        process.env.CONCEPT_GENERATION_PROVIDER = "openai";
        process.env.OPENAI_API_KEY = "sk-real-key";
        process.env.NODE_ENV = "production";
        process.env.ASSET_STORAGE_MODE = "data_uri";
        const { getConceptGenerationConfig } = await import(
          "./generation-provider-config"
        );
        const config = getConceptGenerationConfig();
        const reason = config.mode === "unavailable" ? config.internalReason : "";
        assert.doesNotMatch(reason, /sk-|api[_-]?key\s*=|Bearer/i);
      });

      it("allows openai in production once a production-safe storage mode is configured — configuration-layer readiness only, no storage backend is implemented by this", async () => {
        process.env.CONCEPT_GENERATION_PROVIDER = "openai";
        process.env.OPENAI_API_KEY = "sk-real-key";
        process.env.NODE_ENV = "production";

        for (const mode of ["supabase_storage", "s3"]) {
          process.env.ASSET_STORAGE_MODE = mode;
          const { getConceptGenerationConfig } = await import(
            "./generation-provider-config"
          );
          assert.equal(getConceptGenerationConfig().mode, "openai");
        }
      });

      it("never blocks placeholder in production regardless of ASSET_STORAGE_MODE — no real image payload is ever produced", async () => {
        process.env.CONCEPT_GENERATION_PROVIDER = "placeholder";
        process.env.NODE_ENV = "production";
        process.env.ASSET_STORAGE_MODE = "data_uri";
        const { getConceptGenerationConfig } = await import(
          "./generation-provider-config"
        );
        assert.deepEqual(getConceptGenerationConfig(), {
          mode: "placeholder",
          reason: "configured",
        });
      });
    });
  });

  describe("outside production, ASSET_STORAGE_MODE never blocks openai (Sprint 2H Part 1B)", () => {
    for (const env of ["development", "test"]) {
      it(`allows openai with a real key and data_uri storage in ${env}`, async () => {
        process.env.CONCEPT_GENERATION_PROVIDER = "openai";
        process.env.OPENAI_API_KEY = "sk-real-key";
        process.env.NODE_ENV = env;
        process.env.ASSET_STORAGE_MODE = "data_uri";
        const { getConceptGenerationConfig } = await import(
          "./generation-provider-config"
        );
        assert.equal(getConceptGenerationConfig().mode, "openai");
      });
    }
  });

  describe("evaluateGenerationReadiness / isProductionSafeForRealGeneration", () => {
    it("reports ready:true for an openai config", async () => {
      const { evaluateGenerationReadiness, isProductionSafeForRealGeneration } =
        await import("./generation-provider-config");
      const config = {
        mode: "openai" as const,
        apiKey: "sk-real-key",
        model: "gpt-image-1",
      };
      assert.deepEqual(evaluateGenerationReadiness(config), { ready: true });
      assert.equal(isProductionSafeForRealGeneration(config), true);
    });

    it("reports ready:true for a placeholder config", async () => {
      const { evaluateGenerationReadiness } = await import(
        "./generation-provider-config"
      );
      assert.deepEqual(
        evaluateGenerationReadiness({ mode: "placeholder", reason: "configured" }),
        { ready: true },
      );
    });

    it("reports ready:false with the safe error code and reason for an unavailable config", async () => {
      const { evaluateGenerationReadiness, isProductionSafeForRealGeneration } =
        await import("./generation-provider-config");
      const config = {
        mode: "unavailable" as const,
        safeErrorCode: "PRODUCTION_ASSET_STORAGE_NOT_CONFIGURED" as const,
        internalReason: "ASSET_STORAGE_MODE=data_uri is not production-safe.",
      };
      assert.deepEqual(evaluateGenerationReadiness(config), {
        ready: false,
        safeErrorCode: "PRODUCTION_ASSET_STORAGE_NOT_CONFIGURED",
        internalReason: "ASSET_STORAGE_MODE=data_uri is not production-safe.",
      });
      assert.equal(isProductionSafeForRealGeneration(config), false);
    });
  });
});
