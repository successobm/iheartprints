/**
 * Intelligent Separation Phase 9: deterministic exterior-silhouette
 * extraction, consequential-region identification, and master construction.
 *
 * This is a PORT, not a rewrite, of the algorithms proven across Phases 5-8:
 *
 *   - `silhouetteByGapClosing` / `chebyshevDT` / `inkMask` — Phase 5's
 *     exterior-silhouette extraction (`.local-acceptance/phase5-silhouette-
 *     master/experiment.ts`), which proved it preserves fine detail (the
 *     tiny tagline, fine rings) exactly because it never traces interior
 *     content — only the outer boundary.
 *   - Connected-component region labelling — Phase 6/7/8's region
 *     extraction, which proved deterministic topology CANNOT infer whether
 *     an interior region is substrate or ink, but CAN reduce hundreds of
 *     candidate pixels to a small, materiality-ranked list a human can
 *     actually review.
 *
 * WHAT THIS FILE DOES NOT DO: classify intent. That is `RegionDecision`'s
 * job, and per Phase 8's evidence, only an `operator` decision may ever
 * become authoritative over these pixels (see the contracts module).
 *
 * Pure — no I/O, no provider, no repository, no clock.
 */

import { createHash } from "node:crypto";

import type { RgbaImage } from "@/capabilities/final-artwork/raster-transform";
import { VISIBLE_ALPHA_THRESHOLD, channelDistance } from "./pixel-metrics";
import type { RgbColor } from "./contracts";
import type {
  ConsequentialRegion,
  RegionBounds,
  RegionDecision,
  RegionMap,
  SeparationPostCheck,
} from "./region-separation-contracts";

/**
 * Bumped whenever a change would produce a different silhouette or region
 * set from identical source bytes. Persisted with every `RegionMap` so a
 * stale decision set can always be told apart from a current one.
 */
export const SEPARATION_ALGORITHM_VERSION = "iheartprints_separation_gap_closing_v1";

/** Phase 5's proven value: the smallest gap-closing radius that sealed the bowling badge with a clean canvas border. */
export const SILHOUETTE_RADIUS_PX = 3;

/**
 * The materiality floor a region must clear to be shown to an operator at
 * all (Goal 4). NOT claimed as validated — Phase 6/7/8 never tested where
 * this line should sit, only that regions at 615px and above were
 * consequential enough to matter. Chosen with generous margin BELOW that,
 * so the system asks about MORE rather than fewer regions: the only cost of
 * a false "consequential" is one extra operator click, while a false
 * "not consequential" silently defaults that region to preserved-as-ink
 * (see `buildSeparationMaster`) — which is the safe direction, but an
 * operator should still get the chance to say otherwise for anything of
 * real size.
 */
export const MIN_CONSEQUENTIAL_REGION_PX = 150;

const LIGHT_LUMA = 0.6;
const DARK_LUMA = 0.25;

function encodedLuma(r: number, g: number, b: number): number {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/** A visible pixel whose colour is NOT the detected background colour. */
export function computeInkMask(image: RgbaImage, background: RgbColor, tolerance: number): Uint8Array {
  const n = image.width * image.height;
  const mask = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) {
    const idx = i * 4;
    if (image.data[idx + 3]! < VISIBLE_ALPHA_THRESHOLD) continue;
    if (channelDistance(image.data, idx, background) > tolerance) mask[i] = 1;
  }
  return mask;
}

/** Chebyshev distance transform to the nearest set pixel. Two passes, O(n). */
function chebyshevDistanceTransform(mask: Uint8Array, w: number, h: number): Int32Array {
  const INF = 1 << 28;
  const d = new Int32Array(w * h);
  for (let i = 0; i < d.length; i += 1) d[i] = mask[i] ? 0 : INF;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = y * w + x;
      if (d[i] === 0) continue;
      let best = d[i]!;
      if (x > 0) best = Math.min(best, d[i - 1]! + 1);
      if (y > 0) best = Math.min(best, d[i - w]! + 1);
      if (y > 0 && x > 0) best = Math.min(best, d[i - w - 1]! + 1);
      if (y > 0 && x < w - 1) best = Math.min(best, d[i - w + 1]! + 1);
      d[i] = best;
    }
  }
  for (let y = h - 1; y >= 0; y -= 1) {
    for (let x = w - 1; x >= 0; x -= 1) {
      const i = y * w + x;
      let best = d[i]!;
      if (x < w - 1) best = Math.min(best, d[i + 1]! + 1);
      if (y < h - 1) best = Math.min(best, d[i + w]! + 1);
      if (y < h - 1 && x < w - 1) best = Math.min(best, d[i + w + 1]! + 1);
      if (y < h - 1 && x > 0) best = Math.min(best, d[i + w - 1]! + 1);
      d[i] = best;
    }
  }
  return d;
}

