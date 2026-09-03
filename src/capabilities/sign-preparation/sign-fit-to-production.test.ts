/**
 * Signs Phase 3B (Fit to Production) / Edge-Intent Correction Phase: CUT /
 * SAFE / BLEED_BACKGROUND / EDGE_INTENT_ARTWORK / PROTECTED_CONTENT /
 * AMBIGUOUS_REVIEW — synthetic fixtures with known, hand-placed content at
 * known distances from each edge, so every assertion is an exact expected
 * value.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { RgbaImage } from "@/capabilities/final-artwork/raster-transform";
import { makeImage, fillRect } from "./sign-fixtures";
import {
  analyzeSignFitToProduction,
  signSafeInsetPxForAxis,
  type SignEdgeIntentClassification,
} from "./sign-fit-to-production";

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
    assert.equal(top.requiredProtectedInsetPx, 20);
    assert.equal(top.nearestProtectedContentPx, 30);
    assert.equal(top.protectedResult, "pass");

    const right = result.edges.find((e) => e.edge === "right")!;
    assert.equal(right.nearestProtectedContentPx, 30); // 400-370=30
    assert.equal(right.protectedResult, "pass");

    const bottom = result.edges.find((e) => e.edge === "bottom")!;
    assert.equal(bottom.nearestProtectedContentPx, 15); // 400-385=15
    assert.equal(bottom.protectedResult, "fail");
    assert.equal(bottom.unresolvedAmbiguousPresent, true, "unclassified protected content defaults to unresolved ambiguous");

    const left = result.edges.find((e) => e.edge === "left")!;
    assert.equal(left.nearestProtectedContentPx, 40);
    assert.equal(left.protectedResult, "pass");

    assert.equal(result.overallResult, "fail");
  });

  it("BLEED may reach the cut edge — a uniform background alone never fails, no mandatory white border", () => {
    const image = makeImage(200, 200, RED); // no protected content anywhere
    const result = analyzeSignFitToProduction(image, 2, 2, 0.125); // 100ppi
    for (const edge of result.edges) {
      assert.equal(edge.protectedResult, "pass");
      assert.equal(edge.nearestProtectedContentPx, null); // no violation found within the scanned depth
      assert.equal(edge.unresolvedAmbiguousPresent, false);
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
    assert.equal(top.nearestProtectedContentPx, 0);
    assert.equal(top.protectedResult, "fail");
    // Untouched edges still pass.
    const left = result.edges.find((e) => e.edge === "left")!;
    assert.equal(left.protectedResult, "pass");
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
    assert.equal(top.protectedResult, "unknown");
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
    assert.equal(left.nearestProtectedContentPx, 0); // the white half is conservatively flagged
    assert.equal(left.protectedResult, "fail");
    assert.equal(result.overallResult, "fail");
  });
});

describe("analyzeSignFitToProduction: EDGE_INTENT_ARTWORK classification (Edge-Intent Correction Phase)", () => {
  /**
   * 400x400 canvas, RED bleed background (RED remains the GLOBALLY
   * dominant outermost-line colour — the border below occupies only the
   * top 150 of 400 rows, well under the 50% dominant-coverage bar, exactly
   * so the algorithm's own dominant-colour baseline stays RED rather than
   * accidentally absorbing the border itself). A 9px BLACK border along
   * rows 0..149 of the LEFT edge, then straight into the canvas's own RED
   * bleed background, then a BLACK "protected" square placed at a known
   * depth from the left edge — all within those same border rows. Safe
   * inset is 20px. Without
   * classification, the border itself trips the violation at depth 0
   * (matching the real cc6cfc4b-... sign's own shape); classifying the
   * border EDGE_INTENT_ARTWORK must make the scan continue past it to the
   * TRUE nearest protected content.
   */
  function borderFixture(protectedDepth: number): RgbaImage {
    const image = makeImage(400, 400, RED);
    fillRect(image, 0, 0, 9, 150, BLACK); // border, depth 0..8, rows 0..149
    // No separate "gap" colour between the border and the protected
    // content — the gap is simply the canvas's own RED bleed background
    // (already the measured dominant baseline), matching Section H's own
    // conceptual example's "background area — BLEED" step.
    fillRect(image, protectedDepth, 60, protectedDepth + 20, 80, BLACK); // protected content at [protectedDepth, protectedDepth+20)
    return image;
  }

  it("without any classification, the border itself is flagged as a violation at depth 0 — the pre-Edge-Intent-Phase behaviour", () => {
    const result = analyzeSignFitToProduction(borderFixture(40), 2.5, 2.5, 0.125); // 160ppi, required 20px
    const left = result.edges.find((e) => e.edge === "left")!;
    assert.equal(left.bleedColor?.r, RED.r, "RED must remain the measured dominant baseline");
    assert.equal(left.nearestProtectedContentPx, 0);
    assert.equal(left.protectedResult, "fail");
    assert.equal(left.edgeIntentPresent, false);
  });

  it("classifying the border EDGE_INTENT_ARTWORK exempts it, and the scan continues past it to genuinely protected content beyond required inset -> PASS", () => {
    const image = borderFixture(31); // protected content starts at x=31, required inset is 20px -> clears.
    const classifications: SignEdgeIntentClassification[] = [
      { kind: "edge_intent", edges: ["left"], xPx: 0, yPx: 0, widthPx: 9, heightPx: 150 },
    ];
    const result = analyzeSignFitToProduction(image, 2.5, 2.5, 0.125, classifications);
    const left = result.edges.find((e) => e.edge === "left")!;
    assert.equal(left.edgeIntentPresent, true);
    assert.equal(left.edgeIntentNearestCutPx, 0);
    assert.equal(left.edgeIntentAdvisory, true);
    assert.equal(left.nearestProtectedContentPx, 31);
    assert.equal(left.protectedResult, "pass");
    assert.equal(left.unresolvedAmbiguousPresent, false);
  });

  it("classifying the border EDGE_INTENT_ARTWORK still correctly FAILS when the TRUE protected content is too close", () => {
    const image = borderFixture(14); // protected content starts at x=14 — inside the required 20px inset.
    const classifications: SignEdgeIntentClassification[] = [
      { kind: "edge_intent", edges: ["left"], xPx: 0, yPx: 0, widthPx: 9, heightPx: 150 },
    ];
    const result = analyzeSignFitToProduction(image, 2.5, 2.5, 0.125, classifications);
    const left = result.edges.find((e) => e.edge === "left")!;
    assert.equal(left.edgeIntentPresent, true);
    assert.equal(left.nearestProtectedContentPx, 14);
    assert.equal(left.protectedResult, "fail");
    assert.equal(left.unresolvedAmbiguousPresent, true, "the protected content beyond the border was never classified — still unresolved ambiguous");
  });

  it("EDGE_INTENT_ARTWORK may exist INSIDE the nominal 0.125in safe band without itself failing — the guide is not a blanket no-artwork zone", () => {
    // Border spans depth 0..8, well inside the 20px required inset, over
    // rows 0..149 (a minority of the edge, keeping RED dominant) — with
    // the classified region covering the border's FULL depth-and-length
    // footprint and clean RED everywhere beyond it, this must PASS.
    const image = makeImage(400, 400, RED);
    fillRect(image, 0, 0, 9, 150, BLACK);
    const classifications: SignEdgeIntentClassification[] = [
      { kind: "edge_intent", edges: ["left"], xPx: 0, yPx: 0, widthPx: 9, heightPx: 150 },
    ];
    const result = analyzeSignFitToProduction(image, 2.5, 2.5, 0.125, classifications);
    const left = result.edges.find((e) => e.edge === "left")!;
    assert.equal(left.protectedResult, "pass");
  });

  it("BLEED_BACKGROUND alone (no classification at all) may still reach CUT — unaffected by the edge-intent mechanism", () => {
    const image = makeImage(200, 200, RED);
    const result = analyzeSignFitToProduction(image, 2, 2, 0.125, []);
    for (const edge of result.edges) assert.equal(edge.protectedResult, "pass");
  });

  it("PROTECTED_CONTENT still requires >=0.125in regardless of any edge-intent classification elsewhere on the same edge", () => {
    const image = borderFixture(14); // fails at 14px
    // No classification at all this time — same numeric result as the
    // classified case above, proving classification never WEAKENS the
    // requirement, only reveals what is genuinely behind an exempt region.
    const result = analyzeSignFitToProduction(image, 2.5, 2.5, 0.125);
    const left = result.edges.find((e) => e.edge === "left")!;
    assert.equal(left.protectedResult, "fail");
  });

  it("AMBIGUOUS_REVIEW (unclassified) remains blocking — never silently passed merely because it isn't the border", () => {
    const image = makeImage(400, 400, RED);
    // An unclassified circle-like mark 5px from the right edge — never
    // classified edge_intent nor protected.
    fillRect(image, 395, 100, 400, 120, BLACK);
    const result = analyzeSignFitToProduction(image, 2.5, 2.5, 0.125);
    const right = result.edges.find((e) => e.edge === "right")!;
    assert.equal(right.protectedResult, "fail");
    assert.equal(right.unresolvedAmbiguousPresent, true);
  });
});

