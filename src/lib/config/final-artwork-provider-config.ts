/**
 * Sprint 2M Phase 2E: provider selection for `FinalArtworkProvider` is
 * configuration-driven, never hardcoded — mirrors
 * `generation-provider-config.ts`'s shape (pure, side-effect-free, testable
 * without mutating `process.env`).
 *
 * `FINAL_ARTWORK_PROVIDER=local | topaz`. Default is `local`
 * (`LocalRasterInterpolationProvider` — no network call, no paid request,
 * safe in every environment including a fresh checkout with no
 * configuration at all).
 *
 * Deliberately NOT coupled to `OPENAI_API_KEY`, `CONCEPT_GENERATION_PROVIDER`,
 * `CONCEPT_GENERATION_ENABLE_REAL`, or `CONVERSATION_UNDERSTANDING_PROVIDER`
 * — final-artwork reconstruction is its own independent provider boundary
 * with its own credential (`TOPAZ_API_KEY`) and its own explicit opt-in,
 * exactly as isolated as concept generation's own provider selection is
 * from every other provider boundary in this codebase.
 *
 * `topaz` without `TOPAZ_API_KEY` always resolves to `unavailable` — in
 * every environment, not just production. Unlike concept generation (which
 * has a lenient "outside production, silently fall back to placeholder"
 * mode for local dev convenience), a misconfigured Topaz request must never
 * silently fall back to local interpolation and then let that be mistaken
 * for equivalent production quality (Goal 16) — so this module fails closed
 * everywhere. `FinalArtworkWorkerCapability` treats `unavailable` as an
 * infrastructure failure: the job fails/can be retried, and it never marks
 * `PrintProject.status = "print_ready"`.
 */

export type FinalArtworkUnavailableSafeErrorCode =
  | "FINAL_ARTWORK_PROVIDER_NOT_CONFIGURED";

export type FinalArtworkProviderConfig =
  | { mode: "local" }
  | { mode: "topaz"; apiKey: string }
  | {
      mode: "unavailable";
      safeErrorCode: FinalArtworkUnavailableSafeErrorCode;
      /** Non-secret, server-log-only description. Never a customer-facing string, never the key itself. */
      internalReason: string;
    };

export function getFinalArtworkProviderConfig(): FinalArtworkProviderConfig {
  const requested = (process.env.FINAL_ARTWORK_PROVIDER ?? "local").trim().toLowerCase();

  if (requested !== "topaz") {
    // Any unrecognized value also falls back to the safe default rather
    // than throwing — mirrors `generation-provider-config.ts`'s "never
    // silently upgrade" posture in reverse: never silently *select* a paid
    // provider from a typo either.
    return { mode: "local" };
  }

  const apiKey = process.env.TOPAZ_API_KEY?.trim() || "";
  if (!apiKey) {
    return {
      mode: "unavailable",
      safeErrorCode: "FINAL_ARTWORK_PROVIDER_NOT_CONFIGURED",
      internalReason:
        "FINAL_ARTWORK_PROVIDER=topaz but TOPAZ_API_KEY is not set.",
    };
  }

  return { mode: "topaz", apiKey };
}
