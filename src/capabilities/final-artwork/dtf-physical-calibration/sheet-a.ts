/**
 * Positive / negative / isolated / type / distress — Sheet A feature survival.
 */

import {
  DTF_ISOLATED_COMPONENT_BLOCKING_DIAMETER_MM,
  DTF_ISOLATED_COMPONENT_WARNING_DIAMETER_MM,
  DTF_NEGATIVE_SPACE_BLOCKING_WIDTH_MM,
  DTF_NEGATIVE_SPACE_WARNING_WIDTH_MM,
  DTF_POSITIVE_FEATURE_BLOCKING_WIDTH_MM,
  DTF_POSITIVE_FEATURE_WARNING_WIDTH_MM,
} from "@/capabilities/shared/dtf-feature-integrity-profile";

import { drawBitmapLabel } from "./bitmap-font";
import {
  blit,
  createTransparentCanvas,
  createSeededRng,
  drawCircleRing,
  drawDiagonalLine,
  drawEnclosedHole,
  drawHLine,
  drawNegativeChannelBlock,
  drawVLine,
  fillCircle,
  fillRect,
  INK_BLACK,
  setPixel,
} from "./draw";
import { renderGeometricType } from "./geometric-type";
import type { SpecimenManifestEntry } from "./types";
import { CALIBRATION_PPI, inchesToPx, quantizePhysicalWidthMm } from "./units";

export const SHEET_A_WIDTH_IN = 10.5;
export const SHEET_A_HEIGHT_IN = 14;
export const DISTRESS_SEED = 0x2b4c_a1b7;

/** Dense ladder around provisional floors. */
export const POSITIVE_WIDTHS_MM = [
  0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.6, 0.75, 1.0, 1.25, 1.5,
] as const;

export const REPRESENTATIVE_WIDTHS_MM = [0.25, 0.4, 0.6, 1.0] as const;

function mmTag(mm: number): string {
  return String(Math.round(mm * 100)).padStart(3, "0");
}

