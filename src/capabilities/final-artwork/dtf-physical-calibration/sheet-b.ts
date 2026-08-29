/**
 * Sheet B — partial alpha, continuous coverage, standalone halftone patches.
 */

import {
  DEFAULT_HALFTONE_LPI,
  recommendedHalftoneSettings,
} from "@/capabilities/shared/production-treatment";

import { applyHalftoneScreen } from "../halftone-screen";
import { drawBitmapLabel } from "./bitmap-font";
import {
  blit,
  createTransparentCanvas,
  drawHLine,
  fillCircle,
  fillGradientHorizontal,
  fillRect,
  INK_BLACK,
} from "./draw";
import type { SpecimenManifestEntry } from "./types";
import { CALIBRATION_PPI, inchesToPx, quantizePhysicalWidthMm } from "./units";

export const SHEET_B_WIDTH_IN = 10.5;
export const SHEET_B_HEIGHT_IN = 10.5;

export const ALPHA_LEVELS = [255, 224, 192, 160, 128, 96, 64] as const;

const BLACK_GARMENT = {
  label: "Black",
  hex: "#000000",
  rgb: { r: 0, g: 0, b: 0 },
} as const;

export function generateSheetB(): {
  image: ReturnType<typeof createTransparentCanvas>;
  specimens: SpecimenManifestEntry[];
  widthIn: number;
  heightIn: number;
} {
  const widthPx = inchesToPx(SHEET_B_WIDTH_IN);
  const heightPx = inchesToPx(SHEET_B_HEIGHT_IN);
  const image = createTransparentCanvas(widthPx, heightPx);
  const specimens: SpecimenManifestEntry[] = [];

  let y = 40;
  drawBitmapLabel(image, "SHEET B ALPHA TONAL COVERAGE HALFTONE", 40, y, 3);
  y += 40;
  drawBitmapLabel(image, "PHYSICAL CALIBRATION — NOT PRODUCTION PASS-FAIL", 40, y, 2);
  y += 50;

  // Partial alpha patches / lines / dots
  drawBitmapLabel(image, "PARTIAL ALPHA", 40, y, 2);
  y += 28;
  let ax = 40;
  for (const a of ALPHA_LEVELS) {
    const id = `ALPHA-PATCH-${String(a).padStart(3, "0")}`;
    const color = { r: 0, g: 0, b: 0, a };
    fillRect(image, ax, y, 80, 80, color);
    drawBitmapLabel(image, id, ax, y + 86, 1);
    specimens.push({
      id,
      sheetId: "SHEET_B",
      category: "partial_alpha",
      label: `Alpha patch a=${a}`,
      bounds: { x: ax, y, widthPx: 80, heightPx: 80 },
      rgba: color,
      requested: { alpha: a, shape: "patch" },
    });

    const lineId = `ALPHA-LINE-${String(a).padStart(3, "0")}`;
    const stroke = quantizePhysicalWidthMm(0.6);
    drawHLine(image, ax, ax + 80, y + 120, stroke.actualPx, color);
    drawBitmapLabel(image, lineId, ax, y + 130, 1);
    specimens.push({
      id: lineId,
      sheetId: "SHEET_B",
      category: "partial_alpha",
      label: `Alpha line a=${a}`,
      bounds: { x: ax, y: y + 120 - Math.floor(stroke.actualPx / 2), widthPx: 80, heightPx: stroke.actualPx },
      rgba: color,
      physical: { stroke },
      requested: { alpha: a, shape: "line" },
    });

    const dotId = `ALPHA-DOT-${String(a).padStart(3, "0")}`;
    const d = quantizePhysicalWidthMm(1.5);
    fillCircle(image, ax + 40, y + 170 + d.actualPx / 2, d.actualPx / 2, color);
    drawBitmapLabel(image, dotId, ax, y + 170 + d.actualPx + 6, 1);
    specimens.push({
      id: dotId,
      sheetId: "SHEET_B",
      category: "partial_alpha",
      label: `Alpha dot a=${a}`,
      bounds: { x: ax, y: y + 170, widthPx: 80, heightPx: d.actualPx + 4 },
      rgba: color,
      physical: { diameter: d },
      requested: { alpha: a, shape: "dot" },
    });

    ax += 100;
  }
  y += 230;

  // Continuous coverage
  drawBitmapLabel(image, "CONTINUOUS COVERAGE", 40, y, 2);
  y += 28;
  const coverage = [
    { id: "COV-SOLID-100", a: 255, label: "100% solid" },
    { id: "COV-ALPHA-75", a: 191, label: "75% alpha" },
    { id: "COV-ALPHA-50", a: 128, label: "50% alpha" },
    { id: "COV-ALPHA-25", a: 64, label: "25% alpha" },
  ];
  ax = 40;
  for (const c of coverage) {
    fillRect(image, ax, y, 160, 120, { r: 0, g: 0, b: 0, a: c.a });
    drawBitmapLabel(image, c.id, ax, y + 126, 2);
    specimens.push({
      id: c.id,
      sheetId: "SHEET_B",
      category: "continuous_coverage",
      label: c.label,
      bounds: { x: ax, y, widthPx: 160, heightPx: 120 },
      rgba: { r: 0, g: 0, b: 0, a: c.a },
      requested: { alpha: c.a },
    });
    ax += 180;
  }
  y += 170;

  const gradId = "COV-GRAD-H";
  fillGradientHorizontal(image, 40, y, 600, 100, { r: 0, g: 0, b: 0 });
  drawBitmapLabel(image, gradId, 40, y + 106, 2);
  specimens.push({
    id: gradId,
    sheetId: "SHEET_B",
    category: "continuous_coverage",
    label: "Horizontal alpha gradient 0→255",
    bounds: { x: 40, y, widthPx: 600, heightPx: 100 },
    requested: { shape: "gradient_horizontal" },
  });
  y += 140;

  const darkId = "COV-DARK-FIELD";
  fillRect(image, 40, y, 400, 120, { r: 10, g: 10, b: 10, a: 255 });
  drawBitmapLabel(image, darkId, 40, y + 126, 2);
  specimens.push({
    id: darkId,
    sheetId: "SHEET_B",
    category: "continuous_coverage",
    label: "Large dark tonal field",
    bounds: { x: 40, y, widthPx: 400, heightPx: 120 },
    rgba: { r: 10, g: 10, b: 10, a: 255 },
  });
  y += 160;

  // Halftone patches — practical subset
  drawBitmapLabel(image, "HALFTONE PATCHES EXISTING ENGINE", 40, y, 2);
  y += 28;
  const tonalSource = createTransparentCanvas(180, 140);
  fillGradientHorizontal(tonalSource, 0, 0, 180, 140, { r: 20, g: 20, b: 20 });

  const htConfigs = [
    { id: "HT-35LPI-50", lpi: DEFAULT_HALFTONE_LPI, angleDeg: 45 as const, midtone: 1, chokePx: 0, dotShape: "round" as const },
    { id: "HT-25LPI-50", lpi: 25, angleDeg: 45 as const, midtone: 1, chokePx: 0, dotShape: "round" as const },
    { id: "HT-45LPI-50", lpi: 45, angleDeg: 45 as const, midtone: 1, chokePx: 0, dotShape: "round" as const },
    { id: "HT-35LPI-225", lpi: 35, angleDeg: 22.5 as const, midtone: 1, chokePx: 0, dotShape: "round" as const },
    { id: "HT-35LPI-ELL", lpi: 35, angleDeg: 45 as const, midtone: 1, chokePx: 0, dotShape: "ellipse" as const },
    { id: "HT-35LPI-CH1", lpi: 35, angleDeg: 45 as const, midtone: 1, chokePx: 1, dotShape: "round" as const },
  ];

  ax = 40;
  let rowY = y;
  for (const cfg of htConfigs) {
    if (ax > widthPx - 200) {
      ax = 40;
      rowY += 180;
    }
    const base = recommendedHalftoneSettings(BLACK_GARMENT);
    const settings = {
      ...base,
      lpi: cfg.lpi,
      angleDeg: cfg.angleDeg,
      midtone: cfg.midtone,
      chokePx: cfg.chokePx,
      dotShape: cfg.dotShape,
    };
    const screened = applyHalftoneScreen(tonalSource, settings, CALIBRATION_PPI);
    blit(image, screened.image, ax, rowY);
    drawBitmapLabel(image, cfg.id, ax, rowY + 146, 1);
    specimens.push({
      id: cfg.id,
      sheetId: "SHEET_B",
      category: "halftone",
      label: `Halftone ${cfg.lpi} LPI`,
      bounds: { x: ax, y: rowY, widthPx: 180, heightPx: 140 },
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
    ax += 200;
  }

  return { image, specimens, widthIn: SHEET_B_WIDTH_IN, heightIn: SHEET_B_HEIGHT_IN };
}
