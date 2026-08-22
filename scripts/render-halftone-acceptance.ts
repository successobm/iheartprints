/**
 * Print'em All Phase 2 (Goal 29) — VISUAL ACCEPTANCE ARTIFACTS.
 *
 * Tests can prove a halftone plate is the screen it claims to be, at the
 * physical size it claims, generated where it claims. They cannot tell anyone
 * whether it LOOKS right, and no amount of arithmetic will. This script exists
 * so a person can look.
 *
 * Renders the live Print'em All fixture geometry through the REAL production
 * path — the same `normalizeProductionRaster` then `applyHalftoneScreen`
 * order, at the same confirmed physical size, with the same settings the
 * pipeline would use — and writes the results where they can be opened.
 *
 * NO EXTERNAL PROVIDER. No network, no Topaz, no OpenAI, no Stripe. Pure local
 * raster math.
 *
 * NO CUSTOMER ARTWORK IS COMMITTED. Output goes to `.local-acceptance/`, which
 * is git-ignored. The default source is a deterministic synthetic fixture with
 * the live file's exact geometry (584x640 canvas, 562x486 visible artwork);
 * pass a path to a real prepared PNG to inspect one instead.
 *
 *   npx tsx scripts/render-halftone-acceptance.ts
 *   npx tsx scripts/render-halftone-acceptance.ts path/to/prepared.png
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { PNG } from "pngjs";

import {
  applyHalftoneScreen,
  compositeOverGarment,
  measureHalftoneTonalContent,
} from "@/capabilities/final-artwork/halftone-screen";
import {
  encodeProductionPng,
  normalizeProductionRaster,
} from "@/capabilities/final-artwork/production-normalization";
import type { RgbaImage } from "@/capabilities/final-artwork/raster-transform";
import { sizingPolicyForConfirmedSize } from "@/capabilities/shared/confirmed-production-size";
import {
  normalizeHalftoneSettings,
  productionTreatmentKey,
  resolveGarmentColor,
} from "@/capabilities/shared/production-treatment";

/** The live Print'em All geometry. */
const CANVAS = { width: 584, height: 640 };
const ARTWORK = { width: 562, height: 486 };

const GARMENT_LABEL = "Black";
const CONFIRMED_WIDTH_IN = 10.5;
const CONFIRMED_BOX_HEIGHT_IN = 10.5;

const OUT_DIR = path.join(process.cwd(), ".local-acceptance", "phase-2-halftone");

/**
 * A deterministic stand-in with the live file's exact geometry: a tonal
 * subject with a colour cast, plus a solid patch and a near-black patch, so
 * gradient rendering, solid-stays-solid, and the garment-blend floor are all
 * visible in one image.
 */
function syntheticPreparedArtwork(): RgbaImage {
  const data = Buffer.alloc(CANVAS.width * CANVAS.height * 4);
  const insetX = Math.floor((CANVAS.width - ARTWORK.width) / 2);
  const insetY = Math.floor((CANVAS.height - ARTWORK.height) / 2);

  for (let y = 0; y < CANVAS.height; y += 1) {
    for (let x = 0; x < CANVAS.width; x += 1) {
      const i = (y * CANVAS.width + x) * 4;
      const inside =
        x >= insetX &&
        x < insetX + ARTWORK.width &&
        y >= insetY &&
        y < insetY + ARTWORK.height;
      if (!inside) continue;

      const tx = (x - insetX) / (ARTWORK.width - 1);
      const ty = (y - insetY) / (ARTWORK.height - 1);

      let r: number;
      let g: number;
      let b: number;
      if (ty < 0.18) {
        // A solid highlight band — must come out solid, not speckled.
        r = 255;
        g = 236;
        b = 210;
      } else if (ty > 0.86) {
        // Near-black on a black garment — the Goal 4 case. Must survive as a
        // visible screen rather than disappearing into the fabric.
        r = 10;
        g = 10;
        b = 12;
      } else {
        const level = Math.round(((tx + (ty - 0.18) / 0.68) / 2) * 255);
        r = level;
        g = Math.round(level * 0.72);
        b = Math.round(level * 0.4);
      }

      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  }
  return { width: CANVAS.width, height: CANVAS.height, data };
}

function writePng(name: string, image: RgbaImage): string {
  const png = new PNG({ width: image.width, height: image.height });
  image.data.copy(png.data);
  const file = path.join(OUT_DIR, name);
  writeFileSync(file, PNG.sync.write(png));
  return file;
}

/** Scales an image down by an integer factor, for the side-by-side sheet only. */
function downscale(image: RgbaImage, factor: number): RgbaImage {
  const width = Math.max(1, Math.floor(image.width / factor));
  const height = Math.max(1, Math.floor(image.height / factor));
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < factor; sy += 1) {
        for (let sx = 0; sx < factor; sx += 1) {
          const i = ((y * factor + sy) * image.width + (x * factor + sx)) * 4;
          const alpha = image.data[i + 3];
          r += image.data[i] * alpha;
          g += image.data[i + 1] * alpha;
          b += image.data[i + 2] * alpha;
          a += alpha;
        }
      }
      const o = (y * width + x) * 4;
      data[o] = a > 0 ? Math.round(r / a) : 0;
      data[o + 1] = a > 0 ? Math.round(g / a) : 0;
      data[o + 2] = a > 0 ? Math.round(b / a) : 0;
      data[o + 3] = Math.round(a / (factor * factor));
    }
  }
  return { width, height, data };
}

