/**
 * Signs Phase 3B (Fit to Production): CUT / SAFE / BLEED / PROTECTED —
 * synthetic fixtures with known, hand-placed content at known distances
 * from each edge, so every assertion is an exact expected value.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { RgbaImage } from "@/capabilities/final-artwork/raster-transform";
import { makeImage, fillRect } from "./sign-fixtures";
import { analyzeSignFitToProduction, signSafeInsetPxForAxis } from "./sign-fit-to-production";

const RED = { r: 200, g: 20, b: 20 };
const BLACK = { r: 10, g: 10, b: 10 };

describe("signSafeInsetPxForAxis: physical -> pixel conversion", () => {
  it("0.125in converts correctly at 150 PPI", () => {
    // 0.125 * 150 = 18.75 -> ceil -> 19
    assert.equal(signSafeInsetPxForAxis(0.125, 150), 19);
  });

  it("0.125in converts correctly at 154.9 PPI (the real cc6cfc4b-... candidate's own density)", () => {
    // 0.125 * 154.888... = 19.361 -> ceil -> 20
    assert.equal(signSafeInsetPxForAxis(0.125, 154.888888888889), 20);
  });

  it("0.125in converts correctly at 300 PPI", () => {
    // 0.125 * 300 = 37.5 -> ceil -> 38
    assert.equal(signSafeInsetPxForAxis(0.125, 300), 38);
  });

  it("enforcement rounding NEVER reduces the physical minimum — always rounds UP, never down", () => {
    // A PPI chosen so the exact product is already just past an integer,
    // proving ceil (not round) is used: 0.125 * 160 = 20 exactly -> 20;
    // 0.125 * 161 = 20.125 -> must be 21, never 20 (which would be < 0.125in).
    assert.equal(signSafeInsetPxForAxis(0.125, 160), 20);
    assert.equal(signSafeInsetPxForAxis(0.125, 161), 21);
  });

  it("non-finite or non-positive inputs return 0 rather than a fabricated figure", () => {
    assert.equal(signSafeInsetPxForAxis(0, 150), 0);
    assert.equal(signSafeInsetPxForAxis(0.125, 0), 0);
    assert.equal(signSafeInsetPxForAxis(NaN, 150), 0);
  });
});

describe("analyzeSignFitToProduction: CUT vs SAFE vs BLEED vs PROTECTED", () => {
  /**
   * 400x400 canvas, uniform RED background (BLEED — permitted to reach
   * every cut edge), with a small BLACK square (PROTECTED content) placed
   * at exact, known distances from each edge:
   *   top:    30px from the top edge
   *   right:  25px from the right edge
   *   bottom: 15px from the bottom edge
   *   left:   40px from the left edge
   * A safe inset of 20px (0.125in @ 160ppi) makes bottom/right violations
   * and top/left passes, at exactly known, hand-computed values.
   */
  function fixture(): RgbaImage {
    const image = makeImage(400, 400, RED);
    // Protected square spans x=[40,370), y=[30,385) — distances above.
    fillRect(image, 40, 30, 370, 385, BLACK);
    return image;
  }

  it("passes on sides with enough clearance, fails on sides without, at exact measured px/in", () => {
    const result = analyzeSignFitToProduction(fixture(), 2.5, 2.5, 0.125); // 400/2.5 = 160ppi -> 20px safe inset
    assert.equal(result.achievedPpiX, 160);
    assert.equal(result.achievedPpiY, 160);
    assert.equal(result.safeInsetIn, 0.125);

    const top = result.edges.find((e) => e.edge === "top")!;
    assert.equal(top.requiredSafeInsetPx, 20);
    assert.equal(top.nearestNonBleedPx, 30);
    assert.equal(top.result, "pass");

    const right = result.edges.find((e) => e.edge === "right")!;
    assert.equal(right.nearestNonBleedPx, 30); // 400-370=30
    assert.equal(right.result, "pass");

    const bottom = result.edges.find((e) => e.edge === "bottom")!;
    assert.equal(bottom.nearestNonBleedPx, 15); // 400-385=15
    assert.equal(bottom.result, "fail");

    const left = result.edges.find((e) => e.edge === "left")!;
    assert.equal(left.nearestNonBleedPx, 40);
    assert.equal(left.result, "pass");

    assert.equal(result.overallResult, "fail");
  });

  it("BLEED may reach the cut edge — a uniform background alone never fails, no mandatory white border", () => {
    const image = makeImage(200, 200, RED); // no protected content anywhere
    const result = analyzeSignFitToProduction(image, 2, 2, 0.125); // 100ppi
    for (const edge of result.edges) {
      assert.equal(edge.result, "pass");
      assert.equal(edge.nearestNonBleedPx, null); // no violation found within the scanned depth
    }
    assert.equal(result.overallResult, "pass");
  });

  it("protected content genuinely AT the cut edge (0px clearance) fails on that side, at the single worst position", () => {
    const image = makeImage(200, 200, RED);
    // A small black mark touching the very top edge at one place only —
    // the worst-case-across-all-positions design must still catch it even
    // though most of the top edge is clean.
    fillRect(image, 90, 0, 110, 5, BLACK);
    const result = analyzeSignFitToProduction(image, 2, 2, 0.125);
    const top = result.edges.find((e) => e.edge === "top")!;
    assert.equal(top.nearestNonBleedPx, 0);
    assert.equal(top.result, "fail");
    // Untouched edges still pass.
    const left = result.edges.find((e) => e.edge === "left")!;
    assert.equal(left.result, "pass");
  });

  it("a genuinely mixed/ambiguous edge (no provable dominant colour — no single colour reaches even 50%) is 'unknown', never silently 'pass'", () => {
    const image = makeImage(100, 100, RED);
    // Three-way striped top edge (full width) so no single colour reaches
    // the 50% dominant-coverage bar for the TOP edge specifically — this
    // fixture is not trying to isolate the other three edges (a stripe
    // this close to the top-left/top-right corners legitimately also
    // trips their own safe-inset check, correctly, since it puts genuine
    // non-bleed content within a few px of those edges too).
    for (let x = 0; x < 100; x++) {
      const color = x % 3 === 0 ? BLACK : x % 3 === 1 ? { r: 255, g: 255, b: 255 } : { r: 0, g: 200, b: 0 };
      fillRect(image, x, 0, x + 1, 20, color);
    }
    const result = analyzeSignFitToProduction(image, 1, 1, 0.125);
    const top = result.edges.find((e) => e.edge === "top")!;
    assert.equal(top.result, "unknown");
    assert.equal(top.bleedColor, null);
    // "unknown" never silently becomes "pass" at the overall level either.
    assert.notEqual(result.overallResult, "pass");
  });

  it("a genuinely multi-coloured edge (two DIFFERENT bleed colours in different Y-ranges along the same left/right edge) conservatively flags the non-dominant colour — fail-closed, never a false pass", () => {
    // Mirrors the real sign's own shape: a red band on top, a white band
    // below, both legitimately reaching the left/right cut edges — but
    // this module deliberately uses ONE dominant colour per edge (Section
    // E: no new segmentation architecture), so the non-dominant colour's
    // own half of the edge is conservatively reported as a violation
    // (worst-case clearance 0) rather than silently waved through.
    const image = makeImage(200, 400, RED); // 200 red rows, then 200 white -> exact tie; RED inserted first wins the dominant tie-break.
    fillRect(image, 0, 200, 200, 400, { r: 255, g: 255, b: 255 });
    const result = analyzeSignFitToProduction(image, 2, 4, 0.125); // 100ppi
    const left = result.edges.find((e) => e.edge === "left")!;
    assert.equal(left.bleedColor?.r, RED.r);
    assert.equal(left.nearestNonBleedPx, 0); // the white half is conservatively flagged
    assert.equal(left.result, "fail");
    assert.equal(result.overallResult, "fail");
  });
});
