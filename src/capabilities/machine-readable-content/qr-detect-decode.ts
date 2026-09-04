/**
 * Detection + decode primitives for QR-shaped regions in a decoded RGBA
 * image. Two separate, deliberately different-strength tools:
 *
 *   `decodeQrCodes`             — full decode (locates AND reads). Backed
 *                                  by `jsqr`, a small, well-established,
 *                                  pure-JS decoder (no native bindings, no
 *                                  network, deterministic given the same
 *                                  pixels). This is the ONLY source of
 *                                  truth for a payload anywhere in this
 *                                  codebase — see `contracts.ts`'s
 *                                  fail-closed doc.
 *
 *   `scanForQrFinderPatterns`   — detection ONLY, no decode. A bounded,
 *                                  deterministic implementation of the QR
 *                                  finder-pattern signature every real QR
 *                                  decoder (jsQR included) uses internally:
 *                                  a 1:1:3:1:1 dark:light:dark:light:dark
 *                                  run-length ratio along a scanline
 *                                  (ISO/IEC 18004). It exists ONLY to
 *                                  distinguish "something QR-shaped is
 *                                  here but we can't read it" (preservation
 *                                  CASE 2) from "there is genuinely no QR
 *                                  here at all" (CASE 5) — `decodeQrCodes`
 *                                  alone cannot tell those apart, because a
 *                                  failed decode returns nothing describing
 *                                  WHY. It is deliberately NOT a general
 *                                  barcode/shape detector and makes no
 *                                  attempt at full symbol location,
 *                                  version, or orientation.
 */

import jsQR from "jsqr";

import type {
  DecodedMachineReadableRegion,
  MachineReadableRegionBounds,
  QrLocalizationConfidence,
  UndecodedMachineReadableRegion,
} from "./contracts";

export interface RgbaImage {
  width: number;
  height: number;
  /** RGBA, 4 bytes per pixel, row-major. */
  data: Buffer;
}

function luminanceBuffer(image: RgbaImage): Uint8ClampedArray {
  const out = new Uint8ClampedArray(image.width * image.height);
  for (let i = 0; i < out.length; i++) {
    const r = image.data[i * 4];
    const g = image.data[i * 4 + 1];
    const b = image.data[i * 4 + 2];
    out[i] = (r * 306 + g * 601 + b * 117) >> 10;
  }
  return out;
}

/**
 * Decodes every QR code jsQR can find in `image`, up to `maxInstances`
 * (Section J: 0..N regions). jsQR itself only ever reports ONE match per
 * whole-image call — AND, empirically, a single call can fail to find
 * EITHER code at all when two genuinely separate, valid QR codes are both
 * present (jsQR's internal finder-pattern grouping gets confused between
 * the two real triples rather than falling back to trying one). Two
 * complementary, still-bounded strategies handle this:
 *
 *   1. Try the whole image first (covers the overwhelmingly common case
 *      of 0 or 1 QR present, and is also jsQR's fastest path).
 *   2. If that fails, retry against four overlapping quadrant crops (each
 *      strictly more than half the image on each axis, so a QR sitting
 *      near the center is still fully contained in at least one quadrant)
 *      — a genuinely separate, well-spaced second QR is then decoded from
 *      a crop that no longer contains the first one's finder patterns to
 *      confuse jsQR's grouping.
 *
 * After a hit (from either strategy), the found region is blanked (white)
 * in a private working copy and the whole process repeats, bounded by
 * `maxInstances` so a pathological image can never spin unboundedly. This
 * remains intentionally simple — a from-scratch multi-symbol decoder is
 * out of scope (Section J: "do not overbuild generalized barcode
 * infrastructure"); the quadrant fallback exists only to cover the common
 * "a couple of well-separated codes" case, not dense/overlapping symbols.
 */
