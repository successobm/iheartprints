/**
 * Sprint 2H Part 1: provider selection is configuration-driven, never
 * hardcoded. Adding a new provider (Recraft, Flux, Ideogram, Stable
 * Diffusion, ...) means adding one more branch where this config is
 * consumed, plus one adapter file — never a domain or capability change.
 *
 * Sprint 2H Part 1A: this function is now an explicit, environment-aware
 * decision rather than a silent fallback. Requesting `openai` without an
 * API key resolves differently depending on environment:
 *   - outside production: `placeholder` with `reason: "development_fallback"`
 *     — convenient for local dev/tests, but the caller is expected to warn.
 *   - in production: `unavailable` — misconfiguration is never silently
 *     downgraded to placeholder concepts a customer could mistake for real
 *     generated artwork.
 *
 * Sprint 2H Part 1B: a real provider key is necessary but not sufficient in
 * production. Real provider generation may run only when BOTH are true:
 *   1. a real provider is properly configured (Part 1A, above)
 *   2. a production-safe object-storage asset backend is configured
 *      (`ASSET_STORAGE_MODE` — see `asset-storage-config.ts`)
 * `CONCEPT_GENERATION_PROVIDER=openai` + a valid key + `ASSET_STORAGE_MODE`
 * still `data_uri` in production also resolves to `unavailable` — never
 * silently downgraded to `placeholder` (only an explicit
 * `CONCEPT_GENERATION_PROVIDER=placeholder` selects placeholder), and never
 * silently upgraded to `openai` just because a key exists. Outside
 * production, `data_uri` remains fine (local dev, automated tests,
 * placeholder concepts, architecture verification) — the gate below only
 * ever fires when `NODE_ENV === "production"`.
 *
 * Pure and side-effect-free (no logging here) so it stays trivially
 * testable — logging belongs to whatever consumes the result.
 */

import {
  getAssetStorageMode,
  isProductionSafeAssetStorageMode,
  type AssetStorageMode,
} from "./asset-storage-config";

/**
 * Sprint 2H Part 1B: the class of blocker behind an `unavailable` result —
 * never a secret, safe to surface in server logs (and, if ever needed,
 * status/health tooling). `GENERATION_PROVIDER_NOT_CONFIGURED` is a
 * provider-credential problem; `PRODUCTION_ASSET_STORAGE_NOT_CONFIGURED` is
 * a storage-backend problem. Kept as a plain literal union (rather than
 * imported from `capabilities/providers`) so this composition-layer module
 * never depends on a capability — see `capability-boundaries.ts`; providers
 * depend on config, not the reverse.
 */
export type GenerationUnavailableSafeErrorCode =
  | "GENERATION_PROVIDER_NOT_CONFIGURED"
  | "PRODUCTION_ASSET_STORAGE_NOT_CONFIGURED";

export type ConceptGenerationConfig =
  | {
      mode: "placeholder";
      /**
       * "configured" — placeholder was explicitly selected (or is simply
       * the default with nothing else requested); always allowed.
       * "development_fallback" — `openai` was requested but couldn't be
       * used outside production; only ever returned when NODE_ENV is not
       * "production".
       */
      reason: "configured" | "development_fallback";
    }
  | {
      mode: "openai";
      apiKey: string;
      model: string;
    }
  | {
      mode: "unavailable";
      safeErrorCode: GenerationUnavailableSafeErrorCode;
      /** Non-secret, server-log-only description. Never a customer-facing string. */
      internalReason: string;
    };

const DEFAULT_OPENAI_MODEL = "gpt-image-1";

export function getConceptGenerationConfig(
  assetStorageMode: AssetStorageMode = getAssetStorageMode(),
): ConceptGenerationConfig {
  const requestedProvider = (process.env.CONCEPT_GENERATION_PROVIDER ?? "placeholder")
    .trim()
    .toLowerCase();

  if (requestedProvider !== "openai") {
    return { mode: "placeholder", reason: "configured" };
  }

  const apiKey = process.env.OPENAI_API_KEY?.trim() || "";
  const model = process.env.OPENAI_IMAGE_MODEL?.trim() || DEFAULT_OPENAI_MODEL;
  const isProduction = process.env.NODE_ENV === "production";

  if (!apiKey) {
    if (isProduction) {
      return {
        mode: "unavailable",
        safeErrorCode: "GENERATION_PROVIDER_NOT_CONFIGURED",
        internalReason:
          "CONCEPT_GENERATION_PROVIDER=openai but OPENAI_API_KEY is not set in a production environment.",
      };
    }
    return { mode: "placeholder", reason: "development_fallback" };
  }

  if (isProduction && !isProductionSafeAssetStorageMode(assetStorageMode)) {
    return {
      mode: "unavailable",
      safeErrorCode: "PRODUCTION_ASSET_STORAGE_NOT_CONFIGURED",
      internalReason:
        `CONCEPT_GENERATION_PROVIDER=openai and OPENAI_API_KEY are set, but ` +
        `ASSET_STORAGE_MODE=${assetStorageMode} is not a production-safe ` +
        "object-storage backend in a production environment.",
    };
  }

  return { mode: "openai", apiKey, model };
}

/**
 * Sprint 2H Part 1B: the same policy collapsed to a single readiness
 * question, for callers that only need "can real generation run right now"
 * without resolving a full provider (e.g. a future health/status surface).
 * Never a secret — only reports the blocker class + a non-secret reason,
 * matching `ConceptGenerationConfig`'s `unavailable` variant exactly.
 */
export type GenerationReadiness =
  | { ready: true }
  | {
      ready: false;
      safeErrorCode: GenerationUnavailableSafeErrorCode;
      internalReason: string;
    };

export function evaluateGenerationReadiness(
  config: ConceptGenerationConfig = getConceptGenerationConfig(),
): GenerationReadiness {
  if (config.mode === "unavailable") {
    return {
      ready: false,
      safeErrorCode: config.safeErrorCode,
      internalReason: config.internalReason,
    };
  }
  return { ready: true };
}

/** `true` unless configuration would block generation outright (`unavailable`). */
export function isProductionSafeForRealGeneration(
  config: ConceptGenerationConfig = getConceptGenerationConfig(),
): boolean {
  return evaluateGenerationReadiness(config).ready;
}
