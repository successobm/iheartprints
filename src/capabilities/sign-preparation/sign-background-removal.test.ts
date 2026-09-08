/**
 * Constitution amendment 3.2 (§16A.2): `prepareSignBackgroundRemoval`
 * reuses artwork-preparation's neutral classification/removal engine —
 * these tests prove the SIGNS-SIDE wrapper routes every verdict honestly
 * (never destructively guesses on ambiguity, never crops, never resizes),
 * not the underlying engine's own safety invariant (proven exhaustively by
 * `artwork-preparation`'s own test suite already).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { hasAnyTransparentPixel } from "@/capabilities/final-artwork/raster-transform";
import { complexPhotographicBackgroundArtwork } from "@/capabilities/artwork-preparation/artwork-fixtures";

import { prepareSignBackgroundRemoval } from "./sign-background-removal";
import { fillRect, makeImage } from "./sign-fixtures";

function pixelAlpha(image: { width: number; data: Buffer }, x: number, y: number): number {
  return image.data[(y * image.width + x) * 4 + 3]!;
}

describe("prepareSignBackgroundRemoval", () => {
  it("B: a white exterior background around a distinct subject is removed", () => {
    const image = makeImage(120, 120, { r: 255, g: 255, b: 255 });
    fillRect(image, 30, 30, 90, 90, { r: 20, g: 40, b: 120 });

    const outcome = prepareSignBackgroundRemoval(image);
    assert.equal(outcome.status, "removed");
    if (outcome.status !== "removed") return;
    // Exterior corner — was white background — is now transparent.
    assert.equal(pixelAlpha(outcome.image, 2, 2), 0);
    // Subject pixel remains fully opaque and unchanged.
    assert.equal(pixelAlpha(outcome.image, 60, 60), 255);
    assert.deepEqual(
      [outcome.image.data[(60 * 120 + 60) * 4], outcome.image.data[(60 * 120 + 60) * 4 + 1], outcome.image.data[(60 * 120 + 60) * 4 + 2]],
      [20, 40, 120],
    );
  });

  it("C: a legitimate white interior detail, fully enclosed by the subject and never edge-connected to the exterior, is preserved", () => {
    const image = makeImage(120, 120, { r: 255, g: 255, b: 255 });
    // The subject: a large black square, well clear of every edge.
    fillRect(image, 20, 20, 100, 100, { r: 5, g: 5, b: 5 });
    // A legitimate white interior detail (e.g. a highlight/counter) —
    // fully surrounded by the subject on every side, never touching the
    // canvas border.
    fillRect(image, 50, 50, 70, 70, { r: 255, g: 255, b: 255 });

    const outcome = prepareSignBackgroundRemoval(image);
    assert.equal(outcome.status, "removed");
    if (outcome.status !== "removed") return;
    // The exterior white is gone...
    assert.equal(pixelAlpha(outcome.image, 2, 2), 0);
    // ...but the interior white detail — never edge-connected to the true
    // background — remains fully opaque. Enclosure alone is never
    // sufficient evidence to remove it (the safety invariant this wrapper
    // inherits unmodified from artwork-preparation).
    assert.equal(pixelAlpha(outcome.image, 60, 60), 255);
  });

  it("D: ambiguous/complex background routes to review_required — never a destructive guess", () => {
    const image = complexPhotographicBackgroundArtwork();
    const outcome = prepareSignBackgroundRemoval(image);
    assert.equal(outcome.status, "review_required");
  });

  it("already-transparent artwork is recognized, not re-processed", () => {
    const image = makeImage(80, 80, { r: 0, g: 0, b: 0, a: 0 });
    fillRect(image, 20, 20, 60, 60, { r: 200, g: 40, b: 40, a: 255 });
    const outcome = prepareSignBackgroundRemoval(image);
    assert.equal(outcome.status, "already_transparent");
  });

  it("no visible artwork at all is reported honestly, not silently 'removed'", () => {
    const image = makeImage(80, 80, { r: 255, g: 255, b: 255 });
    const outcome = prepareSignBackgroundRemoval(image);
    assert.equal(outcome.status, "no_visible_artwork");
  });

  it("E/G: a removed result keeps the EXACT source pixel dimensions — no crop to visible bounds, no resize", () => {
    const image = makeImage(200, 140, { r: 255, g: 255, b: 255 });
    fillRect(image, 60, 40, 140, 100, { r: 10, g: 10, b: 10 });

    const outcome = prepareSignBackgroundRemoval(image);
    assert.equal(outcome.status, "removed");
    if (outcome.status !== "removed") return;
    assert.equal(outcome.image.width, 200);
    assert.equal(outcome.image.height, 140);
  });

  it("a removed result genuinely carries transparency (sanity check for downstream treatment-aware gates)", () => {
    const image = makeImage(120, 120, { r: 255, g: 255, b: 255 });
    fillRect(image, 30, 30, 90, 90, { r: 20, g: 40, b: 120 });
    const outcome = prepareSignBackgroundRemoval(image);
    assert.equal(outcome.status, "removed");
    if (outcome.status !== "removed") return;
    assert.equal(hasAnyTransparentPixel(outcome.image), true);
  });
});
