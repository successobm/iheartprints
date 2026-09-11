/**
 * Universal Raster Reconstruction Phase R4A: provider selection for
 * artwork fidelity proposal extraction — configuration-driven, mirroring
 * `concept-evaluation-provider-config.ts`'s own shape exactly.
 *
 * Deliberately ADVISORY-ONLY, exactly like Concept Evaluation and unlike
 * Sign Preservation's blocking gate: a proposal is never authority (see
 * `ArtworkFidelityCapability`'s own doc comment) — customer/operator
 * confirmation is REQUIRED regardless of whether a proposal exists or
 * succeeded. A misconfigured/absent provider safely falls back to the
 * placeholder (an empty proposal) in every environment, including
 * production: the customer simply fills in every field from scratch, the
 * same experience as if this capability did not exist yet.
 *
 * Pure and side-effect-free, exactly like its concept-evaluation sibling.
 */

const DEFAULT_OPENAI_ARTWORK_FIDELITY_PROPOSAL_MODEL = "gpt-4o-mini";

export type ArtworkFidelityProposalProviderConfig =
  | {
      mode: "placeholder";
      reason: "configured" | "fallback";
    }
  | {
      mode: "openai";
      apiKey: string;
      model: string;
    };

export function getArtworkFidelityProposalProviderConfig(): ArtworkFidelityProposalProviderConfig {
  const requestedProvider = (
    process.env.ARTWORK_FIDELITY_PROPOSAL_PROVIDER ?? "placeholder"
  )
    .trim()
    .toLowerCase();

  if (requestedProvider !== "openai") {
    return { mode: "placeholder", reason: "configured" };
  }

  // Reuses the same OpenAI credential as concept generation/evaluation —
  // same vendor account/key; this does not require its own separate secret.
  const apiKey = process.env.OPENAI_API_KEY?.trim() || "";
  if (!apiKey) {
    return { mode: "placeholder", reason: "fallback" };
  }

  const model =
    process.env.ARTWORK_FIDELITY_PROPOSAL_MODEL?.trim() ||
    DEFAULT_OPENAI_ARTWORK_FIDELITY_PROPOSAL_MODEL;

  return { mode: "openai", apiKey, model };
}
