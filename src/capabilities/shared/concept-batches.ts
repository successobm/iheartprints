/**
 * Live Acceptance Cleanup (Issue 3): what a "batch of concepts" IS.
 *
 * Until now, "the current concepts" meant "every ArtworkVersion tied to the
 * most recently approved Design Brief version" — which was correct only
 * because one approved brief version could never have more than one batch.
 * "Show Me 3 New Concepts" breaks that assumption on purpose: the customer
 * disliked all three directions while the brief itself is perfectly right,
 * so a second batch of three is generated from the SAME approved version,
 * and the first batch is kept (Constitution §6.11 — Version Everything).
 *
 * A batch is therefore identified by (approved brief version, generation
 * job): every batch is produced by exactly one `GenerationJob`, and every
 * job produces exactly one batch. Concepts with no job at all (the
 * placeholder provider) group together rather than fragmenting into one
 * batch each.
 *
 * Pure and dependency-free — no repository, no capability, no I/O.
 */

import type { ArtworkVersion } from "@/lib/domain/types";

/** Stable grouping key. Internal only — never surfaced to a customer. */
function batchKey(version: ArtworkVersion): string {
  return `${version.designBriefVersionId ?? "no-brief-version"}::${
    version.generationJobId ?? "no-job"
  }`;
}

/**
 * Splits versions into batches, ordered oldest batch first. Ordering is by
 * each batch's earliest `versionNumber` — monotonically increasing and
 * immune to two batches sharing a `createdAt` second.
 */
export function groupConceptBatches(
  versions: ArtworkVersion[],
): ArtworkVersion[][] {
  const batches = new Map<string, ArtworkVersion[]>();
  for (const version of versions) {
    const key = batchKey(version);
    const existing = batches.get(key);
    if (existing) existing.push(version);
    else batches.set(key, [version]);
  }

  return [...batches.values()].sort(
    (a, b) => earliestVersionNumber(a) - earliestVersionNumber(b),
  );
}

function earliestVersionNumber(batch: ArtworkVersion[]): number {
  return batch.reduce(
    (lowest, version) => Math.min(lowest, version.versionNumber),
    Number.POSITIVE_INFINITY,
  );
}

/**
 * A customer-safe batch number (1, 2, 3, …) per artwork version, assigned in
 * generation order across the whole project.
 *
 * Deliberately an ordinal rather than the `generationJobId` it derives from:
 * the customer-facing `CustomerArtworkVersion` projection strips every
 * internal id (see `contracts.ts`), but a *presentation* surface still has
 * to be able to tell "the first three concepts" from "the three new ones" —
 * Design History renders them as separate milestones, and the concept grid
 * shows only the newest. An opaque counter carries exactly that much and
 * nothing else.
 */
export function assignConceptBatchOrdinals(
  versions: ArtworkVersion[],
): Map<string, number> {
  const ordinals = new Map<string, number>();
  groupConceptBatches(versions).forEach((batch, index) => {
    for (const version of batch) ordinals.set(version.id, index + 1);
  });
  return ordinals;
}
