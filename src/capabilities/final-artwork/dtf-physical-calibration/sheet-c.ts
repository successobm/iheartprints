/**
 * Sheet C — raster vs halftone pairs + optional experimental hybrid specimen.
 */

import { recommendedHalftoneSettings } from "@/capabilities/shared/production-treatment";

import { applyHalftoneScreen } from "../halftone-screen";
import type { RgbaImage } from "../raster-transform";
import { drawBitmapLabel } from "./bitmap-font";
import {
  blit,
  createTransparentCanvas,
  fillCircle,
  fillGradientHorizontal,
  fillRect,
  INK_BLACK,
  setPixel,
} from "./draw";
import type { SpecimenManifestEntry } from "./types";
import { CALIBRATION_PPI, inchesToPx } from "./units";

export const SHEET_C_WIDTH_IN = 10.5;
export const SHEET_C_HEIGHT_IN = 12;

const BLACK_GARMENT = {
  label: "Black",
  hex: "#000000",
  rgb: { r: 0, g: 0, b: 0 },
} as const;

function logoLikePatch(w: number, h: number): RgbaImage {
  const img = createTransparentCanvas(w, h);
  fillRect(img, 10, 10, w - 20, h - 20, { r: 0, g: 0, b: 0, a: 220 });
  fillRect(img, 30, 30, w - 60, 24, INK_BLACK);
  fillCircle(img, w / 2, h / 2 + 10, 28, INK_BLACK);
  return img;
}

function shadowFadePatch(w: number, h: number): RgbaImage {
  const img = createTransparentCanvas(w, h);
  fillGradientHorizontal(img, 0, 0, w, h, { r: 0, g: 0, b: 0 });
  return img;
}

function illustrationPatch(w: number, h: number): RgbaImage {
  const img = createTransparentCanvas(w, h);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const tone = Math.round(40 + 180 * (0.5 + 0.5 * Math.sin(x / 18) * Math.cos(y / 22)));
      setPixel(img, x, y, { r: tone, g: tone, b: tone, a: Math.min(255, tone + 40) });
    }
  }
  fillCircle(img, w / 2, h / 2, 40, { r: 0, g: 0, b: 0, a: 255 });
  return img;
}

function solidTonalPatch(w: number, h: number): RgbaImage {
  const img = createTransparentCanvas(w, h);
  fillRect(img, 0, 0, w, h, { r: 0, g: 0, b: 0, a: 180 });
  return img;
}

export function generateSheetC(): {
  image: ReturnType<typeof createTransparentCanvas>;
  specimens: SpecimenManifestEntry[];
  widthIn: number;
  heightIn: number;
  experimentalHybridIncluded: boolean;
} {
  const widthPx = inchesToPx(SHEET_C_WIDTH_IN);
  const heightPx = inchesToPx(SHEET_C_HEIGHT_IN);
  const image = createTransparentCanvas(widthPx, heightPx);
  const specimens: SpecimenManifestEntry[] = [];

  let y = 40;
  drawBitmapLabel(image, "SHEET C RASTER VS HALFTONE", 40, y, 3);
  y += 40;
  drawBitmapLabel(image, "SAME SOURCE — A CONTINUOUS RASTER / B EXISTING DTF HALFTONE", 40, y, 2);
  y += 28;
  drawBitmapLabel(image, "NO CLAIM WHICH IS BETTER — PHYSICAL COMPARISON ONLY", 40, y, 2);
  y += 50;

  const settings = recommendedHalftoneSettings(BLACK_GARMENT);
  const pairs: { group: string; label: string; source: RgbaImage }[] = [
    { group: "PAIR-LOGO", label: "Logo-like tonal", source: logoLikePatch(220, 160) },
    { group: "PAIR-GRAD", label: "Gradient", source: shadowFadePatch(220, 160) },
    { group: "PAIR-FADE", label: "Shadow fade", source: shadowFadePatch(220, 160) },
    { group: "PAIR-ILLUS", label: "Illustration-like", source: illustrationPatch(220, 160) },
    { group: "PAIR-SOLID", label: "Solid tonal", source: solidTonalPatch(220, 160) },
  ];

  for (const pair of pairs) {
    drawBitmapLabel(image, pair.group, 40, y, 2);
    y += 24;
    const screened = applyHalftoneScreen(pair.source, settings, CALIBRATION_PPI);

    blit(image, pair.source, 40, y);
    drawBitmapLabel(image, `${pair.group}-R`, 40, y + 168, 2);
    specimens.push({
      id: `${pair.group}-R`,
      sheetId: "SHEET_C",
      category: "raster_vs_halftone",
      label: `${pair.label} continuous raster`,
      bounds: { x: 40, y, widthPx: pair.source.width, heightPx: pair.source.height },
      pair: { role: "raster", pairGroupId: pair.group },
    });

    blit(image, screened.image, 300, y);
    drawBitmapLabel(image, `${pair.group}-H`, 300, y + 168, 2);
    specimens.push({
      id: `${pair.group}-H`,
      sheetId: "SHEET_C",
      category: "raster_vs_halftone",
      label: `${pair.label} DTF halftone`,
      bounds: { x: 300, y, widthPx: screened.image.width, heightPx: screened.image.height },
      pair: { role: "halftone", pairGroupId: pair.group },
      halftone: {
        lpi: settings.lpi,
        angleDeg: settings.angleDeg,
        dotShape: settings.dotShape,
        midtone: settings.midtone,
        chokePx: settings.chokePx,
        garmentHex: settings.garment.hex,
        algorithmVersion: settings.algorithmVersion,
      },
    });

    y += 210;
  }

  // Experimental hybrid — solid structure + screened tonal region using existing primitives only.
  drawBitmapLabel(image, "EXPERIMENTAL HYBRID — NOT PRODUCTION LOGIC", 40, y, 2);
  y += 28;
  const hybrid = createTransparentCanvas(420, 180);
  fillGradientHorizontal(hybrid, 0, 0, 420, 180, { r: 0, g: 0, b: 0 });
  const hybridScreened = applyHalftoneScreen(hybrid, settings, CALIBRATION_PPI).image;
  // Overwrite left half with solid structural foreground (opaque).
  fillRect(hybridScreened, 20, 30, 160, 120, INK_BLACK);
  fillCircle(hybridScreened, 100, 90, 35, INK_BLACK);
  blit(image, hybridScreened, 40, y);
  drawBitmapLabel(image, "HYBRID-EXP-01", 40, y + 188, 2);
  specimens.push({
    id: "HYBRID-EXP-01",
    sheetId: "SHEET_C",
    category: "experimental_hybrid",
    label: "Solid structure + screened tonal field",
    bounds: { x: 40, y, widthPx: 420, heightPx: 180 },
    experimental: true,
    pair: { role: "hybrid_experimental", pairGroupId: "HYBRID-EXP" },
    notes: [
      "EXPERIMENTAL — NOT PRODUCTION LOGIC",
      "Composed from existing draw + applyHalftoneScreen primitives only",
    ],
    halftone: {
      lpi: settings.lpi,
      angleDeg: settings.angleDeg,
      dotShape: settings.dotShape,
      midtone: settings.midtone,
      chokePx: settings.chokePx,
      garmentHex: settings.garment.hex,
      algorithmVersion: settings.algorithmVersion,
    },
  });

  return {
    image,
    specimens,
    widthIn: SHEET_C_WIDTH_IN,
    heightIn: SHEET_C_HEIGHT_IN,
    experimentalHybridIncluded: true,
  };
}
