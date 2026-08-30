/**
 * Signs Phase S1: SYNTHETIC test fixtures.
 *
 * The Ruth-like fixture reproduces the production geometry and structural
 * characteristics of the live 18×24 acceptance order — 1024×1536 opaque
 * PNG, predominantly black background, meaningful foreground composition,
 * rainbow-like bands bleeding into the left/right edge regions near the
 * top, and footer content that makes a vertical crop unacceptable — WITHOUT
 * customer PII and without touching any live order (the bowling-fixture
 * precedent: the customer's own file is never committed).
 */

import { PNG } from "pngjs";

import type { RgbaImage } from "@/capabilities/final-artwork/raster-transform";

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a?: number;
}

export function makeImage(width: number, height: number, fill: Rgba): RgbaImage {
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = fill.r;
    data[i * 4 + 1] = fill.g;
    data[i * 4 + 2] = fill.b;
    data[i * 4 + 3] = fill.a ?? 255;
  }
  return { width, height, data };
}

export function fillRect(
  image: RgbaImage,
  x0: number,
  y0: number,
  x1: number, // exclusive
  y1: number, // exclusive
  color: Rgba,
): void {
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * image.width + x) * 4;
      image.data[i] = color.r;
      image.data[i + 1] = color.g;
      image.data[i + 2] = color.b;
      image.data[i + 3] = color.a ?? 255;
    }
  }
}

export function toPngBytes(image: RgbaImage): Buffer {
  const png = new PNG({ width: image.width, height: image.height });
  image.data.copy(png.data);
  return PNG.sync.write(png);
}

const NEAR_BLACK: Rgba = { r: 6, g: 6, b: 6 };

/**
 * The Ruth-shaped acceptance fixture: 1024×1536 (2:3), opaque, near-black
 * field, full-width rainbow bands near the top (foreground bleeding off
 * BOTH side edges), a large white content card, and footer content —
 * important material top AND bottom, so a 3-inch vertical crop is never
 * acceptable.
 */
export function ruthLikeSignArtwork(): RgbaImage {
  const image = makeImage(1024, 1536, NEAR_BLACK);
  const stripes: Rgba[] = [
    { r: 228, g: 26, b: 60 },
    { r: 255, g: 140, b: 20 },
    { r: 250, g: 220, b: 40 },
    { r: 60, g: 180, b: 80 },
    { r: 40, g: 120, b: 220 },
    { r: 140, g: 70, b: 180 },
  ];
  // Rainbow: y 96..288, full width — reaches/bleeds off left and right edges.
  stripes.forEach((color, index) => {
    fillRect(image, 0, 96 + index * 32, 1024, 96 + (index + 1) * 32, color);
  });
  // Headline block (does not touch side edges).
  fillRect(image, 192, 336, 832, 432, { r: 245, g: 245, b: 245 });
  // Main content card.
  fillRect(image, 64, 480, 960, 1400, { r: 255, g: 255, b: 255 });
  // Footer wording band (meaningful content near the bottom).
  fillRect(image, 200, 1440, 800, 1500, { r: 240, g: 60, b: 120 });
  return image;
}

/**
 * Uniform-background variant: same 2:3 geometry class, near-black field,
 * one centered content card touching NO edge — every edge band is provably
 * uniform background.
 */
export function uniformBackgroundSignArtwork(
  width = 1000,
  height = 1500,
): RgbaImage {
  const image = makeImage(width, height, NEAR_BLACK);
  fillRect(
    image,
    Math.round(width * 0.2),
    Math.round(height * 0.2),
    Math.round(width * 0.8),
    Math.round(height * 0.8),
    { r: 255, g: 255, b: 255 },
  );
  return image;
}

/** Exact-aspect (matches orderedW:orderedH), uniform background, opaque. */
export function exactAspectSignArtwork(width: number, height: number): RgbaImage {
  const image = makeImage(width, height, NEAR_BLACK);
  fillRect(
    image,
    Math.round(width * 0.25),
    Math.round(height * 0.25),
    Math.round(width * 0.75),
    Math.round(height * 0.75),
    { r: 250, g: 250, b: 250 },
  );
  return image;
}

/** Carries genuine transparency — invalid for opaque sign intent as-is. */
export function transparentSignArtwork(width = 600, height = 800): RgbaImage {
  const image = makeImage(width, height, NEAR_BLACK);
  fillRect(image, 100, 100, 300, 300, { r: 200, g: 200, b: 200, a: 0 });
  return image;
}

/** No dominant edge colour anywhere — deterministic "cannot prove" case. */
export function noisyEdgeSignArtwork(width = 400, height = 600): RgbaImage {
  const image = makeImage(width, height, NEAR_BLACK);
  // Deterministic pseudo-noise across the whole frame (no RNG — replayable).
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      image.data[i] = (x * 37 + y * 101) % 256;
      image.data[i + 1] = (x * 71 + y * 13) % 256;
      image.data[i + 2] = (x * 5 + y * 197) % 256;
      image.data[i + 3] = 255;
    }
  }
  return image;
}
