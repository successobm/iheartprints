/**
 * Phase 2C0: explicit concept-generation image quality for OpenAI
 * `/v1/images/generations` (and concept edits). Never rely on OpenAI's
 * omitted-parameter default of `auto`.
 *
 * Scoped to concept generation only — final-artwork reconstruction uses
 * Topaz / local raster and is deliberately not coupled to this variable
 * (see `final-artwork-provider-config.ts`).
 *
 * Env: `OPENAI_CONCEPT_IMAGE_QUALITY`
 * Allowed: `low` | `medium` | `high`
 * Default: `medium`
 * Invalid values (including `auto`) fail closed — no silent fallback.
 */

export const OPENAI_CONCEPT_IMAGE_QUALITY_ENV = "OPENAI_CONCEPT_IMAGE_QUALITY";

export const OPENAI_CONCEPT_IMAGE_QUALITIES = ["low", "medium", "high"] as const;

export type OpenAIConceptImageQuality =
  (typeof OPENAI_CONCEPT_IMAGE_QUALITIES)[number];

export const DEFAULT_OPENAI_CONCEPT_IMAGE_QUALITY: OpenAIConceptImageQuality =
  "medium";

export function resolveOpenAIConceptImageQuality(
  raw: string | undefined = process.env[OPENAI_CONCEPT_IMAGE_QUALITY_ENV],
): OpenAIConceptImageQuality {
  const trimmed = (raw ?? "").trim();
  if (trimmed.length === 0) {
    return DEFAULT_OPENAI_CONCEPT_IMAGE_QUALITY;
  }
  const normalized = trimmed.toLowerCase();
  if (
    (OPENAI_CONCEPT_IMAGE_QUALITIES as readonly string[]).includes(normalized)
  ) {
    return normalized as OpenAIConceptImageQuality;
  }
  throw new Error(
    `Invalid ${OPENAI_CONCEPT_IMAGE_QUALITY_ENV}="${trimmed}". ` +
      `Allowed values: ${OPENAI_CONCEPT_IMAGE_QUALITIES.join(", ")}. ` +
      "Do not use auto — quality must be explicit.",
  );
}
