/**
 * Phase R5 (Confirmed-Authority Raster Reconstruction v1): provider
 * selection for GENERATIVE raster reconstruction — configuration-driven,
 * mirroring `artwork-fidelity-proposal-provider-config.ts`'s own shape
 * exactly (own env vars, own default model constant, own fallback-to-
 * placeholder discipline).
 *
 * MODEL CHOICE (documented per the R5 task's own instruction, not a blind
 * copy of Phase R1 research): the ONLY OpenAI image-EDIT (`/v1/images/
 * edits`) integration already live in this codebase —
 * `OpenAIConceptGenerationProvider`'s targeted-revision path — resolves its
 * model from `generation-provider-config.ts`'s own
 * `DEFAULT_OPENAI_MODEL = "gpt-image-1"`. That is the actual CURRENT
 * production default this repository already uses for this exact endpoint
 * today, independent of and never overlapping with Phase R1's research
 * pin — reusing it here is "what this repository's own image-edit
 * capability is configured to use," not an assumption carried over from a
 * research branch. It remains independently configurable
 * (`RASTER_RECONSTRUCTION_MODEL`) precisely so it can change without
 * touching concept generation's own config, per this module's own capability
 * boundary.
 *
 * Deliberately advisory-safe like its sibling: a misconfigured/absent
 * provider falls back to the placeholder (a provider that refuses to
 * reconstruct rather than fabricating output) in every environment,
 * including production.
 */

const DEFAULT_OPENAI_RASTER_RECONSTRUCTION_MODEL = "gpt-image-1";

export type RasterReconstructionProviderConfig =
  | {
      mode: "placeholder";
      reason: "configured" | "fallback";
    }
  | {
      mode: "openai";
      apiKey: string;
      model: string;
    };

export function getRasterReconstructionProviderConfig(): RasterReconstructionProviderConfig {
  const requestedProvider = (process.env.RASTER_RECONSTRUCTION_PROVIDER ?? "placeholder")
    .trim()
    .toLowerCase();

  if (requestedProvider !== "openai") {
    return { mode: "placeholder", reason: "configured" };
  }

  // Reuses the same OpenAI credential as every other OpenAI-backed
  // capability in this codebase — same vendor account/key; this does not
  // require its own separate secret.
  const apiKey = process.env.OPENAI_API_KEY?.trim() || "";
  if (!apiKey) {
    return { mode: "placeholder", reason: "fallback" };
  }

  const model =
    process.env.RASTER_RECONSTRUCTION_MODEL?.trim() ||
    DEFAULT_OPENAI_RASTER_RECONSTRUCTION_MODEL;

  return { mode: "openai", apiKey, model };
}
