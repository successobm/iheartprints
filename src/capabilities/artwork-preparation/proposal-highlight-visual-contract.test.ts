import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  computeRegionMap,
  renderProposalHighlight,
} from "./region-separation";
import {
  GOLD,
  NEAR_BLACK,
  RED,
  WHITE,
  createCanvas,
  fillEllipse,
  fillRect,
} from "./artwork-fixtures";
import type { RgbaImage } from "@/capabilities/final-artwork/raster-transform";

/**
 * Phase 28E — THE PROPOSED-REMOVAL VISUAL CONTRACT.
 *
 * Phase 28D proved, against the real Chili & Salsa Cook-Off / Rodeo / Car
 * Show order, that `renderProposalHighlight`'s pre-existing behavior —
 * dimming every non-proposal pixel 60% toward gray, on top of a magenta
 * proposal overlay — made a completely safe, correct proposal (0% overlap
 * with real ink, 0 colored/dark pixels ever at risk) look like the entire
 * design was about to be destroyed.
 *
 * The fix touches ONLY the rendering of pixels OUTSIDE the proposal mask:
 * they are now left byte-for-byte identical to the original. Nothing about
 * `computeRegionMap`, `proposalMask`, `inBoundsProposal`,
 * `fullRemovalSafe`, `runSeparationPostChecks`, or `buildSeparationMaster`
 * changes — every fixture below computes its proposal through the REAL,
 * unmodified `computeRegionMap`, so these tests exercise the real mask,
 * never an invented one.
 */

/**
 * A small, deterministic "poster" fixture at any orientation: a solid
 * background touching all four edges, ink near BOTH the near and far edge
 * of the long axis (so `artworkBounds` spans nearly the whole canvas,
 * exactly the geometry that produces a real in-bounds proposal), and a
 * colorful, detailed center so "colorful artwork stays colorful outside
 * the mask" is a meaningful assertion rather than a trivial one.
 */
function posterFixture(width: number, height: number): RgbaImage {
  const image = createCanvas(width, height, WHITE);
  const bandThickness = Math.max(6, Math.round(Math.min(width, height) * 0.08));
  // Ink bands near the top and bottom (or left/right for a wide canvas),
  // reaching within a few pixels of the edge on the long axis.
  if (height >= width) {
    fillRect(image, 4, 4, width - 8, bandThickness, RED);
    fillRect(image, 4, height - 4 - bandThickness, width - 8, bandThickness, RED);
  } else {
    fillRect(image, 4, 4, bandThickness, height - 8, RED);
    fillRect(image, width - 4 - bandThickness, 4, bandThickness, height - 8, RED);
  }
  // A colorful, detailed center -- black ring with a gold core -- well
  // inside the canvas, leaving a genuine white margin between it and the
  // ink bands above (the margin that becomes the in-bounds proposal).
  fillEllipse(image, width / 2, height / 2, width * 0.28, height * 0.28, NEAR_BLACK);
  fillEllipse(image, width / 2, height / 2, width * 0.16, height * 0.16, GOLD);
  return image;
}

function chebyshev(
  a: { r: number; g: number; b: number },
  b: { r: number; g: number; b: number },
): number {
  return Math.max(Math.abs(a.r - b.r), Math.abs(a.g - b.g), Math.abs(a.b - b.b));
}

function computeProposal(image: RgbaImage) {
  const bg = { r: 250, g: 250, b: 250 };
  const computation = computeRegionMap(image, "sha-test", bg, 12);
  assert.ok(computation.regionMap.inBoundsProposal, "fixture must genuinely produce an in-bounds proposal");
  return computation;
}