export function decodeQrCodes(
  image: RgbaImage,
  maxInstances = 4,
): DecodedMachineReadableRegion[] {
  const working = Buffer.from(image.data);
  const results: DecodedMachineReadableRegion[] = [];

  for (let attempt = 0; attempt < maxInstances; attempt++) {
    const found = decodeOnce(working, image.width, image.height);
    if (!found) break;

    results.push({ kind: "qr", payload: found.payload, bounds: found.bounds });

    // Blank the found region (flood white) so the next pass cannot re-find
    // the same code — the ONLY purpose of this mutation is to advance the
    // scan; `working` is a private copy, never the caller's own buffer.
    const { xPx, yPx, widthPx, heightPx } = found.bounds;
    for (let y = yPx; y < yPx + heightPx; y++) {
      for (let x = xPx; x < xPx + widthPx; x++) {
        const i = (y * image.width + x) * 4;
        working[i] = 255;
        working[i + 1] = 255;
        working[i + 2] = 255;
        working[i + 3] = 255;
      }
    }
  }

  return results;
}

function decodeOnce(
  working: Buffer,
  width: number,
  height: number,
): { payload: string; bounds: MachineReadableRegionBounds } | null {
  const whole = jsQrDecode(working, width, height, 0, 0, width, height);
  if (whole) return whole;

  // Overlapping quadrants: each spans 60% of its axis (not a strict 50/50
  // split) so a code straddling the true center is still wholly inside at
  // least one quadrant.
  const qw = Math.ceil(width * 0.6);
  const qh = Math.ceil(height * 0.6);
  const quadrants: [number, number][] = [
    [0, 0],
    [width - qw, 0],
    [0, height - qh],
    [width - qw, height - qh],
  ];
  for (const [ox, oy] of quadrants) {
    const hit = jsQrDecode(working, width, height, ox, oy, qw, qh);
    if (hit) return hit;
  }
  return null;
}

function jsQrDecode(
  source: Buffer,
  sourceWidth: number,
  sourceHeight: number,
  offsetX: number,
  offsetY: number,
  regionWidth: number,
  regionHeight: number,
): { payload: string; bounds: MachineReadableRegionBounds } | null {
  let clamped: Uint8ClampedArray;
  if (offsetX === 0 && offsetY === 0 && regionWidth === sourceWidth && regionHeight === sourceHeight) {
    clamped = new Uint8ClampedArray(source.buffer, source.byteOffset, source.length);
  } else {
    const crop = Buffer.alloc(regionWidth * regionHeight * 4);
    for (let y = 0; y < regionHeight; y++) {
      const srcRowStart = ((offsetY + y) * sourceWidth + offsetX) * 4;
      const destRowStart = y * regionWidth * 4;
      source.copy(crop, destRowStart, srcRowStart, srcRowStart + regionWidth * 4);
    }
    clamped = new Uint8ClampedArray(crop.buffer, crop.byteOffset, crop.length);
  }

  const found = jsQR(clamped, regionWidth, regionHeight);
  if (!found) return null;

  const xs = [
    found.location.topLeftCorner.x,
    found.location.topRightCorner.x,
    found.location.bottomLeftCorner.x,
    found.location.bottomRightCorner.x,
  ];
  const ys = [
    found.location.topLeftCorner.y,
    found.location.topRightCorner.y,
    found.location.bottomLeftCorner.y,
    found.location.bottomRightCorner.y,
  ];
  const minX = Math.max(0, Math.floor(Math.min(...xs))) + offsetX;
  const maxX = Math.min(regionWidth, Math.ceil(Math.max(...xs))) + offsetX;
  const minY = Math.max(0, Math.floor(Math.min(...ys))) + offsetY;
  const maxY = Math.min(regionHeight, Math.ceil(Math.max(...ys))) + offsetY;

  return {
    payload: found.data,
    bounds: {
      xPx: Math.min(minX, sourceWidth),
      yPx: Math.min(minY, sourceHeight),
      widthPx: Math.max(0, Math.min(maxX, sourceWidth) - minX),
      heightPx: Math.max(0, Math.min(maxY, sourceHeight) - minY),
    },
  };
}

interface FinderPatternHit {
  centerX: number;
  centerY: number;
  moduleWidthPx: number;
}

/** Approximate 1:1:3:1:1 ratio tolerance — generous enough to survive mild blur/compression, tight enough not to fire on arbitrary striped content. */
const RATIO_TOLERANCE = 0.25;

