/**
 * Signs Phase S4.2A: provider selection for semantic rigid-sign
 * preservation verification — configuration-driven, mirroring
 * `concept-evaluation-provider-config.ts`'s own shape exactly.
 *
 * Unlike Concept Evaluation's config (advisory-only, so a misconfigured
 * provider safely falls back everywhere), this gate is BLOCKING —
 * `preservationStatus = preserved` is the value it exists to authorize.
 * The fallback here is safe for a different, stronger reason: a
 * misconfigured/absent provider resolves to `PlaceholderSignPreservationSemanticProvider`,
 * which answers every category `cannot_determine` and can therefore never
 * produce `preserved` by construction (`deriveSemanticVerdict`). A
 * misconfigured semantic provider in production means rigid signs
 * requiring reconstruction simply stay `finalization_required` forever —
 * never that one is wrongly certified ready. Fail-closed, never
 * fail-open.
 *
 * `OPENAI_SIGN_PRESERVATION_MODEL`'s default below is a DOCUMENTED
 * PLACEHOLDER — the real model id/snapshot is pinned only at Signs Phase
 * S4.2B's explicit live-call authorization, never invoked this phase (no
 * `OPENAI_API_KEY`-dependent code path runs in any test or build step).
 *
 * Pure and side-effect-free, exactly like its concept-evaluation sibling.
 */

/**
 * Documented placeholder only — the real pinned model/snapshot is chosen
 * at Signs Phase S4.2B's own explicit authorization step, informed by
 * whatever is actually available and priced at that time. Never invoked
 * this phase.
 */
const DEFAULT_OPENAI_SIGN_PRESERVATION_MODEL = "gpt-5.6-sol";

export type SignPreservationSemanticProviderConfig =
  | {
      mode: "placeholder";
      /**
       * "configured" — placeholder was explicitly selected, or is simply
       * the default with nothing else requested.
       * "fallback" — `openai` was requested but `OPENAI_API_KEY` is not
       * set. Safe in every environment (see module doc): the gate simply
       * never opens rather than opening incorrectly.
       */
      reason: "configured" | "fallback";
    }
  | {
      mode: "openai";
      apiKey: string;
      model: string;
    };

export function getSignPreservationSemanticProviderConfig(): SignPreservationSemanticProviderConfig {
  const requestedProvider = (
    process.env.SIGN_PRESERVATION_SEMANTIC_PROVIDER ?? "placeholder"
  )
    .trim()
    .toLowerCase();

  if (requestedProvider !== "openai") {
    return { mode: "placeholder", reason: "configured" };
  }

  // Reuses the same OpenAI credential as concept generation/evaluation —
  // same vendor account/key; this gate does not require its own separate
  // secret.
  const apiKey = process.env.OPENAI_API_KEY?.trim() || "";
  if (!apiKey) {
    return { mode: "placeholder", reason: "fallback" };
  }

  const model =
    process.env.OPENAI_SIGN_PRESERVATION_MODEL?.trim() ||
    DEFAULT_OPENAI_SIGN_PRESERVATION_MODEL;

  return { mode: "openai", apiKey, model };
}
