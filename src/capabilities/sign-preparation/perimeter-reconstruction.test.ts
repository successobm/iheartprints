import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { measurePerimeterBand, tiledRowColor } from "./perimeter-reconstruction";
import {
  bandWithEmbeddedMarkArtwork,
  ruthLikeSignArtwork,
  stripedPerimeterBandArtwork,
  uniformBackgroundSignArtwork,
} from "./sign-fixtures";

describe("measurePerimeterBand", () => {
  it("1: a solid single-colour band (degenerates to what extend_uniform_background already does) is reconstructable, every row identical", () => {
    const image = uniformBackgroundSignArtwork();
    const m = measurePerimeterBand(image, "top");
    assert.equal(m.reconstructable, true);
    assert.equal(m.rows.length, m.bandDepthPx);
    for (const row of m.rows) {
      assert.ok(Math.abs(row.r - 6) <= 2 && Math.abs(row.g - 6) <= 2 && Math.abs(row.b - 6) <= 2);
    }
  });

  it("2: a striped band (2 alternating flat colours across its depth) is reconstructable, and each measured row matches its own stripe colour", () => {
    const image = stripedPerimeterBandArtwork();
    const m = measurePerimeterBand(image, "top");
    assert.equal(m.reconstructable, true);
    assert.equal(m.rows[0]!.r, 200);
    assert.equal(m.rows[1]!.r, 20);
  });

  it("3: a band containing an embedded mark (e.g. a hole indicator) refuses — never tiles through unmeasured structure", () => {
    const image = bandWithEmbeddedMarkArtwork();
    const m = measurePerimeterBand(image, "top");
    assert.equal(m.reconstructable, false);
    assert.equal(m.rows.length < m.bandDepthPx, true, "must stop at the first non-uniform line, not silently skip it");
  });

  it("4: Ruth's real bleeding-content edges (left/right) are not reconstructable — ordinary foreground_bleed, not a tileable band", () => {
    const image = ruthLikeSignArtwork();
    assert.equal(measurePerimeterBand(image, "left").reconstructable, false);
    assert.equal(measurePerimeterBand(image, "right").reconstructable, false);
  });

  it("only the edges being measured are touched — other edges are independent", () => {
    const image = stripedPerimeterBandArtwork();
    // bottom/left/right remain the plain uniform background the fixture starts from.
    assert.equal(measurePerimeterBand(image, "bottom").reconstructable, true);
    assert.equal(measurePerimeterBand(image, "bottom").rows[0]!.r, 6);
  });
});

describe("tiledRowColor", () => {
  function m(rows: { r: number; g: number; b: number }[]) {
    return { edge: "top" as const, bandDepthPx: rows.length, rows, reconstructable: true, reason: "" };
  }

  it("degenerates to a single flat colour when every measured row is identical", () => {
    const measurement = m([{ r: 6, g: 6, b: 6 }, { r: 6, g: 6, b: 6 }, { r: 6, g: 6, b: 6 }]);
    for (let d = 0; d < 9; d++) {
      const color = tiledRowColor(measurement, d);
      assert.deepEqual(color, { r: 6, g: 6, b: 6 });
    }
  });

  it("distance 0 (adjacent to original content) uses the DEEPEST measured row; distance depth-1 (at the new outer edge) uses the OUTERMOST measured row", () => {
    const rows = [{ r: 1, g: 0, b: 0 }, { r: 2, g: 0, b: 0 }, { r: 3, g: 0, b: 0 }];
    const measurement = m(rows);
    assert.deepEqual(tiledRowColor(measurement, 0), rows[2]);
    assert.deepEqual(tiledRowColor(measurement, 2), rows[0]);
  });

  it("is periodic with period bandDepthPx — every colour used is one of the measured rows, never invented", () => {
    const rows = [{ r: 200, g: 20, b: 20 }, { r: 20, g: 20, b: 20 }];
    const measurement = m(rows);
    const validColors = new Set(rows.map((r) => `${r.r},${r.g},${r.b}`));
    for (let d = 0; d < 40; d++) {
      const color = tiledRowColor(measurement, d);
      assert.ok(validColors.has(`${color.r},${color.g},${color.b}`), `distance ${d} produced an invented colour`);
    }
    // Exact periodicity.
    for (let d = 0; d < 20; d++) {
      assert.deepEqual(tiledRowColor(measurement, d), tiledRowColor(measurement, d + rows.length));
    }
  });
});
