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

import { edgeBandDepthPx } from "./edge-inspection";

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

/**
 * Signs Perimeter Safety Phase: a continuous, near-full-length band of
 * non-background content sitting right at the TOP edge — the deterministic
 * shape a designed perimeter/border/frame graphic produces, regardless of
 * whether `edge-inspection.ts`'s coarse three-way classifier lands on
 * `foreground_bleed` or `mixed_or_uncertain`. Geometry is hand-derived (not
 * guessed) against `edgeBandDepthPx(1000, 1500) === 20`: `contentDepthPx`
 * rows nearest the edge, across `contentLengthPx` of the width (leaving a
 * small untouched margin at both ends, never literally 100%), everything
 * else in the band left as the same uniform background
 * `uniformBackgroundSignArtwork` uses.
 *
 *   `solidColor: true`  — ONE flat alternate colour fills the content rows.
 *                          With a shallow `contentDepthPx` (4 of 20 band
 *                          rows), background still covers ~81% of the WHOLE
 *                          band, so `dominantCoverage` clears
 *                          `DOMINANT_MIN_COVERAGE` and this classifies
 *                          `foreground_bleed` under the EXISTING three-way
 *                          classifier — the "strong continuous border"
 *                          case (a full-length run, unlike
 *                          `ruthLikeSignArtwork`'s partial ~12.5% one, at
 *                          the SAME classification).
 *   `solidColor: false` — content rows cycle through several DISTINCT
 *                          alternate colours (no single one competes with
 *                          the background bucket) across a DEEPER
 *                          `contentDepthPx` (9 of 20 band rows, ~58%
 *                          background overall) — `dominantCoverage` lands
 *                          just under 0.6, classifying `mixed_or_uncertain`
 *                          — the real S1 acceptance incident's own measured
 *                          shape (dominantCoverage ~0.595, outermostCoverage
 *                          ~0.07, longest run ~93% of the edge length).
 *
 * Both variants put the SAME outermost-line evidence in front of
 * `isEdgeDependentStructure` (`outermostCoverage` ~0.07, longest
 * contiguous run ~93% of the edge length) — proving the signal fires
 * identically regardless of which three-way bucket the coarse classifier
 * happens to land on, which is the whole point of it being a genuinely
 * independent, more specific concept.
 */
export function edgeStructureSignArtwork(options: {
  width?: number;
  height?: number;
  solidColor: boolean;
}): RgbaImage {
  const width = options.width ?? 1000;
  const height = options.height ?? 1500;
  const image = uniformBackgroundSignArtwork(width, height);
  const contentDepthPx = options.solidColor ? 4 : 9;
  const marginPx = Math.round(width * 0.035);
  const contentLengthPx = width - 2 * marginPx;
  const ALT_COLORS: Rgba[] = [
    { r: 200, g: 20, b: 20 },
    { r: 20, g: 20, b: 20 },
    { r: 20, g: 90, b: 160 },
    { r: 210, g: 150, b: 20 },
    { r: 90, g: 20, b: 140 },
  ];
  for (let y = 0; y < contentDepthPx; y++) {
    for (let x = marginPx; x < marginPx + contentLengthPx; x++) {
      // `y` only (never `x`) — each ROW must be internally uniform for the
      // `mixed_or_uncertain`-under-the-old-classifier shape this fixture
      // targets; varying by `x` too would make individual rows non-uniform,
      // which is a DIFFERENT (also real, separately covered) fixture shape.
      const color = options.solidColor ? ALT_COLORS[0]! : ALT_COLORS[y % ALT_COLORS.length]!;
      const i = (y * width + x) * 4;
      image.data[i] = color.r;
      image.data[i + 1] = color.g;
      image.data[i + 2] = color.b;
      image.data[i + 3] = 255;
    }
  }
  return image;
}

/**
 * Production-Aware Perimeter Reconstruction Phase: a genuinely
 * row-uniform, full-EDGE-LENGTH striped band along the TOP edge — every
 * row within the measured depth is ONE flat colour across the ENTIRE
 * width (no margin, unlike `edgeStructureSignArtwork`, which intentionally
 * leaves one for the coarser whole-band edge-dependence tests). This is
 * the shape `perimeter-reconstruction.ts`'s STRICT per-row uniform-
 * coverage bar (`UNIFORM_MIN_COVERAGE`) is actually meant to admit — a
 * real striped/banded perimeter design, not merely "mostly one colour on
 * average".
 */
export function stripedPerimeterBandArtwork(width = 1000, height = 1500): RgbaImage {
  const image = uniformBackgroundSignArtwork(width, height);
  const depth = edgeBandDepthPx(width, height);
  // Row 0 (the OUTERMOST line, at the actual edge) is a distinct MINORITY
  // accent colour; every deeper row shares a second, majority colour. Both
  // groups are individually solid (each row 100% one colour, satisfying
  // `measurePerimeterBand`'s per-row bar), but because row 0's colour is a
  // small minority of the whole band, `edge-inspection.ts`'s WHOLE-BAND
  // dominant colour is the majority one — meaning row 0 does NOT match it,
  // giving a genuinely LOW `outermostCoverage` and correctly tripping
  // `isEdgeDependentStructure` too. A naive every-other-row stripe with two
  // EQUALLY-sized colour groups does NOT do this: ties in the whole-band
  // dominant-bucket computation resolve to whichever colour was scanned
  // first (row 0's own colour), which would make the outermost line
  // trivially "match the dominant colour" and never read as edge-dependent
  // at all — an accent/fill split avoids that tie entirely.
  const accentColor: Rgba = { r: 200, g: 20, b: 20 };
  const fillColor: Rgba = { r: 20, g: 20, b: 20 };
  fillRect(image, 0, 0, width, 1, accentColor);
  for (let y = 1; y < depth; y++) {
    fillRect(image, 0, y, width, y + 1, fillColor);
  }
  return image;
}

/**
 * Production-Aware Perimeter Reconstruction Phase: a band otherwise
 * identical to `stripedPerimeterBandArtwork`'s solid-fill degenerate case,
 * but with one small isolated mark (e.g. a mounting-hole/corner indicator)
 * embedded roughly in the middle of the band's own depth and length. Must
 * refuse reconstructability — proves the row-uniform evidence bar alone is
 * what keeps this capability from ever tiling through unmeasured structure,
 * without needing any dedicated mark detector (see `perimeter-
 * reconstruction.ts`'s own module doc for why that is sufficient).
 */
export function bandWithEmbeddedMarkArtwork(width = 1000, height = 1500): RgbaImage {
  const image = uniformBackgroundSignArtwork(width, height);
  const depth = edgeBandDepthPx(width, height);
  // Same accent-row-0/majority-fill split `stripedPerimeterBandArtwork`
  // uses, and for the identical reason: row 0 must be a whole-band MINORITY
  // colour so the outermost line genuinely does not match the band's
  // dominant colour, which is what makes this fixture edge-dependent (not
  // merely non-reconstructable) — the planner never even LOOKS at
  // reconstructability unless edge-dependence already fired.
  const accentColor: Rgba = { r: 200, g: 20, b: 20 };
  const fillColor: Rgba = { r: 40, g: 40, b: 200 };
  fillRect(image, 0, 0, width, 1, accentColor);
  for (let y = 1; y < depth; y++) fillRect(image, 0, y, width, y + 1, fillColor);
  // The mark sits within the FILL rows (never row 0) — it alone is what
  // must break reconstructability; row 0's own accent colour stays clean.
  const markY = Math.max(1, Math.floor(depth / 2));
  fillRect(image, 490, markY, 510, markY + 1, { r: 255, g: 255, b: 255 });
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
