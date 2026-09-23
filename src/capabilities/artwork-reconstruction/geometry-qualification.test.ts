import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { RgbaImage } from "@/capabilities/final-artwork/raster-transform";
import {
  NEAR_BLACK,
  WHITE,
  GOLD,
  blend,
  createCanvas,
  denseBlackCompositionArtwork,
  alreadyTransparentArtwork,
  complexPhotographicBackgroundArtwork,
  fingerHoleArtwork,
  fillRect,
  haloArtwork,
  setPixel,
  whiteBackgroundArtwork,
  type Rgba,
} from "@/capabilities/artwork-preparation/artwork-fixtures";

import { qualifyReconstructionGeometry } from "./geometry-qualification";

/**
 * R6A: geometry qualification for an approved, fully-opaque reconstruction
 * candidate. Cases A-J mirror the R6A implementation task's own edge-safety
 * list; the REGENCY-shaped fixture (J) reproduces the R6A investigation's
 * own measured live-candidate evidence synthetically (Constitution §16 —
 * no real customer artwork is committed to this repository).
 */

function countMatchingOpaquePixels(image: RgbaImage, target: Rgba, tolerance: number): number {
  let count = 0;
  for (let i = 0; i < image.width * image.height; i += 1) {
    const idx = i * 4;
    const a = image.data[idx + 3]!;
    if (a !== 255) continue;
    const r = image.data[idx]!;
    const g = image.data[idx + 1]!;
    const b = image.data[idx + 2]!;
    if (
      Math.abs(r - target.r) <= tolerance &&
      Math.abs(g - target.g) <= tolerance &&
      Math.abs(b - target.b) <= tolerance
    ) {
      count += 1;
    }
  }
  return count;
}

/** D: a legitimate white DETAIL enclosed by colored foreground — trivially distinct from the background colour, never touched regardless of cavity evidence. */
function legitimateWhiteForegroundEnclosedByColorArtwork(): RgbaImage {
  const image = createCanvas(120, 120, NEAR_BLACK);
  fillRect(image, 20, 20, 80, 80, GOLD);
  fillRect(image, 50, 50, 20, 20, WHITE);
  return image;
}

/** I: a single uniform colour, no artwork at all. */
function emptyCanvasArtwork(): RgbaImage {
  return createCanvas(64, 64, { r: 255, g: 255, b: 255, a: 255 });
}

/**
 * E: content that reaches the canvas edge only over a small sliver (20 of
 * 796 border-ring pixels) — small enough that the border ring stays
 * dominated by one colour (so `classifyRepairability` itself would still
 * consider `remove_exterior`), which is what isolates THIS module's own
 * explicit border-touch guard from the classifier's separate
 * `complex_exterior_background` check.
 */
function contentBarelyTouchingBorderArtwork(): RgbaImage {
  const image = createCanvas(200, 200, NEAR_BLACK);
  fillRect(image, 0, 90, 100, 20, { r: 20, g: 20, b: 20, a: 255 });
  return image;
}

const REGENCY_BG: Rgba = { r: 254, g: 254, b: 254, a: 255 };

function regencyNoise(x: number, y: number): number {
  const hash = (x * 928_371 + y * 12_345) % 5;
  return hash === 0 ? 253 : hash === 1 ? 255 : 254;
}

/**
 * J: reproduces the R6A investigation's own measured live-candidate
 * evidence — a 1024x1024, fully opaque, near-white provider canvas
 * (border avg ≈254/254/254, max deviation ≈1.9) containing an off-center,
 * wide (≈4:1) wordmark (measured content bbox ≈803x201, not touching any
 * canvas edge), with a real anti-aliased left edge and an enclosed,
 * background-coloured letterform-counter cavity. Synthetic only — no real
 * customer artwork is committed to this repository (Constitution §16).
 */
