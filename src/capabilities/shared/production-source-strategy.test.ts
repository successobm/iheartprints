import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_PRODUCTION_SOURCE_STRATEGY,
  GARMENT_BACKGROUND_MATCH_TOLERANCE,
  MIN_BACKGROUND_CONFIDENCE_FOR_SAFE,
  assessProductionSourceStrategy,
  isProductionSourceStrategy,
  lineageIsDerived,
  mayProduceWithoutReview,
  type ProductionSourceEvidence,
  type ProductionSourceLineage,
} from "./production-source-strategy";
import {
  PRODUCTION_TREATMENTS,
  isProductionTreatment,
} from "./production-treatment";

/**
 * An ordinary, uncomplicated upload: solid removable background, nothing in
 * the design sharing its colour, removal never reached inside the artwork.
 */
function safeEvidence(
  overrides: Partial<ProductionSourceEvidence> = {},
): ProductionSourceEvidence {
  return {
    sourceFullyOpaque: true,
    sourceHasTransparency: false,
    disconnectedBackgroundColoredPixels: 0,
    backgroundIsEdgeConnected: true,
    backgroundConfidence: 0.99,
    exteriorRemovalEnclosureRatio: 0,
    garmentToBackgroundChannelDistance: 255,
    ...overrides,
  };
}

/**
 * The measured live bowling evidence, from the immutable original
 * `99ee94fc…afa5` (979x1024) and its current prepared asset:
 *
 *   disconnectedBackgroundColoredPixels  5832   (recorded on the live row)
 *   backgroundIsEdgeConnected            true
 *   backgroundConfidence                 0.9891
 *   exteriorRemovalEnclosureRatio        0.4558 (measured original vs prepared)
 *   garment                              Black #000000 vs background rgb(1,1,1)
 */
function bowlingEvidence(
  overrides: Partial<ProductionSourceEvidence> = {},
): ProductionSourceEvidence {
  return {
    sourceFullyOpaque: true,
    sourceHasTransparency: false,
    disconnectedBackgroundColoredPixels: 5832,
    backgroundIsEdgeConnected: true,
    backgroundConfidence: 0.9891,
    exteriorRemovalEnclosureRatio: 0.4558,
    garmentToBackgroundChannelDistance: 1,
    ...overrides,
  };
}

describe("ProductionSourceStrategy is a separate axis from ProductionTreatment", () => {
  it("B: no strategy value is a treatment value, and no treatment value is a strategy", () => {
    for (const treatment of PRODUCTION_TREATMENTS) {
      assert.equal(
        isProductionSourceStrategy(treatment),
        false,
        `"${treatment}" must not read as a source strategy`,
      );
    }
    for (const strategy of [
      "prepared_background_removed",
      "original_preserving_separation",
      "manual_intervention",
    ]) {
      assert.equal(
        isProductionTreatment(strategy),
        false,
        `"${strategy}" must not read as a production treatment`,
      );
    }
  });

  it("B: the assessment says nothing about which treatment to print", () => {
    const assessment = assessProductionSourceStrategy(bowlingEvidence());
    const serialized = JSON.stringify(assessment);
    for (const treatment of PRODUCTION_TREATMENTS) {
      assert.equal(
        serialized.includes(treatment),
        false,
        `the source assessment leaked the treatment "${treatment}"`,
      );
    }
  });
});

describe("assessProductionSourceStrategy — an ordinary safe upload", () => {
  it("C: is safe, and keeps the existing prepared authority as the recommendation", () => {
    const assessment = assessProductionSourceStrategy(safeEvidence());
    assert.equal(assessment.readiness, "safe");
    assert.equal(assessment.recommended, "prepared_background_removed");
    assert.equal(assessment.recommended, DEFAULT_PRODUCTION_SOURCE_STRATEGY);
    assert.equal(assessment.automationMayProceed, true);
    assert.equal(
      mayProduceWithoutReview(assessment, "prepared_background_removed"),
      true,
    );
  });

  it("C: adds no operator friction — no risk reasons are raised", () => {
    const { reasons } = assessProductionSourceStrategy(safeEvidence());
    for (const risky of [
      "background_colour_used_inside_design",
      "exterior_removal_enters_enclosed_design_region",
      "background_not_edge_connected",
      "background_estimate_low_confidence",
    ] as const) {
      assert.equal(reasons.includes(risky), false, `unexpected reason ${risky}`);
    }
  });

  it("does not offer separation when the garment is nothing like the background", () => {
    const assessment = assessProductionSourceStrategy(safeEvidence());
    assert.equal(
      assessment.allowedStrategies.includes("original_preserving_separation"),
      false,
    );
    assert.ok(assessment.reasons.includes("garment_differs_from_background"));
  });
});

