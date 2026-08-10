import {
  analyzeDesignContent,
  type DesignContentContract,
} from "./design-content-contract";
import type {
  ConceptDirectionKey,
  GenerationPromptRequest,
  RequiredWordingMode,
} from "./types";

// Re-exported for backward compatibility — the canonical definition now
// lives in `./types` (see its doc comment) to avoid a circular import,
// since this module already imports `GenerationPromptRequest` from there.
export type { ConceptDirectionKey } from "./types";

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

/**
 * Detailed-Description Fidelity (Phase 1), part B: the six treatment fields
 * a direction actually contributes to a provider prompt. Split out from
 * `ConceptDirection` so a direction can express the SAME creative angle
 * differently depending on what the approved content requires, without
 * anyone downstream having to know which variant they were handed.
 */
export interface ConceptDirectionTreatment {
  /** Plain-language composition guidance — provider-neutral, not prompt dialect. */
  composition: string;
  /**
   * Phase 1.1: `null` when the customer explicitly asked for NO text
   * (`wordingMode === "none"`). A direction has nothing to say about
   * typography in a design that must contain no lettering at all, and the
   * type says so rather than leaving a consumer to filter a string that
   * still authorizes text. Consumers must omit typography guidance entirely
   * when this is `null` — see `openai-concept-provider.ts`.
   */
  typographyEmphasis: string | null;
  illustrationDensity: string;
  iconography: string;
  layout: string;
  visualHierarchy: string;
}

export type ConceptDirectionTreatmentOverrides = Partial<ConceptDirectionTreatment>;

export interface ConceptDirection extends ConceptDirectionTreatment {
  key: ConceptDirectionKey;
  /** Customer-facing concept title (Constitution §13: layout/typography/hierarchy variation, not a different brief). */
  title: string;
  placeholderLabel: string;
  accentColor: string;
  /** The base entry always states its typography angle; only the no-text layer removes it. */
  typographyEmphasis: string;
  /**
   * Phase 1.1: applied when the customer explicitly asked for NO text
   * (`wordingMode === "none"`). Applied LAST, after every other layer,
   * because explicit no-text sits in the highest precedence tier — above
   * required content, style preference, direction treatment, and defaults.
   *
   * Overrides only the fields that would otherwise authorize or reference
   * lettering. Everything else — the direction's shape language, density,
   * framing and scene-fidelity guarantees — is left exactly as the lower
   * layers resolved it, so the three concepts stay genuinely distinct
   * (Constitution §13) instead of collapsing into one graphic-only look.
   */
  noTextTreatment?: ConceptDirectionTreatmentOverrides;
  /**
   * Applied when the approved design content requires more than one element
   * or states a relationship between elements (`DesignContentContract.
   * requiresScene`). Only the fields that would otherwise CONTRADICT the
   * customer's content are overridden — the direction's creative angle is
   * unchanged, only its licence to remove subject matter is withdrawn.
   */
  sceneTreatment?: ConceptDirectionTreatmentOverrides;
  /**
   * Applied when the customer stated where things go
   * (`DesignContentContract.hasExplicitComposition`). A direction that
   * prefers a centered/symmetrical arrangement may keep its framing
   * character but must stop asserting a placement the customer already
   * decided.
   */
  customerComposedTreatment?: ConceptDirectionTreatmentOverrides;
}

/**
 * Detailed-Description Fidelity (Phase 1), part B — why the base entries
 * below still contain minimal/icon language, and why that is now safe.
 *
 * The audit did not find that "single small icon, no scene" was wrong; it
 * found that it was UNCONDITIONAL. For "a red 1988 Toyota MR2" it is exactly
 * the right instruction, and deleting it everywhere would have destroyed the
 * real creative difference between the three concepts — which is its own
 * product failure (Constitution §13).
 *
 * So the base fields remain the direction's treatment for a single, simple
 * required subject, and `sceneTreatment` states the same creative angle for
 * content that genuinely requires several elements. What changes is never
 * WHAT is depicted, only how densely and how simply it is drawn.
 */
