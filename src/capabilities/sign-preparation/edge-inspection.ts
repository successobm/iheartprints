/**
 * Signs Phase S1: deterministic per-edge inspection.
 *
 * Each of the four source edges is classified INDEPENDENTLY from a measured
 * BAND (never a single pixel line), because the question each edge answers
 * is independent: "may a canvas extension along THIS edge be automatic?"
 *
 * > THE SAFETY RULE (the §13h background-isolation invariant, transposed):
 * > an edge may be called `uniform_background` only on AFFIRMATIVE evidence
 * > — a single dominant colour covering essentially the whole band at low
 * > variance, out to the outermost line. Anything the algorithm cannot
 * > prove classifies conservatively. Unknown never becomes safe.
 *
 * No LLM, no multimodal provider, no network — pure pixel arithmetic, so
 * every classification is replayable from the immutable original alone.
 */

import type { RgbaImage } from "@/capabilities/final-artwork/raster-transform";

import type { SignEdge, SignEdgeEvidence } from "./contracts";

/**
 * Chebyshev RGB membership tolerance — the audited §13h baseline for a
 * genuinely flat export (`pixel-metrics.ts` uses the same figure).
 */
export const EDGE_BACKGROUND_TOLERANCE = 12;

/** A band is uniform only when membership covers essentially all of it. */
export const UNIFORM_MIN_COVERAGE = 0.985;

/**
 * Ceiling on per-channel standard deviation for a uniform verdict — the
 * `MAX_SAFE_EDGE_STANDARD_DEVIATION` precedent from `image-analysis.ts`.
 */
export const UNIFORM_MAX_STDDEV = 24;

/**
 * Below this dominant coverage no background model is trusted at all and
 * the edge is `mixed_or_uncertain`.
 */
export const DOMINANT_MIN_COVERAGE = 0.6;

/** Band pixels with alpha below this are counted toward `transparentFraction`. */
const OPAQUE_ALPHA = 255;

/**
 * Transparency in an edge band beyond this fraction forfeits any uniform
 * verdict — a see-through band is not a provable flat background.
 */
const MAX_UNIFORM_TRANSPARENT_FRACTION = 0.001;

const BUCKET_SHIFT = 4; // 16-value colour buckets, the image-analysis precedent.

export function edgeBandDepthPx(width: number, height: number): number {
  const proportional = Math.round(0.02 * Math.min(width, height));
  return Math.max(4, Math.min(32, proportional));
}

function contentRunThresholdPx(edgeLengthPx: number): number {
  return Math.max(8, Math.round(0.01 * edgeLengthPx));
}

interface BandGeometry {
  x0: number;
  y0: number;
  x1: number; // exclusive
  y1: number; // exclusive
  /** The outermost single pixel line of the band, as start + step. */
  outermost: { x0: number; y0: number; dx: number; dy: number; length: number };
}

function bandGeometry(edge: SignEdge, width: number, height: number, depth: number): BandGeometry {
  switch (edge) {
    case "top":
      return {
        x0: 0, y0: 0, x1: width, y1: depth,
        outermost: { x0: 0, y0: 0, dx: 1, dy: 0, length: width },
      };
    case "bottom":
      return {
        x0: 0, y0: height - depth, x1: width, y1: height,
        outermost: { x0: 0, y0: height - 1, dx: 1, dy: 0, length: width },
      };
    case "left":
      return {
        x0: 0, y0: 0, x1: depth, y1: height,
        outermost: { x0: 0, y0: 0, dx: 0, dy: 1, length: height },
      };
    case "right":
      return {
        x0: width - depth, y0: 0, x1: width, y1: height,
        outermost: { x0: width - 1, y0: 0, dx: 0, dy: 1, length: height },
      };
  }
}

function chebyshev(r1: number, g1: number, b1: number, r2: number, g2: number, b2: number): number {
  return Math.max(Math.abs(r1 - r2), Math.abs(g1 - g2), Math.abs(b1 - b2));
}

