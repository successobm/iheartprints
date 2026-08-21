import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createRevisionIntelligenceCapability } from "./revision-intelligence-capability";
import type { TShirtDesignBrief } from "@/lib/domain/types";

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
    garmentSizeClass: null,
    productionSizeConfirmedAt: null,
    productionSizeConfirmedWidthIn: null,
    productionSizeConfirmedMaxHeightIn: null,
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

const capability = createRevisionIntelligenceCapability();

describe("RevisionIntelligenceCapability — change detection", () => {
  it("is a no-op when nothing changed", () => {
    const a = brief();
    const b = brief();
    const impact = capability.analyze(a, b);

    assert.equal(impact.isNoOp, true);
    assert.deepEqual(impact.changedSections, []);
    assert.deepEqual(impact.affectedRulePacks, []);
    assert.equal(impact.needsReevaluation, false);
    assert.equal(impact.needsSummaryRefresh, false);
    assert.equal(impact.needsNewRecommendations, false);
    assert.equal(impact.needsConceptRegeneration, false);
  });

  it("detects a product-only change", () => {
    const impact = capability.analyze(
      brief(),
      brief({ productSummary: "Camp hoodies" }),
    );
    assert.deepEqual(impact.changedSections, ["product"]);
    assert.equal(impact.needsConceptRegeneration, true);
  });

  it("detects a product color-only change", () => {
    const impact = capability.analyze(brief(), brief({ shirtColor: "Black" }));
    assert.deepEqual(impact.changedSections, ["productColor"]);
    assert.equal(impact.needsConceptRegeneration, true);
  });

  it("detects an artwork color-only change", () => {
    const impact = capability.analyze(
      brief(),
      brief({ preferredColors: ["White"] }),
    );
    assert.deepEqual(impact.changedSections, ["colors"]);
  });

  it("treats a reordered/re-cased identical color list as unchanged", () => {
    const impact = capability.analyze(
      brief({ preferredColors: ["Gold", "White"] }),
      brief({ preferredColors: ["white", "GOLD"] }),
    );
    assert.equal(impact.changedSections.includes("colors"), false);
  });

  it("detects a graphics-only change", () => {
    const impact = capability.analyze(
      brief(),
      brief({ designDescription: "A howling wolf" }),
    );
    assert.deepEqual(impact.changedSections, ["graphics"]);
  });

  it("detects a required-wording-only change", () => {
    const impact = capability.analyze(
      brief(),
      brief({ exactText: "Strike First" }),
    );
    assert.deepEqual(impact.changedSections, ["requiredWording"]);
  });

  it("detects audience/purpose/style/printLocation/notes changes individually", () => {
    assert.deepEqual(
      capability.analyze(brief(), brief({ audience: "Alumni" })).changedSections,
      ["audience"],
    );
    assert.deepEqual(
      capability.analyze(brief(), brief({ purpose: "Reunion" })).changedSections,
      ["purpose"],
    );
    assert.deepEqual(
      capability.analyze(brief(), brief({ designStyle: "Modern" })).changedSections,
      ["style"],
    );
    assert.deepEqual(
      capability.analyze(brief(), brief({ printPlacement: "sleeve" }))
        .changedSections,
      ["printLocation"],
    );
    assert.deepEqual(
      capability.analyze(
        brief(),
        brief({ additionalInstructions: "Rush order" }),
      ).changedSections,
      ["additionalNotes"],
    );
  });

  it("a newly deferred section counts as a change to that section", () => {
    const impact = capability.analyze(
      brief({ designStyle: null, deferredSections: [] }),
      brief({ designStyle: null, deferredSections: ["style"] }),
    );
    assert.deepEqual(impact.changedSections, ["style"]);
  });

  it("detects multiple simultaneous changes", () => {
    const impact = capability.analyze(
      brief(),
      brief({ shirtColor: "Black", designStyle: "Modern", purpose: "Reunion" }),
    );
    assert.deepEqual(
      [...impact.changedSections].sort(),
      ["productColor", "purpose", "style"].sort(),
    );
  });
});

describe("RevisionIntelligenceCapability — concept/recommendation relevance", () => {
  it("audience/purpose/notes changes do not warrant concept regeneration", () => {
    const impact = capability.analyze(
      brief(),
      brief({ audience: "Alumni", purpose: "Reunion", additionalInstructions: "Rush" }),
    );
    assert.equal(impact.needsConceptRegeneration, false);
    assert.equal(impact.needsNewRecommendations, false);
    // Still worth a summary refresh / re-evaluation — just not new concepts.
    assert.equal(impact.needsSummaryRefresh, true);
    assert.equal(impact.needsReevaluation, true);
  });

  it("a graphics change does warrant concept regeneration", () => {
    const impact = capability.analyze(
      brief(),
      brief({ designDescription: "A howling wolf" }),
    );
    assert.equal(impact.needsConceptRegeneration, true);
    assert.equal(impact.needsNewRecommendations, true);
  });
});

describe("RevisionIntelligenceCapability — rule pack routing", () => {
  it("a wording change affects only wording-dependent rule packs, not graphics ones", () => {
    const impact = capability.analyze(brief(), brief({ exactText: "Strike First" }));
    assert.ok(impact.affectedRulePacks.includes("small_placement_long_wording"));
    assert.ok(impact.affectedRulePacks.includes("full_placement_wall_of_text"));
    assert.equal(
      impact.affectedRulePacks.includes("small_placement_dense_graphics"),
      false,
    );
  });

  it("a graphics change affects only the graphics-density rule pack", () => {
    const impact = capability.analyze(
      brief(),
      brief({ designDescription: "Covered in intricate detail" }),
    );
    assert.deepEqual(impact.affectedRulePacks, ["small_placement_dense_graphics"]);
  });

  it("a product color change affects no rule packs (none depend on it)", () => {
    const impact = capability.analyze(brief(), brief({ shirtColor: "Black" }));
    assert.deepEqual(impact.affectedRulePacks, []);
  });

  it("a print location change affects every rule pack (all depend on placement)", () => {
    const impact = capability.analyze(brief(), brief({ printPlacement: "sleeve" }));
    assert.deepEqual(
      [...impact.affectedRulePacks].sort(),
      [
        "full_placement_wall_of_text",
        "small_placement_dense_graphics",
        "small_placement_long_wording",
      ].sort(),
    );
  });
});

describe("RevisionIntelligenceCapability — determinism", () => {
  it("the same before/after pair always produces the same impact", () => {
    const before = brief();
    const after = brief({ shirtColor: "Black", designStyle: "Modern" });
    assert.deepEqual(capability.analyze(before, after), capability.analyze(before, after));
  });
});
