import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  classifyDtfFeatureWidth,
  classifyDtfPartialAlphaFeature,
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
