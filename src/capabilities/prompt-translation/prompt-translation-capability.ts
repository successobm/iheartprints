import type {
  DesignBriefSnapshotContent,
  GenerationPromptRequest,
  PrintPlacement,
  RevisionDirective,
} from "@/lib/domain/types";
import type { RegenerationPlan } from "@/capabilities/regeneration-intelligence";
import { deriveRequiredWording } from "@/lib/domain/required-wording";
import { COLOR_WORD_PATTERN } from "@/capabilities/shared/color-families";
import { extractRevisionDelta } from "@/capabilities/shared/revision-delta";

import { extractCreativeReferences } from "./creative-reference-extraction";
import type { GenerationIntent } from "./generation-intent";

/**
 * Sprint 2H Part 1 + Sprint 2J Phase 3: the only bridge between
 * GenerationIntent and a generation provider. Pure and deterministic —
 * no I/O, no provider knowledge, no quality-boosting keywords.
 *
 * `translate(generationIntent)` is the sole entry point. When the intent
 * has no RegenerationPlan, output is byte-for-byte equivalent to the
 * historical brief-only translation (initial generation regression).
 * When a plan is present, the approved brief is merged with regeneration
 * guidance in documented priority order — still provider-neutral.
 *
 * Never mutates the approved Design Brief.
 */
export interface PromptTranslationCapability {
  translate(generationIntent: GenerationIntent): GenerationPromptRequest;
}

export function createPromptTranslationCapability(): PromptTranslationCapability {
  return {
    translate(generationIntent) {
      const base: GenerationPromptRequest = {
        ...translateApprovedBrief(generationIntent.approvedBrief),
        targetConceptDirectionKey: generationIntent.targetConceptDirectionKey,
      };
      if (!generationIntent.regenerationPlan) return base;
      const merged = mergeRegenerationPlan(
        base,
        generationIntent.approvedBrief,
        generationIntent.regenerationPlan,
      );
      // True Source-Image Targeted Revision: only a TARGETED revision (one
      // selected source concept) is an edit. A three-direction "show me
      // alternatives" regeneration has no single artwork to apply a delta
      // to and stays pure text-to-image, exactly as before.
      if (!generationIntent.targetConceptDirectionKey) return merged;
      merged.revision = buildRevisionDirective(
        merged,
        generationIntent.regenerationPlan,
        generationIntent.revisionInstruction,
      );
      return merged;
    },
  };
}

/**
 * Historical brief→request mapping. Kept as a named function so initial-
 * generation regression tests can prove byte-for-byte equivalence with
 * the pre-GenerationIntent translator.
 */
export function translateApprovedBrief(
  content: DesignBriefSnapshotContent,
): GenerationPromptRequest {
  const deferred = new Set(content.deferredSections);

  // Sprint 2K Phase 3 (Goal 4): split reference/inspiration language out of
  // the free-text description and style before it becomes `subject`/
  // `style` — a stylistic reference ("inspired by a 1960s sitcom") must
  // never be handed to a provider as if it were content to depict.
  const rawSubject = content.designDescription?.trim() || "";
  const subjectSplit = extractCreativeReferences(rawSubject);
  const rawStyle = deferred.has("style") ? "" : content.designStyle?.trim() || "";
  const styleSplit = extractCreativeReferences(rawStyle);

  const inspirationReferences = dedupeInspirations([
    ...subjectSplit.inspirations,
    ...styleSplit.inspirations,
  ]);

  // Phase 1.1: the fix for the live no-text failure. The old expression here
  // was `content.exactText?.trim() || null`, which collapsed the customer's
  // explicit "no wording" (`exactText === ""`) into exactly the same `null`
  // that an unanswered question produces. Every downstream layer then had no
  // way to tell "the customer wants NO text" apart from "we don't know yet",
  // so neither the provider prompt nor the concept directions ever imposed a
  // no-text constraint — and the generated artwork came back covered in
  // invented lettering. `deriveRequiredWording` is the one authority on that
  // distinction; the mode travels with the request from here on.
  const wording = deriveRequiredWording({ exactText: content.exactText });

  return {
    product: content.productSummary?.trim() || "a custom t-shirt",
    subject: subjectSplit.content || "a design that reflects the customer's intent",
    style: deferred.has("style") ? null : styleSplit.content || null,
    colors: deferred.has("colors") ? [] : content.preferredColors,
    productColor: content.shirtColor?.trim() || null,
    requiredWording: wording.mode === "provided" ? wording.text : null,
    wordingMode: wording.mode,
    printLocation: content.printPlacement,
    audience: deferred.has("audience")
      ? null
      : content.audience?.trim() || null,
    purpose: deferred.has("purpose") ? null : content.purpose?.trim() || null,
    exclusions: content.exclusions?.trim() || null,
    notes: content.additionalInstructions?.trim() || null,
    inspirationReferences,
    // Sprint 2K Phase 3 (Goal 7): generation must never invent wording the
    // brief didn't ask for. No current brief signal asks for *additional*
    // text beyond the required wording, so this is always false — an
    // explicit, provider-neutral field rather than an OpenAI prompt hack.
    allowAdditionalText: false,
    // Set by `translate()` itself from `GenerationIntent.targetConceptDirectionKey`
    // — never known at this pure brief→request mapping stage.
    targetConceptDirectionKey: null,
    // True Source-Image Targeted Revision: a brief alone is never an edit.
    // Only `translate()` can set this, and only for a targeted revision.
    revision: null,
  };
}