export function generateSheetA(): {
  image: ReturnType<typeof createTransparentCanvas>;
  specimens: SpecimenManifestEntry[];
  widthIn: number;
  heightIn: number;
} {
  const widthPx = inchesToPx(SHEET_A_WIDTH_IN);
  const heightPx = inchesToPx(SHEET_A_HEIGHT_IN);
  const image = createTransparentCanvas(widthPx, heightPx);
  const specimens: SpecimenManifestEntry[] = [];

  let y = 40;
  drawBitmapLabel(image, "SHEET A FEATURE SURVIVAL", 40, y, 3);
  y += 40;
  drawBitmapLabel(
    image,
    `PROVISIONAL POS ${DTF_POSITIVE_FEATURE_BLOCKING_WIDTH_MM}/${DTF_POSITIVE_FEATURE_WARNING_WIDTH_MM} MM NEG ${DTF_NEGATIVE_SPACE_BLOCKING_WIDTH_MM}/${DTF_NEGATIVE_SPACE_WARNING_WIDTH_MM} MM`,
    40,
    y,
    2,
  );
  y += 36;
  drawBitmapLabel(image, "NOT PRODUCTION PASS-FAIL — PHYSICAL CALIBRATION ONLY", 40, y, 2);
  y += 50;

  // --- Positive horizontal ---
  drawBitmapLabel(image, "POSITIVE HORIZONTAL", 40, y, 2);
  y += 28;
  for (const mm of POSITIVE_WIDTHS_MM) {
    const q = quantizePhysicalWidthMm(mm);
    const id = `POS-H-${mmTag(mm)}`;
    const x0 = 40;
    const x1 = 900;
    const box = drawHLine(image, x0, x1, y + 10, q.actualPx, INK_BLACK);
    drawBitmapLabel(image, `${id} REQ ${mm.toFixed(2)} ACT ${q.actualMm.toFixed(3)} MM`, x1 + 20, y, 2);
    specimens.push({
      id,
      sheetId: "SHEET_A",
      category: "positive_stroke",
      label: `Horizontal stroke ${mm}mm`,
      bounds: { x: box.x0, y: box.y0, widthPx: box.x1 - box.x0, heightPx: box.y1 - box.y0 },
      physical: { stroke: q },
      rgba: INK_BLACK,
      requested: { orientation: "horizontal", requestedWidthMm: mm },
    });
    y += Math.max(22, q.actualPx + 18);
  }

  y += 20;
  drawBitmapLabel(image, "POSITIVE VERTICAL", 40, y, 2);
  y += 28;
  let vx = 60;
  const vTop = y;
  const vBottom = y + 280;
  for (const mm of POSITIVE_WIDTHS_MM) {
    const q = quantizePhysicalWidthMm(mm);
    const id = `POS-V-${mmTag(mm)}`;
    const box = drawVLine(image, vTop, vBottom, vx, q.actualPx, INK_BLACK);
    drawBitmapLabel(image, id, vx - 10, vBottom + 8, 1);
    specimens.push({
      id,
      sheetId: "SHEET_A",
      category: "positive_stroke",
      label: `Vertical stroke ${mm}mm`,
      bounds: { x: box.x0, y: box.y0, widthPx: box.x1 - box.x0, heightPx: box.y1 - box.y0 },
      physical: { stroke: q },
      rgba: INK_BLACK,
      requested: { orientation: "vertical", requestedWidthMm: mm },
    });
    vx += Math.max(36, q.actualPx + 28);
  }
  y = vBottom + 50;

  // --- Diagonal / curve / ring ---
  drawBitmapLabel(image, "DIAGONAL CURVE RING CORNER", 40, y, 2);
  y += 28;
  let dx = 60;
  for (const mm of REPRESENTATIVE_WIDTHS_MM) {
    const q = quantizePhysicalWidthMm(mm);
    const id = `POS-D45-${mmTag(mm)}`;
    drawDiagonalLine(image, dx, y + 120, dx + 120, y, q.actualPx, INK_BLACK);
    drawBitmapLabel(image, id, dx, y + 130, 1);
    specimens.push({
      id,
      sheetId: "SHEET_A",
      category: "diagonal_curve",
      label: `45-degree stroke ${mm}mm`,
      bounds: { x: dx, y, widthPx: 120, heightPx: 130 },
      physical: { stroke: q },
      rgba: INK_BLACK,
      requested: { orientation: "diagonal_45", requestedWidthMm: mm },
    });
    dx += 150;
  }
  for (const mm of REPRESENTATIVE_WIDTHS_MM) {
    const q = quantizePhysicalWidthMm(mm);
    const id = `POS-RING-${mmTag(mm)}`;
    const cx = dx + 50;
    const cy = y + 60;
    drawCircleRing(image, cx, cy, 48, q.actualPx, INK_BLACK);
    drawBitmapLabel(image, id, dx, y + 120, 1);
    specimens.push({
      id,
      sheetId: "SHEET_A",
      category: "diagonal_curve",
      label: `Ring stroke ${mm}mm`,
      bounds: { x: dx, y, widthPx: 110, heightPx: 130 },
      physical: { stroke: q },
      rgba: INK_BLACK,
      requested: { shape: "ring", requestedWidthMm: mm },
    });
    dx += 130;
  }
  y += 160;

  // --- Negative space ---
  drawBitmapLabel(image, "NEGATIVE SPACE CHANNELS AND HOLES", 40, y, 2);
  y += 28;
  let nx = 40;
  for (const mm of POSITIVE_WIDTHS_MM) {
    if (nx > widthPx - 120) {
      nx = 40;
      y += 110;
    }
    const q = quantizePhysicalWidthMm(mm);
    const id = `NEG-H-${mmTag(mm)}`;
    drawNegativeChannelBlock(image, nx, y, 90, 70, q.actualPx, "horizontal");
    drawBitmapLabel(image, id, nx, y + 74, 1);
    specimens.push({
      id,
      sheetId: "SHEET_A",
      category: "negative_space",
      label: `Horizontal channel ${mm}mm`,
      bounds: { x: nx, y, widthPx: 90, heightPx: 70 },
      physical: { channel: q },
      requested: { orientation: "horizontal", requestedWidthMm: mm },
    });
    nx += 100;
  }
  y += 120;
  nx = 40;
  for (const mm of REPRESENTATIVE_WIDTHS_MM) {
    const q = quantizePhysicalWidthMm(mm);
    for (const [orient, prefix] of [
      ["vertical", "NEG-V"],
      ["diagonal", "NEG-D"],
    ] as const) {
      const id = `${prefix}-${mmTag(mm)}`;
      drawNegativeChannelBlock(image, nx, y, 90, 70, q.actualPx, orient);
      drawBitmapLabel(image, id, nx, y + 74, 1);
      specimens.push({
        id,
        sheetId: "SHEET_A",
        category: "negative_space",
        label: `${orient} channel ${mm}mm`,
        bounds: { x: nx, y, widthPx: 90, heightPx: 70 },
        physical: { channel: q },
        requested: { orientation: orient, requestedWidthMm: mm },
      });
      nx += 100;
    }
  }
  y += 120;
  nx = 40;
  for (const mm of [...POSITIVE_WIDTHS_MM].filter((_, i) => i % 2 === 0)) {
    const q = quantizePhysicalWidthMm(mm);
    const id = `NEG-HOLE-${mmTag(mm)}`;
    drawEnclosedHole(image, nx, y, 80, 80, q.actualPx);
    drawBitmapLabel(image, id, nx, y + 84, 1);
    specimens.push({
      id,
      sheetId: "SHEET_A",
      category: "negative_space",
      label: `Enclosed hole ${mm}mm`,
      bounds: { x: nx, y, widthPx: 80, heightPx: 80 },
      physical: { diameter: q },
      requested: { shape: "enclosed_hole", requestedDiameterMm: mm },
    });
    nx += 95;
  }
  y += 130;

  // --- Isolated ---
  drawBitmapLabel(
    image,
    `ISOLATED ISO BLOCK ${DTF_ISOLATED_COMPONENT_BLOCKING_DIAMETER_MM} WARN ${DTF_ISOLATED_COMPONENT_WARNING_DIAMETER_MM}`,
    40,
    y,
    2,
  );
  y += 28;
  const isoMm = [0.4, 0.6, 0.8, 1.0, 1.2, 1.5, 2.0, 2.5];
  let ix = 50;
  for (const mm of isoMm) {
    const q = quantizePhysicalWidthMm(mm);
    const id = `ISO-DOT-${mmTag(mm)}`;
    const r = q.actualPx / 2;
    fillCircle(image, ix + r, y + r, r, INK_BLACK);
    drawBitmapLabel(image, id, ix, y + q.actualPx + 6, 1);
    specimens.push({
      id,
      sheetId: "SHEET_A",
      category: "isolated_component",
      label: `Isolated circle ${mm}mm`,
      bounds: { x: ix, y, widthPx: q.actualPx, heightPx: q.actualPx },
      physical: { diameter: q },
      rgba: INK_BLACK,
      requested: { shape: "circle", requestedDiameterMm: mm },
    });
    const idSq = `ISO-SQ-${mmTag(mm)}`;
    const sx = ix;
    const sy = y + 70;
    fillRect(image, sx, sy, q.actualPx, q.actualPx, INK_BLACK);
    drawBitmapLabel(image, idSq, sx, sy + q.actualPx + 6, 1);
    specimens.push({
      id: idSq,
      sheetId: "SHEET_A",
      category: "isolated_component",
      label: `Isolated square ${mm}mm`,
      bounds: { x: sx, y: sy, widthPx: q.actualPx, heightPx: q.actualPx },
      physical: { width: q, height: q },
      rgba: INK_BLACK,
      requested: { shape: "square", requestedWidthMm: mm },
    });
    ix += Math.max(70, q.actualPx + 40);
  }
  y += 160;

  // --- Typography geometric ---
  drawBitmapLabel(image, "TYPOGRAPHY GEOMETRIC SURROGATE — NO EXTERNAL FONT ASSETS", 40, y, 2);
  y += 28;
  const typeSpecs = [
    { id: "TYPE-SANS-SM", text: "DTF 123 ABC", style: "sans" as const, capMm: 2.5, strokeMm: 0.35 },
    { id: "TYPE-SANS-MD", text: "SMALL TYPE", style: "sans" as const, capMm: 4.0, strokeMm: 0.5 },
    { id: "TYPE-BOLD-MD", text: "STRIKE TEST", style: "bold_sans" as const, capMm: 4.0, strokeMm: 0.5 },
    { id: "TYPE-COND-MD", text: "DTF 123 ABC", style: "condensed" as const, capMm: 4.0, strokeMm: 0.4 },
    { id: "TYPE-SERF-MD", text: "SMALL TYPE", style: "serif_surrogate" as const, capMm: 4.0, strokeMm: 0.45 },
  ];
  for (const t of typeSpecs) {
    const capQ = quantizePhysicalWidthMm(t.capMm);
    const strokeQ = quantizePhysicalWidthMm(t.strokeMm);
    const rendered = renderGeometricType({
      text: t.text,
      style: t.style,
      capHeightPx: capQ.actualPx,
      strokePx: strokeQ.actualPx,
    });
    blit(image, rendered.image, 40, y, 0, 0, rendered.bounds.widthPx, rendered.bounds.heightPx);
    drawBitmapLabel(image, t.id, 40 + rendered.bounds.widthPx + 12, y, 2);
    specimens.push({
      id: t.id,
      sheetId: "SHEET_A",
      category: "typography",
      label: t.text,
      bounds: { x: 40, y, widthPx: rendered.bounds.widthPx, heightPx: rendered.bounds.heightPx },
      typography: {
        text: t.text,
        style: t.style,
        nominalCapHeightMm: t.capMm,
        nominalStrokeMm: t.strokeMm,
        renderedCapHeightPx: rendered.capHeightPx,
        renderedStrokePx: rendered.strokePx,
        note: "Geometric stroke surrogate — not an OpenType system font.",
      },
      physical: { stroke: strokeQ, height: capQ },
    });
    y += rendered.bounds.heightPx + 24;
  }

  // --- Distress ---
  drawBitmapLabel(image, `DISTRESS SEED ${DISTRESS_SEED.toString(16)}`, 40, y, 2);
  y += 28;
  const rng = createSeededRng(DISTRESS_SEED);
  fillRect(image, 40, y, 400, 160, INK_BLACK);
  // holes
  for (let i = 0; i < 18; i += 1) {
    const hx = 50 + Math.floor(rng() * 380);
    const hy = y + 10 + Math.floor(rng() * 140);
    const hr = 1 + Math.floor(rng() * 4);
    fillCircle(image, hx, hy, hr, { r: 0, g: 0, b: 0, a: 0 });
  }
  // cracks
  for (let i = 0; i < 8; i += 1) {
    const x0 = 50 + Math.floor(rng() * 300);
    const y0 = y + 20 + Math.floor(rng() * 120);
    drawDiagonalLine(
      image,
      x0,
      y0,
      x0 + 20 + Math.floor(rng() * 40),
      y0 + (rng() > 0.5 ? 30 : -30),
      1 + Math.floor(rng() * 2),
      { r: 0, g: 0, b: 0, a: 0 },
    );
  }
  // positive specks outside
  for (let i = 0; i < 12; i += 1) {
    const sx = 460 + Math.floor(rng() * 200);
    const sy = y + Math.floor(rng() * 160);
    fillCircle(image, sx, sy, 1 + Math.floor(rng() * 3), INK_BLACK);
  }
  // ragged right edge
  for (let row = 0; row < 160; row += 1) {
    const jut = Math.floor(rng() * 8);
    for (let k = 0; k < jut; k += 1) {
      setPixel(image, 440 + k, y + row, INK_BLACK);
    }
  }
  specimens.push({
    id: "DIST-BLOCK-01",
    sheetId: "SHEET_A",
    category: "distress",
    label: "Distressed block with holes/cracks/specks",
    bounds: { x: 40, y, widthPx: 620, heightPx: 160 },
    requested: { seed: DISTRESS_SEED },
    notes: ["Fixed-seed deterministic distress"],
  });

  void CALIBRATION_PPI;
  return { image, specimens, widthIn: SHEET_A_WIDTH_IN, heightIn: SHEET_A_HEIGHT_IN };
}