describe("assessProductionSourceStrategy — the live bowling evidence", () => {
  it("J: ambiguity cannot silently become production authority", () => {
    const assessment = assessProductionSourceStrategy(bowlingEvidence());
    assert.equal(assessment.readiness, "review_required");
    assert.equal(assessment.automationMayProceed, false);
    assert.equal(
      mayProduceWithoutReview(assessment, "prepared_background_removed"),
      false,
    );
  });

  it("raises exactly the reasons the measurements support", () => {
    const { reasons } = assessProductionSourceStrategy(bowlingEvidence());
    assert.ok(reasons.includes("source_fully_opaque"));
    assert.ok(reasons.includes("background_colour_used_inside_design"));
    assert.ok(reasons.includes("exterior_removal_enters_enclosed_design_region"));
    assert.ok(reasons.includes("garment_matches_background"));
  });

  it("E: offers garment separation but never RECOMMENDS it", () => {
    const assessment = assessProductionSourceStrategy(bowlingEvidence());
    assert.ok(
      assessment.allowedStrategies.includes("original_preserving_separation"),
      "black garment matches the rgb(1,1,1) background, so separation is coherent",
    );
    assert.equal(assessment.recommended, "prepared_background_removed");
  });

  it("E: an experimental separation can never be produced without review", () => {
    const assessment = assessProductionSourceStrategy(bowlingEvidence());
    assert.equal(
      mayProduceWithoutReview(assessment, "original_preserving_separation"),
      false,
    );
  });

  it("E: separation stays un-automatable even when every other signal is clean", () => {
    // The one case a future change could plausibly get wrong: a garment that
    // matches the background on an otherwise unremarkable upload.
    const assessment = assessProductionSourceStrategy(
      safeEvidence({ garmentToBackgroundChannelDistance: 0 }),
    );
    assert.equal(assessment.readiness, "safe");
    assert.ok(assessment.allowedStrategies.includes("original_preserving_separation"));
    assert.equal(
      mayProduceWithoutReview(assessment, "original_preserving_separation"),
      false,
      "a press test has not happened; 'safe' preparation must not authorize it",
    );
  });
});

describe("what the evidence is and is not allowed to claim", () => {
  it("no reason code asserts that artwork was damaged or identified", () => {
    const all = new Set<string>();
    for (const evidence of [
      safeEvidence(),
      bowlingEvidence(),
      bowlingEvidence({ backgroundIsEdgeConnected: false }),
      bowlingEvidence({ garmentToBackgroundChannelDistance: null }),
      safeEvidence({ sourceHasTransparency: true, sourceFullyOpaque: false }),
    ]) {
      for (const r of assessProductionSourceStrategy(evidence).reasons) all.add(r);
    }
    for (const reason of all) {
      for (const forbidden of ["lost", "destroyed", "damaged", "logo", "object", "safe_to_print"]) {
        assert.equal(
          reason.includes(forbidden),
          false,
          `reason "${reason}" claims more than pixels can establish`,
        );
      }
    }
  });

  it("an unknown garment colour is never treated as a mismatch", () => {
    const { reasons, allowedStrategies } = assessProductionSourceStrategy(
      bowlingEvidence({ garmentToBackgroundChannelDistance: null }),
    );
    assert.ok(reasons.includes("garment_colour_unknown"));
    assert.equal(reasons.includes("garment_differs_from_background"), false);
    assert.equal(reasons.includes("garment_matches_background"), false);
    assert.equal(
      allowedStrategies.includes("original_preserving_separation"),
      false,
      "no garment colour means no garment-substrate claim is available",
    );
  });

  it("H: garment colour alone never changes readiness", () => {
    // Garment colour is treatment/substrate evidence. It must not make an
    // ordinary preparation look riskier or safer than it measured.
    const far = assessProductionSourceStrategy(
      safeEvidence({ garmentToBackgroundChannelDistance: 255 }),
    );
    const near = assessProductionSourceStrategy(
      safeEvidence({ garmentToBackgroundChannelDistance: 0 }),
    );
    const unknown = assessProductionSourceStrategy(
      safeEvidence({ garmentToBackgroundChannelDistance: null }),
    );
    assert.equal(far.readiness, "safe");
    assert.equal(near.readiness, "safe");
    assert.equal(unknown.readiness, "safe");

    const farRisky = assessProductionSourceStrategy(bowlingEvidence({
      garmentToBackgroundChannelDistance: 255,
    }));
    assert.equal(farRisky.readiness, "review_required");
  });

  it("the match tolerance is the same number background membership already uses", () => {
    assert.equal(GARMENT_BACKGROUND_MATCH_TOLERANCE, 12);
    const atLimit = assessProductionSourceStrategy(
      safeEvidence({
        garmentToBackgroundChannelDistance: GARMENT_BACKGROUND_MATCH_TOLERANCE,
      }),
    );
    assert.ok(atLimit.reasons.includes("garment_matches_background"));
    const justOver = assessProductionSourceStrategy(
      safeEvidence({
        garmentToBackgroundChannelDistance: GARMENT_BACKGROUND_MATCH_TOLERANCE + 1,
      }),
    );
    assert.ok(justOver.reasons.includes("garment_differs_from_background"));
  });

  it("a low-confidence background estimate is reviewable on its own", () => {
    const assessment = assessProductionSourceStrategy(
      safeEvidence({ backgroundConfidence: MIN_BACKGROUND_CONFIDENCE_FOR_SAFE - 0.01 }),
    );
    assert.equal(assessment.readiness, "review_required");
    assert.ok(assessment.reasons.includes("background_estimate_low_confidence"));
  });

  it("an uncomputed enclosure ratio is not evidence of anything", () => {
    const assessment = assessProductionSourceStrategy(
      safeEvidence({ exteriorRemovalEnclosureRatio: null }),
    );
    assert.equal(assessment.readiness, "safe");
    assert.equal(
      assessment.reasons.includes("exterior_removal_enters_enclosed_design_region"),
      false,
    );
  });
});