/**
 * A 1:1 crop, composited over the garment.
 *
 * The contact sheet is downscaled to fit on a screen, and downscaling a dot
 * lattice aliases into blotchy moire that is an artifact of the thumbnail and
 * not of the plate. Judging dot shape, size, and spacing therefore needs an
 * unscaled crop — this is the tile a person should actually look at to decide
 * whether a screen is right before committing to a press test.
 */
function crop(
  image: RgbaImage,
  x: number,
  y: number,
  width: number,
  height: number,
): RgbaImage {
  const w = Math.min(width, image.width - x);
  const h = Math.min(height, image.height - y);
  const data = Buffer.alloc(w * h * 4);
  for (let row = 0; row < h; row += 1) {
    image.data.copy(
      data,
      row * w * 4,
      ((y + row) * image.width + x) * 4,
      ((y + row) * image.width + x + w) * 4,
    );
  }
  return { width: w, height: h, data };
}

/** Lays images out left to right on one opaque garment-coloured sheet. */
function contactSheet(
  tiles: RgbaImage[],
  garmentRgb: { r: number; g: number; b: number },
  gap = 24,
): RgbaImage {
  const width =
    tiles.reduce((sum, tile) => sum + tile.width, 0) + gap * (tiles.length + 1);
  const height = Math.max(...tiles.map((tile) => tile.height)) + gap * 2;
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = garmentRgb.r;
    data[i + 1] = garmentRgb.g;
    data[i + 2] = garmentRgb.b;
    data[i + 3] = 255;
  }

  let offsetX = gap;
  for (const tile of tiles) {
    for (let y = 0; y < tile.height; y += 1) {
      for (let x = 0; x < tile.width; x += 1) {
        const s = (y * tile.width + x) * 4;
        const alpha = tile.data[s + 3] / 255;
        if (alpha === 0) continue;
        const d = ((y + gap) * width + (x + offsetX)) * 4;
        data[d] = Math.round(tile.data[s] * alpha + data[d] * (1 - alpha));
        data[d + 1] = Math.round(tile.data[s + 1] * alpha + data[d + 1] * (1 - alpha));
        data[d + 2] = Math.round(tile.data[s + 2] * alpha + data[d + 2] * (1 - alpha));
      }
    }
    offsetX += tile.width + gap;
  }
  return { width, height, data };
}

