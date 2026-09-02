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

/**
 * Parametric Perimeter Frame Reconstruction Phase: a synthetic bordered
 * sign — concentric band sequence (outer stroke / gap / inner stroke),
 * optional rounded corners, optional four symmetric corner-hole
 * indicators, and a distinct interior "content" fill so the protected
 * interior is visually and numerically distinguishable from the frame's
 * own fill colour. Deliberately mirrors the REAL cc6cfc4b-... acceptance
 * sign's own measured geometry (outer stroke ~9px, gap ~15px, inner stroke
 * ~7px, corner radius ~42px, hole radius ~9px, hole offset ~33/33px from
 * each corner) without reproducing the customer's own artwork.
 */
export function framedSignArtwork(options: {
  width?: number;
  height?: number;
  rounded?: boolean;
  withHoles?: boolean;
  /** Deliberately break one corner's rounding (different radius) or hole (missing) — for the ambiguous/blocked fixtures. */
  breakCorner?: "radius" | "missing_hole" | null;
  /**
   * Interior "content" fill colour — defaults to a bright near-white,
   * distinct from the frame's own fill colour. Override to `NEAR_BLACK`
   * (or similar) for a worker-level test that ALSO dispatches
   * `FakeSignReconstructionProvider`: its own solid-fill fake output is
   * always near-black, and `checkSourceSimilarity`'s advisory catastrophic
   * floor compares the source's own interior against it — a bright content
   * colour reads as a genuine catastrophic mismatch against that fake
   * output, exactly as `ruthLikeSignArtwork`'s own near-black background
   * already accounts for.
   */
  contentColor?: Rgba;
}): RgbaImage {
  const width = options.width ?? 1086;
  const height = options.height ?? 1448;
  const rounded = options.rounded ?? true;
  const withHoles = options.withHoles ?? true;
  const breakCorner = options.breakCorner ?? null;

  const outerStroke: Rgba = { r: 4, g: 4, b: 4 };
  const gapColor: Rgba = { r: 253, g: 253, b: 253 };
  const innerStroke: Rgba = { r: 4, g: 4, b: 4 };
  const fillColor: Rgba = { r: 202, g: 14, b: 14 };
  const contentColor: Rgba = options.contentColor ?? { r: 250, g: 250, b: 250 };
  const holeRing: Rgba = { r: 4, g: 4, b: 4 };
  const holeInterior: Rgba = { r: 253, g: 253, b: 253 };

  const OUTER_T = 9, GAP_T = 15, INNER_T = 7;
  const frameDepth = OUTER_T + GAP_T + INNER_T;
  const radius = rounded ? 42 : 0;
  const brokenRadius = 30; // a deliberately DIFFERENT radius for the "inconsistent corner" fixture.
  const holeRadius = 9;
  const holeOffsetX = 33, holeOffsetY = 33;

  const image = makeImage(width, height, fillColor);
  // Interior "content" fill, distinct from the frame's own fill colour —
  // never touched by this module's own measurement, just makes the
  // fixture visually/numerically honest about where content begins.
  fillRect(image, frameDepth, frameDepth, width - frameDepth, height - frameDepth, contentColor);

  function cornerRadiusFor(cx: number, cy: number): number {
    if (breakCorner === "radius" && cx === 0 && cy === 0) return brokenRadius;
    return radius;
  }

  function bandColorAt(depth: number): Rgba | null {
    if (depth < OUTER_T) return outerStroke;
    if (depth < OUTER_T + GAP_T) return gapColor;
    if (depth < frameDepth) return innerStroke;
    return null; // fill — already painted, leave untouched.
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const cornerX = x < width / 2 ? 0 : width - 1;
      const cornerY = y < height / 2 ? 0 : height - 1;
      const r = cornerRadiusFor(cornerX, cornerY);
      const inCornerX = x < r ? r - x : x > width - 1 - r ? x - (width - 1 - r) : 0;
      const inCornerY = y < r ? r - y : y > height - 1 - r ? y - (height - 1 - r) : 0;
      let depth: number | null;
      if (inCornerX > 0 && inCornerY > 0) {
        const dist = Math.sqrt(inCornerX * inCornerX + inCornerY * inCornerY);
        depth = dist > r ? null : r - dist;
      } else {
        depth = Math.min(x, y, width - 1 - x, height - 1 - y);
      }
      if (depth === null) {
        fillRect(image, x, y, x + 1, y + 1, gapColor); // outer background pocket outside the rounded corner.
        continue;
      }
      const color = bandColorAt(depth);
      if (color) fillRect(image, x, y, x + 1, y + 1, color);
    }
  }

  if (withHoles) {
    const corners: [number, number, 1 | -1, 1 | -1][] = [
      [0, 0, 1, 1],
      [width - 1, 0, -1, 1],
      [0, height - 1, 1, -1],
      [width - 1, height - 1, -1, -1],
    ];
    for (const [cx, cy, sx, sy] of corners) {
      if (breakCorner === "missing_hole" && cx === 0 && cy === 0) continue; // one corner deliberately has NO hole.
      const centerX = cx + sx * holeOffsetX;
      const centerY = cy + sy * holeOffsetY;
      for (let y = Math.floor(centerY - holeRadius - 2); y <= centerY + holeRadius + 2; y++) {
        for (let x = Math.floor(centerX - holeRadius - 2); x <= centerX + holeRadius + 2; x++) {
          if (x < 0 || y < 0 || x >= width || y >= height) continue;
          const d = Math.sqrt((x - centerX) ** 2 + (y - centerY) ** 2);
          if (d <= holeRadius) fillRect(image, x, y, x + 1, y + 1, holeInterior);
          else if (d <= holeRadius + 2) fillRect(image, x, y, x + 1, y + 1, holeRing);
        }
      }
    }
  }

  return image;
}

