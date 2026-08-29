/**
 * Geometric stroke letterforms for typography calibration specimens.
 *
 * No external/system font assets are loaded (none are bundled; parsing TTF
 * would add a dependency and platform coupling). These are explicit stroke
 * constructions with known physical stroke width and cap height so Feature
 * Integrity can measure the SAME geometry that was requested — a calibration
 * surrogate clearly labeled on the sheet, not a claim of OpenType rendering.
 */

import type { RgbaImage } from "../raster-transform";
import { createTransparentCanvas, drawHLine, drawVLine, fillRect, type Rgba, INK_BLACK } from "./draw";

export interface GeometricTypeSpec {
  text: string;
  /** Cap height in pixels. */
  capHeightPx: number;
  /** Stroke thickness in pixels. */
  strokePx: number;
  style: "sans" | "bold_sans" | "condensed" | "serif_surrogate";
}

function strokeForStyle(base: number, style: GeometricTypeSpec["style"]): number {
  if (style === "bold_sans") return Math.max(base, Math.round(base * 1.6));
  if (style === "condensed") return Math.max(1, Math.round(base * 0.85));
  return base;
}

function charWidth(cap: number, style: GeometricTypeSpec["style"]): number {
  if (style === "condensed") return Math.round(cap * 0.55);
  if (style === "bold_sans") return Math.round(cap * 0.75);
  return Math.round(cap * 0.65);
}

/** Draw a simple block capital into `image` at (x,y). Returns advance width. */
function drawCap(
  image: RgbaImage,
  ch: string,
  x: number,
  y: number,
  cap: number,
  stroke: number,
  style: GeometricTypeSpec["style"],
  color: Rgba,
): number {
  const w = charWidth(cap, style);
  const serif = style === "serif_surrogate" ? Math.max(1, Math.round(stroke * 0.8)) : 0;
  const ink = color;

  const bar = (x0: number, y0: number, bw: number, bh: number) => fillRect(image, x0, y0, bw, bh, ink);

  switch (ch) {
    case " ":
      return Math.round(w * 0.6);
    case "A":
      drawVLine(image, y, y + cap, x + Math.floor(stroke / 2), stroke, ink);
      drawVLine(image, y, y + cap, x + w - Math.floor(stroke / 2), stroke, ink);
      drawHLine(image, x, x + w, y + Math.floor(cap * 0.55), stroke, ink);
      drawHLine(image, x, x + w, y + Math.floor(stroke / 2), stroke, ink);
      break;
    case "B":
    case "D":
    case "O":
    case "C":
    case "G":
    case "P":
    case "R":
    case "S":
    case "E":
    case "F":
    case "H":
    case "I":
    case "L":
    case "T":
    case "U":
    case "N":
    case "M":
    case "X":
    case "Y":
    case "Z":
    case "1":
    case "2":
    case "3":
    default: {
      // Generic readable block: left stem + top/mid/bottom bars — enough for
      // Feature Integrity stroke measurement at known thickness.
      bar(x, y, stroke, cap);
      bar(x, y, w, stroke);
      bar(x, y + Math.floor(cap / 2) - Math.floor(stroke / 2), Math.floor(w * 0.85), stroke);
      bar(x, y + cap - stroke, w, stroke);
      if (serif > 0) {
        bar(x - serif, y, stroke + serif * 2, stroke);
        bar(x - serif, y + cap - stroke, stroke + serif * 2, stroke);
      }
      break;
    }
  }
  return w + Math.max(2, Math.round(stroke * 0.6));
}

export function renderGeometricType(spec: GeometricTypeSpec, color: Rgba = INK_BLACK): {
  image: RgbaImage;
  strokePx: number;
  capHeightPx: number;
  bounds: { widthPx: number; heightPx: number };
} {
  const stroke = strokeForStyle(spec.strokePx, spec.style);
  const cap = spec.capHeightPx;
  const approxW = spec.text.length * (charWidth(cap, spec.style) + stroke);
  const image = createTransparentCanvas(Math.max(8, approxW + 8), cap + 4);
  let cursor = 2;
  for (const ch of spec.text.toUpperCase()) {
    cursor += drawCap(image, ch, cursor, 2, cap, stroke, spec.style, color);
  }
  return {
    image,
    strokePx: stroke,
    capHeightPx: cap,
    bounds: { widthPx: cursor + 2, heightPx: cap + 4 },
  };
}
