import {
  getConceptGenerationConfig,
  type ConceptGenerationConfig,
} from "@/lib/config/generation-provider-config";
import { logConceptGenerationDevelopmentFallback } from "@/lib/config/generation-provider-logging";
import { isAutomatedTestEnvironment } from "@/lib/config/automated-test-safety";
import type { ConceptGenerationProvider } from "./concept-generation-provider";
import { OpenAIConceptGenerationProvider } from "./openai-concept-provider";
import { PlaceholderConceptProvider } from "./placeholder-concept-provider";
import { UnavailableConceptGenerationProvider } from "./unavailable-concept-provider";

/**
 * Sprint 2H Part 2A: real OpenAI generation stays off in every environment
 * — independent of how well provider credentials and asset storage are
 * configured — until this sprint's background-job/storage pipeline has
 * been fully verified end to end. A deliberate, reversible kill switch:
 * set `CONCEPT_GENERATION_ENABLE_REAL=true` to lift it. Read at call time
 * (not cached) to match every other config function in this codebase.
 */
function isRealGenerationEnabled(): boolean {
  return (
    (process.env.CONCEPT_GENERATION_ENABLE_REAL ?? "false").trim().toLowerCase() ===
    "true"
  );
}

/**
 * Sprint 2H Part 1A: turns a `ConceptGenerationConfig` decision into an
 * actual provider instance. Composition-layer concern, not a domain or
 * capability one — `ConceptGenerationCapability` never inspects
 * environment variables itself (see `capability-boundaries.ts`).
 *
 * Never throws: an "unavailable" configuration still resolves to a real
 * `ConceptGenerationProvider` (`UnavailableConceptGenerationProvider`) so
 * application startup never crashes on bad generation configuration —
 * failure is deferred to the moment generation is actually attempted,
 * where a real `GenerationJob`/customer message can represent it.
 *
 * Accepts an explicit `config` (default: the live environment) so it can
 * be unit-tested without mutating `process.env`.
 *
 * Release-blocker hotfix: when `config` is omitted (the live-environment
 * default `getCapabilityGraph()`/`createCapabilityGraph()` always uses),
 * `isAutomatedTestEnvironment()` unconditionally forces
 * `PlaceholderConceptProvider` — no network call is possible — no matter
 * what `CONCEPT_GENERATION_PROVIDER`/`CONCEPT_GENERATION_ENABLE_REAL`/
 * `OPENAI_API_KEY` happen to be set to in the ambient environment. A caller
 * that passes an explicit `config` (this module's own resolver unit tests)
 * is unaffected — see `lib/config/automated-test-safety.ts`.
 */
export function resolveConceptGenerationProvider(
  config?: ConceptGenerationConfig,
): ConceptGenerationProvider {
  if (config === undefined && isAutomatedTestEnvironment()) {
    return new PlaceholderConceptProvider();
  }
  const resolvedConfig = config ?? getConceptGenerationConfig();

  if (resolvedConfig.mode === "openai" && !isRealGenerationEnabled()) {
    return new UnavailableConceptGenerationProvider(
      "REAL_GENERATION_NOT_YET_ENABLED",
      "openai",
      "Real provider generation is intentionally disabled pending Sprint 2H Part 2A verification. Set CONCEPT_GENERATION_ENABLE_REAL=true to enable it.",
    );
  }

  switch (resolvedConfig.mode) {
    case "openai":
      return new OpenAIConceptGenerationProvider({
        apiKey: resolvedConfig.apiKey,
        model: resolvedConfig.model,
      });

    case "placeholder":
      if (resolvedConfig.reason === "development_fallback") {
        logConceptGenerationDevelopmentFallback({
          requestedProvider: "openai",
          environment: process.env.NODE_ENV ?? "development",
        });
      }
      return new PlaceholderConceptProvider();

    case "unavailable":
      return new UnavailableConceptGenerationProvider(
        resolvedConfig.safeErrorCode,
        "openai",
        resolvedConfig.internalReason,
      );
  }
}