/** 4-connected flood from the image border across pixels where `passable` is true. */
function floodFromBorder(passable: (i: number) => boolean, w: number, h: number): Uint8Array {
  const seen = new Uint8Array(w * h);
  const stack: number[] = [];
  const push = (i: number) => {
    if (!seen[i] && passable(i)) {
      seen[i] = 1;
      stack.push(i);
    }
  };
  for (let x = 0; x < w; x += 1) {
    push(x);
    push((h - 1) * w + x);
  }
  for (let y = 0; y < h; y += 1) {
    push(y * w);
    push(y * w + w - 1);
  }
  while (stack.length) {
    const p = stack.pop()!;
    const x = p % w;
    const y = (p / w) | 0;
    if (x > 0) push(p - 1);
    if (x < w - 1) push(p + 1);
    if (y > 0) push(p - w);
    if (y < h - 1) push(p + w);
  }
  return seen;
}

/**
 * THE EXTERIOR SILHOUETTE (Phase 5). Gap-closing: seal border-connectivity
 * gaps up to `2*radius` across, flood the sealed exterior from the border,
 * then grow the result back by `radius` — but ALWAYS excluding ink. No
 * radius can ever remove an ink pixel; the only thing it trades is how much
 * background-coloured halo survives around the silhouette boundary.
 */
export function computeExteriorSilhouette(
  ink: Uint8Array,
  width: number,
  height: number,
  radius: number = SILHOUETTE_RADIUS_PX,
): Uint8Array {
  const dtInk = chebyshevDistanceTransform(ink, width, height);
  const sealedExterior = floodFromBorder((i) => dtInk[i]! > radius, width, height);
  const dtSealed = chebyshevDistanceTransform(sealedExterior, width, height);
  const silhouette = new Uint8Array(width * height);
  for (let i = 0; i < silhouette.length; i += 1) {
    const isExterior = dtSealed[i]! <= radius && !ink[i];
    silhouette[i] = isExterior ? 0 : 1;
  }
  return silhouette;
}

interface LabelResult {
  label: Int32Array;
  regions: Array<{ id: number; pixelCount: number; bounds: RegionBounds }>;
}

/** Connected components of "interior" (inside the silhouette, not ink) pixels. */
function labelInteriorRegions(
  ink: Uint8Array,
  silhouette: Uint8Array,
  width: number,
  height: number,
): LabelResult {
  const interior = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i += 1) if (silhouette[i] && !ink[i]) interior[i] = 1;

  const label = new Int32Array(width * height).fill(-1);
  const regions: LabelResult["regions"] = [];
  const stack: number[] = [];
  for (let start = 0; start < width * height; start += 1) {
    if (!interior[start] || label[start] >= 0) continue;
    const id = regions.length;
    stack.length = 0;
    stack.push(start);
    label[start] = id;
    let pixelCount = 0;
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    while (stack.length) {
      const p = stack.pop()!;
      pixelCount += 1;
      const x = p % width;
      const y = (p / width) | 0;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      const neighbors = [
        x > 0 ? p - 1 : -1,
        x < width - 1 ? p + 1 : -1,
        y > 0 ? p - width : -1,
        y < height - 1 ? p + width : -1,
      ];
      for (const q of neighbors) {
        if (q >= 0 && interior[q] && label[q] < 0) {
          label[q] = id;
          stack.push(q);
        }
      }
    }
    regions.push({
      id,
      pixelCount,
      bounds: { left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1 },
    });
  }
  return { label, regions };
}

