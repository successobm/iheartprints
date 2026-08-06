import type { GenerationPromptRequest } from "./types";

/**
 * Sprint 2K Phase 3 (Goal 5) — the single, provider-neutral source of truth
 * for how the three concepts shown to a customer differ from one another.
 *
 * Before this sprint, "Bold & Direct" / "Soft & Illustrated" / "Minimal
 * Badge" existed as two independently-maintained copies: a placeholder-only
 * list in `lib/domain/concepts.ts`, and a second, OpenAI-specific list
 * inside `openai-concept-provider.ts` (each with its own title/
 * placeholderLabel/accentColor, and only a single generic sentence of real
 * differentiation). That duplication risked drift, and buried the one
 * general mechanism this sprint asks for inside a single provider adapter.
 *
 * This module is that mechanism. It is deliberately NOT bowling-specific —
 * every field below is a plain-language description of composition,
 * typography, illustration density, iconography, layout, and visual
 * hierarchy that applies to any product/subject. A provider adapter is
 * still the only place actual dialect/keyword phrasing lives (see
 * `openai-concept-provider.ts`'s `buildPrompt`) — this catalog supplies the
 * *content* of the differentiation, never provider syntax.
 *
 * Regeneration (Goal 9) does not need its own copy of this catalog: the
 * three directions are independent of the approved brief and of any
 * `RegenerationPlan` — they are always applied, so distinctiveness across
 * concepts survives regeneration automatically. What changes on
 * regeneration is the shared `GenerationPromptRequest` (via
 * `PromptTranslationCapability`); each direction still layers its own
 * composition/typography/iconography on top of that updated shared
 * request, exactly as it does on initial generation.
 */

export type ConceptDirectionKey = "bold_direct" | "soft_illustrated" | "minimal_badge";

export interface ConceptDirection {
  key: ConceptDirectionKey;
  /** Customer-facing concept title (Constitution §13: layout/typography/hierarchy variation, not a different brief). */
  title: string;
  placeholderLabel: string;
  accentColor: string;
  /** Plain-language composition guidance — provider-neutral, not prompt dialect. */
  composition: string;
  typographyEmphasis: string;
  illustrationDensity: string;
  iconography: string;
  layout: string;
  visualHierarchy: string;
}

export const CONCEPT_DIRECTIONS: readonly ConceptDirection[] = [
  {
    key: "bold_direct",
    title: "Bold & Direct",
    placeholderLabel: "Concept A",
    accentColor: "#1f6f5b",
    composition: "a bold, high-contrast composition built around a strong central silhouette",
    typographyEmphasis:
      "typography-forward — the required wording is the dominant visual element, large and unmistakably readable",
    illustrationDensity: "minimal supporting illustration; only what reinforces the wording",
    iconography: "one simple, direct supporting graphic, not a scene",
    layout: "centered, symmetrical layout with generous margins",
    visualHierarchy: "wording first, supporting graphic second — nothing competes with the text",
  },
  {
    key: "soft_illustrated",
    title: "Soft & Illustrated",
    placeholderLabel: "Concept B",
    accentColor: "#3d5a80",
    composition: "a warm, illustrated composition with softer edges and a friendly poster feel",
    typographyEmphasis:
      "the wording is integrated into the illustration (banner, ribbon, or hand-lettered treatment) rather than sitting apart from it",
    illustrationDensity: "richer, characterful illustration with more visual texture than the other two directions",
    iconography: "a small scene or grouped motifs that add personality without depending on any specific real character or person",
    layout: "asymmetrical or loosely balanced layout that feels hand-arranged, not gridded",
    visualHierarchy: "illustration and wording read as one integrated unit",
  },
  {
    key: "minimal_badge",
    title: "Minimal Badge",
    placeholderLabel: "Concept C",
    accentColor: "#7a4e2d",
    composition: "a compact, emblem/badge-style composition contained within a simple border or shape",
    typographyEmphasis: "small, clean, evenly arced or stacked typography, sized to stay legible at a compact size",
    illustrationDensity: "very restrained — a single small icon or mark, no scene",
    iconography: "one restrained icon representative of the subject, rendered simply",
    layout: "circular, shield, or crest-style contained layout with a defined edge",
    visualHierarchy: "badge shape first, wording and icon balanced evenly within it",
  },
] as const;

/**
 * Sprint 2K Phase 3 (Goal 8): the truthful, customer-facing description of
 * a concept — describes the INTENDED creative direction actually sent to
 * the provider (subject, required wording, product color, and this
 * direction's real compositional angle), never a fabricated claim about
 * pixels no evaluation has confirmed. Shared by every provider (including
 * the placeholder) so the description a customer sees is never provider-
 * specific and never drifts between adapters.
 */
export function describeConceptDirection(
  direction: ConceptDirection,
  prompt: GenerationPromptRequest,
): string {
  const shirt = prompt.productColor?.trim() || "the shirt";
  const text = prompt.requiredWording
    ? `Featuring "${prompt.requiredWording}".`
    : "No text lockup — graphic-led.";
  return `${direction.title}: ${direction.composition}. ${text} Designed for a ${shirt} shirt.`;
}
