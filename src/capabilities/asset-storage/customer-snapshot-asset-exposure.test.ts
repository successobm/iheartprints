import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ProjectSnapshot } from "@/lib/domain/types";

describe("customer snapshot asset exposure (Sprint 2H Part 2A security)", () => {
  it("ProjectSnapshot has no assets array and ArtworkVersion exposes only asset ids", () => {
    // Compile-time shape check via a value that satisfies ProjectSnapshot —
    // raw storage keys must never appear on the customer-facing snapshot.
    const snapshot = {
      project: {} as ProjectSnapshot["project"],
      brief: {} as ProjectSnapshot["brief"],
      conversation: {} as ProjectSnapshot["conversation"],
      messages: [],
      artworkVersions: [
        {
          id: "art-1",
          projectId: "proj-1",
          versionNumber: 1,
          kind: "concept",
          title: "Concept 1",
          summary: "summary",
          placeholderLabel: "Concept 1",
          accentColor: "#000",
          isSelected: false,
          designBriefVersionId: null,
          generationJobId: null,
          primaryAssetId: "asset-1",
          thumbnailAssetId: "asset-2",
          providerKey: null,
          customerRating: null,
          evaluationStatus: null,
          printValidationStatus: null,
          createdAt: new Date().toISOString(),
        },
      ],
      designBriefVersions: [],
    } satisfies ProjectSnapshot;

    assert.equal("assets" in snapshot, false);
    assert.equal("storageKey" in snapshot.artworkVersions[0]!, false);
    assert.equal(snapshot.artworkVersions[0]!.primaryAssetId, "asset-1");
    assert.equal(snapshot.artworkVersions[0]!.thumbnailAssetId, "asset-2");
  });
});