async function main() {
  const sourcePath = process.argv[2] ?? null;
  const garment = resolveGarmentColor(GARMENT_LABEL);
  if (!garment) throw new Error(`Cannot resolve garment colour "${GARMENT_LABEL}"`);

  const prepared: RgbaImage = sourcePath
    ? await (async () => {
        const png = PNG.sync.read(await readFile(sourcePath));
        return { width: png.width, height: png.height, data: png.data };
      })()
    : syntheticPreparedArtwork();

  mkdirSync(OUT_DIR, { recursive: true });

  const sizing = sizingPolicyForConfirmedSize("full_back", {
    widthIn: CONFIRMED_WIDTH_IN,
    boxMaxHeightIn: CONFIRMED_BOX_HEIGHT_IN,
    confirmedAt: new Date().toISOString(),
  });

  // EXACTLY the production order: normalize to the confirmed final production
  // dimensions first, screen second. Reversing it would render dots at a line
  // frequency the plate would not print at.
  const normalized = normalizeProductionRaster(prepared, sizing);
  if (normalized.status !== "normalized") throw new Error(normalized.reason);

  const tone = measureHalftoneTonalContent(normalized.result.image, garment);
  const written: string[] = [];

  written.push(writePng("01-prepared-source.png", prepared));
  written.push(
    writePng("02-normalized-continuous-tone.png", normalized.result.image),
  );

  const variants = [
    { name: "03-halftone-35lpi-45deg-round", request: { lpi: 35 } },
    { name: "04-halftone-45lpi-45deg-round", request: { lpi: 45 } },
    { name: "05-halftone-35lpi-22_5deg-round", request: { lpi: 35, angleDeg: 22.5 } },
    { name: "06-halftone-35lpi-45deg-ellipse", request: { lpi: 35, dotShape: "ellipse" } },
  ];

  const summary: Record<string, unknown>[] = [];
  const sheetTiles: RgbaImage[] = [downscale(normalized.result.image, 6)];

  for (const variant of variants) {
    const settings = normalizeHalftoneSettings(variant.request, garment);
    if (!settings) throw new Error(`Refused settings for ${variant.name}`);

    const screened = applyHalftoneScreen(
      normalized.result.image,
      settings,
      normalized.result.metadata.targetPpi,
    );

    // The production PNG, encoded exactly as the pipeline encodes it —
    // transparent, full colour, carrying its pHYs density. No garment colour
    // is baked into it.
    const encoded = encodeProductionPng({
      image: screened.image,
      metadata: normalized.result.metadata,
    });
    writeFileSync(path.join(OUT_DIR, `${variant.name}.png`), encoded.bytes);
    written.push(path.join(OUT_DIR, `${variant.name}.png`));

    // Preview only — never persisted by the pipeline, never the deliverable.
    written.push(
      writePng(
        `${variant.name}-on-garment.png`,
        compositeOverGarment(screened.image, garment),
      ),
    );

    if (variant.request.lpi === 35 && !variant.request.angleDeg && !variant.request.dotShape) {
      sheetTiles.push(downscale(screened.image, 6));
    }

    // The 1:1 detail crop — taken from the middle of the tonal ramp, where the
    // dots are mid-sized and their shape is easiest to judge.
    written.push(
      writePng(
        `${variant.name}-detail-1to1.png`,
        compositeOverGarment(
          crop(
            screened.image,
            Math.floor(screened.image.width / 2) - 200,
            Math.floor(screened.image.height / 2) - 100,
            400,
            200,
          ),
          garment,
        ),
      ),
    );

    summary.push({
      variant: variant.name,
      treatmentKey: productionTreatmentKey({ treatment: "halftone_dtf", halftone: settings }),
      outputWidthPx: screened.metadata.screenWidthPx,
      outputHeightPx: screened.metadata.screenHeightPx,
      intendedWidthIn: Number(normalized.result.metadata.intendedWidthIn.toFixed(3)),
      intendedHeightIn: Number(normalized.result.metadata.intendedHeightIn.toFixed(3)),
      targetPpi: screened.metadata.targetPpi,
      requestedLpi: screened.metadata.lpi,
      achievedLpi: Number(screened.metadata.achievedLpi.toFixed(6)),
      cellPx: Number(screened.metadata.cellPx.toFixed(4)),
      minDotRadiusPx: Number(screened.metadata.minDotRadiusPx.toFixed(3)),
      sourceTonalPpi: Number(
        (
          normalized.result.metadata.trimmedWidthPx /
          normalized.result.metadata.intendedWidthIn
        ).toFixed(2),
      ),
      inkedPixelFraction: Number(screened.metadata.inkedPixelFraction.toFixed(4)),
      meanRequestedCoverage: Number(
        screened.metadata.meanRequestedCoverage.toFixed(4),
      ),
    });
  }

  written.push(
    writePng("07-side-by-side-continuous-vs-halftone.png", contactSheet(sheetTiles, garment.rgb)),
  );

  const report = {
    note: "Print'em All Phase 2 halftone acceptance artifacts. Local only, never committed. Physical print testing is still required — nothing here is a press-verified result.",
    source: sourcePath ?? "synthetic fixture with the live Print'em All geometry",
    garment: { label: garment.label, hex: garment.hex },
    confirmedSize: { widthIn: CONFIRMED_WIDTH_IN, boxMaxHeightIn: CONFIRMED_BOX_HEIGHT_IN },
    sourceVisibleArtworkPx: {
      widthPx: normalized.result.metadata.alphaBBoxWidthPx,
      heightPx: normalized.result.metadata.alphaBBoxHeightPx,
    },
    continuousToneScaleRequired: Number(
      (
        (normalized.result.metadata.intendedWidthIn *
          normalized.result.metadata.targetPpi) /
        normalized.result.metadata.alphaBBoxWidthPx
      ).toFixed(3),
    ),
    tonalContent: {
      visiblePixelCount: tone.visiblePixelCount,
      midtoneFraction: Number(tone.midtoneFraction.toFixed(4)),
    },
    variants: summary,
  };
  writeFileSync(
    path.join(OUT_DIR, "report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );

  console.log(`Halftone acceptance artifacts written to ${OUT_DIR}`);
  console.log(JSON.stringify(report, null, 2));
  for (const file of written) console.log(`  ${file}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
