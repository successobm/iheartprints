import type { ArtworkVersion } from "@/lib/domain/types";

/**
 * Live Acceptance Corrective Pass (Section 2): a single, artwork-version-
 * lineage-based customer-facing design history, replacing the two surfaces
 * that used to collide in the UI —
 *   1. the old `buildRevisionTimeline` (message-metadata-keyed: any brief
 *      field edit, including ones that never produced new artwork, showed
 *      up as a milestone — "Changed Print Location" being the reported
 *      confusion), and
 *   2. a separate "View design history" panel that only ever showed
 *      `previousBatches`, with no unified narrative and its own heading.
 *
 * This module derives history purely from `ArtworkVersion` fields that
 * already exist — `kind`, `sourceArtworkVersionId`, `designBriefVersionId`,
 * `createdAt` — plus the project's current `selectedArtworkVersionId`. No
 * new persistence, no brief-field diffing: a brief edit that never produced
 * a new artwork version is invisible here, by construction, exactly as
 * required. The full internal audit history (brief versions, every field
 * change) is untouched and still recorded elsewhere — this is only a
 * customer-facing projection.
 *
 * Model: "Original Concepts → Selected Concept → Revision 1 → Revision 2 →
 * Current Version" — each entry names either a batch of fresh concepts
 * (`kind: "concept"`, no `sourceArtworkVersionId`) or a single targeted
 * revision (`sourceArtworkVersionId` set), with a "Selected Concept"
 * milestone inserted wherever the lineage shows a customer pick fed the
 * next revision, and a final "Current Version" marker for whatever is
 * selected right now (even if that's the same artwork as the last
 * milestone, or an earlier one the customer explicitly returned to).
 */
export interface DesignHistoryEntry {
  id: string;
  label: string;
  /** Which artwork version(s) this milestone represents — lets the UI open the existing preview for any of them. */
  artworkVersionIds: string[];
}

/**
 * Live Acceptance Cleanup (Issue 3): history entries are keyed by (approved
 * brief version, BATCH) rather than by brief version alone. "Show Me 3 New
 * Concepts" produces a second batch under the SAME approved version, and
 * without the batch ordinal the two would merge into one "Original
 * Concepts" milestone — hiding the fact that the earlier batch still exists
 * and is still selectable, which is the whole point of keeping it.
 */
type HistoryArtworkVersion = ArtworkVersion & {
  conceptBatchOrdinal?: number | null;
};

export function buildDesignHistory(
  artworkVersions: HistoryArtworkVersion[],
  selectedArtworkVersionId: string | null,
): DesignHistoryEntry[] {
  // Finalized/production artwork belongs to a separate pipeline
  // (finalization, not concept/revision exploration) — never part of this
  // narrative.
  const relevant = artworkVersions.filter((version) => version.kind !== "final");
  if (relevant.length === 0) return [];

  const sorted = [...relevant].sort((a, b) => {
    const byTime = Date.parse(a.createdAt) - Date.parse(b.createdAt);
    return byTime !== 0 ? byTime : a.versionNumber - b.versionNumber;
  });

  // Group by (designBriefVersionId, batch), preserving order of first
  // appearance — every real generation batch (initial, "show me
  // alternatives", a second exploration of the same brief, or a single
  // revision) is one entry.
  const groups: HistoryArtworkVersion[][] = [];
  const groupIndexByVersion = new Map<string, number>();
  for (const version of sorted) {
    const key = `${version.designBriefVersionId ?? `__ungrouped-${version.id}`}::${
      version.conceptBatchOrdinal ?? "batch"
    }`;
    let index = groupIndexByVersion.get(key);
    if (index === undefined) {
      index = groups.length;
      groupIndexByVersion.set(key, index);
      groups.push([]);
    }
    groups[index]!.push(version);
  }

  const entries: DesignHistoryEntry[] = [];
  let revisionCount = 0;
  let sawFirstBatch = false;
  let previousGroupIds: string[] = [];
  let lastGroupWasRevision = false;

  for (const group of groups) {
    const sourceId = group.find((v) => v.sourceArtworkVersionId)?.sourceArtworkVersionId ?? null;
    const isRevisionGroup = sourceId !== null;

    if (isRevisionGroup) {
      if (sourceId && previousGroupIds.includes(sourceId)) {
        entries.push({
          id: `selected-${sourceId}`,
          label: "Selected Concept",
          artworkVersionIds: [sourceId],
        });
      }
      revisionCount += 1;
      entries.push({
        id: `revision-${group[0]!.id}`,
        label: `Revision ${revisionCount}`,
        artworkVersionIds: group.map((v) => v.id),
      });
      lastGroupWasRevision = true;
    } else {
      entries.push({
        id: `batch-${group[0]!.id}`,
        label: sawFirstBatch ? "New Concepts" : "Original Concepts",
        artworkVersionIds: group.map((v) => v.id),
      });
      sawFirstBatch = true;
      lastGroupWasRevision = false;
    }

    previousGroupIds = group.map((v) => v.id);
  }

  // A selection made from the most recent batch that hasn't yet produced a
  // follow-up revision isn't otherwise represented above (there's no next
  // group's `sourceArtworkVersionId` to reveal it) — add it explicitly.
  if (
    !lastGroupWasRevision &&
    selectedArtworkVersionId &&
    previousGroupIds.includes(selectedArtworkVersionId)
  ) {
    entries.push({
      id: `selected-${selectedArtworkVersionId}`,
      label: "Selected Concept",
      artworkVersionIds: [selectedArtworkVersionId],
    });
  }

  // "You are here" — always last, whatever is selected right now, even if
  // that repeats the immediately preceding milestone's artwork, or points
  // back at an earlier one the customer explicitly returned to.
  if (selectedArtworkVersionId) {
    entries.push({
      id: `current-${selectedArtworkVersionId}`,
      label: "Current Version",
      artworkVersionIds: [selectedArtworkVersionId],
    });
  }

  return entries;
}