function inkBounds(ink: Uint8Array, width: number, height: number): RegionBounds {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!ink[y * width + x]) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return { left: 0, top: 0, width: 0, height: 0 };
  return { left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/** The staleness key: hashes everything a decision set must still agree with. */
function computeRegionMapHash(
  algorithmVersion: string,
  silhouetteRadius: number,
  consequential: ConsequentialRegion[],
): string {
  const sorted = [...consequential].sort((a, b) => a.regionId - b.regionId);
  const payload = JSON.stringify({
    algorithmVersion,
    silhouetteRadius,
    regions: sorted.map((r) => ({ id: r.regionId, px: r.pixelCount, bbox: r.bounds })),
  });
  return createHash("sha256").update(payload).digest("hex");
}

export interface RegionMapComputation {
  regionMap: RegionMap;
  /** Internal working state `buildSeparationMaster`/post-checks need; never persisted. */
  ink: Uint8Array;
  silhouette: Uint8Array;
  label: Int32Array;
}

/**
 * THE ENTRY POINT. Computes the exterior silhouette, labels every interior
 * region, and returns the consequential subset plus the stable identity
 * (`regionMapHash`) a `SeparationDecisionSet` is pinned against.
 */
export function computeRegionMap(
  original: RgbaImage,
  sourceAssetSha256: string,
  background: RgbColor,
  backgroundTolerance: number,
): RegionMapComputation {
  const { width, height } = original;
  const ink = computeInkMask(original, background, backgroundTolerance);
  const silhouette = computeExteriorSilhouette(ink, width, height, SILHOUETTE_RADIUS_PX);
  const { label, regions } = labelInteriorRegions(ink, silhouette, width, height);
  const bounds = inkBounds(ink, width, height);
  const artworkArea = Math.max(1, bounds.width * bounds.height);

  const consequentialRegions: ConsequentialRegion[] = regions
    .filter((r) => r.pixelCount >= MIN_CONSEQUENTIAL_REGION_PX)
    .map((r) => ({
      regionId: r.id,
      pixelCount: r.pixelCount,
      pctOfArtworkBounds: Number(((r.pixelCount / artworkArea) * 100).toFixed(4)),
      bounds: r.bounds,
    }))
    .sort((a, b) => b.pixelCount - a.pixelCount);

  const regionMap: RegionMap = {
    algorithmVersion: SEPARATION_ALGORITHM_VERSION,
    sourceAssetSha256,
    regionMapHash: computeRegionMapHash(SEPARATION_ALGORITHM_VERSION, SILHOUETTE_RADIUS_PX, consequentialRegions),
    silhouetteRadius: SILHOUETTE_RADIUS_PX,
    artworkBounds: bounds,
    consequentialRegions,
    totalRegionCount: regions.length,
  };

  return { regionMap, ink, silhouette, label };
}

/**
 * THE DETERMINISTIC MASTER CONSTRUCTION (Goal 7).
 *
 *   exterior (outside the silhouette)     -> alpha 0
 *   region decided "substrate"            -> alpha 0 across that EXACT
 *                                             precomputed region
 *   region decided "ink" or undecided     -> untouched — RGB and alpha
 *                                             copied byte-for-byte
 *
 * No RGB is ever written. No pixel's alpha is ever raised above what the
 * original had. No resampling, no redraw, no AI-authored pixel — every
 * safety property is verified by `runSeparationPostChecks`, not assumed.
 */
export function buildSeparationMaster(
  original: RgbaImage,
  computation: RegionMapComputation,
  decisions: readonly RegionDecision[],
): RgbaImage {
  const { ink, silhouette, label } = computation;
  const drop = new Set(
    decisions.filter((d) => d.intent === "substrate").map((d) => d.regionId),
  );
  const data = Buffer.from(original.data);
  const { width, height } = original;
  for (let i = 0; i < width * height; i += 1) {
    if (!silhouette[i]) {
      data[i * 4 + 3] = 0;
      continue;
    }
    const regionId = label[i]!;
    if (regionId >= 0 && drop.has(regionId)) data[i * 4 + 3] = 0;
  }
  void ink;
  return { width, height, data };
}

/**
 * THE DETERMINISTIC SAFETY NET (Goal 15). Runs regardless of how confident
 * or how human-confirmed the decisions were — Phase 6 proved a semantically
 * CORRECT substrate decision can still create a production concern (the
 * white-ring casualty: correctly removing the badge disc orphans light ink
 * that depended on it for contrast).
 */
export function runSeparationPostChecks(
  original: RgbaImage,
  master: RgbaImage,
  computation: RegionMapComputation,
  decisions: readonly RegionDecision[],
): SeparationPostCheck {
  const { width, height } = original;
  const { ink, label } = computation;
  const dropped = new Set(decisions.filter((d) => d.intent === "substrate").map((d) => d.regionId));
  const lum = new Float32Array(width * height);
  for (let i = 0; i < width * height; i += 1) {
    lum[i] = encodedLuma(original.data[i * 4]!, original.data[i * 4 + 1]!, original.data[i * 4 + 2]!);
  }

  let rgbMismatch = 0;
  let alphaRaised = 0;
  for (let i = 0; i < width * height; i += 1) {
    const a = master.data[i * 4 + 3]!;
    if (a > 0) {
      if (
        master.data[i * 4] !== original.data[i * 4] ||
        master.data[i * 4 + 1] !== original.data[i * 4 + 1] ||
        master.data[i * 4 + 2] !== original.data[i * 4 + 2]
      ) rgbMismatch += 1;
      if (a > original.data[i * 4 + 3]!) alphaRaised += 1;
    }
  }

  // Orphaned light ink: light-toned ink touching a now-transparent pixel
  // with no dark-ink neighbour of its own to carry its contrast.
  let orphaned = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      if (!ink[i] || lum[i]! < LIGHT_LUMA) continue;
      // "touches a region THIS decision set dropped" — deliberately NOT
      // "touches any transparent pixel", which would also count the
      // artwork's own pre-existing exterior boundary and over-report.
      let touchesDroppedRegion = false;
      let hasDarkInk = false;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (!dx && !dy) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const j = ny * width + nx;
          const jRegion = label[j]!;
          if (jRegion >= 0 && dropped.has(jRegion)) touchesDroppedRegion = true;
          if (ink[j] && lum[j]! <= DARK_LUMA) hasDarkInk = true;
        }
      }
      if (touchesDroppedRegion && !hasDarkInk) orphaned += 1;
    }
  }

  // `passed` is the HARD pixel-authority guarantee ONLY — rgbPreserved and
  // noAlphaRaised are true by construction of `buildSeparationMaster` and
  // this check exists to VERIFY that, not assume it. It never fires false in
  // practice; if it ever does, that is a bug in the construction, not a
  // judgement call.
  //
  // Orphaned light ink is deliberately NOT part of `passed`. Phase 6 proved
  // a semantically CORRECT decision (bowling's region 1) still orphans real
  // pixels (577 of them) — and this phase's whole premise is that an
  // OPERATOR, shown that fact, may knowingly accept it. Hard-blocking here
  // would make that acceptance impossible rather than informed. It is
  // reported so the review UI can show it before final approval (Goal 15),
  // never hidden, never silently overridden.
  const reasons: string[] = [];
  if (rgbMismatch > 0) reasons.push(`${rgbMismatch} retained pixel(s) have RGB that differs from the original`);
  if (alphaRaised > 0) reasons.push(`${alphaRaised} pixel(s) have alpha raised above the original`);
  if (orphaned > 0) reasons.push(`${orphaned} light-ink pixel(s) may lose their only visible backing on a light garment`);

  return {
    orphanedLightInkPixels: orphaned,
    rgbPreserved: rgbMismatch === 0,
    noAlphaRaised: alphaRaised === 0,
    passed: rgbMismatch === 0 && alphaRaised === 0,
    reasons,
  };
}