export const CONCEPT_DIRECTIONS: readonly ConceptDirection[] = [
  {
    key: "bold_direct",
    title: "Bold & Direct",
    placeholderLabel: "Concept A",
    accentColor: "#1f6f5b",
    composition: "a bold, high-contrast composition built around a strong central silhouette",
    typographyEmphasis:
      "typography-forward — the required wording is the dominant visual element, large and unmistakably readable",
    // Phase 1.1: "reinforces the focal point" rather than "reinforces the
    // wording" — the base density guidance has to be true of a design that
    // may legitimately have no lettering at all, so that the no-text layer
    // below only has to remove typography, not repair every field that
    // silently assumed text existed.
    illustrationDensity: "minimal supporting illustration; only what reinforces the focal point",
    iconography: "one simple, direct supporting graphic, not a scene",
    layout: "centered, symmetrical layout with generous margins",
    visualHierarchy: "wording first, supporting graphic second — nothing competes with the text",
    noTextTreatment: {
      typographyEmphasis: null,
      visualHierarchy:
        "hierarchy comes entirely from scale, contrast, and shape weight — the dominant graphic reads first, and there is no lettering anywhere to compete with it",
    },
    sceneTreatment: {
      composition:
        "a bold, high-contrast composition that renders the whole required subject in strong, simplified shapes with clear separation between elements",
      illustrationDensity:
        "simplified, high-impact illustration — reduce the detail drawn inside each element, never the number of required elements",
      iconography:
        "every required subject drawn as a bold, graphic shape; simplify how each one is rendered, and leave none of them out",
      visualHierarchy:
        "wording reads first, with the required subject matter rendered boldly beneath it — strong hierarchy, complete content",
    },
    customerComposedTreatment: {
      layout:
        "generous margins and a clear, uncluttered frame, arranged to follow the placements the customer stated rather than forcing a symmetrical center",
    },
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
    noTextTreatment: {
      typographyEmphasis: null,
      visualHierarchy:
        "the illustration reads as one complete, self-contained unit that needs no caption or label to be understood",
    },
    sceneTreatment: {
      illustrationDensity:
        "the richest, most detailed illustration of the three directions — full scenic treatment with visual texture and depth",
      iconography:
        "the complete required subject matter rendered as a warm, characterful illustrated scene, without depending on any specific real character or person",
    },
    customerComposedTreatment: {
      layout:
        "loosely balanced, hand-arranged framing that follows the placements the customer stated rather than a grid",
    },
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
    noTextTreatment: {
      typographyEmphasis: null,
      visualHierarchy:
        "badge shape first, with the imagery balanced evenly inside it — the emblem is carried by shape and image alone, with no lettering, monogram, or inscription on or around the border",
    },
    sceneTreatment: {
      composition:
        "a compact, emblem/badge-style composition contained within a simple border, whose interior holds the complete required subject matter drawn in a pared-back way",
      illustrationDensity:
        "very restrained linework and flat shapes — simplify how every element is drawn while keeping every required element present",
      iconography:
        "the required subject matter reduced to clean, emblematic shapes — simplified in rendering, complete in content",
      visualHierarchy:
        "badge shape first, with the required subject matter and the wording balanced evenly inside it",
    },
    customerComposedTreatment: {
      layout:
        "a contained badge shape with a defined edge, with the required elements arranged inside it according to the placements the customer stated",
    },
  },
] as const;

/**
 * Detailed-Description Fidelity (Phase 1), part B — the ONE place a
 * direction's treatment is resolved against what the approved content
 * actually requires. Layered so a lower-priority preference can never
 * survive a conflict with a higher-priority customer requirement:
 *
 *   base treatment (simple single subject)
 *     ← overridden by `sceneTreatment` when the content requires several
 *       elements or states a relationship between them
 *     ← overridden by `customerComposedTreatment` when the customer stated
 *       where things go
 *
 * The result still differs sharply between the three directions — that is
 * the point. Fidelity is achieved by constraining what a direction may
 * REMOVE, never by making the three prompts converge.
 *
 * Phase 1.1 adds a fourth, highest layer: `noTextTreatment`, applied when
 * the customer explicitly asked for no wording. It goes last because
 * explicit no-text is precedence tier 1 — above required content,
 * composition, style, direction treatment, and provider defaults — so it
 * must be able to override anything the layers beneath it decided.
 */
export function resolveDirectionTreatment(
  direction: ConceptDirection,
  contract: Pick<DesignContentContract, "requiresScene" | "hasExplicitComposition">,
  options: { wordingMode?: RequiredWordingMode } = {},
): ConceptDirectionTreatment {
  return {
    composition: direction.composition,
    typographyEmphasis: direction.typographyEmphasis,
    illustrationDensity: direction.illustrationDensity,
    iconography: direction.iconography,
    layout: direction.layout,
    visualHierarchy: direction.visualHierarchy,
    ...(contract.requiresScene ? direction.sceneTreatment ?? {} : {}),
    ...(contract.hasExplicitComposition
      ? direction.customerComposedTreatment ?? {}
      : {}),
    ...(options.wordingMode === "none" ? direction.noTextTreatment ?? {} : {}),
  };
}

/**
 * Sprint 2G Live Acceptance Corrective Pass: resolves one catalog direction
 * by its stable key — the lookup a targeted single-concept revision uses to
 * regenerate in the SAME direction the customer already selected, instead
 * of defaulting to the catalog's first entry. Falls back to the first
 * direction for an unrecognized/missing key (defensive; every direction
 * ever persisted comes from this same catalog).
 */
export function resolveConceptDirection(
  key: ConceptDirectionKey | null | undefined,
): ConceptDirection {
  return CONCEPT_DIRECTIONS.find((d) => d.key === key) ?? CONCEPT_DIRECTIONS[0]!;
}

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
  // Phase 1.1: the card copy must match the contract the provider was
  // actually given. Live acceptance showed cards reading "No text lockup —
  // graphic-led" while the prompt still carried typography-forward direction
  // language and the artwork came back covered in lettering. An explicit
  // no-text request now says so plainly; an unanswered wording question is
  // still only "no lockup", because that is genuinely all we know.
  const text =
    prompt.wordingMode === "provided" && prompt.requiredWording
      ? `Featuring "${prompt.requiredWording}".`
      : prompt.wordingMode === "none"
        ? "Graphic-only — no text."
        : "No text lockup — graphic-led.";
  // Detailed-Description Fidelity (Phase 1): describe the treatment actually
  // sent to the provider. Telling a customer their scenic request became "a
  // strong central silhouette" when the prompt says otherwise would be the
  // same fabrication this function exists to prevent.
  const treatment = resolveDirectionTreatment(
    direction,
    analyzeDesignContent(prompt.subject, { additionalContext: prompt.notes }),
    { wordingMode: prompt.wordingMode },
  );
  return `${direction.title}: ${treatment.composition}. ${text} Designed for a ${shirt} shirt.`;
}