describe("analyzeSignFitToProduction: spatial bounding of the edge-intent exemption (Section G)", () => {
  /**
   * LEFT edge: a 9px BLACK border along rows 0..149 only (a minority of
   * the 400-row edge, keeping RED the measured dominant baseline), split
   * into a classified sub-range (rows 0..99) and an UNCLASSIFIED sub-range
   * of the SAME physical border (rows 100..149) — simulating a warning
   * triangle/hole graphic sitting right next to a legitimately classified
   * border segment. The exemption must not leak onto the unclassified part.
   */
  function partiallyClassifiedFixture(): RgbaImage {
    const image = makeImage(400, 400, RED);
    fillRect(image, 0, 0, 9, 150, BLACK); // border, rows 0..149 (minority of the edge)
    return image;
  }

  it("the edge-intent exemption applies ONLY to the classified region — an adjacent unclassified strip of the SAME border still fails", () => {
    const image = partiallyClassifiedFixture();
    const classifications: SignEdgeIntentClassification[] = [
      // Classified for rows 0..99 only — the border ALSO covers 100..149, left unclassified.
      { kind: "edge_intent", edges: ["left"], xPx: 0, yPx: 0, widthPx: 9, heightPx: 100 },
    ];
    const result = analyzeSignFitToProduction(image, 2.5, 2.5, 0.125, classifications);
    const left = result.edges.find((e) => e.edge === "left")!;
    // The border still physically exists at rows 100..149 (unclassified there) -> still the worst point, still fails.
    assert.equal(left.protectedResult, "fail");
    assert.equal(left.nearestProtectedContentPx, 0);
    assert.ok(
      left.violatingPositionPx! >= 100 && left.violatingPositionPx! < 150,
      "the violating position must land in the UNCLASSIFIED slice of the border, never the classified one",
    );
  });

  it("a warning-triangle-shaped mark immediately adjacent to a classified border region is NOT exempted merely by proximity", () => {
    const image = makeImage(400, 400, RED);
    fillRect(image, 0, 0, 9, 150, BLACK); // border, rows 0..149
    // A second, DISTINCT mark (simulating a warning triangle) directly
    // beside the border's own classified region, reaching one row deeper.
    fillRect(image, 0, 120, 11, 140, { r: 0, g: 0, b: 0 }); // depth 0..10, rows 120..139
    const classifications: SignEdgeIntentClassification[] = [
      // Classified to depth 9 only (the border's own true depth) — the
      // triangle-mark's extra depth (10) is never covered.
      { kind: "edge_intent", edges: ["left"], xPx: 0, yPx: 0, widthPx: 9, heightPx: 150 },
    ];
    const result = analyzeSignFitToProduction(image, 2.5, 2.5, 0.125, classifications);
    const left = result.edges.find((e) => e.edge === "left")!;
    assert.equal(left.protectedResult, "fail");
    assert.ok(left.violatingPositionPx! >= 120 && left.violatingPositionPx! < 140);
  });

  it("classifying one edge's region never exempts a DIFFERENT edge — the RIGHT edge remains completely unaffected by the LEFT edge's own classification", () => {
    const image = makeImage(400, 400, RED);
    fillRect(image, 0, 0, 9, 150, BLACK); // LEFT border only
    const classifications: SignEdgeIntentClassification[] = [
      { kind: "edge_intent", edges: ["left"], xPx: 0, yPx: 0, widthPx: 9, heightPx: 150 },
    ];
    const result = analyzeSignFitToProduction(image, 2.5, 2.5, 0.125, classifications);
    const right = result.edges.find((e) => e.edge === "right")!;
    assert.equal(right.protectedResult, "pass");
    assert.equal(right.edgeIntentPresent, false);
  });
});

