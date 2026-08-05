import type { BriefConflict, BriefSectionKey } from "./contracts";

/**
 * Centralized, provider-neutral customer-facing phrasing (Sprint 2F).
 *
 * "Avoid scattering customer-facing question strings through orchestration
 * code" — this is the one place ask/clarify/contradiction copy lives.
 * Lives in `shared/` (not inside `interview-intelligence/`) because both
 * `DesignIntelligenceCapability` (building a plain-language recommendation
 * from a non-blocking contradiction) and `InterviewIntelligenceCapability`
 * (building a "clarify" act from a blocking one) need the exact same
 * contradiction phrasing, and neither capability may depend on the other's
 * internals.
 *
 * Every message here is short, plain-language, asks one thing, and never
 * exposes field names, numeric confidence, or internal severity codes.
 */

interface QuestionOptions {
  /** True when this section has already been asked/clarified at least once this session. */
  retry?: boolean;
}

const MISSING_QUESTIONS: Partial<Record<BriefSectionKey, [string, string]>> = {
  product: [
    "What are we printing today?",
    "Just so I don't miss it — what product are we printing on?",
  ],
  graphics: [
    "Tell me about the design — what should it show?",
    "What imagery or graphic would you like on the design?",
  ],
  requiredWording: [
    'What exact text should appear on the design? Say "none" if there is no text.',
    'And just to confirm — what exact wording, if any, should be on the design?',
  ],
  productColor: [
    "What color garment will this print on?",
    "Which garment color should we use?",
  ],
  purpose: [
    "What's the occasion or purpose for this design?",
    "What's this design for — an event, a team, a gift, something else?",
  ],
  audience: [
    "Who is this design for?",
    "Who will be wearing or receiving this?",
  ],
  style: [
    "What kind of look are you going for — vintage, modern, athletic, playful, or something else?",
    "Any particular style in mind, or should I choose something that fits the rest of the brief?",
  ],
  colors: [
    "Do you have any color preferences for the design itself?",
    "Any specific colors you'd like in the artwork?",
  ],
  printLocation: [
    "Where should this print — full front, full back, left chest, or a sleeve?",
    "Which placement works best — front, back, left chest, or sleeve?",
  ],
};

const GENERIC_ASK: [string, string] = [
  "Anything else I should know before we continue?",
  "Anything else worth mentioning here?",
];

export function questionForMissingSection(
  section: BriefSectionKey,
  opts: QuestionOptions = {},
): string {
  const [initial, retry] = MISSING_QUESTIONS[section] ?? GENERIC_ASK;
  return opts.retry ? retry : initial;
}

const AMBIGUOUS_QUESTIONS: Partial<Record<BriefSectionKey, [string, string]>> = {
  style: [
    "What kind of look feels right — vintage, modern, athletic, playful, or something else?",
    "Just to narrow it down — which of these feels closest: vintage, modern, athletic, or playful?",
  ],
  colors: [
    "Do you want me to choose colors that work best with the shirt, or do you have any colors you want included?",
    "Should I pick colors that pair well with the shirt, or is there a specific color you'd like included?",
  ],
  graphics: [
    "Could you describe the design a little more — what should it actually show?",
    "What's the main image or subject you'd like front and center?",
  ],
  productColor: [
    "Which specific garment color should we use?",
    "Just to confirm the exact garment color — which one?",
  ],
  product: [
    "Could you tell me a bit more about what we're printing?",
    "Just to confirm — what exactly are we printing?",
  ],
  requiredWording: [
    "Could you tell me the exact words you'd like on the design?",
    "What's the exact wording you have in mind?",
  ],
  purpose: [
    "Could you say a bit more about what this is for?",
    "What's the occasion, roughly?",
  ],
  audience: [
    "Could you tell me a bit more about who this is for?",
    "Who specifically will wear or receive this?",
  ],
};

export function questionForAmbiguousSection(
  section: BriefSectionKey,
  opts: QuestionOptions = {},
): string {
  const [initial, retry] = AMBIGUOUS_QUESTIONS[section] ?? GENERIC_ASK;
  return opts.retry ? retry : initial;
}

/**
 * Plain-language phrasing for a detected contradiction, ending in one clear
 * follow-up question. Used both for a blocking contradiction's "clarify"
 * act and a non-blocking contradiction's Design Intelligence recommendation
 * — the underlying issue and the question to ask about it are the same
 * either way; only how urgently it is surfaced differs.
 */
export function contradictionMessage(conflict: BriefConflict): string {
  switch (conflict.code) {
    case "color_clash":
      return "The color you'd like for the design matches the shirt color, so it may not be visible once printed. Should we use a different design color, or a different shirt color?";
    case "minimalist_wording_clash":
      return "You mentioned a minimalist style, but the required wording is fairly long, which can be hard to keep clean and minimal. Would you like to shorten the wording, or go with a less minimal style?";
    case "minimalist_graphics_clash":
      return "You mentioned a minimalist style, but the design description sounds fairly busy. Should I aim for a simpler graphic, or would a bolder, more detailed style fit better?";
    default:
      return conflict.message;
  }
}

/**
 * Sprint 2G Part 2: short, plain-language name for a section, used only to
 * acknowledge a revision ("I've updated the product color") — never to
 * expose the internal section key itself.
 */
const SECTION_LABELS: Record<BriefSectionKey, string> = {
  product: "the product",
  graphics: "the design",
  productColor: "the product color",
  requiredWording: "the wording",
  style: "the style",
  colors: "the colors",
  audience: "the audience",
  purpose: "the purpose",
  printLocation: "the print location",
  exclusions: "what to avoid",
  additionalNotes: "the notes",
  references: "the references",
  production: "the production notes",
  layoutPreference: "the layout",
};

/**
 * Brief acknowledgement of a revision that needed no follow-up question —
 * "continue naturally" rather than restart or interrogate.
 */
export function acknowledgeRevision(changedSections: BriefSectionKey[]): string {
  if (changedSections.length === 0) return "Got it.";
  if (changedSections.length === 1) {
    const [section] = changedSections;
    return `Got it — I've updated ${SECTION_LABELS[section]}.`;
  }
  return "Got it — I've made those changes.";
}

/** Asked once, after a revision, only when concepts already exist and are now stale. */
export function conceptRegenerationPrompt(): string {
  return "Your changes affect the current concepts. Would you like me to generate updated concepts?";
}
