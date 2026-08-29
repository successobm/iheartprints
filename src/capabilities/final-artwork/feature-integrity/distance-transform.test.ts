import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { chamferDistanceTransform, nearestSeedTransform, ridgeMask } from "./distance-transform";
import { labelConnectedComponents } from "./connected-components";

describe("chamferDistanceTransform", () => {
  it("returns 0 for background pixels and grows away from them", () => {
    const w = 10;
    const h = 1;
    const mask = new Uint8Array(w * h).fill(1);
    mask[0] = 0; // one background pixel at the left edge
    const d = chamferDistanceTransform(mask, w, h);
    assert.equal(d[0], 0);
    // Distance should increase monotonically moving away from the single background pixel.
    for (let x = 1; x < w; x += 1) {
      assert.ok(d[x]! >= d[x - 1]!);
    }
    assert.ok(Math.abs(d[9]! - 9) < 0.01, `expected ~9, got ${d[9]}`);
  });

  it("approximates true Euclidean distance on a diagonal within a small tolerance", () => {
    const w = 20;
    const h = 20;
    const mask = new Uint8Array(w * h).fill(1);
    mask[0] = 0; // background pixel at (0,0)
    const d = chamferDistanceTransform(mask, w, h);
    const i = 10 * w + 10; // (10,10) — true Euclidean distance to (0,0) is 10*sqrt(2) ≈ 14.142
    const trueDistance = Math.sqrt(200);
    assert.ok(Math.abs(d[i]! - trueDistance) / trueDistance < 0.03, `expected within 3% of ${trueDistance}, got ${d[i]}`);
  });
});

describe("ridgeMask", () => {
  it("marks the centerline of a straight band as the ridge", () => {
    const w = 20;
    const h = 7; // a 7px-tall horizontal band, background above/below
    const mask = new Uint8Array(w * h).fill(1);
    const d = chamferDistanceTransform(mask, w, h);
    // No background pixel exists in this mask, so distance is degenerate;
    // instead build a mask with true background rows.
    const bandMask = new Uint8Array(w * h);
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        bandMask[y * w + x] = y >= 2 && y <= 4 ? 1 : 0; // 3px-tall band (rows 2-4)
      }
    }
    const bandDt = chamferDistanceTransform(bandMask, w, h);
    const ridge = ridgeMask(bandMask, bandDt, w, h);
    // The center row (y=3) should be the ridge; rows 2 and 4 should not.
    assert.equal(ridge[3 * w + 10], 1);
    assert.equal(ridge[2 * w + 10], 0);
    assert.equal(ridge[4 * w + 10], 0);
    void d; // silence unused var from the degenerate example above
  });
});

describe("nearestSeedTransform", () => {
  it("propagates the nearest seed's label alongside distance", () => {
    const w = 10;
    const h = 1;
    const seedLabel = new Int32Array(w).fill(-1);
    seedLabel[0] = 0;
    seedLabel[9] = 1;
    const { distance, nearestLabel } = nearestSeedTransform(seedLabel, w, h);
    assert.equal(nearestLabel[0], 0);
    assert.equal(nearestLabel[9], 1);
    assert.equal(nearestLabel[2], 0); // closer to seed 0 at x=0
    assert.equal(nearestLabel[8], 1); // closer to seed 1 at x=9
    assert.equal(distance[0], 0);
    assert.equal(distance[9], 0);
  });
});

describe("labelConnectedComponents (used by feature-integrity for both ink and gap grouping)", () => {
  it("separates two non-touching regions and flags border contact independently", () => {
    const w = 5;
    const h = 5;
    const mask = new Uint8Array(w * h);
    mask[0] = 1; // touches border (corner)
    mask[2 * w + 2] = 1; // interior, isolated
    const { components } = labelConnectedComponents(mask, w, h);
    assert.equal(components.length, 2);
    const border = components.find((c) => c.touchesBorder);
    const interior = components.find((c) => !c.touchesBorder);
    assert.ok(border && interior);
  });
});
