import type { DesignBriefSnapshotContent, TShirtDesignBrief } from "./types";

/**
 * Pure `TShirtDesignBrief` → `DesignBriefSnapshotContent` projection —
 * shared by `DesignBriefCapability` (durable approval snapshots) and
 * `ConversationCapability` (Sprint 2G Part 3's one-level undo, which
 * snapshots the brief's revisable fields before applying a change).
 */
export function toDesignBriefSnapshotContent(
  brief: TShirtDesignBrief,
): DesignBriefSnapshotContent {
  return {
    productSummary: brief.productSummary,
    designDescription: brief.designDescription,
    exactText: brief.exactText,
    shirtColor: brief.shirtColor,
    printPlacement: brief.printPlacement,
    preferredColors: [...brief.preferredColors],
    designStyle: brief.designStyle,
    additionalInstructions: brief.additionalInstructions,
    audience: brief.audience,
    purpose: brief.purpose,
    exclusions: brief.exclusions,
    deferredSections: [...brief.deferredSections],
  };
}