// ---------------------------------------------------------------------------
// Phase 14: OPERATOR REGION REVIEW VISUAL CLARITY.
//
// THE PROBLEM THIS SECTION FIXES. `overlayRegion` (the route's original
// preview) tints only the exact region-labelled pixels magenta on the FULL,
// full-resolution canvas, which the panel then displays in a small fixed box.
// A region that is a few hundred pixels on a 979x1024 canvas becomes a fleck
// too small to see once shrunk to thumbnail size — every one of 18 cards
// looked like the same mostly-black artwork with an imperceptible tint
// difference. The operator could not tell which exact area a question was
// about, which is unacceptable for a workflow whose entire purpose is
// preventing a wrong guess from destroying real artwork.
//
// THE FIX IS RENDERING ONLY. Both functions below read the SAME
// `RegionMapComputation.label` array and `ConsequentialRegion.bounds` the
// route already computes — no new region analysis, no second segmentation
// implementation, no change to region identity, hashing, or approval
// semantics. They produce PREVIEW pixels only; neither is ever written back
// to `original` or to the approved master (see `buildSeparationMaster`,
// untouched above).
// ---------------------------------------------------------------------------

/** A visible boundary is drawn with these two tones (a "halo": a light ring then a dark ring) so the region's edge reads on both light and dark backgrounds without depending on hue — Goal 9 (accessibility) is a contrast/shape requirement, not a color one. */
const HIGHLIGHT_FILL = { r: 255, g: 0, b: 255 } as const;
const OUTLINE_OUTER = { r: 255, g: 255, b: 255 } as const;
const OUTLINE_INNER = { r: 0, g: 0, b: 0 } as const;
const DIM_TOWARD = { r: 205, g: 205, b: 205 } as const;
/** Fraction of the way each suppressed pixel is blended toward `DIM_TOWARD`. Deliberately not 100%: total flattening removes the very orientation cues (nearby lettering, canvas edge) the context view exists to preserve. */
const DIM_STRENGTH = 0.82;
/** Fraction of the way each target-region pixel is blended toward `HIGHLIGHT_FILL`. Deliberately not 100%: an operator inspecting light vs. dark ink inside the candidate region needs some of its own luminance to survive the highlight. */
const HIGHLIGHT_STRENGTH = 0.55;