/** Classifies one edge band of `image`. Pure; reads pixels, changes nothing. */
export function inspectSignEdge(image: RgbaImage, edge: SignEdge): SignEdgeEvidence {
  const depth = edgeBandDepthPx(image.width, image.height);
  const geo = bandGeometry(edge, image.width, image.height, depth);
  const edgeLengthPx = geo.outermost.length;
  const data = image.data;

  // Pass 1: dominant colour bucket + channel statistics + transparency.
  const bucketCount = new Map<number, number>();
  const bucketSum = new Map<number, [number, number, number]>();
  let n = 0;
  let sumR = 0, sumG = 0, sumB = 0;
  let sumR2 = 0, sumG2 = 0, sumB2 = 0;
  let transparent = 0;

  for (let y = geo.y0; y < geo.y1; y++) {
    for (let x = geo.x0; x < geo.x1; x++) {
      const i = (y * image.width + x) * 4;
      const r = data[i]!, g = data[i + 1]!, b = data[i + 2]!, a = data[i + 3]!;
      n++;
      if (a < OPAQUE_ALPHA) transparent++;
      sumR += r; sumG += g; sumB += b;
      sumR2 += r * r; sumG2 += g * g; sumB2 += b * b;
      const key = ((r >> BUCKET_SHIFT) << 8) | ((g >> BUCKET_SHIFT) << 4) | (b >> BUCKET_SHIFT);
      bucketCount.set(key, (bucketCount.get(key) ?? 0) + 1);
      const sums = bucketSum.get(key);
      if (sums) { sums[0] += r; sums[1] += g; sums[2] += b; }
      else bucketSum.set(key, [r, g, b]);
    }
  }

  const transparentFraction = n === 0 ? 0 : transparent / n;
  const stddev = (sum: number, sum2: number) => {
    const mean = sum / n;
    return Math.sqrt(Math.max(0, sum2 / n - mean * mean));
  };
  const maxChannelStdDev = n === 0 ? 0 : Math.max(
    stddev(sumR, sumR2), stddev(sumG, sumG2), stddev(sumB, sumB2),
  );

  let dominantKey: number | null = null;
  let dominantN = 0;
  for (const [key, count] of bucketCount) {
    if (count > dominantN) { dominantN = count; dominantKey = key; }
  }
  const dominantSums = dominantKey === null ? null : bucketSum.get(dominantKey)!;
  const dominantColor = dominantSums === null || dominantN === 0
    ? null
    : {
        r: Math.round(dominantSums[0] / dominantN),
        g: Math.round(dominantSums[1] / dominantN),
        b: Math.round(dominantSums[2] / dominantN),
      };

  // Pass 2: membership coverage against the dominant mean, band + outermost
  // line, and the longest contiguous non-background run on the outermost line.
  let members = 0;
  let outerMembers = 0;
  let longestRun = 0;
  let currentRun = 0;

  if (dominantColor) {
    for (let y = geo.y0; y < geo.y1; y++) {
      for (let x = geo.x0; x < geo.x1; x++) {
        const i = (y * image.width + x) * 4;
        if (
          chebyshev(
            data[i]!, data[i + 1]!, data[i + 2]!,
            dominantColor.r, dominantColor.g, dominantColor.b,
          ) <= EDGE_BACKGROUND_TOLERANCE
        ) {
          members++;
        }
      }
    }
    for (let k = 0; k < geo.outermost.length; k++) {
      const x = geo.outermost.x0 + k * geo.outermost.dx;
      const y = geo.outermost.y0 + k * geo.outermost.dy;
      const i = (y * image.width + x) * 4;
      const isMember =
        chebyshev(
          data[i]!, data[i + 1]!, data[i + 2]!,
          dominantColor.r, dominantColor.g, dominantColor.b,
        ) <= EDGE_BACKGROUND_TOLERANCE && data[i + 3]! === OPAQUE_ALPHA;
      if (isMember) {
        outerMembers++;
        currentRun = 0;
      } else {
        currentRun++;
        if (currentRun > longestRun) longestRun = currentRun;
      }
    }
  }

  const dominantCoverage = n === 0 || !dominantColor ? 0 : members / n;
  const outermostCoverage =
    edgeLengthPx === 0 || !dominantColor ? 0 : outerMembers / edgeLengthPx;
  const runThreshold = contentRunThresholdPx(edgeLengthPx);

  let classification: SignEdgeEvidence["classification"];
  let reason: string;

  if (
    dominantColor &&
    dominantCoverage >= UNIFORM_MIN_COVERAGE &&
    outermostCoverage >= UNIFORM_MIN_COVERAGE &&
    maxChannelStdDev <= UNIFORM_MAX_STDDEV &&
    transparentFraction <= MAX_UNIFORM_TRANSPARENT_FRACTION
  ) {
    classification = "uniform_background";
    reason =
      `band coverage ${dominantCoverage.toFixed(4)} and outermost coverage ` +
      `${outermostCoverage.toFixed(4)} at tolerance ${EDGE_BACKGROUND_TOLERANCE}, ` +
      `max channel stddev ${maxChannelStdDev.toFixed(1)} — affirmatively one flat background`;
  } else if (
    dominantColor &&
    dominantCoverage >= DOMINANT_MIN_COVERAGE &&
    longestRun >= runThreshold
  ) {
    classification = "foreground_bleed";
    reason =
      `a dominant background exists (coverage ${dominantCoverage.toFixed(4)}) but content ` +
      `evidence reaches the edge (longest non-background run ${longestRun}px against a ` +
      `${runThreshold}px threshold; outermost coverage ${outermostCoverage.toFixed(4)}) — ` +
      `an extension here terminates visibly`;
  } else {
    classification = "mixed_or_uncertain";
    reason =
      `no provable background model (dominant coverage ${dominantCoverage.toFixed(4)}, ` +
      `max channel stddev ${maxChannelStdDev.toFixed(1)}, transparent fraction ` +
      `${transparentFraction.toFixed(4)}) — unknown never becomes safe`;
  }

  return {
    edge,
    classification,
    bandDepthPx: depth,
    edgeLengthPx,
    dominantColor,
    dominantCoverage,
    outermostCoverage,
    maxChannelStdDev,
    tolerance: EDGE_BACKGROUND_TOLERANCE,
    longestNonBackgroundRunPx: longestRun,
    transparentFraction,
    reason,
  };
}

export function inspectAllSignEdges(image: RgbaImage): SignEdgeEvidence[] {
  return (["top", "right", "bottom", "left"] as const).map((edge) =>
    inspectSignEdge(image, edge),
  );
}
