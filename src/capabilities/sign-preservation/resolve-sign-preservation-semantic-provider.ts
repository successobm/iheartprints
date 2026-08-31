import { getSignPreservationSemanticProviderConfig } from "@/lib/config/sign-preservation-semantic-provider-config";
import { isAutomatedTestEnvironment } from "@/lib/config/automated-test-safety";

import { PlaceholderSignPreservationSemanticProvider } from "./placeholder-sign-preservation-semantic-provider";
import { OpenAISignPreservationSemanticProvider } from "./openai-sign-preservation-semantic-provider";
import type { SignPreservationSemanticProvider } from "./sign-preservation-semantic-provider";
import type { SignPreservationSemanticProviderConfig } from "@/lib/config/sign-preservation-semantic-provider-config";

/**
 * Signs Phase S4.2A: turns a `SignPreservationSemanticProviderConfig`
 * decision into an actual provider instance — composition-layer concern,
 * mirroring `resolve-concept-evaluation-provider.ts` exactly.
 *
 * When `config` is omitted (the live-environment default),
 * `isAutomatedTestEnvironment()` unconditionally forces
 * `PlaceholderSignPreservationSemanticProvider` — no network call is
 * possible from any test, no matter what
 * `SIGN_PRESERVATION_SEMANTIC_PROVIDER`/`OPENAI_API_KEY` happen to be set
 * to in the ambient environment. A caller that passes an explicit `config`
 * (this module's own resolver unit tests) is unaffected. This is Signs
 * Phase S4.2A's OWN forcing, structurally identical to but independent of
 * `resolveConceptEvaluationProvider`'s and `resolveSignReconstructionProvider`-
 * equivalent forcing elsewhere.
 */
export function resolveSignPreservationSemanticProvider(
  config?: SignPreservationSemanticProviderConfig,
): SignPreservationSemanticProvider {
  if (config === undefined && isAutomatedTestEnvironment()) {
    return new PlaceholderSignPreservationSemanticProvider();
  }
  const resolvedConfig = config ?? getSignPreservationSemanticProviderConfig();

  switch (resolvedConfig.mode) {
    case "openai":
      return new OpenAISignPreservationSemanticProvider({
        apiKey: resolvedConfig.apiKey,
        model: resolvedConfig.model,
      });
    case "placeholder":
      return new PlaceholderSignPreservationSemanticProvider();
  }
}
