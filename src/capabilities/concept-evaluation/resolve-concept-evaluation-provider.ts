import {
  getConceptEvaluationConfig,
  type ConceptEvaluationConfig,
} from "@/lib/config/concept-evaluation-provider-config";
import { logConceptEvaluationFallback } from "@/lib/config/concept-evaluation-provider-logging";
import { isAutomatedTestEnvironment } from "@/lib/config/automated-test-safety";

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
 *
 * Release-blocker hotfix: when `config` is omitted (the live-environment
 * default `getCapabilityGraph()`/`createCapabilityGraph()` always uses),
 * `isAutomatedTestEnvironment()` unconditionally forces
 * `PlaceholderConceptEvaluationProvider` — no network call is possible — no
 * matter what `CONCEPT_EVALUATION_PROVIDER`/`OPENAI_API_KEY` happen to be
 * set to in the ambient environment. A caller that passes an explicit
 * `config` (this module's own resolver unit tests) is unaffected — see
 * `lib/config/automated-test-safety.ts`. This matters beyond concept
 * evaluation's own pipeline: Sprint 2M Phase 2E's
 * `FinalArtworkWorkerCapability` also depends on this same resolver for
 * independent production-asset re-verification.
 */
export function resolveConceptEvaluationProvider(
  config?: ConceptEvaluationConfig,
): ConceptEvaluationProvider {
  if (config === undefined && isAutomatedTestEnvironment()) {
    return new PlaceholderConceptEvaluationProvider();
  }
  const resolvedConfig = config ?? getConceptEvaluationConfig();

  switch (resolvedConfig.mode) {
    case "openai":
      return new OpenAIConceptEvaluationProvider({
        apiKey: resolvedConfig.apiKey,
        model: resolvedConfig.model,
      });

    case "placeholder":
      if (resolvedConfig.reason === "fallback") {
        logConceptEvaluationFallback({
          requestedProvider: "openai",
          environment: process.env.NODE_ENV ?? "development",
        });
      }
      return new PlaceholderConceptEvaluationProvider();
  }
}