/**
 * Structural Layout Reflow Phase 1 (Foundations): banner-sign fixture
 * family for `sign-layout-segmentation.ts`. These are a GENERAL synthetic
 * banner shape (colored top/bottom bands with "content" inside them,
 * middle content blocks, measured background gaps) — never the real
 * customer's own wording or exact geometry, and deliberately generic so a
 * fixture-specific detector could never pass these tests: the segmentation
 * module must derive everything from measured colour/uniformity evidence
 * alone.
 *
 * "Content" rows are built with `stripeContentRow` — full-width alternating
 * colour stripes — rather than a single flat colour, because
 * `segmentStructuralLayout` classifies each row independently across its
 * FULL width: a row painted one solid colour is indistinguishable from fill
 * no matter what colour it is, so genuine "content" rows must be internally
 * non-uniform themselves (simulating text/icon rows), not merely a
 * different colour from their neighbours.
 */
function stripeContentRow(
  image: RgbaImage,
  y: number,
  colorA: Rgba,
  colorB: Rgba,
  stripeWidthPx = 24,
): void {
  for (let x = 0; x < image.width; x++) {
    const color = Math.floor(x / stripeWidthPx) % 2 === 0 ? colorA : colorB;
    const i = (y * image.width + x) * 4;
    image.data[i] = color.r;
    image.data[i + 1] = color.g;
    image.data[i + 2] = color.b;
    image.data[i + 3] = 255;
  }
}

function stripeContentBlock(
  image: RgbaImage,
  y0: number,
  y1: number, // exclusive
  colorA: Rgba,
  colorB: Rgba,
  stripeWidthPx = 24,
): void {
  for (let y = y0; y < y1; y++) stripeContentRow(image, y, colorA, colorB, stripeWidthPx);
}

const BANNER_TOP_COLOR: Rgba = { r: 200, g: 28, b: 28 };
const BANNER_BOTTOM_COLOR: Rgba = { r: 26, g: 58, b: 150 };
const BANNER_BACKGROUND_COLOR: Rgba = { r: 10, g: 10, b: 10 };
const CONTENT_A: Rgba = { r: 250, g: 250, b: 250 };
const CONTENT_B: Rgba = { r: 40, g: 40, b: 40 };
const CONTENT_C: Rgba = { r: 250, g: 200, b: 40 };
const CONTENT_D: Rgba = { r: 40, g: 140, b: 200 };

/**
 * (1) Valid structured banner sign — the primary segmentation fixture.
 * 900×800 (9:8): deliberately NOT the same aspect ratio as any admitted
 * production template (e.g. 24×36in is 2:3) — segmentation must operate
 * on SOURCE geometry alone, independent of any ordered target size.
 *
 * Top banner fill (edge-reaching) with content inside it, two separate
 * measured-background-gap-separated middle content blocks, bottom banner
 * fill (edge-reaching) with content inside it. Expected: 4 regions
 * (`top_anchor`, `middle`, `middle`, `bottom_anchor`), 3 gaps.
 */
export function bannerSignArtwork(): RgbaImage {
  const width = 900;
  const height = 800;
  const image = makeImage(width, height, BANNER_BACKGROUND_COLOR);

  fillRect(image, 0, 0, width, 150, BANNER_TOP_COLOR); // top banner fill, touches y=0.
  stripeContentBlock(image, 150, 230, CONTENT_A, CONTENT_B); // content inside top banner.
  fillRect(image, 0, 230, width, 280, BANNER_BACKGROUND_COLOR); // gap 1.
  stripeContentBlock(image, 280, 380, CONTENT_A, CONTENT_C); // middle content 1.
  fillRect(image, 0, 380, width, 430, BANNER_BACKGROUND_COLOR); // gap 2.
  stripeContentBlock(image, 430, 530, CONTENT_D, CONTENT_C); // middle content 2.
  fillRect(image, 0, 530, width, 580, BANNER_BACKGROUND_COLOR); // gap 3.
  stripeContentBlock(image, 580, 660, CONTENT_A, CONTENT_B); // content inside bottom banner.
  fillRect(image, 0, 660, width, height, BANNER_BOTTOM_COLOR); // bottom banner fill, touches y=height.

  return image;
}

