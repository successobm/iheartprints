/**
 * Print'em All Phase 2 — THE HALFTONE ENGINE.
 *
 * A deterministic, local, amplitude-modulated halftone screen for apparel DTF
 * production. Pure RGBA pixel math — no PNG codec, no I/O, no provider, no
 * network, no paid call — for the same reason `raster-transform.ts` and
 * `alpha-trim.ts` are: the geometry has to be independently testable, and the
 * one thing a production screen must never be is a black box somebody has to
 * take on faith.
 *
 * WHAT IT PRODUCES, AND WHY THAT IS A DIFFERENT THING FROM AN UPSCALE
 *
 * Continuous-tone raster production asks "does this file carry 300 PPI of
 * real detail?", and for a 562px-wide upload printing at 10.5in the honest
 * answer is no — hence the standard path's refusal. A halftone asks a
 * different question, because it is a different representation: the printed
 * thing is a lattice of solid dots whose SIZE carries tone, and that lattice
 * is GENERATED here, at the final production pixel dimensions, from scratch.
 * Its geometry is exact at 300 PPI because it was drawn at 300 PPI, not
 * because anything was reconstructed.
 *
 * The source is still asked for something, and it is asked honestly: a screen
 * at L lines per inch samples tone L times per inch, so it needs the prepared
 * artwork to carry at least L PPI of TONAL information. That is a real,
 * checkable bar (`halftone_tonal_sufficiency`), it is roughly a tenth of the
 * continuous-tone bar, and it is the entire reason this representation can
 * serve a file the other one cannot.
 *
 * WHAT IT CANNOT DO. Halftoning represents tone. It does not restore
 * information. Blurred subjects stay blurred, unreadable text stays
 * unreadable, malformed generated detail stays malformed — at a coarser
 * sampling than before. Nothing in this module, its metadata, or any copy
 * derived from it may suggest otherwise.
 *
 * NOT A RIP. This writes an ordinary transparent RGBA raster. It does not
 * drive a printer, choose ink, build an underbase, separate channels, or
 * model any downstream production variable.
 */

import {
  MIN_PRINTABLE_DOT_RADIUS_PX,
  type GarmentColor,
  type HalftoneSettings,
} from "@/capabilities/shared/production-treatment";

import { DEFAULT_ALPHA_THRESHOLD } from "./alpha-trim";
import type { RgbaImage } from "./raster-transform";

// ---------------------------------------------------------------------------
// Tuned constants — engine identity, not operator controls (Goal 14)
// ---------------------------------------------------------------------------

/**
 * THE GARMENT-BLEND FLOOR, and the single most important number in this file.
 *
 * Coverage is driven by how far a pixel's tone sits from the GARMENT's tone,
 * so that artwork which visually merges into the fabric prints with less ink
 * and lets the garment do the work. Taken literally, that rule deletes black
 * artwork on a black shirt — which is precisely the failure the black-
 * background preparation work surfaced, and precisely what Goal 4 forbids.
 *
 * So the transfer is not "coverage = tonal separation". It is "coverage =
 * this floor, plus tonal separation across the remaining range". Every
 * meaningfully opaque pixel therefore keeps a real, printable dot no matter
 * how close its colour is to the garment: black-on-black screens down to a
 * 15% dot — a visible ink texture — never to nothing.
 *
 * This is what makes the treatment a BLEND rather than a knockout. Deliberate
 * garment-colour knockout (dropping matched regions entirely) is a separate
 * operation this phase does not implement; see ARCHITECTURE.md.
 */
export const HALFTONE_MIN_COVERAGE = 0.15;

/**
 * Re-exported for this engine's callers and tests. It is DEFINED in
 * `shared/production-treatment.ts` because authoritative Print Validation
 * judges resolved screens against the same number, and a validator that had to
 * import the engine to read its own bar would be depending on the thing it is
 * supposed to be checking. Both sides depend on shared instead.
 */
export { MIN_PRINTABLE_DOT_RADIUS_PX };

