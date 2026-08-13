import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { decideEnhancement } from "./enhancement-decision";

/**
 * Existing Artwork → Print Ready Phase 2, acceptance scenarios E/F/G/H.
 *
 * The whole point of testing this as a pure function: whether a customer's
 * uploaded artwork triggers a PAID reconstruction call is a cost decision, and
 * a cost decision that can only be observed by running the whole worker is one
 * nobody will notice regressing.
 */
describe("decideEnhancement — when uploaded artwork needs reconstruction", () => {
  const FULL_BACK = { targetWidthIn: 10.5, targetPpi: 300 };

  it("E: artwork already at the production target skips paid enhancement", () => {
    const decision = decideEnhancement({
      sourceVisibleWidthPx: 3150,
      ...FULL_BACK,
    });

    assert.equal(decision.method, "skipped");
    assert.equal(decision.requiresReconstruction, false);
    assert.equal(decision.requiredWidthPx, 3150);
    assert.equal(decision.coverageRatio, 1);
  });

  it("E: exactly at target is enough — never 'one pixel short, pay anyway'", () => {
    assert.equal(
      decideEnhancement({ sourceVisibleWidthPx: 3150, ...FULL_BACK })
        .requiresReconstruction,
      false,
    );
    assert.equal(
      decideEnhancement({ sourceVisibleWidthPx: 3149, ...FULL_BACK })
        .requiresReconstruction,
      true,
      "one pixel short is genuinely short — the alternative is stretching and calling it print-ready",
    );
  });

  it("F: undersized artwork requires enhancement", () => {
    const decision = decideEnhancement({
      sourceVisibleWidthPx: 1200,
      ...FULL_BACK,
    });

    assert.equal(decision.method, "reconstructed");
    assert.equal(decision.requiresReconstruction, true);
    assert.ok(decision.coverageRatio < 1);
    assert.match(decision.reason, /below the 3150px/);
  });

  it("G: the bowling case — ~919px of visible artwork for a 10.5in, 300 PPI print", () => {
    const decision = decideEnhancement({
      sourceVisibleWidthPx: 919,
      ...FULL_BACK,
    });

    assert.equal(decision.requiresReconstruction, true);
    assert.equal(decision.requiredWidthPx, 3150);
    assert.equal(decision.sourceVisibleWidthPx, 919);
  });

  it("H: a 4000px source for the same 3150px target spends nothing", () => {
    const decision = decideEnhancement({
      sourceVisibleWidthPx: 4000,
      ...FULL_BACK,
    });

    assert.equal(decision.method, "skipped");
    assert.equal(decision.requiresReconstruction, false);
    assert.match(decision.reason, /no reconstruction needed/);
  });

  it("H: a 3000px source for the same target is short, and is not rounded up to 'close enough'", () => {
    // The tempting shortcut — "3000 is basically 3150, just resample it
    // locally" — is exactly the self-deception this pipeline refuses: the file
    // would carry 3150 pixels with 3000 pixels of detail.
    assert.equal(
      decideEnhancement({ sourceVisibleWidthPx: 3000, ...FULL_BACK })
        .requiresReconstruction,
      true,
    );
  });

  it("scales with the placement rather than assuming a full-back print", () => {
    // A 3in sleeve needs 900px, so the same artwork that was short for a
    // full-back print is comfortably sufficient here.
    assert.equal(
      decideEnhancement({
        sourceVisibleWidthPx: 1200,
        targetWidthIn: 3,
        targetPpi: 300,
      }).requiresReconstruction,
      false,
    );
  });

  it("honors a customer-chosen width, not just the placement default", () => {
    const twelveInch = decideEnhancement({
      sourceVisibleWidthPx: 3300,
      targetWidthIn: 12,
      targetPpi: 300,
    });
    assert.equal(twelveInch.requiredWidthPx, 3600);
    assert.equal(twelveInch.requiresReconstruction, true);

    const tenAndAHalf = decideEnhancement({
      sourceVisibleWidthPx: 3300,
      ...FULL_BACK,
    });
    assert.equal(tenAndAHalf.requiresReconstruction, false);
  });

  it("treats degenerate artwork as needing enhancement rather than crashing", () => {
    const decision = decideEnhancement({ sourceVisibleWidthPx: 0, ...FULL_BACK });
    assert.equal(decision.requiresReconstruction, true);
    assert.equal(decision.coverageRatio, 0);
  });
});
