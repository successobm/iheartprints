/**
 * Deterministic drawing primitives for calibration sheets.
 * Pure RGBA buffers — no codec, no I/O.
 */

import type { RgbaImage } from "../raster-transform";

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

export const INK_BLACK: Rgba = { r: 0, g: 0, b: 0, a: 255 };
export const INK_LABEL: Rgba = { r: 40, g: 40, b: 40, a: 255 };
export const TRANSPARENT: Rgba = { r: 0, g: 0, b: 0, a: 0 };

export function createTransparentCanvas(width: number, height: number): RgbaImage {
  return {
    width,
    height,
    data: Buffer.alloc(width * height * 4, 0),
  };
}

export function setPixel(image: RgbaImage, x: number, y: number, color: Rgba): void {
  if (x < 0 || y < 0 || x >= image.width || y >= image.height) return;
  const i = (y * image.width + x) * 4;
  image.data[i] = color.r;
  image.data[i + 1] = color.g;
  image.data[i + 2] = color.b;
  image.data[i + 3] = color.a;
}

export function fillRect(
  image: RgbaImage,
  x0: number,
  y0: number,
  width: number,
  height: number,
  color: Rgba,
): void {
  const x1 = Math.min(image.width, Math.ceil(x0 + width));
  const y1 = Math.min(image.height, Math.ceil(y0 + height));
  const xs = Math.max(0, Math.floor(x0));
  const ys = Math.max(0, Math.floor(y0));
  for (let y = ys; y < y1; y += 1) {
    for (let x = xs; x < x1; x += 1) {
      setPixel(image, x, y, color);
    }
  }
}

/** Axis-aligned stroke of exact `thicknessPx` (odd preferred for centering). */
export function drawHLine(
  image: RgbaImage,
  x0: number,
  x1: number,
  yCenter: number,
  thicknessPx: number,
  color: Rgba,
): { x0: number; y0: number; x1: number; y1: number } {
  const half = Math.floor(thicknessPx / 2);
  const y0 = yCenter - half;
  fillRect(image, x0, y0, x1 - x0, thicknessPx, color);
  return { x0, y0, x1, y1: y0 + thicknessPx };
}

export function drawVLine(
  image: RgbaImage,
  y0: number,
  y1: number,
  xCenter: number,
  thicknessPx: number,
  color: Rgba,
): { x0: number; y0: number; x1: number; y1: number } {
  const half = Math.floor(thicknessPx / 2);
  const x0 = xCenter - half;
  fillRect(image, x0, y0, thicknessPx, y1 - y0, color);
  return { x0, y0, x1: x0 + thicknessPx, y1 };
}

/** Bresenham-style thick diagonal — thickness is perpendicular extent in px. */
export function drawDiagonalLine(
  image: RgbaImage,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  thicknessPx: number,
  color: Rgba,
): void {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  const half = thicknessPx / 2;
  const steps = Math.ceil(len);
  for (let s = 0; s <= steps; s += 1) {
    const t = s / steps;
    const cx = x0 + dx * t;
    const cy = y0 + dy * t;
    for (let k = -half; k <= half; k += 0.5) {
      setPixel(image, Math.round(cx + nx * k), Math.round(cy + ny * k), color);
    }
  }
}

export function drawCircleRing(
  image: RgbaImage,
  cx: number,
  cy: number,
  outerRadiusPx: number,
  strokePx: number,
  color: Rgba,
): void {
  const inner = Math.max(0, outerRadiusPx - strokePx);
  const rOut2 = outerRadiusPx * outerRadiusPx;
  const rIn2 = inner * inner;
  const x0 = Math.max(0, Math.floor(cx - outerRadiusPx - 1));
  const x1 = Math.min(image.width - 1, Math.ceil(cx + outerRadiusPx + 1));
  const y0 = Math.max(0, Math.floor(cy - outerRadiusPx - 1));
  const y1 = Math.min(image.height - 1, Math.ceil(cy + outerRadiusPx + 1));
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const d2 = (x - cx) * (x - cx) + (y - cy) * (y - cy);
      if (d2 <= rOut2 && d2 >= rIn2) setPixel(image, x, y, color);
    }
  }
}

export function fillCircle(image: RgbaImage, cx: number, cy: number, radiusPx: number, color: Rgba): void {
  const r2 = radiusPx * radiusPx;
  const x0 = Math.max(0, Math.floor(cx - radiusPx - 1));
  const x1 = Math.min(image.width - 1, Math.ceil(cx + radiusPx + 1));
  const y0 = Math.max(0, Math.floor(cy - radiusPx - 1));
  const y1 = Math.min(image.height - 1, Math.ceil(cy + radiusPx + 1));
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      if ((x - cx) * (x - cx) + (y - cy) * (y - cy) <= r2) setPixel(image, x, y, color);
    }
  }
}

/** Solid block with a transparent channel of exact thickness through the middle. */
export function drawNegativeChannelBlock(
  image: RgbaImage,
  x: number,
  y: number,
  blockW: number,
  blockH: number,
  channelThicknessPx: number,
  orientation: "horizontal" | "vertical" | "diagonal",
  ink: Rgba = INK_BLACK,
): void {
  fillRect(image, x, y, blockW, blockH, ink);
  if (orientation === "horizontal") {
    const cy = y + Math.floor(blockH / 2);
    const half = Math.floor(channelThicknessPx / 2);
    fillRect(image, x, cy - half, blockW, channelThicknessPx, TRANSPARENT);
  } else if (orientation === "vertical") {
    const cx = x + Math.floor(blockW / 2);
    const half = Math.floor(channelThicknessPx / 2);
    fillRect(image, cx - half, y, channelThicknessPx, blockH, TRANSPARENT);
  } else {
    // Punch a diagonal band of transparent pixels.
    for (let py = y; py < y + blockH; py += 1) {
      for (let px = x; px < x + blockW; px += 1) {
        const t = (px - x) / blockW;
        const lineY = y + t * blockH;
        if (Math.abs(py - lineY) <= channelThicknessPx / 2) {
          setPixel(image, px, py, TRANSPARENT);
        }
      }
    }
  }
}

export function drawEnclosedHole(
  image: RgbaImage,
  x: number,
  y: number,
  blockW: number,
  blockH: number,
  holeDiameterPx: number,
  ink: Rgba = INK_BLACK,
): void {
  fillRect(image, x, y, blockW, blockH, ink);
  fillCircle(image, x + blockW / 2, y + blockH / 2, holeDiameterPx / 2, TRANSPARENT);
}

/** Copy a rectangular region from source into dest at (dx,dy). */
export function blit(
  dest: RgbaImage,
  source: RgbaImage,
  dx: number,
  dy: number,
  sx = 0,
  sy = 0,
  sw = source.width,
  sh = source.height,
): void {
  for (let y = 0; y < sh; y += 1) {
    for (let x = 0; x < sw; x += 1) {
      const si = ((sy + y) * source.width + (sx + x)) * 4;
      setPixel(dest, dx + x, dy + y, {
        r: source.data[si]!,
        g: source.data[si + 1]!,
        b: source.data[si + 2]!,
        a: source.data[si + 3]!,
      });
    }
  }
}

export function fillGradientHorizontal(
  image: RgbaImage,
  x: number,
  y: number,
  w: number,
  h: number,
  rgb: { r: number; g: number; b: number },
): void {
  for (let col = 0; col < w; col += 1) {
    const a = Math.round((col / Math.max(1, w - 1)) * 255);
    fillRect(image, x + col, y, 1, h, { ...rgb, a });
  }
}

/** Mulberry32 — deterministic PRNG for distress. */
export function createSeededRng(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}