function dedupeInspirations(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const key = value.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(value.trim());
  }
  return result;
}

/**
 * Merge priority (Sprint 2J Phase 3):
 * 1. Explicit exclusions
 * 2. Required wording
 * 3. Latest customer revisions
 * 4. Evaluation-driven improvements
 * 5. Product Intelligence (reserved)
 * 6. Design Intelligence (reserved)
 * 7. Preserve satisfied requirements
 */
function mergeRegenerationPlan(
  base: GenerationPromptRequest,
  content: DesignBriefSnapshotContent,
  plan: RegenerationPlan,
): GenerationPromptRequest {
  const merged: GenerationPromptRequest = { ...base };

  if (content.exclusions?.trim()) {
    merged.exclusions = content.exclusions.trim();
  }

  for (const change of plan.remove) {
    applyRemove(merged, change.section);
  }

  const guidance = plan.priorityChanges
    .filter((change) => change.section !== "exclusions")
    .map((change) => change.description.trim())
    .filter(Boolean);
  const uniqueGuidance = [...new Set(guidance)];
  const briefNotes = content.additionalInstructions?.trim() || "";
  const parts = [briefNotes, ...uniqueGuidance].filter(Boolean);
  merged.notes = parts.length > 0 ? parts.join(" ") : null;

  return merged;
}

/**
 * Nouns that NAME the wording of a design. Naming the wording is not by
 * itself a request to change it — see `requestsWordingChange`.
 * `font`/`typeface` are deliberately absent: they name typography, not
 * wording, so "change the font to something more retro" never unlocks it.
 */
const WORDING_NOUN_PATTERN =
  /\b(text|wording|words?|letter(?:s|ing)?|caption|slogan|title|tagline|headline|name)\b/i;

/**
 * Cues that mean the wording ITSELF is changing — what the design SAYS.
 * Independent of whether a wording noun is present ("make it say MR2
 * TURBO", "fix the spelling").
 */
const WORDING_MUTATION_PATTERN =
  /\b(spell(?:s|ed|ing)?|misspell\w*|says?|reads?|reword\w*|rephras\w*|renam\w*|retype\w*|typo|capitali[sz]\w*|uppercase|lowercase|all\s+caps)\b/i;

/**
 * Cues that a clause is about how something LOOKS rather than what it says
 * — color, typography treatment, size, weight, position. Deliberately
 * generic (no product nouns, no per-scenario keywords).
 */
const APPEARANCE_CHANGE_PATTERN =
  /\b(colou?rs?|colou?red|shade|tint|hue|font|typeface|typography|bold(?:er)?|italic|weight|thick(?:er)?|thinner|outline|stroke|shadow|glow|gradient|chrome|metallic|matte|glossy|size|sizes|bigger|larger|smaller|enlarge|shrink|scale|position|placement|move|centre|center|align|spacing|kerning|match(?:es|ing)?|same\s+as)\b/i;

/**
 * A quoted string — how a customer states replacement wording
 * (`change the text to "MR2 TURBO"`). Only real double/smart quotes: an
 * apostrophe in "don't" must never read as a quoted replacement.
 */
