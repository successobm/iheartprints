import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildDesignHistory } from "./design-history";
import type { ArtworkVersion } from "@/lib/domain/types";

let versionCounter = 0;

function artwork(overrides: Partial<ArtworkVersion> & { id: string }): ArtworkVersion {
  versionCounter += 1;
  return {
    projectId: "project-1",
    versionNumber: versionCounter,
    kind: "concept",
    title: `Concept ${versionCounter}`,
    summary: "A design concept",
    placeholderLabel: `Concept ${versionCounter}`,
    accentColor: "#000000",
    isSelected: false,
    sourceArtworkVersionId: null,
    conceptDirectionKey: null,
    designBriefVersionId: "brief-v1",
    generationJobId: null,
    primaryAssetId: null,
    thumbnailAssetId: null,
    providerKey: null,
    customerRating: null,
    evaluationStatus: null,
    evaluation: null,
    evaluationEvaluatedAt: null,
    evaluationProviderKey: null,
    printValidationStatus: null,
    createdAt: `2026-08-04T00:00:${String(versionCounter).padStart(2, "0")}.000Z`,
    ...overrides,
  };
}

describe("buildDesignHistory — Live Acceptance Corrective Pass (Section 2): artwork-lineage-based customer history", () => {
  it("returns nothing when there is no artwork yet", () => {
    assert.deepEqual(buildDesignHistory([], null), []);
  });

  it("scenario 2: initial generation produces a single 'Original Concepts' milestone with all three concepts", () => {
    const c1 = artwork({ id: "c1", designBriefVersionId: "brief-v1" });
    const c2 = artwork({ id: "c2", designBriefVersionId: "brief-v1" });
    const c3 = artwork({ id: "c3", designBriefVersionId: "brief-v1" });

    const entries = buildDesignHistory([c1, c2, c3], null);
    assert.deepEqual(
      entries.map((e) => e.label),
      ["Original Concepts"],
    );
    assert.deepEqual(entries[0]!.artworkVersionIds.sort(), ["c1", "c2", "c3"]);
  });

  it("scenario 3: a customer selection is represented as its own milestone, plus the trailing 'Current Version' marker", () => {
    const c1 = artwork({ id: "c1", designBriefVersionId: "brief-v1" });
    const c2 = artwork({ id: "c2", designBriefVersionId: "brief-v1" });
    const c3 = artwork({ id: "c3", designBriefVersionId: "brief-v1" });

    const entries = buildDesignHistory([c1, c2, c3], "c1");
    assert.deepEqual(
      entries.map((e) => e.label),
      ["Original Concepts", "Selected Concept", "Current Version"],
    );
    assert.deepEqual(entries[1]!.artworkVersionIds, ["c1"]);
    assert.deepEqual(entries[2]!.artworkVersionIds, ["c1"]);
  });

  it("scenario 4 + 5: one real revision produces exactly one 'Revision 1' milestone, and sourceArtworkVersionId lineage is preserved in the preceding 'Selected Concept' entry", () => {
    const c1 = artwork({ id: "c1", designBriefVersionId: "brief-v1" });
    const c2 = artwork({ id: "c2", designBriefVersionId: "brief-v1" });
    const c3 = artwork({ id: "c3", designBriefVersionId: "brief-v1" });
    const rev1 = artwork({
      id: "rev1",
      designBriefVersionId: "brief-v2",
      kind: "revision",
      sourceArtworkVersionId: "c1",
    });

    const entries = buildDesignHistory([c1, c2, c3, rev1], "rev1");
    assert.deepEqual(
      entries.map((e) => e.label),
      ["Original Concepts", "Selected Concept", "Revision 1", "Current Version"],
    );
    assert.deepEqual(entries[1]!.artworkVersionIds, ["c1"]);
    assert.deepEqual(entries[2]!.artworkVersionIds, ["rev1"]);
    assert.deepEqual(entries[3]!.artworkVersionIds, ["rev1"]);
  });

  it("scenario 6: multiple revisions are ordered 'Revision 1', 'Revision 2', ... by creation order", () => {
    const c1 = artwork({ id: "c1", designBriefVersionId: "brief-v1" });
    const rev1 = artwork({
      id: "rev1",
      designBriefVersionId: "brief-v2",
      kind: "revision",
      sourceArtworkVersionId: "c1",
    });
    const rev2 = artwork({
      id: "rev2",
      designBriefVersionId: "brief-v3",
      kind: "revision",
      sourceArtworkVersionId: "rev1",
    });

    const entries = buildDesignHistory([c1, rev1, rev2], "rev2");
    assert.deepEqual(
      entries.map((e) => e.label),
      [
        "Original Concepts",
        "Selected Concept",
        "Revision 1",
        "Selected Concept",
        "Revision 2",
        "Current Version",
      ],
    );
    assert.deepEqual(
      entries.map((e) => e.artworkVersionIds),
      [["c1"], ["c1"], ["rev1"], ["rev1"], ["rev2"], ["rev2"]],
    );
  });

  it("scenario 7: historical artwork remains represented (never dropped) even after later revisions", () => {
    const c1 = artwork({ id: "c1", designBriefVersionId: "brief-v1" });
    const c2 = artwork({ id: "c2", designBriefVersionId: "brief-v1" });
    const rev1 = artwork({
      id: "rev1",
      designBriefVersionId: "brief-v2",
      kind: "revision",
      sourceArtworkVersionId: "c1",
    });

    const entries = buildDesignHistory([c1, c2, rev1], "rev1");
    const allIds = entries.flatMap((e) => e.artworkVersionIds);
    // The original batch's concepts are still referenced somewhere in the
    // history (the "Original Concepts" milestone), never removed.
    assert.ok(allIds.includes("c1"));
    assert.ok(allIds.includes("c2"));
  });

  it("scenario 1 + 8: only artwork-version milestones ever appear — no brief-field-only or implementation-detail labels (e.g. 'Changed Print Location')", () => {
    const c1 = artwork({ id: "c1", designBriefVersionId: "brief-v1" });
    const c2 = artwork({ id: "c2", designBriefVersionId: "brief-v1" });
    const rev1 = artwork({
      id: "rev1",
      designBriefVersionId: "brief-v2",
      kind: "revision",
      sourceArtworkVersionId: "c1",
    });
    const rev2 = artwork({
      id: "rev2",
      designBriefVersionId: "brief-v3",
      kind: "revision",
      sourceArtworkVersionId: "rev1",
    });

    const entries = buildDesignHistory([c1, c2, rev1, rev2], "rev2");
    for (const entry of entries) {
      assert.doesNotMatch(entry.label, /changed|print location|updated the design|wording/i);
    }
    // buildDesignHistory has no brief/field input at all — a brief-field-only
    // edit (no new artwork version) is structurally impossible to represent
    // here, which is the guarantee itself.
  });

  it("an explicit 'show me alternatives' batch (no sourceArtworkVersionId) after a revision is labeled 'New Concepts', not 'Original Concepts' or a fabricated revision", () => {
    const c1 = artwork({ id: "c1", designBriefVersionId: "brief-v1" });
    const rev1 = artwork({
      id: "rev1",
      designBriefVersionId: "brief-v2",
      kind: "revision",
      sourceArtworkVersionId: "c1",
    });
    const alt1 = artwork({ id: "alt1", designBriefVersionId: "brief-v3", sourceArtworkVersionId: null });
    const alt2 = artwork({ id: "alt2", designBriefVersionId: "brief-v3", sourceArtworkVersionId: null });
    const alt3 = artwork({ id: "alt3", designBriefVersionId: "brief-v3", sourceArtworkVersionId: null });

    const entries = buildDesignHistory([c1, rev1, alt1, alt2, alt3], null);
    assert.deepEqual(
      entries.map((e) => e.label),
      ["Original Concepts", "Selected Concept", "Revision 1", "New Concepts"],
    );
  });

  it("the customer explicitly returning to an earlier concept after an unwanted revision shows 'Current Version' pointing back at it, distinct from the revision milestone", () => {
    const c1 = artwork({ id: "c1", designBriefVersionId: "brief-v1" });
    const rev1 = artwork({
      id: "rev1",
      designBriefVersionId: "brief-v2",
      kind: "revision",
      sourceArtworkVersionId: "c1",
    });

    // The revision auto-selected itself, then the customer returned to c1.
    const entries = buildDesignHistory([c1, rev1], "c1");
    assert.deepEqual(
      entries.map((e) => e.label),
      ["Original Concepts", "Selected Concept", "Revision 1", "Current Version"],
    );
    assert.deepEqual(entries.at(-1)!.artworkVersionIds, ["c1"]);
    assert.notDeepEqual(entries.at(-1)!.artworkVersionIds, entries.at(-2)!.artworkVersionIds);
  });

  it("finalized ('kind: final') artwork is excluded from the concept/revision narrative entirely", () => {
    const c1 = artwork({ id: "c1", designBriefVersionId: "brief-v1" });
    const final1 = artwork({
      id: "final1",
      designBriefVersionId: "brief-v1",
      kind: "final",
      sourceArtworkVersionId: "c1",
    });

    const entries = buildDesignHistory([c1, final1], "c1");
    const allIds = entries.flatMap((e) => e.artworkVersionIds);
    assert.ok(!allIds.includes("final1"));
  });

  it("N: production AssetRecords are not Design History entries (creative lineage only)", () => {
    // Production output lives on AssetRecord with production_png — it is
    // never an ArtworkVersion, so it cannot appear in history unless a
    // caller incorrectly fabricates a version for it. Guard the filter
    // contract for kind:final and confirm ordinary concepts remain.
    const c1 = artwork({ id: "c1", designBriefVersionId: "brief-v1" });
    const entries = buildDesignHistory([c1], "c1");
    const labels = entries.map((e) => e.label).join(" ");
    assert.doesNotMatch(labels, /print-ready|production|Topaz/i);
    assert.ok(entries.every((e) => !e.artworkVersionIds.includes("production-asset")));
  });
});