/**
 * (2) Ambiguous-background case — two directly adjacent full-width fill
 * runs of genuinely different measured colours, no content anywhere. There
 * is no single colour that can represent a "gap" between them; segmentation
 * must fail closed (`status: "ambiguous"`), never guess which colour wins.
 */
export function ambiguousAdjacentFillArtwork(): RgbaImage {
  const width = 900;
  const height = 600;
  const image = makeImage(width, height, BANNER_TOP_COLOR);
  fillRect(image, 0, 300, width, height, BANNER_BOTTOM_COLOR);
  return image;
}

/**
 * (3) No-inter-region-gap case — two visually distinct "content" blocks
 * (different stripe colours) painted back-to-back with NO separating fill
 * run between them. Row-run-length-encoding merges consecutive content
 * rows regardless of their own colours, so this must segment as ONE middle
 * region spanning both blocks, not two — proving a measured background gap
 * is what delineates separate regions, not a mere colour change within
 * content.
 */
export function bannerSignNoGapMiddleArtwork(): RgbaImage {
  const width = 900;
  const height = 900;
  const image = makeImage(width, height, BANNER_BACKGROUND_COLOR);

  fillRect(image, 0, 0, width, 120, BANNER_TOP_COLOR);
  stripeContentBlock(image, 120, 200, CONTENT_A, CONTENT_B);
  fillRect(image, 0, 200, width, 250, BANNER_BACKGROUND_COLOR); // gap 1.
  stripeContentBlock(image, 250, 350, CONTENT_A, CONTENT_C); // "block A" — no gap follows.
  stripeContentBlock(image, 350, 450, CONTENT_D, CONTENT_C); // "block B" — directly adjacent to block A, must merge with it.
  fillRect(image, 0, 450, width, 500, BANNER_BACKGROUND_COLOR); // gap 2.
  stripeContentBlock(image, 500, 600, CONTENT_A, CONTENT_D); // a genuinely separate middle region.
  fillRect(image, 0, 600, width, 650, BANNER_BACKGROUND_COLOR); // gap 3.
  stripeContentBlock(image, 650, 730, CONTENT_A, CONTENT_B);
  fillRect(image, 0, 730, width, height, BANNER_BOTTOM_COLOR);

  return image;
}

/**
 * (4) Meaningful content sitting directly at the top canvas edge (no
 * banner fill before it at all) — for later safe-area reasoning, which
 * needs to know a region's `contentBounds` can legitimately start at
 * `startYPx === 0` with no owning fill (`fillColor: null`,
 * `fillEdgeReaching: false`). A separate later content block (with its own
 * edge-reaching bottom banner) keeps the top region's own measurement
 * clean of that unrelated bottom absorption.
 */
export function bannerSignEdgeContentArtwork(): RgbaImage {
  const width = 900;
  const height = 1200;
  const image = makeImage(width, height, BANNER_BACKGROUND_COLOR);

  stripeContentBlock(image, 0, 90, CONTENT_A, CONTENT_B); // touches y=0 directly — no banner fill precedes it.
  fillRect(image, 0, 90, width, 400, BANNER_BACKGROUND_COLOR); // gap.
  stripeContentBlock(image, 400, 1120, CONTENT_A, CONTENT_C);
  fillRect(image, 0, 1120, width, height, BANNER_BOTTOM_COLOR); // touches y=height.

  return image;
}

/**
 * Structural Layout Reflow Phase 2 (Planner Wiring): a synthetic banner
 * sign sized to the REAL cc6cfc4b-... acceptance sign's own SOURCE pixel
 * dimensions (1086×1448, ordered 24×36in) — but a GENERIC banner-style
 * structural layout (top/middle/bottom bands, no customer wording, no
 * customer geometry), never the customer's own file. Proves segmentation
 * and the reflow planner path against the real incident's own scale
 * without touching the real project.
 */
export function acceptanceBannerSignArtwork(): RgbaImage {
  const width = 1086;
  const height = 1448;
  const image = makeImage(width, height, BANNER_BACKGROUND_COLOR);

  fillRect(image, 0, 0, width, 160, BANNER_TOP_COLOR); // top banner fill, touches y=0.
  stripeContentBlock(image, 160, 260, CONTENT_A, CONTENT_B); // meaningful content well inside the top banner.
  fillRect(image, 0, 260, width, 340, BANNER_BACKGROUND_COLOR); // gap 1.
  stripeContentBlock(image, 340, 520, CONTENT_A, CONTENT_C); // middle content 1.
  fillRect(image, 0, 520, width, 600, BANNER_BACKGROUND_COLOR); // gap 2.
  stripeContentBlock(image, 600, 780, CONTENT_D, CONTENT_C); // middle content 2.
  fillRect(image, 0, 780, width, 860, BANNER_BACKGROUND_COLOR); // gap 3.
  stripeContentBlock(image, 860, 960, CONTENT_A, CONTENT_B); // meaningful content well inside the bottom banner.
  fillRect(image, 0, 960, width, height, BANNER_BOTTOM_COLOR); // bottom banner fill, touches y=height.

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
