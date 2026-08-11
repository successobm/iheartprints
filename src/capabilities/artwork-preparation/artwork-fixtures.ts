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
/**
 * A REAL measured outline colour from the audited bowling artwork, against
 * its measured ≈(1,1,1) background.
 *
 * This value is the whole reason the first cavity classifier failed on the
 * customer's file. Chebyshev distance 15 puts it clearly outside a tolerance
 * of 12 — unambiguously foreground — while its Euclidean distance from the
 * background is only ~16.6. Fixtures that outline artwork in bright white
 * cannot exercise that gap, and the original suite's did, which is why it
 * passed while the real file did not.
 */
export const DARK_OUTLINE: Rgba = { r: 16, g: 8, b: 0, a: 255 };
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

/**
 * Fills a rectangle with the SAME dithered near-black the exterior carries.
 *
 * Used to punch counters and cavities. A real letter counter is not "a black
 * rectangle drawn inside a letter" — it is the original background, still
 * visible through a hole, carrying the background's own encoder noise. A
 * fixture that filled counters with flat `NEAR_BLACK` would be testing an
 * easier problem than the one the customer's file poses.
 */
export function punchBackgroundCavity(
  image: RgbaImage,
  x: number,
  y: number,
  width: number,
  height: number,
): void {
  for (let row = y; row < y + height; row += 1) {
    for (let column = x; column < x + width; column += 1) {
      const value = nearBlackNoise(column, row);
      setPixel(image, column, row, { r: value, g: value, b: value, a: 255 });
    }
  }
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

// --- Enclosed background cavities (Phase 1 follow-up) ----------------------
//
// The exterior fill is blind to background a foreground shape has sealed off
// from the border. These fixtures state, one property each, where that
// background must be removed and where the SAME colour, equally enclosed, is
// the customer's artwork and must survive. Nothing here is typographic: the
// shapes are rings, plates, and bars, because the algorithm is topological.

/** Foreground ring enclosing a region of true background colour. Expect: REMOVED. */
export function foregroundRingArtwork(): RgbaImage {
  const image = createCanvas(120, 120, NEAR_BLACK);
  fillEllipse(image, 60, 60, 40, 40, GOLD);
  fillEllipse(image, 60, 60, 25, 25, NEAR_BLACK);
  return image;
}

/**
 * A typography-LIKE shape: a solid body with one enclosed counter, of the
 * proportions a bold letterform actually has (an 18px-and-12px wall around a
 * 12px-inradius counter). Expect: counter REMOVED.
 */
export function letterCounterArtwork(): RgbaImage {
  const image = createCanvas(120, 120, NEAR_BLACK);
  fillRect(image, 30, 20, 60, 80, WHITE);
  punchBackgroundCavity(image, 48, 32, 24, 56);
  return image;
}

/**
 * Three counters at three scales in one image — display size, body size, and
 * the 4px-wall case that small wording produces. Expect: ALL THREE REMOVED.
 */
export function multipleCountersArtwork(): RgbaImage {
  const image = createCanvas(160, 120, NEAR_BLACK);

  fillRect(image, 10, 20, 50, 70, WHITE);
  punchBackgroundCavity(image, 24, 34, 22, 42);

  fillRect(image, 70, 20, 34, 50, WHITE);
  punchBackgroundCavity(image, 78, 28, 18, 34);

  fillRect(image, 115, 25, 18, 22, WHITE);
  punchBackgroundCavity(image, 119, 29, 10, 14);

  return image;
}

/**
 * THE NEGATIVE CONTROL: a bowling ball's finger holes. Enclosed, black, the
 * same colour as the background, surrounded entirely by foreground — and the
 * customer's artwork. Expect: PRESERVED.
 *
 * The only thing that separates these from the counters above is how much
 * foreground stands between them and the outside: 48px of ball around a 12px
 * hole, against 4px of stroke around a 5px counter.
 */
export function fingerHoleArtwork(): RgbaImage {
  const image = createCanvas(320, 320, NEAR_BLACK);
  fillEllipse(image, 160, 160, 110, 110, GOLD);
  fillEllipse(image, 130, 120, 12, 12, NEAR_BLACK);
  fillEllipse(image, 190, 120, 12, 12, NEAR_BLACK);
  fillEllipse(image, 160, 175, 12, 12, NEAR_BLACK);
  return image;
}

/** An intentional black drop shadow under a shape, deep inside a light plate. Expect: PRESERVED. */
export function intentionalShadowArtwork(): RgbaImage {
  const image = createCanvas(240, 240, NEAR_BLACK);
  fillEllipse(image, 120, 120, 100, 100, WHITE);
  fillEllipse(image, 120, 100, 60, 45, GOLD);
  fillEllipse(image, 120, 160, 55, 8, NEAR_BLACK);
  return image;
}

/**
 * Near-black FOREGROUND artwork on a black background: a charcoal ring around
 * a large black interior. The wall here is thin relative to what it encloses,
 * so the geometry alone would say "cavity" — and it is wrong. The enclosing
 * wall is not convincingly foreground, which is the evidence that refuses it.
 * Expect: PRESERVED, conservatively.
 */
export function nearBlackForegroundArtwork(): RgbaImage {
  const image = createCanvas(160, 160, NEAR_BLACK);
  fillRect(image, 30, 30, 100, 100, { r: 26, g: 26, b: 26, a: 255 });
  fillRect(image, 45, 45, 70, 70, NEAR_BLACK);
  return image;
}

/**
 * The identical geometry on a WHITE background with a dark subject. Nothing in
 * the algorithm knows what colour a background is; this fixture is what proves
 * it. Expect: counter REMOVED.
 */
export function lightBackgroundCounterArtwork(): RgbaImage {
  const white: Rgba = { r: 250, g: 250, b: 250, a: 255 };
  const image = createCanvas(120, 120, white);
  fillRect(image, 30, 20, 60, 80, { r: 20, g: 35, b: 90, a: 255 });
  fillRect(image, 48, 32, 24, 56, white);
  return image;
}

// --- Dark-walled counters (the real-file failure mode) ---------------------
//
// Real typography is outlined in DARK ink, and the counter's immediate
// boundary is that inner outline — not the letter's bright fill. These
// fixtures put the measured `DARK_OUTLINE` directly against the counter, so
// the enclosing wall is affirmatively non-background while being nowhere near
// high-contrast. That is the exact configuration the customer's file has and
// the earlier bright-walled surrogates did not.

/** Fills the canvas with the exterior's dither, at the real ≈(1,1,1) level. */
function ditheredNearBlackCanvas(width: number, height: number): RgbaImage {
  const image: RgbaImage = { width, height, data: Buffer.alloc(width * height * 4) };
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const value = nearBlackNoise(x, y);
      setPixel(image, x, y, { r: value, g: value, b: value, a: 255 });
    }
  }
  return image;
}

