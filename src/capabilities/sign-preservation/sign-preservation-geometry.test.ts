import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  RECONSTRUCTION_SCALE_PROPORTIONALITY_TOLERANCE,
  mapSourceRangeToReconstruction,
  resolveProportionalReconstructionScale,
} from "./sign-preservation-geometry";

/**
 * LIVE PRODUCT BLOCKER #4C: the coordinate-mapping primitives every
 * preservation-verification consumer (`checkSourceSimilarity`,
 * `deriveSemanticComparisonImages`) now shares — tested here in isolation,
 * independent of image bytes or the wider preservation pipeline.
 */
describe("resolveProportionalReconstructionScale", () => {
  it("1: exact 2x reconstruction — still resolves", () => {
    const scale = resolveProportionalReconstructionScale(200, 300, 400, 600);
    assert.ok(scale);
    assert.equal(scale!.scaleX, 2);
    assert.equal(scale!.scaleY, 2);
  });

  it("2: exact 4x reconstruction — still resolves", () => {
    const scale = resolveProportionalReconstructionScale(1024, 1536, 4096, 6144);
    assert.ok(scale);
    assert.equal(scale!.scaleX, 4);
    assert.equal(scale!.scaleY, 4);
  });

  it("3: realistic non-integer proportional reconstruction resolves (the real customer's own 3.3812x)", () => {
    const scale = resolveProportionalReconstructionScale(1086, 1448, 3672, 4896);
    assert.ok(scale);
    assert.ok(Math.abs(scale!.scaleX - 3.38121546961326) < 1e-9);
  });

  it("4: THIS CUSTOMER's exact persisted reconstruction geometry (1086x1448 -> 3672x4896) resolves with scaleX === scaleY exactly", () => {
    const scale = resolveProportionalReconstructionScale(1086, 1448, 3672, 4896);
    assert.ok(scale);
    // The plan's own requestedScale is a single scalar applied to both
    // axes before rounding — for THIS exact pair of dimensions the two
    // independently-computed ratios land on the identical float.
    assert.equal(scale!.scaleX, scale!.scaleY);
  });

  it("5: non-integer X/Y scaling with legitimate one-pixel raster rounding still resolves", () => {
    // scaleX = 500/200 = 2.5, scaleY = 499/200 = 2.495 — the kind of
    // difference two independently Math.round()-ed axis dimensions
    // legitimately produce, well inside tolerance.
    const scale = resolveProportionalReconstructionScale(200, 200, 500, 499);
    assert.ok(scale);
  });

  it("6: materially inconsistent X/Y scaling fails closed (null), never guessed", () => {
    // scaleX = 16/5 = 3.2, scaleY = 20/7 ≈ 2.857 — over 10% apart.
    const scale = resolveProportionalReconstructionScale(5, 7, 16, 20);
    assert.equal(scale, null);
  });

  it("boundary: comfortably within tolerance passes; comfortably beyond it fails", () => {
    const sourceWidth = 1000;
    const sourceHeight = 1000;
    const scaleX = 2;
    const withinToleranceScaleY = scaleX * (1 - RECONSTRUCTION_SCALE_PROPORTIONALITY_TOLERANCE / 2);
    const beyondToleranceScaleY = scaleX * (1 - RECONSTRUCTION_SCALE_PROPORTIONALITY_TOLERANCE * 3);

    const passing = resolveProportionalReconstructionScale(
      sourceWidth,
      sourceHeight,
      sourceWidth * scaleX,
      Math.round(sourceHeight * withinToleranceScaleY),
    );
    assert.ok(passing, "well within the tolerance must pass");

    const failing = resolveProportionalReconstructionScale(
      sourceWidth,
      sourceHeight,
      sourceWidth * scaleX,
      Math.round(sourceHeight * beyondToleranceScaleY),
    );
    assert.equal(failing, null, "well beyond the tolerance must fail closed");
  });

  it("non-positive dimensions never resolve", () => {
    assert.equal(resolveProportionalReconstructionScale(0, 100, 200, 200), null);
    assert.equal(resolveProportionalReconstructionScale(100, 100, -200, 200), null);
  });
});

describe("mapSourceRangeToReconstruction", () => {
  it("7: mapped crops never exceed reconstruction bounds — a range at the very end of the source frame", () => {
    const dimLimit = 3672;
    const { start, end } = mapSourceRangeToReconstruction(1085, 1086, 3672 / 1086, dimLimit);
    assert.ok(start >= 0 && start <= dimLimit);
    assert.ok(end >= 0 && end <= dimLimit);
    assert.ok(end > start);
  });

  it("8a: tiny/edge crop rounding remains non-empty — a sub-one-pixel source range at a near-1x scale", () => {
    // start=5, end=5.4 (rounds to the same integer at scale 1) would
    // naively collapse to zero width.
    const { start, end } = mapSourceRangeToReconstruction(5, 5.4, 1, 100);
    assert.ok(end > start, "must never be empty");
    assert.equal(end - start, 1, "widened by exactly the minimum single pixel needed");
  });

  it("8b: a degenerate range at the RIGHT edge of the reconstruction widens backward, never past the bound", () => {
    const dimLimit = 100;
    const { start, end } = mapSourceRangeToReconstruction(99.6, 100, 1, dimLimit);
    assert.ok(end > start, "must never be empty");
    assert.ok(end <= dimLimit, "must never exceed the bound even while widening");
  });

  it("normal case: a mid-frame range maps cleanly, in proportion, with no widening needed", () => {
    const { start, end } = mapSourceRangeToReconstruction(100, 200, 2, 1000);
    assert.equal(start, 200);
    assert.equal(end, 400);
  });

  it("mapping is monotonic across adjacent grid cells — no gap, no overlap, at a non-integer scale", () => {
    const scale = 3.38121546961326;
    const dimLimit = 3672;
    const cellA = mapSourceRangeToReconstruction(0, 543, scale, dimLimit);
    const cellB = mapSourceRangeToReconstruction(543, 1086, scale, dimLimit);
    assert.equal(cellA.end, cellB.start, "adjacent source-space boundaries must map to the identical reconstruction pixel");
  });
});
