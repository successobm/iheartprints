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

/**
 * Live Acceptance Cleanup (UPDATED badge): the subset of `diffBriefSections`
 * that represents a customer CHANGING something they had already
 * established — never establishing it for the first time.
 *
 * The live bug: answering "Print Location" once, during the initial
 * interview, rendered the Design Summary row as `Full Front UPDATED`. Every
 * field starts empty, so the very first answer to every question read as an
 * update to a value that had never existed. "UPDATED" has to mean "this is
 * different from what you told me before", or it means nothing.
 *
 * Deliberately NOT a change to `diffBriefSections` itself. Revision
 * Intelligence genuinely needs "did this section change at all" — a
 * first-time answer absolutely warrants re-evaluation, new recommendations,
 * and concept-staleness analysis. This is the narrower, presentation-only
 * question, so the two never get conflated.
 *
 * A section the customer newly DEFERRED to the designer is treated the same
 * way: deferring a section that had no value yet is a first-time decision,
 * not a revision of one.
 */
export function diffEstablishedBriefSections(
  previous: TShirtDesignBrief,
  updated: TShirtDesignBrief,
): BriefSectionKey[] {
  return diffBriefSections(previous, updated).filter((section) =>
    sectionWasEstablished(previous, section),
  );
}

/** Whether `brief` already carried a real value (or an explicit deferral) for `section`. */
function sectionWasEstablished(
  brief: TShirtDesignBrief,
  section: BriefSectionKey,
): boolean {
  if (brief.deferredSections.includes(section)) return true;

  switch (section) {
    case "product":
      return hasText(brief.productSummary);
    case "graphics":
      return hasText(brief.designDescription);
    case "productColor":
      return hasText(brief.shirtColor);
    case "requiredWording":
      return hasText(brief.exactText);
    case "colors":
      return brief.preferredColors.length > 0;
    case "style":
      return hasText(brief.designStyle);
    case "printLocation":
      return brief.printPlacement !== null;
    case "audience":
      return hasText(brief.audience);
    case "purpose":
      return hasText(brief.purpose);
    case "exclusions":
      return hasText(brief.exclusions);
    case "additionalNotes":
      return hasText(brief.additionalInstructions);
    default:
      return false;
  }
}

function hasText(value: string | null): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function sameStringSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const normalize = (values: string[]) =>
    [...values].map((value) => value.toLowerCase()).sort();
  const na = normalize(a);
  const nb = normalize(b);
  return na.every((value, index) => value === nb[index]);
}
