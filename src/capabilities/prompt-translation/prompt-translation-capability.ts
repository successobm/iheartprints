import type {
  DesignBriefSnapshotContent,
  GenerationPromptRequest,
  PrintPlacement,
} from "@/lib/domain/types";
import type { RegenerationPlan } from "@/capabilities/regeneration-intelligence";

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
      const base = translateApprovedBrief(generationIntent.approvedBrief);
      if (!generationIntent.regenerationPlan) return base;
      return mergeRegenerationPlan(
        base,
        generationIntent.approvedBrief,
        generationIntent.regenerationPlan,
      );
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

  return {
    product: content.productSummary?.trim() || "a custom t-shirt",
    subject: subjectSplit.content || "a design that reflects the customer's intent",
    style: deferred.has("style") ? null : styleSplit.content || null,
    colors: deferred.has("colors") ? [] : content.preferredColors,
    productColor: content.shirtColor?.trim() || null,
    requiredWording: content.exactText?.trim() || null,
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

function applyRemove(
  request: GenerationPromptRequest,
  section: string,
): void {
  switch (section) {
    case "requiredWording":
      request.requiredWording = null;
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