/**
 * Alpha at or below this is discarded outright (Goal 12).
 *
 * The white-haze / grey-fringe control. A feathered source edge screened into
 * a scatter of near-transparent specks is exactly the "gray fringe" a DTF
 * operator sees as a halo on press. The threshold is deliberately the SAME
 * one `alpha-trim.ts` already uses to decide what counts as artwork, so this
 * module cannot disagree with the rest of the pipeline about what "visible"
 * means.
 */
export const MIN_PRINTABLE_ALPHA = DEFAULT_ALPHA_THRESHOLD;

/**
 * Dot edge softness, in output pixels.
 *
 * A hard binary dot at 8.5px cells aliases into visibly square-ish blobs
 * whose rasterized area drifts from the tone they are supposed to carry. One
 * pixel of edge feather fixes both and is far below anything a 300 PPI DTF
 * film resolves. It is NOT partial-ink shading: the dot INTERIOR is fully
 * opaque, and only the outline is anti-aliased.
 */
const DOT_EDGE_SOFTNESS_PX = 1;

/**
 * Ellipse minor/major ratio. One number, so "ellipse" means one specific,
 * reproducible thing rather than a family.
 */
const ELLIPSE_MINOR_RATIO = 0.72;

/** Spot-function sampling resolution. `SPOT_SAMPLES^2` samples per cell. */
const SPOT_SAMPLES = 128;
/** Entries in the coverage -> radius table. */
const COVERAGE_TABLE_SIZE = 1024;

/** Tone strictly inside this band is what a screen renders as a PARTIAL dot. */
const MIDTONE_BAND_LOW = 0.05;
const MIDTONE_BAND_HIGH = 0.95;

// ---------------------------------------------------------------------------
// Tone (Goal 10)
// ---------------------------------------------------------------------------

/**
 * Rec.709 luma on the gamma-encoded sRGB values, normalized to 0..1.
 *
 * Deliberately NOT linear-light luminance. The question this answers is "how
 * far apart do these two tones LOOK", which drives how much ink a human wants
 * to see there — a perceptual axis. Linearizing first would crush the
 * midtones the screen exists to render.
 */
