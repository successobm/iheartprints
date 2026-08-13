import type { BriefConflict, BriefSectionKey, DesignSummaryView } from "./contracts";
import { isChangeClause } from "./revision-delta";

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
 * Sprint 2G Part 3: the same short label used to acknowledge a revision,
 * exposed directly for other presentation needs (e.g. the revision
 * timeline) that want "Shirt Color" rather than the internal section key —
 * single source of truth, safe to reuse client-side too (pure data, no
 * server-only dependency).
 */
export function sectionLabel(section: BriefSectionKey): string {
  return SECTION_LABELS[section];
}

/**
 * Title-cased variant for headings/badges (the timeline, "Updated" badges)
 * where "the shirt color" would read oddly — "Shirt Color" instead.
 */
export function sectionTitle(section: BriefSectionKey): string {
  const label = SECTION_LABELS[section].replace(/^(the|what to avoid)\s*/i, "");
  const base = label || SECTION_LABELS[section];
  return base
    .split(" ")
    .map((word) => (word.length > 0 ? word[0]!.toUpperCase() + word.slice(1) : word))
    .join(" ");
}

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

/**
 * Sprint 2M Phase 2G (Goal 4/10): shown when an explicit customer revision
 * request has just automatically enqueued regeneration — distinct from
 * `conceptRegenerationPrompt` (which asks permission). States what is
 * already happening, truthfully: the artwork is being revised, never
 * implying final approval or that production has started.
 */
export function revisionGeneratingMessage(): string {
  return "I'm updating the concept now.";
}

/**
 * Live Acceptance Cleanup (Issue 5): confirms a PRODUCTION-SIZE change.
 *
 * Deliberately says nothing about the artwork changing — because it hasn't.
 * Resolution is stated as a guarantee we keep at whatever size the customer
 * chose, never offered as a setting for them to manage (Constitution §6.4 /
 * AGENTS.md Goal 8). When a request fell outside what the placement can
 * physically print, that is said plainly rather than silently honored.
 */
export function productionSizeAcknowledgement(
  resolved: { widthIn: number; clamped: boolean; minWidthIn: number; maxWidthIn: number },
  dpi: number | null,
): string {
  const width = formatInchesForCustomer(resolved.widthIn);
  const quality = dpi ? ` It'll still be printed at full ${dpi} DPI quality.` : "";

  if (resolved.clamped) {
    return `${formatInchesForCustomer(resolved.minWidthIn)}" to ${formatInchesForCustomer(
      resolved.maxWidthIn,
    )}" wide is what fits this print location, so I've set your print to ${width}" wide.${quality}`;
  }
  return `Got it — I'll prepare your print at ${width}" wide. The design itself stays exactly as you approved it.${quality}`;
}

function formatInchesForCustomer(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100);
}

/**
 * True Source-Image Targeted Revision: acknowledges the DELTA the customer
 * actually asked for, not the brief fields it happened to touch.
 *
 * The old behavior reported extraction results — "Got it — I have Red in
 * the artwork and the design direction." — which describes our data model,
 * not the customer's request, and reads as if we misunderstood them. A
 * revision turn is a promise about the artwork, so it should restate the
 * artwork change and the preservation guarantee that goes with it.
 *
 * Free: built from the customer's own already-parsed instruction (shared
 * `splitRequestedChanges`), never a second paid model call.
 *
 * Returns `null` when the instruction does not decompose into imperative
 * change clauses — callers fall back to the existing field-based
 * acknowledgement, which is still truthful for those turns.
 *
 * Says nothing about generation starting: that claim is only true once the
 * regeneration job is durably enqueued, and `enqueue` makes it itself.
 */
export function acknowledgeRequestedChanges(
  requestedChanges: string[],
): string | null {
  const clauses = requestedChanges
    .map((clause) => clause.trim())
    .filter((clause) => clause.length > 0 && isChangeClause(clause));
  if (clauses.length === 0) return null;

  // Every clause is already a bare imperative ("make the border red",
  // "remove the sunset"), so a single "I'll" carries the whole list.
  const joined = joinNaturally(clauses.map(lowerFirst));
  return `Got it — I'll ${joined}. Everything else in the design stays the same.`;
}

/**
 * Sprint 2L Phase 1A: a natural, value-bearing acknowledgement of exactly
 * what was just resolved — "Got it — I have the bowling team, the name
 * My 3 Sons, and the T-shirt." — instead of a generic count-only
 * acknowledgement ("I've made those changes") that reads as if
 * *everything* asked about was captured even when it wasn't. Built only
 * from `summary` (the already-computed `DesignSummaryView` of the
 * *updated* brief) restricted to `changedSections` — it can only ever
 * mention a field that is both (a) something this turn actually changed
 * and (b) something Design Summary itself would show as resolved, so it
 * can never claim a field that failed reconciliation/validation this turn
 * (e.g. a rejected Product proposal) was captured.
 *
 * Returns `null` when nothing in `changedSections` has a displayable
 * value (e.g. the only change was a deferral) — callers should fall back
 * to `acknowledgeRevision` in that case, which is still truthful ("I've
 * made those changes") because a deferral is itself a real, applied
 * change.
 */