/**
 * A tagline-scale outlined glyph: dark outline, bright fill, dark INNER
 * outline, background counter. Wall ≈9px around a 5px-inradius counter.
 *
 * Expect: counter REMOVED. Under the old contrast rule its boundary scored 0
 * and it was refused; the enclosing ink is foreground, and that is all the
 * topology needs it to be.
 */
export function darkOutlinedTaglineArtwork(): RgbaImage {
  const image = ditheredNearBlackCanvas(120, 120);
  fillRect(image, 32, 42, 28, 36, DARK_OUTLINE);
  fillRect(image, 35, 45, 22, 30, WHITE);
  fillRect(image, 39, 49, 14, 22, DARK_OUTLINE);
  punchBackgroundCavity(image, 41, 51, 10, 18);
  return image;
}

/**
 * The SAME construction at display scale, with the compound stroke a heavy
 * outlined face actually carries: 8px outer outline + 14px fill + 8px inner
 * outline = a 30px wall around an 11px-inradius counter.
 *
 * This reproduces the audited real large counters (wall 26 and 61 against
 * allowances of 19.75 and 26.75). It is a CHARACTERIZATION fixture: the
 * boundary evidence now passes, and the wall/inradius geometry is what still
 * refuses it. See `background-cavities.test.ts` for what that pins.
 */
export function darkOutlinedDisplayArtwork(): RgbaImage {
  const image = ditheredNearBlackCanvas(160, 180);
  fillRect(image, 30, 30, 82, 100, DARK_OUTLINE);
  fillRect(image, 38, 38, 66, 84, WHITE);
  fillRect(image, 52, 52, 38, 56, DARK_OUTLINE);
  punchBackgroundCavity(image, 60, 60, 22, 40);
  return image;
}

/**
 * The light-background analogue, with an equally low-contrast wall: a
 * (232,232,232) body on a (250,250,250) background. Chebyshev 18 against a
 * tolerance of 12 — foreground — but only ~31 Euclidean away, so the old rule
 * refused this too. Expect: counter REMOVED.
 */
