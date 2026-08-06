import type {
  DesignBriefSnapshotContent,
  GenerationPromptRequest,
  PrintPlacement,
} from "@/lib/domain/types";
import type { RegenerationPlan } from "@/capabilities/regeneration-intelligence";

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

  return {
    product: content.productSummary?.trim() || "a custom t-shirt",
    subject:
      content.designDescription?.trim() ||
      "a design that reflects the customer's intent",
    style: deferred.has("style") ? null : content.designStyle?.trim() || null,
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
  };
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
      break;
    case "colors":
      request.colors = [];
      break;
    case "graphics":
      request.subject = "a design that reflects the customer's intent";
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
