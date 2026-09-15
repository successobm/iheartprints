import { getRasterReconstructionProviderConfig } from "@/lib/config/raster-reconstruction-provider-config";
import { isAutomatedTestEnvironment } from "@/lib/config/automated-test-safety";

import { PlaceholderRasterReconstructionProvider } from "./placeholder-raster-reconstruction-provider";
import { OpenAIRasterReconstructionProvider } from "./openai-raster-reconstruction-provider";
import type { RasterReconstructionProvider } from "./raster-reconstruction-provider";
import type { RasterReconstructionProviderConfig } from "@/lib/config/raster-reconstruction-provider-config";

/**
 * Phase R5: turns a `RasterReconstructionProviderConfig` decision into an
 * actual provider instance — composition-layer concern, mirroring
 * `resolve-artwork-fidelity-proposal-provider.ts` exactly, including its
 * hard test-safety rule: no test can ever reach the real OpenAI provider
 * regardless of ambient `RASTER_RECONSTRUCTION_PROVIDER`/`OPENAI_API_KEY`.
 */
export function resolveRasterReconstructionProvider(
  config?: RasterReconstructionProviderConfig,
): RasterReconstructionProvider {
  if (config === undefined && isAutomatedTestEnvironment()) {
    return new PlaceholderRasterReconstructionProvider();
  }
  const resolvedConfig = config ?? getRasterReconstructionProviderConfig();

  switch (resolvedConfig.mode) {
    case "openai":
      return new OpenAIRasterReconstructionProvider({
        apiKey: resolvedConfig.apiKey,
        model: resolvedConfig.model,
      });
    case "placeholder":
      return new PlaceholderRasterReconstructionProvider();
  }
}