function regencyShapedReconstructionCandidate(): RgbaImage {
  const width = 1024;
  const height = 1024;
  const image: RgbaImage = { width, height, data: Buffer.alloc(width * height * 4) };
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const v = regencyNoise(x, y);
      setPixel(image, x, y, { r: v, g: v, b: v, a: 255 });
    }
  }

  const contentLeft = 130;
  const contentTop = 405;
  const contentWidth = 700;
  const contentHeight = 200;

  fillRect(image, contentLeft + 6, contentTop, contentWidth - 6, contentHeight, NEAR_BLACK);

  // A soft anti-aliased ramp on the left edge, mirroring the real measured
  // scanline (255 -> 206 -> 25 -> ... -> 0).
  for (let y = contentTop; y < contentTop + contentHeight; y += 1) {
    setPixel(image, contentLeft, y, blend(REGENCY_BG, NEAR_BLACK, 0.05));
    setPixel(image, contentLeft + 1, y, blend(REGENCY_BG, NEAR_BLACK, 0.2));
    setPixel(image, contentLeft + 2, y, blend(REGENCY_BG, NEAR_BLACK, 0.55));
    setPixel(image, contentLeft + 3, y, blend(REGENCY_BG, NEAR_BLACK, 0.85));
    setPixel(image, contentLeft + 4, y, blend(REGENCY_BG, NEAR_BLACK, 0.97));
  }

  // An enclosed, background-coloured letterform-counter cavity — never
  // touching the exterior — that must survive qualification unchanged.
  fillRect(image, contentLeft + 250, contentTop + 60, 40, 80, REGENCY_BG);

  return image;
}

describe("A: already-transparent candidate", () => {
  it("abstains rather than running colour-based removal a candidate never needed", () => {
    const outcome = qualifyReconstructionGeometry(alreadyTransparentArtwork(), null);
    assert.equal(outcome.status, "abstained");
    if (outcome.status === "abstained") {
      assert.equal(outcome.reason, "already_transparent");
    }
  });
});

describe("B: opaque uniform white canvas + dark artwork", () => {
  it("qualifies and removes the exterior", () => {
    const original = whiteBackgroundArtwork();
    const outcome = qualifyReconstructionGeometry(original, null);
    assert.equal(outcome.status, "qualified");
    if (outcome.status === "qualified") {
      assert.ok(outcome.normalizedWidthPx <= original.width);
      assert.ok(outcome.normalizedHeightPx <= original.height);
      assert.ok(outcome.contentAspectRatio > 0);
    }
  });
});

describe("C/D: enclosed cavity and legitimate colored-foreground detail preservation", () => {
  it("preserves enclosed background-coloured cavities the wall/inradius evidence protects (the finger-hole negative control)", () => {
    const outcome = qualifyReconstructionGeometry(fingerHoleArtwork(), null);
    assert.equal(outcome.status, "qualified");
    if (outcome.status === "qualified") {
      // Three 12x12-radius finger holes, background-coloured (NEAR_BLACK),
      // fully enclosed by a wide gold ring — the exact negative control
      // `artwork-preparation`'s own cavity evidence exists to protect.
      const preserved = countMatchingOpaquePixels(outcome.image, NEAR_BLACK, 4);
      assert.ok(preserved > 300, `expected the finger holes to survive, preserved=${preserved}`);
    }
  });

  it("preserves a legitimate white detail enclosed by colored (non-background) foreground", () => {
    const outcome = qualifyReconstructionGeometry(
      legitimateWhiteForegroundEnclosedByColorArtwork(),
      null,
    );
    assert.equal(outcome.status, "qualified");
    if (outcome.status === "qualified") {
      const preserved = countMatchingOpaquePixels(outcome.image, WHITE, 4);
      assert.equal(preserved, 20 * 20);
    }
  });
});

