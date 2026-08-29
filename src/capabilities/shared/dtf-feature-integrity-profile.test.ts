import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  classifyDtfFeatureWidth,
  classifyDtfPartialAlphaFeature,
  classifyStructuralFragility,
  DTF_ISOLATED_COMPONENT_BLOCKING_DIAMETER_MM,
  DTF_ISOLATED_COMPONENT_WARNING_DIAMETER_MM,
} from "./dtf-feature-integrity-profile";

describe("classifyDtfFeatureWidth", () => {
  it("passes when nothing was measured", () => {
    assert.equal(classifyDtfFeatureWidth(null, 1, 2), "pass");
  });

  it("blocks below the blocking floor, warns below the warning floor, otherwise passes", () => {
    assert.equal(classifyDtfFeatureWidth(0.5, 1, 2), "blocking");
    assert.equal(classifyDtfFeatureWidth(1.5, 1, 2), "warning");
    assert.equal(classifyDtfFeatureWidth(2.5, 1, 2), "pass");
  });

  it("treats the isolated-component tiers as strictly ordered (blocking floor below warning floor)", () => {
    assert.ok(DTF_ISOLATED_COMPONENT_BLOCKING_DIAMETER_MM < DTF_ISOLATED_COMPONENT_WARNING_DIAMETER_MM);
  });
});

describe("classifyDtfPartialAlphaFeature", () => {
  it("never returns blocking, regardless of how small the measurement is", () => {
    assert.equal(classifyDtfPartialAlphaFeature(0.0001), "warning");
    assert.equal(classifyDtfPartialAlphaFeature(null), "pass");
  });
});

describe("classifyStructuralFragility (Phase 2A)", () => {
  const blockingFloor = 0.4;
  const warningFloor = 1.0;
  const structuralBlockingFraction = 0.5;
  const structuralWarningFraction = 0.2;

  it("is 'robust' with an effective pass whenever the minimum itself already passes, regardless of fraction", () => {
    const result = classifyStructuralFragility(
      2.0,
      0.9, // even a huge fraction can't matter if the minimum itself is fine
      0.9,
      blockingFloor,
      warningFloor,
      structuralBlockingFraction,
      structuralWarningFraction,
    );
    assert.deepEqual(result, { minimumTier: "pass", kind: "robust", effectiveTier: "pass" });
  });

  it("is 'structural' and keeps the blocking tier when a majority of the structure is below the blocking floor", () => {
    const result = classifyStructuralFragility(
      0.1,
      0.6,
      0.6,
      blockingFloor,
      warningFloor,
      structuralBlockingFraction,
      structuralWarningFraction,
    );
    assert.equal(result.minimumTier, "blocking");
    assert.equal(result.kind, "structural");
    assert.equal(result.effectiveTier, "blocking");
  });

  it("is 'incidental' and DOWNGRADES blocking to warning when only a small fraction is critically thin", () => {
    const result = classifyStructuralFragility(
      0.1,
      0.05,
      0.05,
      blockingFloor,
      warningFloor,
      structuralBlockingFraction,
      structuralWarningFraction,
    );
    assert.equal(result.minimumTier, "blocking");
    assert.equal(result.kind, "incidental");
    assert.equal(result.effectiveTier, "warning", "Section 9: one pathological point must never block a predominantly robust structure");
  });

  it("is 'structural' at the warning tier when the warning fraction (not blocking fraction) crosses its own floor", () => {
    const result = classifyStructuralFragility(
      0.7, // below warningFloor, above blockingFloor -> minimumTier "warning"
      0.05,
      0.3, // >= structuralWarningFraction (0.2)
      blockingFloor,
      warningFloor,
      structuralBlockingFraction,
      structuralWarningFraction,
    );
    assert.equal(result.minimumTier, "warning");
    assert.equal(result.kind, "structural");
    assert.equal(result.effectiveTier, "warning");
  });

  it("never elevates an incidental warning-tier minimum beyond warning", () => {
    const result = classifyStructuralFragility(
      0.7,
      0.01,
      0.01,
      blockingFloor,
      warningFloor,
      structuralBlockingFraction,
      structuralWarningFraction,
    );
    assert.equal(result.kind, "incidental");
    assert.equal(result.effectiveTier, "warning");
  });
});
