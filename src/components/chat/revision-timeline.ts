import { sectionTitle } from "@/capabilities/shared/question-phrasing";
import type { BriefSectionKey } from "@/capabilities/shared/contracts";
import type { ConversationMessage } from "@/lib/domain/types";

/**
 * Sprint 2G Part 3: a compact, customer-facing design history — "this is
 * not an audit log" — derived purely from message metadata the API
 * already sends (`updatedSections`, `phase`, `undone`). No IDs, no
 * timestamps, no internal state; just natural-language milestones.
 */
export interface TimelineEntry {
  id: string;
  label: string;
}

export function buildRevisionTimeline(
  messages: ConversationMessage[],
): TimelineEntry[] {
  const entries: TimelineEntry[] = [{ id: "original", label: "Original Design" }];
  let conceptBatches = 0;

  for (const message of messages) {
    if (message.role !== "assistant") continue;
    const metadata = message.metadata ?? {};

    const updatedSections = metadata.updatedSections;
    if (Array.isArray(updatedSections) && updatedSections.length > 0) {
      entries.push({ id: `${message.id}-updated`, label: changeLabel(updatedSections) });
    }

    if (metadata.undone) {
      entries.push({ id: `${message.id}-undo`, label: "Undid Last Change" });
    }

    if (metadata.phase === "concepts_ready") {
      conceptBatches += 1;
      entries.push({
        id: `${message.id}-concepts`,
        label: conceptBatches === 1 ? "Generated Concepts" : "Revised Concepts",
      });
    }
  }

  return entries;
}

function changeLabel(sections: unknown[]): string {
  const known = sections.filter(
    (section): section is BriefSectionKey => typeof section === "string",
  );
  if (known.length === 0) return "Updated the Design";
  if (known.length === 1) return `Changed ${sectionTitle(known[0]!)}`;
  return `Changed ${known.map(sectionTitle).join(", ")}`;
}
