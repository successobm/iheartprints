import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { describeConceptStatus } from "./concept-generation-capability";
import type {
  ArtworkVersion,
  DesignBriefVersion,
  TShirtDesignBrief,
} from "@/lib/domain/types";

function brief(overrides: Partial<TShirtDesignBrief> = {}): TShirtDesignBrief {
  return {
    id: "brief-1",
    projectId: "project-1",
    customerName: null,
    projectName: null,
    productSummary: "Camp shirts",
    designDescription: "A friendly bear logo",
    exactText: "Camp Wildwood 2026",
    shirtColor: "Navy",
    printPlacement: "full_front",
    intendedPrintWidthIn: null,
    requestedProductionOutput: null,
    preferredColors: ["Gold"],
    designStyle: "Rustic",
    additionalInstructions: null,
    audience: "Camp families",
    purpose: "Fundraiser",
    exclusions: null,
    deferredSections: [],
    createdAt: "2026-08-04T00:00:00.000Z",
    updatedAt: "2026-08-04T00:00:00.000Z",
    ...overrides,
  };
}

function version(
  overrides: Partial<DesignBriefVersion> = {},
): DesignBriefVersion {
  const content = {
    productSummary: "Camp shirts",
    designDescription: "A friendly bear logo",
    exactText: "Camp Wildwood 2026",
    shirtColor: "Navy",
    printPlacement: "full_front" as const,
    preferredColors: ["Gold"],
    designStyle: "Rustic",
    additionalInstructions: null,
    audience: "Camp families",
    purpose: "Fundraiser",
    exclusions: null,
    deferredSections: [],
  };
  return {
    id: "version-1",
    projectId: "project-1",
    briefId: "brief-1",
    versionNumber: 1,
    status: "approved",
    content,
    approvedAt: "2026-08-04T00:00:00.000Z",
    createdAt: "2026-08-04T00:00:00.000Z",
    ...overrides,
  };
}

function artwork(overrides: Partial<ArtworkVersion> = {}): ArtworkVersion {
  return {
    id: "artwork-1",
    projectId: "project-1",
    versionNumber: 1,
    kind: "concept",
    title: "Concept A",
    summary: "...",
    placeholderLabel: "Concept A",
    accentColor: "#000000",
    isSelected: false,
    designBriefVersionId: "version-1",
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
    createdAt: "2026-08-04T00:00:00.000Z",
    ...overrides,
  };
}

describe("describeConceptStatus", () => {
  it("returns 'none' when no concepts have been generated", () => {
    const status = describeConceptStatus(brief(), [], []);
    assert.equal(status.status, "none");
    assert.equal(status.currentConcepts.length, 0);
  });

  it("is 'current' when the working brief matches the approved version that generated the concepts", () => {
    const v1 = version();
    const concepts = [1, 2, 3].map((n) =>
      artwork({ id: `a${n}`, versionNumber: n, designBriefVersionId: v1.id }),
    );
    const status = describeConceptStatus(brief(), concepts, [v1]);

    assert.equal(status.status, "current");
    assert.match(status.message, /latest approved design/i);
    assert.equal(status.currentConcepts.length, 3);
    assert.deepEqual(status.previousBatches, []);
  });

  it("is 'needs_update' once the working brief diverges from the approved version in a concept-relevant way", () => {
    const v1 = version();
    const concepts = [1, 2, 3].map((n) =>
      artwork({ id: `a${n}`, versionNumber: n, designBriefVersionId: v1.id }),
    );
    const changedBrief = brief({ shirtColor: "Black" }); // productColor is concept-relevant
    const status = describeConceptStatus(changedBrief, concepts, [v1]);

    assert.equal(status.status, "needs_update");
    assert.match(status.message, /affect these concepts/i);
    assert.doesNotMatch(status.message, /stale|invalidated|version mismatch/i);
  });

  it("stays 'current' when only non-concept-relevant fields changed (e.g. audience)", () => {
    const v1 = version();
    const concepts = [1, 2, 3].map((n) =>
      artwork({ id: `a${n}`, versionNumber: n, designBriefVersionId: v1.id }),
    );
    const changedBrief = brief({ audience: "Alumni" });
    const status = describeConceptStatus(changedBrief, concepts, [v1]);

    assert.equal(status.status, "current");
  });

  it("lists older batches as previousBatches, most recent first, without deleting them", () => {
    const v1 = version({ id: "version-1", versionNumber: 1 });
    const v2 = version({ id: "version-2", versionNumber: 2 });
    const firstBatch = [1, 2, 3].map((n) =>
      artwork({ id: `a${n}`, versionNumber: n, designBriefVersionId: v1.id }),
    );
    const secondBatch = [4, 5, 6].map((n) =>
      artwork({ id: `a${n}`, versionNumber: n, designBriefVersionId: v2.id }),
    );

    const status = describeConceptStatus(brief(), [...firstBatch, ...secondBatch], [
      v1,
      v2,
    ]);

    assert.equal(status.currentConcepts.length, 3);
    assert.equal(status.currentConcepts[0]?.designBriefVersionId, "version-2");
    assert.equal(status.previousBatches.length, 1);
    assert.equal(status.previousBatches[0]?.length, 3);
    assert.equal(status.previousBatches[0]?.[0]?.designBriefVersionId, "version-1");
  });

  it("never mentions internal version identifiers in the message", () => {
    const v1 = version();
    const concepts = [artwork({ designBriefVersionId: v1.id })];
    const status = describeConceptStatus(brief(), concepts, [v1]);
    assert.doesNotMatch(status.message, /version-1|[0-9a-f-]{8,}/i);
  });
});
