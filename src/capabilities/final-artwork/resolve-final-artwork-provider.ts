import { LocalRasterInterpolationProvider } from "./local-raster-provider";
import type { FinalArtworkProvider } from "./provider";

/**
 * Sprint 2M Phase 2C (Goal 6/20): composition-owned provider resolution —
 * mirrors `resolveConceptGenerationProvider`/`resolveConceptEvaluationProvider`'s
 * shape (a single, testable resolution function; environment selection
 * never scattered into conversation/UI code) even though Phase 2C only
 * implements one provider.
 *
 * `LocalRasterInterpolationProvider` performs no network call and no paid
 * request — there is nothing to gate behind a kill switch today. If a
 * future phase adds a real provider-hosted reconstruction adapter, it must
 * be wired here behind its own explicit opt-in env var and default OFF,
 * exactly like `CONCEPT_GENERATION_ENABLE_REAL` (Goal 20) — never silently
 * enabled by this function's default branch.
 */
export function resolveFinalArtworkProvider(): FinalArtworkProvider {
  return new LocalRasterInterpolationProvider();
}
