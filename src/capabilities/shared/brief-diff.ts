import type { TShirtDesignBrief } from "@/lib/domain/types";
import type { BriefSectionKey } from "./contracts";

/**
 * Pure Design Brief diffing (Sprint 2G Part 3 — extracted from
 * RevisionIntelligenceCapability so other read-only presentation logic,
 * e.g. "is this batch of concepts still current", can compare a brief
 * against a point-in-time snapshot without duplicating the field↔section
 * mapping or depending on the RevisionIntelligence capability itself).
 *
 * Which `BriefSectionKey` each `TShirtDesignBrief` field maps to — the
 * single source of truth other diffing needs (Revision Intelligence,
 * concept staleness) should build on.
 */
export function diffBriefSections(
  previous: TShirtDesignBrief,
  updated: TShirtDesignBrief,
): BriefSectionKey[] {
  const changed = new Set<BriefSectionKey>();

  if (previous.productSummary !== updated.productSummary) changed.add("product");
  if (previous.designDescription !== updated.designDescription) changed.add("graphics");
  if (previous.shirtColor !== updated.shirtColor) changed.add("productColor");
  if (previous.exactText !== updated.exactText) changed.add("requiredWording");
  if (!sameStringSet(previous.preferredColors, updated.preferredColors)) {
    changed.add("colors");
  }
  if (previous.designStyle !== updated.designStyle) changed.add("style");
  if (previous.printPlacement !== updated.printPlacement) changed.add("printLocation");
  if (previous.audience !== updated.audience) changed.add("audience");
  if (previous.purpose !== updated.purpose) changed.add("purpose");
  if (previous.exclusions !== updated.exclusions) changed.add("exclusions");
  if (previous.additionalInstructions !== updated.additionalInstructions) {
    changed.add("additionalNotes");
  }

  // A section newly deferred, or newly un-deferred (the customer took it
  // back over), is itself a revision to that section — the customer's
  // resolution of it changed even if there's still no concrete content.
  const previousDeferred = new Set(previous.deferredSections);
  const updatedDeferred = new Set(updated.deferredSections);
  for (const section of previousDeferred) {
    if (!updatedDeferred.has(section)) changed.add(section as BriefSectionKey);
  }
  for (const section of updatedDeferred) {
    if (!previousDeferred.has(section)) changed.add(section as BriefSectionKey);
  }

  return [...changed];
}

function sameStringSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const normalize = (values: string[]) =>
    [...values].map((value) => value.toLowerCase()).sort();
  const na = normalize(a);
  const nb = normalize(b);
  return na.every((value, index) => value === nb[index]);
}