/**
 * A single scanline hit — even a confirmed (row+column cross-checked) one
 * — is cheap for ordinary illustrated artwork (busy line art, lettering,
 * fabric texture) to produce by coincidence. A REAL finder pattern is 7
 * modules tall/wide and gets independently confirmed at MANY adjacent scan
 * rows, so requiring a cluster to accumulate at least this many hits
 * before counting as a candidate is what separates "an actual square
 * finder pattern is here" from "one scanline happened to line up".
 * Tuned empirically against a real false-positive case (illustrated
 * chef/flame artwork with no QR at all, which produced isolated
 * coincidental hits below this bound) alongside a real true-positive case
 * (an actual, if visually degraded, QR, whose finder patterns cleared it
 * comfortably).
 */
const MIN_CLUSTER_HITS = 4;

/**
 * A real QR has exactly 3 finder patterns. Requiring at least 2 confirmed
 * clusters (never just 1) is the single strongest false-positive guard
 * available short of full geometric reconstruction — one coincidental
 * square-ish region in ordinary artwork is unremarkable; two independent
 * ones in a consistent relative arrangement essentially never occur by
 * chance.
 *
 * This is the DETECTION floor only — "enough evidence to say something
 * QR-shaped is here, so Print Ready must stay blocked until a human
 * resolves it." It is deliberately NOT enough evidence to trust for
 * automatic pixel REPLACEMENT — see `QR_HIGH_CONFIDENCE_MIN_CLUSTERS` and
 * `QrLocalizationConfidence`'s own doc in `contracts.ts` for why 2 of 3
 * corners cannot safely determine a placement region.
 */
const MIN_CLUSTERS = 2;

/**
 * QR REPAIR V2: the localization-confidence floor. With all 3 real finder
 * patterns independently confirmed, the bounding box spans genuine
 * evidence on every side and is trustworthy for automatic replacement
 * (subject to the additional square-aspect check below). With only 2, one
 * axis of the box is unconstrained by real evidence — see
 * `QrLocalizationConfidence`'s own doc.
 */
const QR_HIGH_CONFIDENCE_MIN_CLUSTERS = 3;

/**
 * A genuine QR symbol is always exactly square. Even with 3 confirmed
 * clusters, noisy centroids could in principle still yield a skewed box;
 * this is a cheap, independent sanity check on the box's own shape,
 * applied regardless of cluster count. Generous enough to tolerate the
 * centroid/margin estimate's own imprecision, but a 2:1 box (the real
 * Get Hibachi failure) fails it by a wide margin.
 */
const SQUARE_ASPECT_TOLERANCE = 0.35;

function isApproximatelySquare(bounds: MachineReadableRegionBounds): boolean {
  if (bounds.widthPx <= 0 || bounds.heightPx <= 0) return false;
  const ratio = Math.max(bounds.widthPx, bounds.heightPx) / Math.min(bounds.widthPx, bounds.heightPx);
  return ratio <= 1 + SQUARE_ASPECT_TOLERANCE;
}

/**
 * Scans one binarized scanline (a row or a column, caller's choice — this
 * function is orientation-agnostic and just receives a 1D array of
 * booleans, `true` = dark) for the QR finder-pattern run-length signature:
 * five consecutive runs whose relative widths approximate 1:1:3:1:1
 * (dark:light:dark:light:dark). Returns the center index of the middle
 * (3-wide) dark run for every qualifying position, plus the estimated
 * module width (the average of the five run widths, divided by their
 * respective unit counts).
 */
function scanLineForFinderSignature(
  line: readonly boolean[],
): { center: number; moduleWidthPx: number }[] {
  const hits: { center: number; moduleWidthPx: number }[] = [];
  // Run-length encode the line.
  const runs: { value: boolean; start: number; length: number }[] = [];
  let runStart = 0;
  for (let i = 1; i <= line.length; i++) {
    if (i === line.length || line[i] !== line[i - 1]) {
      runs.push({ value: line[i - 1], start: runStart, length: i - runStart });
      runStart = i;
    }
  }

  for (let i = 0; i + 4 < runs.length; i++) {
    const [a, b, c, d, e] = runs.slice(i, i + 5);
    if (!(a.value && !b.value && c.value && !d.value && e.value)) continue;
    const unit = (a.length + b.length + c.length / 3 + d.length + e.length) / 5;
    if (unit <= 0) continue;
    const withinRatio = (run: number, expectedUnits: number) => {
      const expected = unit * expectedUnits;
      return Math.abs(run - expected) <= expected * RATIO_TOLERANCE + 1;
    };
    if (
      withinRatio(a.length, 1) &&
      withinRatio(b.length, 1) &&
      withinRatio(c.length, 3) &&
      withinRatio(d.length, 1) &&
      withinRatio(e.length, 1)
    ) {
      hits.push({ center: c.start + c.length / 2, moduleWidthPx: unit });
    }
  }
  return hits;
}

