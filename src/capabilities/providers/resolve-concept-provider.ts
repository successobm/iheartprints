import {
  getConceptGenerationConfig,
  type ConceptGenerationConfig,
} from "@/lib/config/generation-provider-config";
import { logConceptGenerationDevelopmentFallback } from "@/lib/config/generation-provider-logging";
import type { ConceptGenerationProvider } from "./concept-generation-provider";
import { OpenAIConceptGenerationProvider } from "./openai-concept-provider";
import { PlaceholderConceptProvider } from "./placeholder-concept-provider";
import { UnavailableConceptGenerationProvider } from "./unavailable-concept-provider";

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
 */
export function resolveConceptGenerationProvider(
  config: ConceptGenerationConfig = getConceptGenerationConfig(),
): ConceptGenerationProvider {
  switch (config.mode) {
    case "openai":
      return new OpenAIConceptGenerationProvider({
        apiKey: config.apiKey,
        model: config.model,
      });

    case "placeholder":
      if (config.reason === "development_fallback") {
        logConceptGenerationDevelopmentFallback({
          requestedProvider: "openai",
          environment: process.env.NODE_ENV ?? "development",
        });
      }
      return new PlaceholderConceptProvider();

    case "unavailable":
      return new UnavailableConceptGenerationProvider(
        config.safeErrorCode,
        "openai",
        config.internalReason,
      );
  }
}
