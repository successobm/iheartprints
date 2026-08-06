/**
 * Sprint 2I Phase 2: provider selection for Concept Evaluation is
 * configuration-driven, exactly like `generation-provider-config.ts` for
 * image generation. Adding a future evaluator (a different vision model, an
 * OCR-specialist provider, ...) means adding one more branch here plus one
 * adapter file — never a domain or capability change.
 *
 * Deliberately simpler than concept *generation* configuration: Concept
 * Evaluation is advisory-only and internal (Constitution / ARCHITECTURE.md
 * §5 — Phase 1/2 never blocks, hides, or ranks concepts for the customer),
 * and every provider failure already falls back to a deterministic
 * `needs_review` result rather than discarding anything (see
 * `ConceptEvaluationCapability.evaluationFailureFallback`). Unlike image
 * generation — where a misconfigured provider must fail closed rather than
 * silently hand a customer a placeholder image dressed as a real one —
 * there is no customer-facing surface to protect here. A misconfigured
 * evaluation provider can safely fall back to the deterministic placeholder
 * evaluator in every environment, including production; nothing customer
 * visible depends on it.
 *
 * Pure and side-effect-free (no logging here) so it stays trivially
 * testable — logging belongs to whatever consumes the result.
 */

const DEFAULT_OPENAI_EVALUATION_MODEL = "gpt-4o-mini";

export type ConceptEvaluationConfig =
  | {
      mode: "placeholder";
      /**
       * "configured" — placeholder was explicitly selected (or is simply
       * the default with nothing else requested).
       * "fallback" — `openai` was requested but `OPENAI_API_KEY` is not
       * set; evaluation is advisory-only so this is safe in every
       * environment (see module doc), unlike concept generation's
       * production-blocking equivalent.
       */
      reason: "configured" | "fallback";
    }
  | {
      mode: "openai";
      apiKey: string;
      model: string;
    };

export function getConceptEvaluationConfig(): ConceptEvaluationConfig {
  const requestedProvider = (
    process.env.CONCEPT_EVALUATION_PROVIDER ?? "placeholder"
  )
    .trim()
    .toLowerCase();

  if (requestedProvider !== "openai") {
    return { mode: "placeholder", reason: "configured" };
  }

  // Sprint 2I Phase 2: reuses the same OpenAI credential as concept
  // generation — both are the same vendor account/key; evaluation does not
  // require its own separate secret.
  const apiKey = process.env.OPENAI_API_KEY?.trim() || "";
  if (!apiKey) {
    return { mode: "placeholder", reason: "fallback" };
  }

  const model =
    process.env.OPENAI_EVALUATION_MODEL?.trim() ||
    DEFAULT_OPENAI_EVALUATION_MODEL;

  return { mode: "openai", apiKey, model };
}
