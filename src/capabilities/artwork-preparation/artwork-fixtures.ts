/**
 * Test support for `ArtworkPreparationCapability` — synthetic artwork with
 * precisely known properties.
 *
 * These are SYNTHETIC on purpose. The audited reference case is a real
 * customer's bowling logo, and committing a customer's artwork to the
 * repository to serve as a regression fixture would be both a privacy problem
 * and an ownership one (Constitution §16). `bowlingStyleArtwork` instead
 * reproduces the properties that actually made that file hard — near-black
 * exterior touching all four edges, a light subject, intentional interior
 * black strokes, an anti-aliased boundary, and a roughly matching aspect
 * ratio — so the regression is about the algorithm rather than about one
 * file.
 *
 * Everything here is deterministic: no randomness, so a fixture's pixel
 * statistics are a property of the code rather than of the run.
 */

import type { RgbaImage } from "@/capabilities/final-artwork/raster-transform";

import { encodeRgbaToPng } from "./image-decode";

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

export const NEAR_BLACK: Rgba = { r: 0, g: 0, b: 0, a: 255 };
export const WHITE: Rgba = { r: 250, g: 250, b: 250, a: 255 };
export const GOLD: Rgba = { r: 212, g: 168, b: 62, a: 255 };
export const TRANSPARENT: Rgba = { r: 0, g: 0, b: 0, a: 0 };

export function createCanvas(width: number, height: number, fill: Rgba): RgbaImage {
  const image: RgbaImage = { width, height, data: Buffer.alloc(width * height * 4) };
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    writePixel(image, pixel, fill);
  }
  return image;
}

export function setPixel(image: RgbaImage, x: number, y: number, color: Rgba): void {
  if (x < 0 || y < 0 || x >= image.width || y >= image.height) return;
  writePixel(image, y * image.width + x, color);
}

export function getPixel(image: RgbaImage, x: number, y: number): Rgba {
  const idx = (y * image.width + x) * 4;
  return {
    r: image.data[idx]!,
    g: image.data[idx + 1]!,
    b: image.data[idx + 2]!,
    a: image.data[idx + 3]!,
  };
}

export function fillRect(
  image: RgbaImage,
  x: number,
  y: number,
  width: number,
  height: number,
  color: Rgba,
): void {
  for (let row = y; row < y + height; row += 1) {
    for (let column = x; column < x + width; column += 1) {
      setPixel(image, column, row, color);
    }
  }
}

/**
 * Filled ellipse with an anti-aliased rim: pixels whose distance from the
 * boundary is within `feather` blend proportionally toward `background`,
 * exactly the way a real export composites a soft edge over an opaque
 * backdrop.
 */
export function fillEllipse(
  image: RgbaImage,
  centerX: number,
  centerY: number,
  radiusX: number,
  radiusY: number,
  color: Rgba,
  options: { feather?: number; background?: Rgba } = {},
): void {
  const feather = options.feather ?? 0;
  const background = options.background ?? TRANSPARENT;

  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const nx = (x + 0.5 - centerX) / radiusX;
      const ny = (y + 0.5 - centerY) / radiusY;
      const radial = Math.sqrt(nx * nx + ny * ny);
      if (radial > 1) continue;

      if (feather <= 0) {
        setPixel(image, x, y, color);
        continue;
      }

      // Distance from the rim, in units of the feather band.
      const featherFraction = Math.min(radiusX, radiusY) === 0
        ? 1
        : (1 - radial) / (feather / Math.min(radiusX, radiusY));
      const coverage = Math.min(1, Math.max(0, featherFraction));
      setPixel(image, x, y, blend(background, color, coverage));
    }
  }
}

export function blend(from: Rgba, to: Rgba, coverage: number): Rgba {
  const mix = (a: number, b: number) => Math.round(a + (b - a) * coverage);
  return {
    r: mix(from.r, to.r),
    g: mix(from.g, to.g),
    b: mix(from.b, to.b),
    a: mix(from.a, to.a),
  };
}

/** Deterministic 0/1/2 dither, so a "solid" export carries realistic encoder noise. */
export function nearBlackNoise(x: number, y: number): number {
  const hash = (x * 73_856_093) ^ (y * 19_349_663);
  const bucket = Math.abs(hash) % 100;
  if (bucket < 40) return 0;
  if (bucket < 82) return 1;
  return 2;
}

// --- Fixture A–I -----------------------------------------------------------

/** A: white subject on a solid black exterior touching all four edges. */
export function solidBlackExteriorArtwork(): RgbaImage {
  const image = createCanvas(120, 120, NEAR_BLACK);
  fillRect(image, 30, 30, 60, 60, WHITE);
  return image;
}

/** B: a black outline stroke fully enclosed BY the subject — intentional line work. */
export function internalBlackOutlineArtwork(): RgbaImage {
  const image = createCanvas(120, 120, NEAR_BLACK);
  fillRect(image, 20, 20, 80, 80, WHITE);
  // A hollow black square well inside the white subject.
  fillRect(image, 40, 40, 40, 4, NEAR_BLACK);
  fillRect(image, 40, 76, 40, 4, NEAR_BLACK);
  fillRect(image, 40, 40, 4, 40, NEAR_BLACK);
  fillRect(image, 76, 40, 4, 40, NEAR_BLACK);
  return image;
}