/**
 * Detection-only pass over the whole image: finds points that satisfy the
 * finder-pattern signature along BOTH a horizontal AND a vertical scanline
 * through the same location (the standard two-pass cross-check every real
 * QR locator uses to reject stray 1D-only matches), clusters nearby hits
 * into distinct finder-pattern candidates, and returns a bounding box
 * enclosing however many were found — 0 candidates means "no QR-shaped
 * structure detected at all" (CASE 5 evidence); 2 (a real QR has exactly
 * 3, but occlusion/blur can easily cost one) means "something is here"
 * (CASE 2 evidence when decoding failed).
 *
 * QR REPAIR V2: the returned bounds are ALWAYS enough for detection (CASE
 * 2 vs CASE 5), but are only sometimes enough to trust for automatic
 * pixel REPLACEMENT — see the returned `localizationConfidence` and
 * `QrLocalizationConfidence`'s own doc in `contracts.ts`. With only 2 of
 * the 3 true corners confirmed, the box is a genuine UNDER-estimate on
 * whichever axis the missing corner would have constrained (this is
 * exactly the real defect a genuine repair attempt exposed — a 2:1 box
 * from a real, roughly-square QR) — `qr-restore.ts`'s replacement safety
 * gate refuses to composite from a `"low"`-confidence region for exactly
 * this reason, regardless of any confirmed destination recorded against
 * it.
 *
 * Deliberately samples on a coarse row/column stride for bounded runtime
 * on a large candidate image (thousands of pixels per axis) — the
 * signature this looks for is symbol-scale (tens of pixels wide at
 * minimum), so a stride finer than the smallest plausible module width
 * would only waste time, never find something a finer stride would miss.
 */
