/**
 * Structural Layout Reflow Phase 2D (Bounded Transition-Run Segmentation).
 *
 * Proves the deterministic bounded transition-run model in
 * `sign-layout-segmentation.ts`: a short (<=2px), fill-classified run
 * directly adjacent to another fill run is normalized into that neighbour
 * BEFORE the adjacent-fill ambiguity check — but ONLY when affirmative
 * colour/neighbour evidence supports it (a substantial anchor whose colour
 * the candidate is close to, or a genuine channel-wise blend between two
 * substantial anchors). Shortness alone is NEVER sufficient — see the "must
 * not be silently absorbed" cases below, each of which is exactly as short
 * as a case that DOES resolve, differing only in colour evidence.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { framedBannerSignArtwork, verticalRunsArtwork } from "./sign-fixtures";
import { segmentStructuralLayout } from "./sign-layout-segmentation";

describe("segmentStructuralLayout — bounded transition-run normalization (Phase 2D)", () => {
  it("A: large fill -> 1px transition close to that fill's colour -> content resolves (no longer a spurious adjacent-fill ambiguity)", () => {
    const image = verticalRunsArtwork(200, [
      { heightPx: 40, color: { r: 200, g: 30, b: 30 } }, // fillA, edge-reaching.
      { heightPx: 1, color: { r: 218, g: 45, b: 20 } }, // candidate: diffs (18,15,10) from A — outside the DEFAULT 12 tolerance (so it did NOT already merge during run-length encoding) but within the 24 transition tolerance.
      { heightPx: 60, color: { r: 250, g: 250, b: 100 }, content: true },
    ]);
    const result = segmentStructuralLayout(image);
    assert.equal(result.status, "measured");
    if (result.status !== "measured") return;
    assert.equal(result.regions.length, 1);
    assert.equal(result.gaps.length, 0);
    const [region] = result.regions;
    assert.equal(region!.role, "top_anchor");
    assert.deepEqual(region!.sourceBounds, { startYPx: 0, heightPx: 101 });
    assert.deepEqual(region!.fillColor, { r: 200, g: 30, b: 30 });
    assert.equal(region!.fillEdgeReaching, true);
  });

  it("B: content -> 1px transition close to a fill's colour -> large fill resolves, keeping the FILL's own colour (never the candidate's, never an average)", () => {
    const image = verticalRunsArtwork(200, [
      { heightPx: 60, color: { r: 250, g: 250, b: 100 }, content: true },
      { heightPx: 1, color: { r: 45, g: 68, b: 195 } }, // candidate: diffs from fillB (30,60,180) = (15,8,15) — outside 12, within 24.
      { heightPx: 40, color: { r: 30, g: 60, b: 180 } }, // fillB, edge-reaching.
    ]);
    const result = segmentStructuralLayout(image);
    assert.equal(result.status, "measured");
    if (result.status !== "measured") return;
    assert.equal(result.regions.length, 1);
    assert.equal(result.gaps.length, 0);
    const [region] = result.regions;
    assert.deepEqual(region!.sourceBounds, { startYPx: 0, heightPx: 101 });
    // The absorbed run's colour is the fill's OWN measured colour, not the transition row's.
    assert.deepEqual(region!.fillColor, { r: 30, g: 60, b: 180 });
    assert.equal(region!.fillEdgeReaching, true);
  });

  it("C: 1px transition genuinely between two large, differently-coloured fills is folded into the closer one, but the two fills' own genuine disagreement correctly remains ambiguous (never fabricated as resolved)", () => {
    const fillA = { r: 200, g: 30, b: 30 };
    const fillB = { r: 30, g: 60, b: 180 };
    const image = verticalRunsArtwork(200, [
      { heightPx: 40, color: fillA },
      { heightPx: 1, color: { r: 110, g: 45, b: 100 } }, // channel-wise between A and B (with slack), not "close" to either alone.
      { heightPx: 40, color: fillB },
    ]);
    const result = segmentStructuralLayout(image);
    assert.equal(result.status, "ambiguous");
    if (result.status !== "ambiguous") return;
    // The reported boundary is the MERGED one (rows 0-39 / 40-80) — proof
    // the 1px transition row no longer appears as its own third entity —
    // while the deeper fillA-vs-fillB disagreement is still, correctly,
    // never silently resolved.
    assert.match(result.reason, /rows 0-39 and 40-80/);
  });

  it("D: large fill -> thin STRONGLY DISTINCT stripe -> large fill is NEVER silently absorbed merely for being short — remains its own meaningful run and a genuine ambiguity", () => {
    const image = verticalRunsArtwork(200, [
      { heightPx: 40, color: { r: 200, g: 30, b: 30 } },
      { heightPx: 1, color: { r: 0, g: 255, b: 255 } }, // strongly distinct — not close to, nor between, its neighbours.
      { heightPx: 40, color: { r: 30, g: 150, b: 220 } },
    ]);
    const result = segmentStructuralLayout(image);
    assert.equal(result.status, "ambiguous");
    if (result.status !== "ambiguous") return;
    // The FIRST adjacent pair reported is fillA vs the stripe itself — proof
    // the stripe was never folded away before the ambiguity check saw it.
    assert.match(result.reason, /rows 0-39 and 40-40/);
  });

  it("E: content -> thin deliberate separator -> content is preserved as its own measured gap, never absorbed (neither neighbour is a fill run to absorb into)", () => {
    const image = verticalRunsArtwork(200, [
      { heightPx: 60, color: { r: 250, g: 250, b: 100 }, content: true },
      { heightPx: 1, color: { r: 0, g: 200, b: 0 } },
      { heightPx: 60, color: { r: 200, g: 250, b: 250 }, content: true },
    ]);
    const result = segmentStructuralLayout(image);
    assert.equal(result.status, "measured");
    if (result.status !== "measured") return;
    assert.equal(result.regions.length, 2);
    assert.equal(result.gaps.length, 1);
    assert.equal(result.gaps[0]!.sourceHeightPx, 1);
    assert.deepEqual(result.gaps[0]!.fillColor, { r: 0, g: 200, b: 0 });
  });

  it("F: multiple consecutive thin runs (no run has a substantial anchor on either side) fail closed — a genuine pattern is never guessed away", () => {
    const image = verticalRunsArtwork(200, [
      { heightPx: 60, color: { r: 250, g: 250, b: 100 }, content: true },
      { heightPx: 2, color: { r: 200, g: 30, b: 30 } },
      { heightPx: 2, color: { r: 30, g: 200, b: 30 } },
      { heightPx: 2, color: { r: 30, g: 30, b: 200 } },
      { heightPx: 60, color: { r: 200, g: 250, b: 250 }, content: true },
    ]);
    const result = segmentStructuralLayout(image);
    assert.equal(result.status, "ambiguous");
  });

  it("G: a short run adjacent to one substantial fill, whose colour is not plausibly transitional, is NOT absorbed", () => {
    const image = verticalRunsArtwork(200, [
      { heightPx: 40, color: { r: 200, g: 30, b: 30 } },
      { heightPx: 1, color: { r: 0, g: 255, b: 0 } }, // far from fillA on every channel.
      { heightPx: 60, color: { r: 250, g: 250, b: 100 }, content: true },
    ]);
    const result = segmentStructuralLayout(image);
    assert.equal(result.status, "ambiguous");
  });

  it("K: an intentional 1px HIGH-CONTRAST line adjacent to a substantial fill is never auto-suppressed merely because it is one row — the algorithm distinguishes 'short' from 'proven transition'", () => {
    const image = verticalRunsArtwork(200, [
      { heightPx: 40, color: { r: 20, g: 20, b: 20 } },
      { heightPx: 1, color: { r: 255, g: 255, b: 255 } }, // deliberate high-contrast line.
      { heightPx: 60, color: { r: 250, g: 250, b: 100 }, content: true },
    ]);
    const result = segmentStructuralLayout(image);
    assert.equal(result.status, "ambiguous");
  });

  it("N (boundary): a run exactly at the transition bound (2px) with plausible colour evidence absorbs; N+1 (3px) does NOT absorb solely because of length, and correctly remains ambiguous absent colour evidence", () => {
    const atBound = verticalRunsArtwork(200, [
      { heightPx: 40, color: { r: 200, g: 30, b: 30 } },
      { heightPx: 2, color: { r: 218, g: 45, b: 20 } }, // same plausible-transition colour as test A, 2px tall.
      { heightPx: 60, color: { r: 250, g: 250, b: 100 }, content: true },
    ]);
    const atBoundResult = segmentStructuralLayout(atBound);
    assert.equal(atBoundResult.status, "measured");

    const overBound = verticalRunsArtwork(200, [
      { heightPx: 40, color: { r: 200, g: 30, b: 30 } },
      { heightPx: 3, color: { r: 218, g: 45, b: 20 } }, // identical colour evidence, one row taller than the bound.
      { heightPx: 60, color: { r: 250, g: 250, b: 100 }, content: true },
    ]);
    const overBoundResult = segmentStructuralLayout(overBound);
    // heightPx alone disqualifies it as a transition candidate — it is
    // structural fill in its own right, and correctly forms a genuine
    // adjacent-fill ambiguity against fillA (never silently dropped).
    assert.equal(overBoundResult.status, "ambiguous");
  });

  it("H: a continuously-framed banner (unrounded, no holes) with a bounded transition row before an interior gap still measures top/middle/bottom regions and all gaps through the Phase 2C analysis window", () => {
    const result = segmentStructuralLayout(
      framedBannerSignArtwork({ rounded: false, withHoles: false, transitionBeforeGap2: true }),
      { x: 31, y: 31, width: 1086 - 62, height: 1448 - 62 },
    );
    assert.equal(result.status, "measured");
    if (result.status !== "measured") return;
    assert.equal(result.regions.length, 4);
    assert.equal(result.gaps.length, 3);
    assert.equal(result.regions[0]!.role, "top_anchor");
    assert.equal(result.regions[3]!.role, "bottom_anchor");
  });

  it("I: the same framed transition case with rounded corners measures identically", () => {
    const result = segmentStructuralLayout(
      framedBannerSignArtwork({ rounded: true, withHoles: false, transitionBeforeGap2: true }),
      { x: 31, y: 31, width: 1086 - 62, height: 1448 - 62 },
    );
    assert.equal(result.status, "measured");
    if (result.status !== "measured") return;
    assert.equal(result.regions.length, 4);
    assert.equal(result.gaps.length, 3);
  });

  it("J: the same framed transition case with corner hole indicators measures identically", () => {
    const result = segmentStructuralLayout(
      framedBannerSignArtwork({ rounded: true, withHoles: true, transitionBeforeGap2: true }),
      { x: 31, y: 31, width: 1086 - 62, height: 1448 - 62 },
    );
    assert.equal(result.status, "measured");
    if (result.status !== "measured") return;
    assert.equal(result.regions.length, 4);
    assert.equal(result.gaps.length, 3);
  });

  it("determinism: identical bytes and window produce byte-identical results across repeated calls", () => {
    const image = verticalRunsArtwork(200, [
      { heightPx: 40, color: { r: 200, g: 30, b: 30 } },
      { heightPx: 1, color: { r: 218, g: 45, b: 20 } },
      { heightPx: 60, color: { r: 250, g: 250, b: 100 }, content: true },
    ]);
    const first = segmentStructuralLayout(image);
    const second = segmentStructuralLayout(image);
    assert.deepEqual(first, second);
  });
});