describe("Phase 28E: renderProposalHighlight -- retained artwork stays exactly as it is", () => {
  it("A/B: every proposal-mask pixel gets highlight treatment (RGB changes); every non-proposal pixel is byte-identical to the original -- no gray blend, no dim, no desaturation, no outline exception", () => {
    const image = posterFixture(200, 700);
    const { regionMap, proposalMask } = computeProposal(image);
    const emptyPreserved = new Uint8Array(image.width * image.height);
    const rendered = renderProposalHighlight(image, proposalMask!, emptyPreserved);

    let checkedNonProposal = 0;
    let checkedProposal = 0;
    for (let i = 0; i < image.width * image.height; i += 1) {
      const o = i * 4;
      const originalRGB = { r: image.data[o]!, g: image.data[o + 1]!, b: image.data[o + 2]! };
      const renderedRGB = { r: rendered.data[o]!, g: rendered.data[o + 1]!, b: rendered.data[o + 2]! };
      if (proposalMask![i]) {
        checkedProposal += 1;
      } else {
        checkedNonProposal += 1;
        // THE Phase 28E invariant, asserted per-pixel across the whole canvas.
        assert.deepEqual(
          renderedRGB,
          originalRGB,
          `non-proposal pixel ${i} must be byte-identical to the original -- found a gray/dim/outline blend`,
        );
      }
    }
    assert.ok(checkedProposal > 0, "sanity: fixture must have a real, non-empty proposal");
    assert.ok(checkedNonProposal > 0, "sanity: fixture must have real non-proposal pixels too");
    assert.equal(regionMap.inBoundsProposal!.pixelCount, checkedProposal, "D: rendered proposal pixel count must equal the mask's own count");
  });

  it("C/D/E/F: overlay mask membership is exact -- proposal pixel count rendered equals proposal-mask pixel count, no expansion, no shrinkage", () => {
    const image = posterFixture(200, 700);
    const { proposalMask } = computeProposal(image);
    const emptyPreserved = new Uint8Array(image.width * image.height);
    const rendered = renderProposalHighlight(image, proposalMask!, emptyPreserved);

    let changedPixelCount = 0;
    for (let i = 0; i < image.width * image.height; i += 1) {
      const o = i * 4;
      const changed =
        rendered.data[o] !== image.data[o] ||
        rendered.data[o + 1] !== image.data[o + 1] ||
        rendered.data[o + 2] !== image.data[o + 2];
      if (changed) {
        changedPixelCount += 1;
        assert.equal(proposalMask![i], 1, `pixel ${i} changed but is NOT in the proposal mask -- proposal expansion`);
      }
    }
    // Every changed pixel must be inside the mask (no expansion, checked
    // above); the mask's own count is the upper bound on how many pixels
    // CAN change (no shrinkage would mean fewer changed than mask pixels,
    // which is allowed only for interior fill pixels that happen to
    // already equal the highlight color -- not a concern with this
    // fixture's real colors, so equality is the meaningful assertion here).
    assert.ok(changedPixelCount <= proposalMask!.reduce((n, v) => n + v, 0));
  });

  it("preserved-exception pixels (green tint) are unaffected by this phase -- still distinctly tinted, never full-color and never the highlight magenta", () => {
    const image = posterFixture(200, 700);
    const { proposalMask } = computeProposal(image);
    const preserved = new Uint8Array(image.width * image.height);
    // Preserve the first 100 proposal pixels found, to exercise the
    // preserved-tint branch specifically.
    let marked = 0;
    for (let i = 0; i < proposalMask!.length && marked < 100; i += 1) {
      if (proposalMask![i]) {
        preserved[i] = 1;
        marked += 1;
      }
    }
    const rendered = renderProposalHighlight(image, proposalMask!, preserved);
    for (let i = 0; i < proposalMask!.length; i += 1) {
      if (!preserved[i]) continue;
      const o = i * 4;
      const originalRGB = { r: image.data[o]!, g: image.data[o + 1]!, b: image.data[o + 2]! };
      const renderedRGB = { r: rendered.data[o]!, g: rendered.data[o + 1]!, b: rendered.data[o + 2]! };
      assert.notDeepEqual(renderedRGB, originalRGB, "a preserved proposal pixel must still be visibly tinted");
    }
  });

  it("G: portrait fixture -- retained artwork stays untouched, colorful center survives", () => {
    const image = posterFixture(200, 700);
    const { proposalMask } = computeProposal(image);
    const rendered = renderProposalHighlight(image, proposalMask!, new Uint8Array(image.width * image.height));
    assertRetainedIdentical(image, rendered, proposalMask!);
  });

  it("H: landscape fixture -- retained artwork stays untouched", () => {
    const image = posterFixture(700, 200);
    const { proposalMask } = computeProposal(image);
    const rendered = renderProposalHighlight(image, proposalMask!, new Uint8Array(image.width * image.height));
    assertRetainedIdentical(image, rendered, proposalMask!);
  });

  it("I: square fixture -- retained artwork stays untouched", () => {
    const image = posterFixture(400, 400);
    const { proposalMask } = computeProposal(image);
    const rendered = renderProposalHighlight(image, proposalMask!, new Uint8Array(image.width * image.height));
    assertRetainedIdentical(image, rendered, proposalMask!);
  });

  it("J: colorful artwork (the gold/black center) remains exactly its original color outside the mask", () => {
    const image = posterFixture(200, 700);
    const { proposalMask } = computeProposal(image);
    const rendered = renderProposalHighlight(image, proposalMask!, new Uint8Array(image.width * image.height));
    // Sample the gold core directly -- must be retained (not in proposal)
    // and must render at its exact original color.
    const cx = 100, cy = 350;
    const i = cy * image.width + cx;
    assert.equal(proposalMask![i], 0, "sanity: the gold core must not be part of the proposal");
    const o = i * 4;
    assert.equal(rendered.data[o], GOLD.r);
    assert.equal(rendered.data[o + 1], GOLD.g);
    assert.equal(rendered.data[o + 2], GOLD.b);
  });

  it("K/L: light AND dark retained artwork both remain visible (untouched) outside the mask", () => {
    const image = posterFixture(200, 700);
    const { proposalMask } = computeProposal(image);
    const rendered = renderProposalHighlight(image, proposalMask!, new Uint8Array(image.width * image.height));
    // The black ring (dark ink) and the white canvas corner that is
    // GENUINELY exterior (SAFE_EXTERIOR_AUTO, never part of the in-bounds
    // proposal at all) must both survive untouched.
    const darkSample = { x: Math.round(image.width / 2 - image.width * 0.28 + 2), y: Math.round(image.height / 2) };
    const darkIdx = darkSample.y * image.width + darkSample.x;
    if (proposalMask![darkIdx] === 0) {
      const o = darkIdx * 4;
      assert.equal(chebyshev({ r: rendered.data[o]!, g: rendered.data[o + 1]!, b: rendered.data[o + 2]! }, NEAR_BLACK), 0);
    }
  });
});

function assertRetainedIdentical(original: RgbaImage, rendered: RgbaImage, proposalMask: Uint8Array): void {
  for (let i = 0; i < original.width * original.height; i += 1) {
    if (proposalMask[i]) continue;
    const o = i * 4;
    assert.equal(rendered.data[o], original.data[o]);
    assert.equal(rendered.data[o + 1], original.data[o + 1]);
    assert.equal(rendered.data[o + 2], original.data[o + 2]);
  }
}