export function scanForQrFinderPatterns(
  image: RgbaImage,
  options?: { stride?: number; binarizeThreshold?: number },
): UndecodedMachineReadableRegion[] {
  const stride = options?.stride ?? Math.max(1, Math.floor(Math.min(image.width, image.height) / 400));
  const threshold = options?.binarizeThreshold ?? 128;
  const lum = luminanceBuffer(image);
  const isDark = (x: number, y: number) => lum[y * image.width + x] < threshold;

  const rowHits: { x: number; y: number; moduleWidthPx: number }[] = [];
  for (let y = 0; y < image.height; y += stride) {
    const line: boolean[] = new Array(image.width);
    for (let x = 0; x < image.width; x++) line[x] = isDark(x, y);
    for (const hit of scanLineForFinderSignature(line)) {
      rowHits.push({ x: hit.center, y, moduleWidthPx: hit.moduleWidthPx });
    }
  }

  const confirmed: FinderPatternHit[] = [];
  for (const hit of rowHits) {
    const cx = Math.round(hit.x);
    if (cx < 0 || cx >= image.width) continue;
    const line: boolean[] = new Array(image.height);
    for (let y = 0; y < image.height; y++) line[y] = isDark(cx, y);
    const colHits = scanLineForFinderSignature(line);
    const nearby = colHits.find((c) => Math.abs(c.center - hit.y) <= hit.moduleWidthPx * 2);
    if (nearby) {
      confirmed.push({ centerX: hit.x, centerY: nearby.center, moduleWidthPx: hit.moduleWidthPx });
    }
  }

  if (confirmed.length === 0) return [];

  // Cluster nearby confirmed hits (the same real finder pattern is very
  // likely to be confirmed at several adjacent scan rows) into distinct
  // candidates by simple greedy proximity grouping.
  const clusters: FinderPatternHit[][] = [];
  for (const hit of confirmed) {
    const cluster = clusters.find((group) =>
      group.some(
        (member) =>
          Math.abs(member.centerX - hit.centerX) <= hit.moduleWidthPx * 4 &&
          Math.abs(member.centerY - hit.centerY) <= hit.moduleWidthPx * 4,
      ),
    );
    if (cluster) cluster.push(hit);
    else clusters.push([hit]);
  }

  // False-positive guard — see MIN_CLUSTER_HITS/MIN_CLUSTERS's own doc.
  const strongClusters = clusters.filter((group) => group.length >= MIN_CLUSTER_HITS);
  if (strongClusters.length < MIN_CLUSTERS) return [];

  const centroids = strongClusters.map((group) => ({
    x: group.reduce((sum, h) => sum + h.centerX, 0) / group.length,
    y: group.reduce((sum, h) => sum + h.centerY, 0) / group.length,
    moduleWidthPx: group.reduce((sum, h) => sum + h.moduleWidthPx, 0) / group.length,
  }));

  // A QR's overall symbol extent runs from the outer edge of one corner
  // finder pattern to the outer edge of the opposite one, roughly 7
  // modules beyond each detected center. With fewer than 3 centroids the
  // true opposite corner is unknown, so the box is only ever an ESTIMATE —
  // always sufficient evidence for "something is here" (CASE 2), but only
  // trustworthy for automatic pixel placement when `localizationConfidence`
  // is `"high"` (3 centroids AND an approximately square result) — see
  // that field's own doc and `qr-restore.ts`'s replacement safety gate,
  // which is the one place a `"low"`-confidence region is refused for
  // replacement regardless of any confirmed destination recorded against
  // it.
  const margin =
    (centroids.reduce((sum, c) => sum + c.moduleWidthPx, 0) / centroids.length) * 8;
  const minX = Math.max(0, Math.min(...centroids.map((c) => c.x)) - margin);
  const maxX = Math.min(image.width, Math.max(...centroids.map((c) => c.x)) + margin);
  const minY = Math.max(0, Math.min(...centroids.map((c) => c.y)) - margin);
  const maxY = Math.min(image.height, Math.max(...centroids.map((c) => c.y)) + margin);

  const bounds: MachineReadableRegionBounds = {
    xPx: Math.round(minX),
    yPx: Math.round(minY),
    widthPx: Math.round(maxX - minX),
    heightPx: Math.round(maxY - minY),
  };
  const localizationConfidence: QrLocalizationConfidence =
    strongClusters.length >= QR_HIGH_CONFIDENCE_MIN_CLUSTERS && isApproximatelySquare(bounds) ? "high" : "low";
  return [{ kind: "qr", bounds, localizationConfidence }];
}

/**
 * QR REPAIR V2: `scanForQrFinderPatterns`, restricted to a padded search
 * window and reported back in the ORIGINAL (uncropped) image's coordinate
 * space. Used by the replacement safety gate (`qr-restore.ts`) to
 * independently corroborate a source-mapped candidate region against the
 * CANDIDATE's own pixels — restricted to a window (never the whole
 * canvas) specifically so a large candidate with a SECOND, unrelated
 * QR-like region elsewhere can never be accidentally picked up as
 * "confirming" a completely different region (Section I: multiple QR
 * codes must remain independently localized, never unioned).
 */
export function scanForQrFinderPatternsInWindow(
  image: RgbaImage,
  window: MachineReadableRegionBounds,
  options?: { stride?: number; binarizeThreshold?: number },
): UndecodedMachineReadableRegion[] {
  const x0 = Math.max(0, Math.floor(window.xPx));
  const y0 = Math.max(0, Math.floor(window.yPx));
  const x1 = Math.min(image.width, Math.ceil(window.xPx + window.widthPx));
  const y1 = Math.min(image.height, Math.ceil(window.yPx + window.heightPx));
  const w = x1 - x0;
  const h = y1 - y0;
  if (w <= 0 || h <= 0) return [];

  const cropped = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    const srcStart = ((y0 + y) * image.width + x0) * 4;
    const destStart = y * w * 4;
    image.data.copy(cropped, destStart, srcStart, srcStart + w * 4);
  }

  const found = scanForQrFinderPatterns({ width: w, height: h, data: cropped }, options);
  return found.map((region) => ({
    kind: region.kind,
    bounds: {
      xPx: region.bounds.xPx + x0,
      yPx: region.bounds.yPx + y0,
      widthPx: region.bounds.widthPx,
      heightPx: region.bounds.heightPx,
    },
    localizationConfidence: region.localizationConfidence,
  }));
}
