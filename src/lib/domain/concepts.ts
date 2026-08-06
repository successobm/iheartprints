import { CONCEPT_DIRECTIONS, describeConceptDirection } from "./concept-directions";
import type { GenerationPromptRequest } from "./types";

export interface ConceptSeed {
  versionNumber: number;
  title: string;
  summary: string;
  placeholderLabel: string;
  accentColor: string;
}

/**
 * Sprint 2H Part 1: takes the provider-neutral `GenerationPromptRequest`
 * (the same input every real provider adapter receives) instead of the raw
 * Design Brief, so the placeholder path stays a faithful stand-in for a
 * real provider rather than a special case.
 *
 * Sprint 2K Phase 3 (Goal 5/8): the three concept directions — and their
 * customer-facing descriptions — now come from the single shared
 * `shared/concept-directions` catalog, the same one the real (OpenAI)
 * provider uses, instead of a second, independently-drifting copy.
 */
export function buildPlaceholderConcepts(
  prompt: GenerationPromptRequest,
): ConceptSeed[] {
  return CONCEPT_DIRECTIONS.map((direction, index) => ({
    versionNumber: index + 1,
    title: direction.title,
    placeholderLabel: direction.placeholderLabel,
    accentColor: direction.accentColor,
    summary: describeConceptDirection(direction, prompt),
  }));
}