const RESOLVED_FIELD_ORDER: BriefSectionKey[] = [
  "product",
  "requiredWording",
  "audience",
  "purpose",
  "productColor",
  "printLocation",
  "style",
  "colors",
  "graphics",
  "exclusions",
  "additionalNotes",
];

const MAX_ACKNOWLEDGED_FIELDS = 4;

const RESOLVED_FIELD_PHRASE: Partial<Record<BriefSectionKey, (value: string) => string>> = {
  product: (v) => `the ${withoutLeadingArticle(v)}`,
  audience: (v) => `the ${lowerFirst(withoutLeadingArticle(v))}`,
  purpose: (v) => `the ${lowerFirst(withoutLeadingArticle(v))}`,
  requiredWording: (v) => (v === "None" ? "no required wording" : `the name "${v}"`),
  productColor: (v) => `${v} as the shirt color`,
  printLocation: (v) => `${lowerFirst(v)} placement`,
  style: (v) => `a ${lowerFirst(withoutLeadingArticle(v))} style`,
  colors: (v) => `${v} in the artwork`,
  graphics: () => "the design direction",
  exclusions: () => "what to avoid",
  additionalNotes: () => "your notes",
};

/**
 * Sprint 2L Phase 1B (Goal 7): a single low-salience field answer ("black",
 * "full back") does not deserve the full "Got it — I have Black as the
 * shirt color." treatment — repeated every turn, that reads as database-
 * mutation reporting, not conversation. A short, natural confirmation
 * still tells the customer their answer registered without parroting it
 * back as a labeled field. Reserved for the single-field case — a
 * multi-field turn uses `acknowledgeResolvedFields` instead, where the
 * fuller synthesis earns its place by demonstrating real understanding of
 * a richer message.
 */
export function shortAcknowledgement(
  section: BriefSectionKey,
  value: string | null,
): string {
  if (section === "productColor" && value) return `${value} works.`;
  return "Got it.";
}

export function acknowledgeResolvedFields(
  summary: DesignSummaryView,
  changedSections: BriefSectionKey[],
): string | null {
  const changed = new Set(changedSections);
  const phrases: string[] = [];

  for (const section of RESOLVED_FIELD_ORDER) {
    if (phrases.length >= MAX_ACKNOWLEDGED_FIELDS) break;
    if (!changed.has(section)) continue;
    const value = summary[section as keyof DesignSummaryView];
    if (!value) continue;
    const phrase = RESOLVED_FIELD_PHRASE[section]?.(String(value));
    if (phrase) phrases.push(phrase);
  }

  if (phrases.length === 0) return null;
  return `Got it — I have ${joinNaturally(phrases)}.`;
}

function joinNaturally(items: string[]): string {
  if (items.length === 1) return items[0]!;
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

function lowerFirst(value: string): string {
  if (!value) return value;
  return value[0]!.toLowerCase() + value.slice(1);
}

/**
 * Strips a leading "the"/"a"/"an" before this module prepends its own
 * article — otherwise a value a customer or provider already phrased with
 * one (e.g. "The crew") would read as "the the crew" once templated.
 */
function withoutLeadingArticle(value: string): string {
  return value.replace(/^(the|a|an)\s+/i, "");
}

/**
 * Sprint 2G Part 3: shown as a "Designer Decision" card when the customer
 * explicitly defers a decision ("You choose.") — a completed decision the
 * designer will make well, not a gap. Distinct from `DEFERRED_LABELS` in
 * DesignSummaryCapability (a short noun phrase for a list); this is the
 * standalone sentence shown in the moment.
 */
const DESIGNER_DECISION_MESSAGES: Partial<Record<BriefSectionKey, string>> = {
  style: "We'll choose a style that fits the rest of the brief.",
  colors: "We'll choose colors that work well with the shirt.",
  printLocation: "We'll choose the placement that works best for this design.",
  purpose: "We'll keep the design broadly appropriate without a specific occasion in mind.",
  audience: "We'll design with broad appeal in mind.",
};

export function designerDecisionMessage(section: BriefSectionKey): string {
  return (
    DESIGNER_DECISION_MESSAGES[section] ?? "We'll make the best call here for you."
  );
}

/** Plain acknowledgement after undoing the most recent accepted revision. */
export function describeUndo(changedSections: string[]): string {
  const known = changedSections.filter(
    (section): section is BriefSectionKey => section in SECTION_LABELS,
  );
  if (known.length === 0) return "Done — I've undone the last change.";
  if (known.length === 1) {
    return `Done — I've undone the change to ${SECTION_LABELS[known[0]!]}.`;
  }
  return "Done — I've undone the last change.";
}