/** C: a solid black region enclosed by the subject, connected to nothing outside. */
export function enclosedBlackRegionArtwork(): RgbaImage {
  const image = createCanvas(120, 120, NEAR_BLACK);
  fillRect(image, 20, 20, 80, 80, GOLD);
  fillRect(image, 50, 50, 20, 20, NEAR_BLACK);
  return image;
}

/** D: a "black" exterior whose real values wander between 0 and 8. */
export function nearBlackBackgroundArtwork(): RgbaImage {
  const image = createCanvas(120, 120, NEAR_BLACK);
  for (let y = 0; y < 120; y += 1) {
    for (let x = 0; x < 120; x += 1) {
      const value = ((x * 3 + y * 5) % 9) as number;
      setPixel(image, x, y, { r: value, g: value, b: value, a: 255 });
    }
  }
  fillRect(image, 35, 35, 50, 50, WHITE);
  return image;
}

/** E: the same shape on a uniform white exterior. */
export function whiteBackgroundArtwork(): RgbaImage {
  const image = createCanvas(120, 120, { r: 255, g: 255, b: 255, a: 255 });
  fillRect(image, 30, 30, 60, 60, { r: 30, g: 60, b: 140, a: 255 });
  return image;
}

/** F: already transparent — the customer did the isolation themselves. */
export function alreadyTransparentArtwork(): RgbaImage {
  const image = createCanvas(120, 120, TRANSPARENT);
  fillEllipse(image, 60, 60, 34, 34, GOLD);
  return image;
}

/** G: the subject runs off the left edge, so it touches the exterior. */
export function edgeTouchingSubjectArtwork(): RgbaImage {
  const image = createCanvas(120, 120, NEAR_BLACK);
  fillRect(image, 0, 40, 70, 40, WHITE);
  return image;
}

/** H: an anti-aliased light subject composited over a dark background — halo risk. */
export function haloArtwork(): RgbaImage {
  const image = createCanvas(140, 140, NEAR_BLACK);
  fillEllipse(image, 70, 70, 45, 45, WHITE, {
    feather: 3,
    background: NEAR_BLACK,
  });
  // An intentional dark stroke well inside the subject, to prove the fringe
  // pass never reaches interior line work.
  fillRect(image, 60, 45, 20, 6, NEAR_BLACK);
  return image;
}

/** I: a busy, photographic-looking exterior with no single background colour. */
export function complexPhotographicBackgroundArtwork(): RgbaImage {
  const image = createCanvas(120, 120, NEAR_BLACK);
  for (let y = 0; y < 120; y += 1) {
    for (let x = 0; x < 120; x += 1) {
      setPixel(image, x, y, {
        r: (x * 11 + y * 3) % 256,
        g: (x * 5 + y * 17) % 256,
        b: (x * 23 + y * 7) % 256,
        a: 255,
      });
    }
  }
  fillRect(image, 40, 40, 40, 40, WHITE);
  return image;
}

/**
 * The bowling acceptance shape, reproduced synthetically at the real
 * dimensions so the resolution analysis (923px of artwork against a 3150px
 * target for a 10.5" full-front print) is the genuine arithmetic rather than
 * a scaled approximation.
 */
export function bowlingStyleArtwork(): RgbaImage {
  const width = 979;
  const height = 1024;
  const image: RgbaImage = { width, height, data: Buffer.alloc(width * height * 4) };

  // Near-black exterior with deterministic encoder noise, touching all four
  // edges — the property that makes an edge-connected fill the right tool.
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const value = nearBlackNoise(x, y);
      setPixel(image, x, y, { r: value, g: value, b: value, a: 255 });
    }
  }

  // Light subject: ~923 x 909, anti-aliased against the dark backdrop.
  fillEllipse(image, 489, 511, 461, 454, WHITE, {
    feather: 2,
    background: { r: 1, g: 1, b: 1, a: 255 },
  });

  // Intentional interior black line work — the ~5,800 pixels that share the
  // background's colour but must survive because nothing connects them to
  // the exterior.
  fillRect(image, 200, 300, 580, 5, NEAR_BLACK);
  fillRect(image, 200, 500, 580, 5, NEAR_BLACK);
  fillRect(image, 200, 700, 580, 5, NEAR_BLACK);
  fillRect(image, 300, 350, 5, 330, NEAR_BLACK);
  fillRect(image, 680, 350, 5, 330, NEAR_BLACK);
  // A gold accent, so the subject is not a single flat colour.
  fillEllipse(image, 489, 850, 90, 60, GOLD);

  return image;
}

/** Encodes any fixture to PNG bytes, the way a real upload arrives. */
export function toPngBytes(image: RgbaImage): Buffer {
  return encodeRgbaToPng(image);
}

function writePixel(image: RgbaImage, pixel: number, color: Rgba): void {
  const idx = pixel * 4;
  image.data[idx] = color.r;
  image.data[idx + 1] = color.g;
  image.data[idx + 2] = color.b;
  image.data[idx + 3] = color.a;
}
