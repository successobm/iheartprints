import type {
  DesignBriefSnapshotContent,
  GenerationPromptRequest,
} from "@/lib/domain/types";

/**
 * Sprint 2H Part 1: the only bridge between the Design Brief and a
 * generation provider. Pure and deterministic — no I/O, no provider
 * knowledge, no quality-boosting keywords. Turns an *approved* Design Brief
 * snapshot into a plain-language, provider-neutral request. Sections the
 * customer explicitly deferred to the designer are intentionally left out
 * (`null`/empty) rather than filled in with an assumed value — a provider
 * adapter's own creative direction fills that gap, not a fabricated brief
 * answer.
 */
export interface PromptTranslationCapability {
  translate(content: DesignBriefSnapshotContent): GenerationPromptRequest;
}

export function createPromptTranslationCapability(): PromptTranslationCapability {
  return {
    translate(content) {
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
    },
  };
}