function blendChannel(original: number, toward: number, amount: number): number {
  return Math.round(original + (toward - original) * amount);
}

/**
 * Whether pixel `i` sits on the region's boundary — inside the region but
 * with at least one 4-neighbor that is not part of it (including the image
 * edge). Used to draw the halo outline; never used to decide region
 * membership, which `label` alone already settled.
 */
function isBoundaryPixel(label: Int32Array, width: number, height: number, i: number, regionId: number): boolean {
  const x = i % width;
  const y = Math.floor(i / width);
  const neighbors: Array<[number, number]> = [
    [x - 1, y],
    [x + 1, y],
    [x, y - 1],
    [x, y + 1],
  ];
  for (const [nx, ny] of neighbors) {
    if (nx < 0 || ny < 0 || nx >= width || ny >= height) return true;
    if (label[ny * width + nx] !== regionId) return true;
  }
  return false;
}

/**
 * THE CONTEXT VIEW (Goal: TARGET UX §1). Full canvas, one candidate region
 * unmistakably isolated: every other pixel — background, other regions,
 * unrelated ink — is suppressed toward neutral gray; the candidate region is
 * highlighted and outlined with a two-tone halo that reads regardless of the
 * artwork's own colors underneath it.
 *
 * Geometry comes ENTIRELY from `label`, the exact per-pixel output of
 * `computeRegionMap` — the same array `buildSeparationMaster` itself reads.
 * Two calls with the same `label` and `regionId` are pixel-identical.
 */
export function renderRegionContextHighlight(
  original: RgbaImage,
  label: Int32Array,
  regionId: number,
): RgbaImage {
  const { width, height } = original;
  const data = Buffer.from(original.data);
  for (let i = 0; i < width * height; i += 1) {
    const o = i * 4;
    if (label[i] === regionId) {
      if (isBoundaryPixel(label, width, height, i, regionId)) {
        data[o] = OUTLINE_INNER.r;
        data[o + 1] = OUTLINE_INNER.g;
        data[o + 2] = OUTLINE_INNER.b;
      } else {
        data[o] = blendChannel(data[o], HIGHLIGHT_FILL.r, HIGHLIGHT_STRENGTH);
        data[o + 1] = blendChannel(data[o + 1], HIGHLIGHT_FILL.g, HIGHLIGHT_STRENGTH);
        data[o + 2] = blendChannel(data[o + 2], HIGHLIGHT_FILL.b, HIGHLIGHT_STRENGTH);
      }
    } else {
      // The dim side of the same boundary gets the outer halo tone, so the
      // ring is visible whether the eye lands just inside or just outside
      // the region's true edge.
      const adjacentToTarget =
        (label[i - 1] === regionId && i % width !== 0) ||
        (label[i + 1] === regionId && (i + 1) % width !== 0) ||
        label[i - width] === regionId ||
        label[i + width] === regionId;
      if (adjacentToTarget) {
        data[o] = OUTLINE_OUTER.r;
        data[o + 1] = OUTLINE_OUTER.g;
        data[o + 2] = OUTLINE_OUTER.b;
      } else {
        data[o] = blendChannel(data[o], DIM_TOWARD.r, DIM_STRENGTH);
        data[o + 1] = blendChannel(data[o + 1], DIM_TOWARD.g, DIM_STRENGTH);
        data[o + 2] = blendChannel(data[o + 2], DIM_TOWARD.b, DIM_STRENGTH);
      }
    }
    data[o + 3] = 255;
  }
  return { width, height, data };
}

