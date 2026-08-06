import {
  getConceptEvaluationConfig,
  type ConceptEvaluationConfig,
} from "@/lib/config/concept-evaluation-provider-config";
import { logConceptEvaluationFallback } from "@/lib/config/concept-evaluation-provider-logging";

import type { ConceptEvaluationProvider } from "./concept-evaluation-provider";
import { OpenAIConceptEvaluationProvider } from "./openai-concept-evaluation-provider";
import { PlaceholderConceptEvaluationProvider } from "./placeholder-concept-evaluation-provider";

/**
 * Sprint 2I Phase 2: turns a `ConceptEvaluationConfig` decision into an
 * actual provider instance. Composition-layer concern, not a domain or
 * capability one — `ConceptEvaluationCapability` never inspects environment
 * variables itself (see `capability-boundaries.ts`).
 *
 * Never throws and never resolves to an "unavailable" provider — evaluation
 * is advisory-only, so a misconfigured `openai` request always resolves to
 * the deterministic placeholder evaluator instead (see
 * `concept-evaluation-provider-config.ts` for why this differs from concept
 * generation's fail-closed behavior).
 *
 * Accepts an explicit `config` (default: the live environment) so it can be
 * unit-tested without mutating `process.env`.
 */
export function resolveConceptEvaluationProvider(
  config: ConceptEvaluationConfig = getConceptEvaluationConfig(),
): ConceptEvaluationProvider {
  switch (config.mode) {
    case "openai":
      return new OpenAIConceptEvaluationProvider({
        apiKey: config.apiKey,
        model: config.model,
      });

    case "placeholder":
      if (config.reason === "fallback") {
        logConceptEvaluationFallback({
          requestedProvider: "openai",
          environment: process.env.NODE_ENV ?? "development",
        });
      }
      return new PlaceholderConceptEvaluationProvider();
  }
}
