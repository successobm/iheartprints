import { getArtworkFidelityProposalProviderConfig } from "@/lib/config/artwork-fidelity-proposal-provider-config";
import { isAutomatedTestEnvironment } from "@/lib/config/automated-test-safety";

import { PlaceholderArtworkFidelityProposalProvider } from "./placeholder-artwork-fidelity-proposal-provider";
import { OpenAIArtworkFidelityProposalProvider } from "./openai-artwork-fidelity-proposal-provider";
import type { ArtworkFidelityProposalProvider } from "./artwork-fidelity-proposal-provider";
import type { ArtworkFidelityProposalProviderConfig } from "@/lib/config/artwork-fidelity-proposal-provider-config";

/**
 * Universal Raster Reconstruction Phase R4A: turns an
 * `ArtworkFidelityProposalProviderConfig` decision into an actual provider
 * instance — composition-layer concern, mirroring
 * `resolve-sign-preservation-semantic-provider.ts`/
 * `resolve-concept-evaluation-provider.ts` exactly.
 *
 * When `config` is omitted (the live-environment default),
 * `isAutomatedTestEnvironment()` unconditionally forces
 * `PlaceholderArtworkFidelityProposalProvider` — no network call is
 * possible from any test, no matter what
 * `ARTWORK_FIDELITY_PROPOSAL_PROVIDER`/`OPENAI_API_KEY` happen to be set to
 * in the ambient environment. A caller that passes an explicit `config`
 * (this module's own resolver unit tests) is unaffected.
 */
export function resolveArtworkFidelityProposalProvider(
  config?: ArtworkFidelityProposalProviderConfig,
): ArtworkFidelityProposalProvider {
  if (config === undefined && isAutomatedTestEnvironment()) {
    return new PlaceholderArtworkFidelityProposalProvider();
  }
  const resolvedConfig = config ?? getArtworkFidelityProposalProviderConfig();

  switch (resolvedConfig.mode) {
    case "openai":
      return new OpenAIArtworkFidelityProposalProvider({
        apiKey: resolvedConfig.apiKey,
        model: resolvedConfig.model,
      });
    case "placeholder":
      return new PlaceholderArtworkFidelityProposalProvider();
  }
}