describe("the existing prepared path is never withdrawn", () => {
  it("C: prepared_background_removed is allowed under every evidence shape", () => {
    for (const evidence of [
      safeEvidence(),
      bowlingEvidence(),
      bowlingEvidence({ backgroundIsEdgeConnected: false, backgroundConfidence: 0.1 }),
      safeEvidence({ sourceHasTransparency: true, sourceFullyOpaque: false }),
      bowlingEvidence({ garmentToBackgroundChannelDistance: null }),
    ]) {
      const assessment = assessProductionSourceStrategy(evidence);
      assert.ok(
        assessment.allowedStrategies.includes("prepared_background_removed"),
        "an assessment may add strategies, never remove the existing one",
      );
      assert.equal(assessment.recommended, "prepared_background_removed");
    }
  });

  it("manual intervention is always reachable", () => {
    for (const evidence of [safeEvidence(), bowlingEvidence()]) {
      assert.ok(
        assessProductionSourceStrategy(evidence).allowedStrategies.includes(
          "manual_intervention",
        ),
      );
    }
    // ...but never automatable either.
    assert.equal(
      mayProduceWithoutReview(
        assessProductionSourceStrategy(safeEvidence()),
        "manual_intervention",
      ),
      false,
    );
  });

  it("a strategy that is not allowed can never be produced without review", () => {
    const assessment = assessProductionSourceStrategy(safeEvidence());
    assert.equal(
      assessment.allowedStrategies.includes("original_preserving_separation"),
      false,
    );
    assert.equal(
      mayProduceWithoutReview(assessment, "original_preserving_separation"),
      false,
    );
  });
});

describe("K: lineage names the original on every strategy", () => {
  const original = "asset-original";

  it("a prepared-source plate is derived and names its origin", () => {
    const lineage: ProductionSourceLineage = {
      strategy: "prepared_background_removed",
      originAssetId: original,
      sourceAssetId: "asset-prepared",
      derivation: "deterministic_background_removal",
    };
    assert.equal(lineageIsDerived(lineage), true);
    assert.equal(lineage.originAssetId, original);
  });

  it("a separated-source plate names the SAME original, not the prepared asset", () => {
    const lineage: ProductionSourceLineage = {
      strategy: "original_preserving_separation",
      originAssetId: original,
      sourceAssetId: "asset-separated",
      derivation: "deterministic_garment_substrate_separation",
    };
    assert.equal(lineageIsDerived(lineage), true);
    assert.equal(lineage.originAssetId, original);
    assert.notEqual(lineage.sourceAssetId, "asset-prepared");
  });

  it("strategy and derivation are independent — the engine can change under a strategy", () => {
    const operatorFixedPreparation: ProductionSourceLineage = {
      strategy: "manual_intervention",
      originAssetId: original,
      sourceAssetId: "asset-operator",
      derivation: "operator_supplied",
    };
    assert.equal(operatorFixedPreparation.strategy, "manual_intervention");
    assert.equal(operatorFixedPreparation.derivation, "operator_supplied");
  });

  it("an underived lineage (source === origin) is recognisable as such", () => {
    const lineage: ProductionSourceLineage = {
      strategy: "prepared_background_removed",
      originAssetId: original,
      sourceAssetId: original,
      derivation: "deterministic_background_removal",
    };
    assert.equal(lineageIsDerived(lineage), false);
  });
});

describe("I: the decision is pure", () => {
  it("returns the same assessment for the same evidence", () => {
    const evidence = bowlingEvidence();
    assert.deepEqual(
      assessProductionSourceStrategy(evidence),
      assessProductionSourceStrategy(evidence),
    );
  });

  it("does not mutate the evidence it was given", () => {
    const evidence = bowlingEvidence();
    const before = JSON.stringify(evidence);
    assessProductionSourceStrategy(evidence);
    assert.equal(JSON.stringify(evidence), before);
  });
});
