import {
  getFinalArtworkProviderConfig,
  type FinalArtworkProviderConfig,
} from "@/lib/config/final-artwork-provider-config";
import { logFinalArtworkProviderUnavailable } from "@/lib/config/final-artwork-provider-logging";
import { isAutomatedTestEnvironment } from "@/lib/config/automated-test-safety";

import { LocalRasterInterpolationProvider } from "./local-raster-provider";
import { TopazTransparencyUpscaleProvider } from "./topaz-transparency-upscale-provider";
import { UnavailableFinalArtworkProvider } from "./unavailable-final-artwork-provider";
import type { FinalArtworkProvider } from "./provider";

/**
 * Sprint 2M Phase 2C (Goal 6/20): composition-owned provider resolution —
 * mirrors `resolveConceptGenerationProvider`/`resolveConceptEvaluationProvider`'s
 * shape (a single, testable resolution function; environment selection
 * never scattered into conversation/UI code).
 *
 * Sprint 2M Phase 2E: `FINAL_ARTWORK_PROVIDER=local` (the default, and the
 * safe fallback for any unrecognized value) resolves
 * `LocalRasterInterpolationProvider` — no network call, no paid request.
 * `FINAL_ARTWORK_PROVIDER=topaz` resolves the real Topaz Transparency
 * Upscale adapter when `TOPAZ_API_KEY` is configured, or
 * `UnavailableFinalArtworkProvider` otherwise — which always fails the job
 * as an infrastructure problem rather than silently falling back to local
 * interpolation and letting that be mistaken for equivalent production
 * quality (Goal 16).
 *
 * Accepts an explicit `config` (default: the live environment) so it can be
 * unit-tested without mutating `process.env`.
 *
 * Release-blocker hotfix: when `config` is omitted (the live-environment
 * default `getCapabilityGraph()`/`createCapabilityGraph()` always uses),
 * `isAutomatedTestEnvironment()` unconditionally forces
 * `LocalRasterInterpolationProvider` — no network call is possible — no
 * matter what `FINAL_ARTWORK_PROVIDER`/`TOPAZ_API_KEY` happen to be set to
 * in the ambient environment. A caller that passes an explicit `config`
 * (this module's own resolver unit tests) is unaffected — see
 * `lib/config/automated-test-safety.ts` for the full rationale.
 */
export function resolveFinalArtworkProvider(
  config?: FinalArtworkProviderConfig,
): FinalArtworkProvider {
  if (config === undefined && isAutomatedTestEnvironment()) {
    return new LocalRasterInterpolationProvider();
  }
  const resolvedConfig = config ?? getFinalArtworkProviderConfig();

  switch (resolvedConfig.mode) {
    case "topaz":
      return new TopazTransparencyUpscaleProvider({ apiKey: resolvedConfig.apiKey });

    case "unavailable":
      logFinalArtworkProviderUnavailable({
        safeErrorCode: resolvedConfig.safeErrorCode,
        intendedProvider: "topaz",
        internalReason: resolvedConfig.internalReason,
      });
      return new UnavailableFinalArtworkProvider(
        resolvedConfig.safeErrorCode,
        "topaz",
        resolvedConfig.internalReason,
      );

    case "local":
    default:
      return new LocalRasterInterpolationProvider();
  }
}