export function lowContrastLightWallArtwork(): RgbaImage {
  const background: Rgba = { r: 250, g: 250, b: 250, a: 255 };
  const image = createCanvas(120, 120, background);
  fillRect(image, 30, 20, 60, 80, { r: 232, g: 232, b: 232, a: 255 });
  fillRect(image, 48, 32, 24, 56, background);
  return image;
}

/**
 * Phase 1.2, Part A: the HAIRLINE COUNTER case, reproducing the real geometry
 * that the base wall allowance of 4px refused.
 *
 * Two pixels wide, so every pixel of the counter is on its own boundary and
 * its inradius is exactly 1 — which is what makes `CAVITY_WALL_INRADIUS_RATIO`
 * contribute under two pixels and leaves `CAVITY_WALL_BASE_PX` deciding the
 * case single-handed. Six pixels of stroke stand between it and the exterior,
 * measured as a wall of 7.
 *
 *   base 4: allowance 5.75  <  7  → refused (the real "DISTURBING" R and B)
 *   base 6: allowance 7.75 >=  7  → removed
 */
export function hairlineCounterArtwork(): RgbaImage {
  const image = ditheredNearBlackCanvas(80, 80);
  fillRect(image, 20, 20, 20, 40, WHITE);
  punchBackgroundCavity(image, 26, 26, 2, 28);
  return image;
}

/**
 * Phase 1.2, Part B: the SPECKLE case — isolated near-background residue that
 * the fill tolerance just missed, alongside every kind of thing that must
 * survive it.
 *
 *   - four isolated flecks at (14,14,14): Chebyshev 13 against a tolerance of
 *     12, so the flood fill goes around them and leaves them behind. This is
 *     the real mechanism, not an approximation of it — the audited file's
 *     residue measured 13–24.
 *   - one isolated 3px cluster of the same, because the real population ran to
 *     four pixels.
 *   - a bright red isolated dot, which is a deliberate accent and fails the
 *     colour evidence by a mile. MUST SURVIVE.
 *   - a 3px near-background cluster DEEP INSIDE the white subject, attached to
 *     artwork on every side. MUST SURVIVE — it is not isolated.
 *   - a dark outline stroke along the subject's edge, touching the removed
 *     background. MUST SURVIVE — it is attached to the subject.
 */
export function speckleResidueArtwork(): RgbaImage {
  const image = ditheredNearBlackCanvas(120, 120);
  fillRect(image, 30, 30, 60, 60, DARK_OUTLINE);
  fillRect(image, 33, 33, 54, 54, WHITE);

  // Isolated residue out in the background, well clear of the subject.
  const residue: Rgba = { r: 14, g: 14, b: 14, a: 255 };
  for (const [x, y] of SPECKLE_ISLAND_POINTS) setPixel(image, x, y, residue);

  // A three-pixel island of the same residue.
  for (const [x, y] of SPECKLE_CLUSTER_POINTS) setPixel(image, x, y, residue);

  // A deliberate accent: isolated, but nothing like the background.
  setPixel(image, SPECKLE_ACCENT_POINT[0], SPECKLE_ACCENT_POINT[1], {
    r: 220,
    g: 30,
    b: 30,
    a: 255,
  });

  // Near-background pixels buried inside the artwork, attached on every side.
  for (const [x, y] of SPECKLE_INTERIOR_POINTS) setPixel(image, x, y, residue);

  return image;
}

/** The isolated single-pixel flecks in `speckleResidueArtwork`. */
export const SPECKLE_ISLAND_POINTS: Array<[number, number]> = [
  [10, 10],
  [110, 12],
  [12, 108],
  [100, 100],
];

/** The one multi-pixel island in `speckleResidueArtwork`. */
export const SPECKLE_CLUSTER_POINTS: Array<[number, number]> = [
  [60, 12],
  [61, 12],
  [60, 13],
];

/** The deliberate accent in `speckleResidueArtwork`. MUST SURVIVE. */
export const SPECKLE_ACCENT_POINT: [number, number] = [20, 60];

/** Near-background pixels deep inside the subject. MUST SURVIVE. */
export const SPECKLE_INTERIOR_POINTS: Array<[number, number]> = [
  [58, 58],
  [59, 58],
  [58, 59],
];

