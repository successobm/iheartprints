/**
 * Phase R5: the safe, network-free default — mirrors
 * `PlaceholderArtworkFidelityProposalProvider`'s role, but reconstruction
 * has no honest "empty" success the way an advisory proposal does (there is
 * no such thing as "successfully reconstructed nothing"). Refuses outright
 * with a clear, typed error rather than fabricating output or silently
 * returning the untouched source — see `resolve-raster-reconstruction
 * -provider.ts` for when this is selected (no provider configured, or
 * unconditionally under `isAutomatedTestEnvironment()`).
 */

import { ProviderError } from "@/capabilities/providers/provider-error";

import type { RasterReconstructionProvider } from "./raster-reconstruction-provider";
import type { RasterReconstructionRequest, RasterReconstructionResult } from "./contracts";

export class PlaceholderRasterReconstructionProvider implements RasterReconstructionProvider {
  readonly providerKey = "placeholder_raster_reconstruction";

  async reconstruct(
    _request: RasterReconstructionRequest,
  ): Promise<RasterReconstructionResult> {
    throw new ProviderError(
      "unavailable",
      "Artwork reconstruction is not configured in this environment.",
    );
  }
}