describe("E: content touching the canvas border", () => {
  it("abstains rather than removing a background it cannot bound safely", () => {
    const outcome = qualifyReconstructionGeometry(contentBarelyTouchingBorderArtwork(), null);
    assert.equal(outcome.status, "abstained");
    if (outcome.status === "abstained") {
      assert.equal(outcome.reason, "content_touches_canvas_border");
    }
  });
});

describe("F: noisy/ambiguous (multi-colour) border", () => {
  it("the conservative classifier refuses rather than qualifying", () => {
    const outcome = qualifyReconstructionGeometry(denseBlackCompositionArtwork(), null);
    assert.equal(outcome.status, "abstained");
    if (outcome.status === "abstained") {
      assert.equal(outcome.reason, "complex_exterior_background");
    }
  });
});

describe("G: gradient/photo-like background", () => {
  it("abstains rather than guessing at a non-uniform background", () => {
    const outcome = qualifyReconstructionGeometry(complexPhotographicBackgroundArtwork(), null);
    assert.equal(outcome.status, "abstained");
  });
});

describe("H: anti-aliased edge (halo risk)", () => {
  it("qualifies, reusing the existing engine's own edge decontamination rather than a new one", () => {
    const outcome = qualifyReconstructionGeometry(haloArtwork(), null);
    assert.equal(outcome.status, "qualified");
    if (outcome.status === "qualified") {
      // The intentional dark interior stroke (well inside the subject)
      // must survive as real, opaque artwork.
      const preservedStroke = countMatchingOpaquePixels(outcome.image, NEAR_BLACK, 4);
      assert.ok(preservedStroke > 0, "expected the interior stroke to survive");
    }
  });
});

describe("I: empty/near-empty result", () => {
  it("refuses qualification for a canvas with no visible artwork", () => {
    const outcome = qualifyReconstructionGeometry(emptyCanvasArtwork(), null);
    assert.equal(outcome.status, "abstained");
    if (outcome.status === "abstained") {
      assert.equal(outcome.reason, "no_visible_artwork");
    }
  });
});

describe("J: REGENCY-shaped — wide off-center artwork on a much larger square provider canvas", () => {
  it("derives geometry from the artwork's own content, not the 1:1 provider canvas", () => {
    const image = regencyShapedReconstructionCandidate();
    const originalBytesCopy = Buffer.from(image.data);

    const outcome = qualifyReconstructionGeometry(image, null);

    assert.equal(outcome.status, "qualified");
    if (outcome.status === "qualified") {
      assert.equal(outcome.originalCanvasWidthPx, 1024);
      assert.equal(outcome.originalCanvasHeightPx, 1024);
      // The provider canvas is 1:1; the actual content is far from it.
      assert.ok(outcome.contentAspectRatio > 3, `expected a wide aspect ratio, got ${outcome.contentAspectRatio}`);
      assert.ok(outcome.contentAspectRatio < 5, `expected a wide aspect ratio, got ${outcome.contentAspectRatio}`);
      assert.ok(outcome.normalizedWidthPx < 1024);
      assert.ok(outcome.normalizedHeightPx < 1024);

      // The enclosed letterform-counter cavity (40x80 = 3200px) survives.
      const preservedCavity = countMatchingOpaquePixels(outcome.image, REGENCY_BG, 2);
      assert.equal(preservedCavity, 40 * 80);
    }

    // The candidate passed in is never mutated.
    assert.equal(Buffer.compare(originalBytesCopy, image.data), 0);
  });

  it("abstains when trustworthy source evidence proves the result still drifted", () => {
    const image = regencyShapedReconstructionCandidate();
    // A source aspect ratio far from the true ~3.5 content aspect ratio —
    // reuses `content-bounds-normalization.ts`'s own drift tolerance, never
    // a second one.
    const outcome = qualifyReconstructionGeometry(image, 1.0);
    assert.equal(outcome.status, "abstained");
    if (outcome.status === "abstained") {
      assert.equal(outcome.reason, "aspect_ratio_drift_exceeds_tolerance");
    }
  });
});