const QUOTED_REPLACEMENT_PATTERN = /["“”][^"“”]{1,120}["“”]/;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * True Source-Image Targeted Revision (required-wording protection):
 * whether the customer's own delta is about the wording. Only then may the
 * exact-wording lock be lifted — otherwise "change the font to retro" or
 * "make the car larger" could quietly license a provider to reinterpret
 * "1988 Toyota MR2".
 *
 * Live Acceptance Cleanup — the bug this rewrite fixes: the old rule
 * unlocked wording on the bare NOUN "text", so "make the 3 SONS text the
 * same color as the ball" was read as a wording change. That dropped the
 * exact-wording lock and told the provider it was changing what the design
 * says — a direct licence to re-render every word, which is how an
 * untouched word ("MY") came back restyled. Naming a text element while
 * asking for a COLOR/SIZE/WEIGHT/POSITION change is styling, never
 * re-wording.
 *
 * A clause is a wording change when any of these hold — each grounded in
 * what the customer actually said or did:
 *   - it quotes the currently required wording (`change "1988 Toyota MR2"
 *     to "MR2 TURBO"` is unambiguous);
 *   - it carries an explicit wording-mutation cue (say / read / spell /
 *     reword / rename / capitalize);
 *   - it names the wording AND supplies quoted replacement text;
 *   - it names the wording and asks for something that is NOT an
 *     appearance change.
 *
 * The RegenerationPlan's own `requiredWording` entries count too — that is
 * the structured form of the same instruction.
 */
function requestsWordingChange(
  requestedChanges: string[],
  plan: RegenerationPlan,
  requiredWording: string | null,
): boolean {
  const planTouchedWording = [
    ...plan.remove,
    ...plan.replace,
    ...plan.customerRequestedChanges,
  ].some((change) => change.section === "requiredWording");
  if (planTouchedWording) return true;

  const wordingPattern = requiredWording?.trim()
    ? new RegExp(escapeRegExp(requiredWording.trim()), "i")
    : null;

  return requestedChanges.some((change) =>
    clauseRequestsWordingChange(change, wordingPattern),
  );
}

function clauseRequestsWordingChange(
  clause: string,
  currentWordingPattern: RegExp | null,
): boolean {
  if (currentWordingPattern?.test(clause)) return true;
  if (WORDING_MUTATION_PATTERN.test(clause)) return true;
  if (!WORDING_NOUN_PATTERN.test(clause)) return false;
  if (QUOTED_REPLACEMENT_PATTERN.test(clause)) return true;
  // Names the wording, but only asks for how it LOOKS to change. A bare
  // color name counts: customers say "make the word SALE red" far more
  // often than they say the token "color", and reading that as a request to
  // change what the design SAYS is exactly the live bug.
  return !(
    APPEARANCE_CHANGE_PATTERN.test(clause) || COLOR_WORD_PATTERN.test(clause)
  );
}

function dedupeNonEmpty(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    const key = trimmed.toLowerCase();
    if (!trimmed || seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
  }
  return result;
}

/**
 * True Source-Image Targeted Revision: assembles the provider-neutral
 * delta for ONE targeted revision.
 *
 * `requestedChanges` prefers the customer's literal instruction, split into
 * its distinct changes — that is the only representation that can say
 * "change it to a shield" at all. The `RegenerationPlan` is the fallback
 * (and always the source for preserve/avoid/wording): its descriptions are
 * canned section-level sentences ("Make sure the graphics reflect the
 * customer's requested change"), which are enough to know WHAT AREA
 * changed but never enough to edit an image.
 *
 * Still provider-neutral: plain customer language, no prompt syntax. The
 * adapter owns every word of how this is expressed.
 */
function buildRevisionDirective(
  request: GenerationPromptRequest,
  plan: RegenerationPlan,
  revisionInstruction: string | null,
): RevisionDirective {
  const fromInstruction = revisionInstruction
    ? extractRevisionDelta(revisionInstruction)
    : { requestedChanges: [], preserveEverythingElse: false };
  const fromPlan = (
    plan.customerRequestedChanges.length > 0
      ? plan.customerRequestedChanges
      : plan.priorityChanges
  ).map((change) => change.description);

  const requestedChanges = dedupeNonEmpty(
    fromInstruction.requestedChanges.length > 0
      ? fromInstruction.requestedChanges
      : fromPlan,
  );

  const wordingChangeRequested = requestsWordingChange(
    requestedChanges,
    plan,
    request.requiredWording,
  );

  return {
    requestedChanges,
    preserve: dedupeNonEmpty(plan.preserve.map((change) => change.description)),
    avoid: dedupeNonEmpty([
      ...plan.avoid.map((change) => change.description),
      ...(request.exclusions ? [request.exclusions] : []),
    ]),
    lockedWording: wordingChangeRequested ? null : request.requiredWording,
    wordingChangeRequested,
    preserveEverythingElse: fromInstruction.preserveEverythingElse,
  };
}

function applyRemove(
  request: GenerationPromptRequest,
  section: string,
): void {
  switch (section) {
    case "requiredWording":
      request.requiredWording = null;
      // Phase 1.1: a RegenerationPlan removal means "stop requiring THAT
      // string", which is not the same customer intent as "put no text on
      // this design at all". Only an explicit `exactText === ""` on the
      // approved brief may ever produce the hard no-text constraint — and
      // when the customer did say that, `translateApprovedBrief` has already
      // set `wordingMode: "none"` above and this branch is never the thing
      // that decides it. Downgrading to `"unknown"` here keeps the two
      // intents from being conflated in either direction. An already-explicit
      // `"none"` is never downgraded — removing wording that is already
      // absent must not quietly cancel the customer's no-text request.
      if (request.wordingMode === "provided") request.wordingMode = "unknown";
      break;
    case "style":
      request.style = null;
      // A removed style can no longer license any style-derived
      // inspiration reference either.
      request.inspirationReferences = [];
      break;
    case "colors":
      request.colors = [];
      break;
    case "graphics":
      request.subject = "a design that reflects the customer's intent";
      request.inspirationReferences = [];
      break;
    case "productColor":
      request.productColor = null;
      break;
    case "printLocation":
      request.printLocation = null as PrintPlacement | null;
      break;
    case "product":
      request.product = "a custom t-shirt";
      break;
    default:
      break;
  }
}
