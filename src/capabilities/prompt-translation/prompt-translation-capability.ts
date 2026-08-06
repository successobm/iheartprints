import type {
  DesignBriefSnapshotContent,
  GenerationPromptRequest,
  PrintPlacement,
} from "@/lib/domain/types";
import type { RegenerationPlan } from "@/capabilities/regeneration-intelligence";

/**
 * Sprint 2H Part 1 + Sprint 2J Phase 2: the only bridge between the Design
 * Brief (and optional RegenerationPlan) and a generation provider. Pure and
 * deterministic — no I/O, no provider knowledge, no quality-boosting
 * keywords. Turns an *approved* Design Brief snapshot into a plain-language,
 * provider-neutral request. When a `RegenerationPlan` is supplied, its
 * signals are merged into the same `GenerationPromptRequest` in documented
 * priority order — still provider-neutral; adapters own their dialect.
 *
 * Sections the customer explicitly deferred to the designer are intentionally
 * left out (`null`/empty) rather than filled in with an assumed value.
 */
export interface PromptTranslationCapability {
  /**
   * @param content Approved Design Brief snapshot.
   * @param regenerationPlan Optional plan from Regeneration Intelligence.
   *   When omitted/null, behavior is identical to Sprint 2H Part 1 (live
   *   worker path unchanged).
   */
  translate(
    content: DesignBriefSnapshotContent,
    regenerationPlan?: RegenerationPlan | null,
  ): GenerationPromptRequest;
}

export function createPromptTranslationCapability(): PromptTranslationCapability {
  return {
    translate(content, regenerationPlan = null) {
      const base = translateApprovedBrief(content);
      if (!regenerationPlan) return base;
      return mergeRegenerationPlan(base, content, regenerationPlan);
    },
  };
}

function translateApprovedBrief(
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
 * Merge priority (Sprint 2J Phase 2) — older signals never override newer:
 * 1. Explicit exclusions
 * 2. Required wording
 * 3. Latest customer revisions
 * 4. Evaluation failures
 * 5. Product Intelligence (reserved — no signal yet)
 * 6. Design Intelligence (reserved — no signal yet)
 * 7. Preserve already-satisfied requirements
 *
 * Field values still come from the approved brief. Plan guidance is appended
 * as plain-language notes in `priorityChanges` order — never provider dialect.
 */
function mergeRegenerationPlan(
  base: GenerationPromptRequest,
  content: DesignBriefSnapshotContent,
  plan: RegenerationPlan,
): GenerationPromptRequest {
  const merged: GenerationPromptRequest = { ...base };

  // Priority 1: exclusions field always reflects the approved brief.
  if (content.exclusions?.trim()) {
    merged.exclusions = content.exclusions.trim();
  }

  // Priority 2–3: apply explicit removals (customer cleared a section).
  for (const change of plan.remove) {
    applyRemove(merged, change.section);
  }

  // Remaining plan guidance — already ordered by Regeneration Intelligence
  // priorityChanges (exclusions → required wording → customer → evaluation →
  // preserve). Exclusions stay in the exclusions field, not duplicated here.
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