export function encodedLuma(r: number, g: number, b: number): number {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/**
 * GARMENT-RELATIVE TONAL SEPARATION — 0 where the artwork's tone matches the
 * garment's, 1 at the far end of the range that garment leaves available.
 *
 * The normalization by `max(Lg, 1 - Lg)` is what makes one rule serve every
 * garment. On black (Lg = 0) it reduces exactly to luma, so highlights print
 * solid and shadows open up to fabric — the familiar dark-garment look. On
 * white (Lg = 1) it inverts, so shadows print and highlights open up. On a
 * mid grey both ends reach full coverage. No branch, no per-colour table, and
 * no way for a garment colour to be handled inconsistently.
 */
export function garmentRelativeTone(
  luma: number,
  garmentLuma: number,
): number {
  const span = Math.max(garmentLuma, 1 - garmentLuma);
  if (span <= 0) return 0;
  const separation = Math.abs(luma - garmentLuma) / span;
  return separation > 1 ? 1 : separation;
}

/**
 * THE TRANSFER FUNCTION, stated in one place so it is testable rather than
 * emergent (Goal 10).
 *
 *     coverage = FLOOR + (1 - FLOOR) * separation ^ (1 / midtone)
 *
 * `midtone > 1` raises the exponent's output for every interior tone, so more
 * ink lands in the midtones; `midtone < 1` takes ink out. Both ends are
 * fixed points — separation 0 stays at the floor and separation 1 stays at
 * full coverage — so the control moves midtones without ever changing what
 * "solid" or "bare garment" mean.
 */
export function halftoneCoverageForTone(
  separation: number,
  midtone: number,
): number {
  const transferred = separation <= 0 ? 0 : Math.pow(separation, 1 / midtone);
  return HALFTONE_MIN_COVERAGE + (1 - HALFTONE_MIN_COVERAGE) * transferred;
}

// ---------------------------------------------------------------------------
// Screen geometry (Goals 6, 7)
// ---------------------------------------------------------------------------

export interface HalftoneScreenGeometry {
  /**
   * Output pixels per halftone cell: `targetPpi / lpi`. DELIBERATELY NOT
   * ROUNDED — rounding it to an integer is the classic way an engine silently
   * prints a different line frequency than the one it was asked for (35 LPI
   * would become 300/9 = 33.3, or 300/8 = 37.5). The screen lattice is placed
   * in continuous coordinates, so the requested frequency is honoured exactly
   * and only individual dot EDGES land on pixel boundaries.
   */
  cellPx: number;
  /** `targetPpi / cellPx` — equal to the requested LPI by construction; recomputed so validation can verify rather than trust. */
  achievedLpi: number;
  /** The radius, in output pixels, of the SMALLEST dot this screen can emit (i.e. at `HALFTONE_MIN_COVERAGE`). */
  minDotRadiusPx: number;
  /** Cell area in output pixels — how many distinguishable coverage steps the screen can render. */
  cellAreaPx: number;
}

/**
 * Resolves dot-cell geometry from the PHYSICAL facts (Goal 7).
 *
 * LPI is a physical dot frequency, not a visual slider: at a given output
 * density there is exactly one cell size that produces it, and it is this
 * one. Everything downstream — dot size, tonal step count, whether the
 * smallest dot prints — falls out of this single division, which is why no
 * pixel measurement anywhere in this engine is hard-coded.
 */
export function resolveHalftoneScreenGeometry(
  lpi: number,
  targetPpi: number,
  dotShape: HalftoneSettings["dotShape"] = "round",
): HalftoneScreenGeometry {
  if (!Number.isFinite(lpi) || lpi <= 0) {
    throw new Error("Halftone LPI must be a positive number.");
  }
  if (!Number.isFinite(targetPpi) || targetPpi <= 0) {
    throw new Error("Halftone target PPI must be a positive number.");
  }
  const cellPx = targetPpi / lpi;
  const table = coverageRadiusTable(dotShape);
  return {
    cellPx,
    achievedLpi: targetPpi / cellPx,
    minDotRadiusPx: radiusForCoverage(table, HALFTONE_MIN_COVERAGE) * cellPx,
    cellAreaPx: cellPx * cellPx,
  };
}

// ---------------------------------------------------------------------------
// Spot functions (Goal 6)
// ---------------------------------------------------------------------------

/**
 * A spot function's raw metric at a point inside a cell, in cell units.
 * Monotonically increasing outward from the cell centre — that monotonicity
 * is the only property the coverage table requires, which is what makes
 * adding a shape a one-line change.
 */
function spotMetric(shape: HalftoneSettings["dotShape"], cu: number, cv: number): number {
  if (shape === "ellipse") {
    const y = cv / ELLIPSE_MINOR_RATIO;
    return Math.sqrt(cu * cu + y * y);
  }
  return Math.sqrt(cu * cu + cv * cv);
}

/**
 * COVERAGE -> RADIUS, built by measuring rather than by algebra.
 *
 * The engine needs the inverse question: "what metric value encloses exactly
 * this fraction of the cell's area?". Solving that analytically means
 * per-shape integration including the circle/square clipping terms, and every
 * new shape means new algebra to get subtly wrong. Instead the unit cell is
 * sampled on a fixed grid, the metric values are sorted, and the value at
 * rank `c` IS by definition the one enclosing fraction `c` of the area.
 *
 * Exact to one sample (1/16384 of a cell), identical on every machine, and
 * correct for any monotone spot function including ones that chain into
 * neighbouring cells at high coverage.
 *
 * Cached per shape — the table depends only on the shape, never on LPI,
 * angle, tone, or image size.
 */
const coverageTableCache = new Map<string, Float64Array>();

function coverageRadiusTable(shape: HalftoneSettings["dotShape"]): Float64Array {
  const cached = coverageTableCache.get(shape);
  if (cached) return cached;

  const samples = new Float64Array(SPOT_SAMPLES * SPOT_SAMPLES);
  let i = 0;
  for (let sy = 0; sy < SPOT_SAMPLES; sy += 1) {
    const cv = (sy + 0.5) / SPOT_SAMPLES - 0.5;
    for (let sx = 0; sx < SPOT_SAMPLES; sx += 1) {
      const cu = (sx + 0.5) / SPOT_SAMPLES - 0.5;
      samples[i] = spotMetric(shape, cu, cv);
      i += 1;
    }
  }
  samples.sort();

  const table = new Float64Array(COVERAGE_TABLE_SIZE);
  const lastSample = samples.length - 1;
  for (let j = 0; j < COVERAGE_TABLE_SIZE; j += 1) {
    const rank = Math.round((j / (COVERAGE_TABLE_SIZE - 1)) * lastSample);
    table[j] = samples[rank];
  }
  coverageTableCache.set(shape, table);
  return table;
}

/** The spot metric enclosing `coverage` of a cell's area, in cell units. */
function radiusForCoverage(table: Float64Array, coverage: number): number {
  const clamped = coverage <= 0 ? 0 : coverage >= 1 ? 1 : coverage;
  return table[Math.round(clamped * (COVERAGE_TABLE_SIZE - 1))];
}

// ---------------------------------------------------------------------------
// Edge choke (Goal 12)
// ---------------------------------------------------------------------------

/**
 * Erodes the alpha channel by `radiusPx` output pixels — a narrow, explicit
 * edge cleanup, never a general matte editor.
 *
 * Separable min filter (horizontal pass, then vertical), which is exactly
 * equivalent to a square structuring element and turns an O(k^2) per-pixel
 * cost into O(k). RGB is untouched: a choke pulls the artwork's EDGE in, it
 * never recolours anything.
 */
export function chokeAlpha(image: RgbaImage, radiusPx: number): RgbaImage {
  if (radiusPx <= 0) return image;
  const { width, height, data } = image;
  const out = Buffer.from(data);
  const row = new Uint8Array(width);

  for (let y = 0; y < height; y += 1) {
    const base = y * width * 4;
    for (let x = 0; x < width; x += 1) {
      let min = 255;
      const from = Math.max(0, x - radiusPx);
      const to = Math.min(width - 1, x + radiusPx);
      for (let k = from; k <= to; k += 1) {
        const a = data[base + k * 4 + 3];
        if (a < min) min = a;
      }
      row[x] = min;
    }
    for (let x = 0; x < width; x += 1) out[base + x * 4 + 3] = row[x];
  }

  const column = new Uint8Array(height);
  for (let x = 0; x < width; x += 1) {
    for (let y = 0; y < height; y += 1) {
      let min = 255;
      const from = Math.max(0, y - radiusPx);
      const to = Math.min(height - 1, y + radiusPx);
      for (let k = from; k <= to; k += 1) {
        const a = out[k * width * 4 + x * 4 + 3];
        if (a < min) min = a;
      }
      column[y] = min;
    }
    for (let y = 0; y < height; y += 1) out[y * width * 4 + x * 4 + 3] = column[y];
  }

  return { width, height, data: out };
}

// ---------------------------------------------------------------------------
// Tonal content measurement (Goal 3 input)
// ---------------------------------------------------------------------------

export interface HalftoneToneMeasurement {
  visiblePixelCount: number;
  midtoneFraction: number;
  meanTone: number;
}

/**
 * Measures how much genuinely tonal work a screen would have to do on this
 * artwork, against this garment.
 *
 * Feeds `assessHalftoneEligibility`. Kept here rather than in the treatment
 * module so eligibility stays pure arithmetic on a summary and this stays the
 * only place that walks pixels.
 */
export function measureHalftoneTonalContent(
  image: RgbaImage,
  garment: GarmentColor,
): HalftoneToneMeasurement {
  const garmentLuma = encodedLuma(garment.rgb.r, garment.rgb.g, garment.rgb.b);
  let visible = 0;
  let midtone = 0;
  let toneSum = 0;

  for (let i = 0; i < image.data.length; i += 4) {
    if (image.data[i + 3] < MIN_PRINTABLE_ALPHA) continue;
    visible += 1;
    const tone = garmentRelativeTone(
      encodedLuma(image.data[i], image.data[i + 1], image.data[i + 2]),
      garmentLuma,
    );
    toneSum += tone;
    if (tone > MIDTONE_BAND_LOW && tone < MIDTONE_BAND_HIGH) midtone += 1;
  }

  return {
    visiblePixelCount: visible,
    midtoneFraction: visible > 0 ? midtone / visible : 0,
    meanTone: visible > 0 ? toneSum / visible : 0,
  };
}

// ---------------------------------------------------------------------------
// The screen (Goals 6, 9, 11, 12, 17)
// ---------------------------------------------------------------------------

/**
 * Everything about the screen that actually got applied — recorded so
 * production validation can RECOMPUTE rather than trust, exactly as
 * `ProductionNormalizationMetadata` is.
 */
export interface HalftoneScreenMetadata {
  algorithmVersion: string;
  lpi: number;
  angleDeg: number;
  dotShape: HalftoneSettings["dotShape"];
  midtone: number;
  chokePx: number;
  garmentHex: string;
  targetPpi: number;
  cellPx: number;
  /** Recomputed from `targetPpi / cellPx`. Must equal `lpi` to within raster rounding. */
  achievedLpi: number;
  cellAreaPx: number;
  minDotRadiusPx: number;
  /**
   * THE FINAL-SIZE PROOF (Goals 6, 17, 18). The pixel dimensions the screen
   * lattice was actually generated across. Production validation compares
   * these to the delivered plate's own dimensions: equal means the dots were
   * drawn at production size, unequal means something was generated small and
   * enlarged afterwards — the one thing this representation may never do,
   * because an enlarged dot lattice is no longer at the LPI it claims.
   */
  screenWidthPx: number;
  screenHeightPx: number;
  /** Visible source pixels the screen was applied to. */
  visiblePixelCount: number;
  /** Mean tonal coverage requested across visible pixels, before rasterization. */
  meanRequestedCoverage: number;
  /** Fraction of visible source pixels that came out carrying ink. The screen's measured result. */
  inkedPixelFraction: number;
}

export interface HalftoneScreenResult {
  image: RgbaImage;
  metadata: HalftoneScreenMetadata;
}

/**
 * Applies the halftone screen to an image that is ALREADY at final production
 * pixel dimensions.
 *
 * That precondition is the whole design (Goal 6). The caller resamples to the
 * production size first and screens second, never the reverse: a lattice
 * generated at source size and scaled up would carry a line frequency
 * multiplied by the scale factor, so a plate claiming 35 LPI would print at
 * 6. Nothing here resizes, and nothing downstream of it may either.
 *
 * COLOUR IS NOT TOUCHED (Goal 11). Every output pixel keeps its source RGB
 * byte-for-byte; the screen writes ALPHA only. The plate stays full-colour and
 * reproduces shadows, gradients, and highlights through varying dot coverage
 * rather than through varying ink density. This is garment-integration
 * halftoning, not monochrome newspaper screening.
 */
export function applyHalftoneScreen(
  source: RgbaImage,
  settings: HalftoneSettings,
  targetPpi: number,
): HalftoneScreenResult {
  const geometry = resolveHalftoneScreenGeometry(
    settings.lpi,
    targetPpi,
    settings.dotShape,
  );
  const table = coverageRadiusTable(settings.dotShape);
  const garmentLuma = encodedLuma(
    settings.garment.rgb.r,
    settings.garment.rgb.g,
    settings.garment.rgb.b,
  );

  // Goal 12: the choke runs on the SOURCE alpha, before screening, so the
  // artwork edge moves in by whole pixels and the screen then lands on the
  // corrected edge. Choking the screened result instead would eat dots out of
  // the interior of the outermost cell row and thin the artwork unevenly.
  const input = chokeAlpha(source, settings.chokePx);

  const { width, height } = input;
  const out = Buffer.from(input.data);
  const cellPx = geometry.cellPx;
  const invCell = 1 / cellPx;
  const angleRad = (settings.angleDeg * Math.PI) / 180;
  const cos = Math.cos(angleRad);
  const sin = Math.sin(angleRad);

  let visible = 0;
  let coverageSum = 0;
  let inked = 0;

  for (let y = 0; y < height; y += 1) {
    const py = y + 0.5;
    // Screen coordinates advance by a constant step along a row, so the
    // rotation costs two multiplications per ROW rather than two per pixel.
    let u = 0.5 * cos + py * sin;
    let v = -0.5 * sin + py * cos;
    const rowBase = y * width * 4;

    for (let x = 0; x < width; x += 1, u += cos, v -= sin) {
      const i = rowBase + x * 4;
      const sourceAlpha = input.data[i + 3];
      if (sourceAlpha < MIN_PRINTABLE_ALPHA) {
        out[i + 3] = 0;
        continue;
      }
      visible += 1;

      const tone = garmentRelativeTone(
        encodedLuma(input.data[i], input.data[i + 1], input.data[i + 2]),
        garmentLuma,
      );
      const coverage = halftoneCoverageForTone(tone, settings.midtone);
      coverageSum += coverage;

      // A cell asked for full coverage is solid, exactly — no lattice, no
      // rounding, no anti-alias arithmetic that could leave a corner short.
      // Solid artwork stays solid artwork.
      if (coverage >= 1) {
        out[i + 3] = sourceAlpha;
        inked += 1;
        continue;
      }

      const su = u * invCell;
      const sv = v * invCell;
      const cu = su - Math.floor(su) - 0.5;
      const cv = sv - Math.floor(sv) - 0.5;
      const metric = spotMetric(settings.dotShape, cu, cv);
      // SATURATION CORRECTION. The anti-alias band straddles the dot outline,
      // which is area-correct everywhere except as the dot fills its cell:
      // there the band's outer half falls outside the cell entirely and would
      // leave cell corners stranded at half alpha inside what should be solid
      // ink. Pushing the radius out by the band width fixes it, weighted by a
      // high power of coverage so the correction is inert across the tonal
      // range it would otherwise distort.
      const saturation = coverage ** 6;
      const radius =
        radiusForCoverage(table, coverage) +
        (saturation * DOT_EDGE_SOFTNESS_PX) / cellPx;

      // Anti-aliased dot outline, measured in real output pixels so the edge
      // softness is a physical width rather than a fraction of whatever cell
      // size the LPI happened to produce.
      let dot = 0.5 + ((radius - metric) * cellPx) / DOT_EDGE_SOFTNESS_PX;
      if (dot <= 0) {
        out[i + 3] = 0;
        continue;
      }
      if (dot > 1) dot = 1;

      const alpha = Math.round(dot * sourceAlpha);
      // Goal 12: sub-printable alpha is discarded rather than delivered as a
      // faint speck. This is the difference between a clean screened edge and
      // a grey halo on press.
      out[i + 3] = alpha <= MIN_PRINTABLE_ALPHA ? 0 : alpha;
      if (out[i + 3] > 0) inked += 1;
    }
  }

  return {
    image: { width, height, data: out },
    metadata: {
      algorithmVersion: settings.algorithmVersion,
      lpi: settings.lpi,
      angleDeg: settings.angleDeg,
      dotShape: settings.dotShape,
      midtone: settings.midtone,
      chokePx: settings.chokePx,
      garmentHex: settings.garment.hex,
      targetPpi,
      cellPx,
      achievedLpi: geometry.achievedLpi,
      cellAreaPx: geometry.cellAreaPx,
      minDotRadiusPx: geometry.minDotRadiusPx,
      screenWidthPx: width,
      screenHeightPx: height,
      visiblePixelCount: visible,
      meanRequestedCoverage: visible > 0 ? coverageSum / visible : 0,
      inkedPixelFraction: visible > 0 ? inked / visible : 0,
    },
  };
}

/**
 * PREVIEW ONLY (Goal 13). Composites a transparent plate over a solid garment
 * colour so an operator can judge the result the way a wearer would see it.
 *
 * Never used to produce, alter, or replace an exported production asset. The
 * deliverable stays transparent and garment-neutral — flattening a garment
 * colour into artwork would hand a printer a file with a shirt-coloured
 * rectangle baked into it.
 */
export function compositeOverGarment(
  image: RgbaImage,
  garment: GarmentColor,
): RgbaImage {
  const out = Buffer.alloc(image.data.length);
  const { r, g, b } = garment.rgb;

  for (let i = 0; i < image.data.length; i += 4) {
    const a = image.data[i + 3] / 255;
    out[i] = Math.round(image.data[i] * a + r * (1 - a));
    out[i + 1] = Math.round(image.data[i + 1] * a + g * (1 - a));
    out[i + 2] = Math.round(image.data[i + 2] * a + b * (1 - a));
    out[i + 3] = 255;
  }

  return { width: image.width, height: image.height, data: out };
}