describe("analyzeSignFitToProduction: scan-past-edge-artwork behaviour (Section H/P)", () => {
  // Border occupies rows 0..149 only (a minority of the 400-row edge) so
  // RED stays the measured dominant baseline — see the EDGE_INTENT_ARTWORK
  // describe block above for why a full-height border would defeat this.
  function scanPastFixture(protectedDepth: number): RgbaImage {
    const image = makeImage(400, 400, RED);
    fillRect(image, 0, 0, 9, 150, BLACK); // 0..8
    fillRect(image, protectedDepth, 60, protectedDepth + 20, 80, BLACK);
    return image;
  }
  const borderClassification: SignEdgeIntentClassification = {
    kind: "edge_intent", edges: ["left"], xPx: 0, yPx: 0, widthPx: 9, heightPx: 150,
  };

  it("border (0-8px, classified) + background (9-30px) + protected content at 31px, required 20px -> PASS", () => {
    const result = analyzeSignFitToProduction(scanPastFixture(31), 2.5, 2.5, 0.125, [borderClassification]); // 160ppi, required 20px
    const left = result.edges.find((e) => e.edge === "left")!;
    assert.equal(left.nearestProtectedContentPx, 31);
    assert.equal(left.protectedResult, "pass");
  });

  it("border (0-8px, classified) + background (9-13px) + protected content at 14px, required 20px -> FAIL", () => {
    const result = analyzeSignFitToProduction(scanPastFixture(14), 2.5, 2.5, 0.125, [borderClassification]);
    const left = result.edges.find((e) => e.edge === "left")!;
    assert.equal(left.nearestProtectedContentPx, 14);
    assert.equal(left.protectedResult, "fail");
  });

  it("edge-intent border followed by unresolved ambiguous content -> FAIL, and unresolvedAmbiguousPresent is true (never silently treated as acknowledged)", () => {
    const result = analyzeSignFitToProduction(scanPastFixture(14), 2.5, 2.5, 0.125, [borderClassification]); // unclassified content — ambiguous
    const left = result.edges.find((e) => e.edge === "left")!;
    assert.equal(left.protectedResult, "fail");
    assert.equal(left.unresolvedAmbiguousPresent, true);
  });

  it("an explicit 'protected' classification over the same content marks it acknowledged — still fails, but unresolvedAmbiguousPresent is false", () => {
    const image = scanPastFixture(14);
    const classifications: SignEdgeIntentClassification[] = [
      borderClassification,
      { kind: "protected", edges: ["left"], xPx: 14, yPx: 60, widthPx: 20, heightPx: 20 },
    ];
    const result = analyzeSignFitToProduction(image, 2.5, 2.5, 0.125, classifications);
    const left = result.edges.find((e) => e.edge === "left")!;
    assert.equal(left.protectedResult, "fail");
    assert.equal(left.unresolvedAmbiguousPresent, false, "acknowledged protected content is a KNOWN reason to fail, not an open ambiguity");
  });
});