/**
 * The light-background analogue of `speckleResidueArtwork`: a (250,250,250)
 * background with residue at (237,237,237) — the same Chebyshev 13 past the
 * same tolerance. Nothing in the speckle pass knows what colour a background
 * is, and this is what proves it.
 */
export function lightSpeckleResidueArtwork(): RgbaImage {
  const background: Rgba = { r: 250, g: 250, b: 250, a: 255 };
  const image = createCanvas(120, 120, background);
  fillRect(image, 30, 30, 60, 60, { r: 20, g: 35, b: 90, a: 255 });
  const residue: Rgba = { r: 237, g: 237, b: 237, a: 255 };
  for (const [x, y] of SPECKLE_ISLAND_POINTS) setPixel(image, x, y, residue);
  return image;
}

/**
 * THE ACCEPTANCE SURROGATE for the enclosed-cavity defect, at the audited
 * bowling logo's real dimensions.
 *
 * The customer's own file is deliberately not committed to the repository
 * (see this module's header), so this reproduces every property that produced
 * the defect and every property that must survive the fix, in one image:
 *
 *   - near-black dithered exterior touching all four edges
 *   - a light pin plate with an anti-aliased rim
 *   - a gold ball with THREE BLACK FINGER HOLES        → must be preserved
 *   - a black outline crescent on the ball             → must be preserved
 *   - a black drop-shadow band under the pins          → must be preserved
 *   - five display-size glyph bodies with counters     → must be removed
 *   - twelve small-wording glyph bodies with counters  → must be removed
 *
 * Counters are punched with the exterior's own dither, not flat black,
 * because that is what a counter actually is: the background, still showing
 * through.
 */
export function bowlingLetterformArtwork(): RgbaImage {
  const width = 979;
  const height = 1024;
  const image: RgbaImage = { width, height, data: Buffer.alloc(width * height * 4) };

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const value = nearBlackNoise(x, y);
      setPixel(image, x, y, { r: value, g: value, b: value, a: 255 });
    }
  }

  // The pin plate, anti-aliased against the dark backdrop.
  fillEllipse(image, 489, 430, 400, 300, WHITE, {
    feather: 2,
    background: { r: 1, g: 1, b: 1, a: 255 },
  });

  // The ball: a gold disc offset inside a black one, which leaves an
  // intentional outline crescent along the lower-right rather than a closed
  // ring. Deliberately not closed — a closed ring would shield the ball's
  // whole interior from cavity analysis and make the finger-hole result
  // trivially true for the wrong reason.
  fillEllipse(image, 560, 450, 150, 150, NEAR_BLACK);
  fillEllipse(image, 554, 444, 150, 150, GOLD);

  // Finger holes.
  fillEllipse(image, 520, 400, 14, 14, NEAR_BLACK);
  fillEllipse(image, 600, 400, 14, 14, NEAR_BLACK);
  fillEllipse(image, 560, 460, 14, 14, NEAR_BLACK);

  // Drop shadow beneath the pins, kept well inside the plate so its own
  // distance from the exterior is the thing under test rather than an
  // accident of where the plate's rim happens to fall.
  fillEllipse(image, 360, 610, 90, 10, NEAR_BLACK);

  // Display lettering, sitting directly on the exterior background.
  for (const x of BOWLING_DISPLAY_GLYPH_X) {
    fillRect(image, x, 780, 100, 110, WHITE);
    punchBackgroundCavity(image, x + 20, 790, 60, 70);
  }

  // Small wording — the "DISTURBING FROM DAY ONE" case, where only 4px of
  // stroke separates each counter from the exterior.
  for (const x of BOWLING_SMALL_GLYPH_X) {
    fillRect(image, x, 940, 20, 24, WHITE);
    punchBackgroundCavity(image, x + 4, 944, 12, 16);
  }

  return image;
}

/** Left edge of each display glyph in `bowlingLetterformArtwork`. */
export const BOWLING_DISPLAY_GLYPH_X = [120, 280, 440, 600, 760];

/** Left edge of each small-wording glyph in `bowlingLetterformArtwork`. */
export const BOWLING_SMALL_GLYPH_X = Array.from(
  { length: 12 },
  (_, index) => 150 + index * 56,
);

/** Centre of each finger hole in `bowlingLetterformArtwork`. */
export const BOWLING_FINGER_HOLES = [
  { x: 520, y: 400 },
  { x: 600, y: 400 },
  { x: 560, y: 460 },
];

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