/** Minimum crop edge length, in source pixels, so a tiny region is still zoomed in to something inspectable rather than reproduced at its own (postage-stamp) size. */
export const REGION_CROP_MIN_SIZE_PX = 220;
/** Padding added around the region's own bounds, as a fraction of that bound's own width/height, before the minimum-size floor is applied. */
export const REGION_CROP_PADDING_RATIO = 0.6;
/** Always-present minimum margin, in source pixels, even for a region whose padded box already exceeds `REGION_CROP_MIN_SIZE_PX` — keeps at least a sliver of surrounding artwork for orientation (TARGET UX §2: "enough neighbouring artwork for orientation"). */
const REGION_CROP_MIN_MARGIN_PX = 20;

/**
 * THE DETAIL VIEW's geometry (Goal: TARGET UX §2). Pure arithmetic over the
 * region's own deterministic `bounds` — no pixel inspection, so it is cheap
 * to unit test in isolation from image decoding entirely. Clamps to the
 * image's own dimensions unconditionally: a region flush against an edge
 * still produces a valid, in-bounds rectangle.
 */
export function computeRegionCropRect(
  bounds: RegionBounds,
  imageWidth: number,
  imageHeight: number,
): RegionBounds {
  const padX = Math.max(
    bounds.width * REGION_CROP_PADDING_RATIO,
    (REGION_CROP_MIN_SIZE_PX - bounds.width) / 2,
    REGION_CROP_MIN_MARGIN_PX,
  );
  const padY = Math.max(
    bounds.height * REGION_CROP_PADDING_RATIO,
    (REGION_CROP_MIN_SIZE_PX - bounds.height) / 2,
    REGION_CROP_MIN_MARGIN_PX,
  );
  const left = Math.max(0, Math.round(bounds.left - padX));
  const top = Math.max(0, Math.round(bounds.top - padY));
  const right = Math.min(imageWidth, Math.round(bounds.left + bounds.width + padX));
  const bottom = Math.min(imageHeight, Math.round(bounds.top + bounds.height + padY));
  return {
    left,
    top,
    width: Math.max(1, right - left),
    height: Math.max(1, bottom - top),
  };
}

/** Copies a rectangular sub-region out of an `RgbaImage`. Pure pixel-copy — never called on anything but an already-rendered PREVIEW image in this file. */
export function cropRgbaImage(image: RgbaImage, rect: RegionBounds): RgbaImage {
  const data = Buffer.alloc(rect.width * rect.height * 4);
  for (let row = 0; row < rect.height; row += 1) {
    const srcStart = ((rect.top + row) * image.width + rect.left) * 4;
    const destStart = row * rect.width * 4;
    image.data.copy(data, destStart, srcStart, srcStart + rect.width * 4);
  }
  return { width: rect.width, height: rect.height, data };
}

/**
 * THE DETAIL VIEW (Goal: TARGET UX §2), composed from the two primitives
 * above: the same highlight/outline/dim treatment as the context view,
 * cropped to a padded, size-floored, edge-clamped box around the exact
 * region. Two calls with the same `label`/`bounds`/`regionId` are
 * pixel-identical, exactly like the context view.
 */
export function renderRegionDetailCrop(
  original: RgbaImage,
  label: Int32Array,
  regionId: number,
  bounds: RegionBounds,
): RgbaImage {
  const highlighted = renderRegionContextHighlight(original, label, regionId);
  const rect = computeRegionCropRect(bounds, original.width, original.height);
  return cropRgbaImage(highlighted, rect);
}
