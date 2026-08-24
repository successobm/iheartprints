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

// --- Phase 1.6: opaque matte contamination ---------------------------------
//
// The failure these reproduce is NOT the anti-aliased rim the composite pass
// already handles. It is the pixel one step further out: light artwork
// composited over a near-black background, whose darkest edge value lands
// OUTSIDE the fill tolerance (so it is correctly kept) and OFF the B→F line
// (so `liesOnComposite` correctly refuses to divide it by a coverage). It
// survives fully opaque, carrying the removed background's colour, and reads
// as dark stipple the moment the artwork is placed on a light garment.

/**
 * The measured scanline from the audited bowling swoosh, verbatim.
 *
 * (11,5,0) is Chebyshev 10 from the (1,1,1) background and reads as
 * background at the audited tolerance of 12. (18,11,0) is Chebyshev 17 —
 * outside it, kept, and 9.9 off the background→foreground line against a
 * background distance of 19.75, which is what the composite guard rejects.
 * Everything after it climbs to the artwork's own colour.
 */
export const MATTE_RAMP: readonly Rgba[] = [
  { r: 11, g: 5, b: 0, a: 255 },
  { r: 18, g: 11, b: 0, a: 255 },
  { r: 42, g: 30, b: 14, a: 255 },
  { r: 79, g: 66, b: 47, a: 255 },
];
/** The swoosh's own measured colour, inward of the ramp. */
export const MATTE_ARTWORK: Rgba = { r: 161, g: 141, b: 116, a: 255 };

/**
 * A light body whose left edge carries that exact ramp. The contaminated
 * column is x = 39; x = 38 reads as background and is removed, which is what
 * puts x = 39 one pixel from confirmed exterior transparency.
 */
export function matteContaminatedEdgeArtwork(): RgbaImage {
  const image = ditheredNearBlackCanvas(120, 120);
  fillRect(image, 42, 30, 40, 60, MATTE_ARTWORK);
  for (let y = 30; y < 90; y += 1) {
    for (let step = 0; step < MATTE_RAMP.length; step += 1) {
      setPixel(image, 38 + step, y, MATTE_RAMP[step]!);
    }
  }
  return image;
}

/**
 * The NEGATIVE CONTROL: the same light body behind a genuine 3px dark outline
 * that runs right up to the removed background.
 *
 * Its outermost column sits exactly where the contaminated column sits in the
 * fixture above, is exactly as dark, and is exactly as adjacent to
 * transparency. The ONLY thing that distinguishes it is that the dark
 * continues for three pixels instead of stopping after one — which is
 * precisely the discriminator the audit measured, and the reason this pass
 * asks how thick a dark structure is rather than how dark it is.
 */
export function thickDarkOutlineArtwork(): RgbaImage {
  const image = ditheredNearBlackCanvas(120, 120);
  fillRect(image, 42, 30, 40, 60, MATTE_ARTWORK);
  fillRect(image, 39, 30, 3, 60, DARK_OUTLINE);
  return image;
}

/**
 * The SAME contaminated first column, over an edge that then gets DARKER
 * before it brightens. Everything the composite model sees is identical — same
 * colour, same distance from the background, same refusal — so this fixture
 * isolates the ramp test on its own.
 *
 * The audit found ~557 pixels of exactly this character: dark, at the
 * silhouette, with neither a clean rising ramp nor a clean plateau. There is
 * no evidence here that says background composite rather than something the
 * customer drew, and the pass is not in the business of guessing.
 * Expect: preserved, unchanged, and COUNTED as undecided.
 */
export function ambiguousDarkEdgeArtwork(): RgbaImage {
  const image = ditheredNearBlackCanvas(120, 120);
  fillRect(image, 42, 30, 40, 60, MATTE_ARTWORK);
  for (let y = 30; y < 90; y += 1) {
    setPixel(image, 38, y, MATTE_RAMP[0]!);
    setPixel(image, 39, y, MATTE_RAMP[1]!);
    setPixel(image, 40, y, { r: 14, g: 8, b: 0, a: 255 }); // dips instead of climbing
    setPixel(image, 41, y, MATTE_RAMP[3]!);
  }
  return image;
}

/**
 * The light-background mirror: a dark body on a near-white background, with
 * its edge ramp running the other way. Nothing in this pass may fire here —
 * the forensics that justify it measured DARK contamination only, and a pass
 * that guessed at the inverse case would be inventing evidence it does not
 * have.
 */
export function lightBackgroundEdgeArtwork(): RgbaImage {
  const background: Rgba = { r: 250, g: 250, b: 250, a: 255 };
  const image = createCanvas(120, 120, background);
  fillRect(image, 42, 30, 40, 60, { r: 20, g: 35, b: 90, a: 255 });
  for (let y = 30; y < 90; y += 1) {
    setPixel(image, 39, y, { r: 238, g: 238, b: 240, a: 255 });
    setPixel(image, 40, y, { r: 180, g: 185, b: 200, a: 255 });
    setPixel(image, 41, y, { r: 90, g: 100, b: 140, a: 255 });
  }
  return image;
}

/**
 * PHASE 1.6B FIXTURE — the residue Phase 1.6's single inward normal cannot see,
 * alongside the two structures that must survive it.
 *
 * Everything sits on the top edge of one light body, so every feature is the
 * same colour, the same distance from the removed background, and equally
 * adjacent to confirmed transparency. The ONLY thing that differs between them
 * is the shape of the dark component each one belongs to.
 *
 *   `RESIDUAL_SPECK_POINTS`   1px flecks of matte. Transparent on three sides,
 *                             artwork on the fourth. Phase 1.6 picks the first
 *                             probe direction whose opposite is transparent —
 *                             which here points ALONG the silhouette into more
 *                             transparency — so its ramp test has nothing to
 *                             read and it preserves them. Expect: recoloured.
 *   `RESIDUAL_INTERIOR_DOT`   the same fleck, one that does NOT touch the
 *                             exterior. A dark mark inside the artwork is the
 *                             artwork. Expect: byte-identical.
 *   `RESIDUAL_SPIKE_X`        a 1px-wide, 12px-long dark spike standing on the
 *                             body. Just as thin as a fleck and just as
 *                             blind to the ramp test — separated from one ONLY
 *                             by the size of its component. A hairline this
 *                             long is something a customer can draw, so the
 *                             island ceiling must preserve it. Expect:
 *                             byte-identical.
 */
export const RESIDUAL_SPECK_POINTS: Array<[number, number]> = [
  [40, 60],
  [50, 60],
  [60, 60],
];
export const RESIDUAL_INTERIOR_DOT: [number, number] = [70, 75];
export const RESIDUAL_SPIKE_X = 90;
export const RESIDUAL_SPIKE_TOP = 49;
export const RESIDUAL_SPIKE_BOTTOM = 61;
/** The body's top row — the inward artwork reference every fleck must find. */
export const RESIDUAL_BODY_TOP = 61;

export function residualEdgeSpeckArtwork(): RgbaImage {
  const image = ditheredNearBlackCanvas(120, 120);
  fillRect(image, 20, RESIDUAL_BODY_TOP, 80, 40, MATTE_ARTWORK);

  for (const [x, y] of RESIDUAL_SPECK_POINTS) {
    setPixel(image, x, y, DARK_OUTLINE);
  }
  setPixel(image, RESIDUAL_INTERIOR_DOT[0], RESIDUAL_INTERIOR_DOT[1], DARK_OUTLINE);
  for (let y = RESIDUAL_SPIKE_TOP; y < RESIDUAL_SPIKE_BOTTOM; y += 1) {
    setPixel(image, RESIDUAL_SPIKE_X, y, DARK_OUTLINE);
  }

  return image;
}

/**
 * Phase 16: a synthetic stand-in for the class of real-world artwork that
 * exposed the complex-background → operator-separation routing defect — a
 * large black exterior field, extensive intentional black WITHIN the
 * artwork (connected to that same exterior at the pixel level, so a simple
 * exterior fill cannot tell them apart), disconnected black artwork fully
 * enclosed by non-black colour, and a black hole/detail inside a non-black
 * shape. SYNTHETIC ONLY, for the same reason every other fixture in this
 * file is: no real customer artwork is committed to this repository
 * (Constitution §16). Colours and geometry are generic — nothing here
 * encodes any specific brand or composition.
 *
 * Deliberately touches a meaningful share of the canvas border with
 * non-black colour (the red block crossing the top-left corner, the white
 * block crossing the right edge) so the border itself reads as non-uniform
 * — `complex_exterior_background` — mirroring why the real artwork needed
 * manual review in the first place, rather than relying on an
 * exterior-mask-fraction threshold that a synthetic canvas this small could
 * miss by construction.
 */
export const RED: Rgba = { r: 196, g: 30, b: 40, a: 255 };

export function denseBlackCompositionArtwork(): RgbaImage {
  const image = createCanvas(200, 200, NEAR_BLACK);

  // Colour crossing the border itself, in two different places, so the
  // border reads as non-uniform regardless of interior mask fraction.
  fillRect(image, 0, 0, 60, 50, RED);
  fillRect(image, 150, 110, 50, 60, WHITE);

  // A disconnected black shape, fully enclosed by a red ring that never
  // touches the canvas border — topologically separate from the exterior
  // black mass. Represents intentional black artwork (e.g. a black sphere)
  // that must survive independently of the background's own black.
  fillEllipse(image, 100, 100, 34, 34, RED);
  fillEllipse(image, 100, 100, 18, 18, NEAR_BLACK);

  // A black hole/detail fully inside a non-black (white) artwork shape —
  // never touching the exterior black mass or the disconnected ellipse.
  // 16x16 (256px) clears MIN_CONSEQUENTIAL_REGION_PX (150) with margin.
  fillRect(image, 40, 140, 44, 44, WHITE);
  fillRect(image, 54, 154, 16, 16, NEAR_BLACK);

  return image;
}

/** Encodes any fixture to PNG bytes, the way a real upload arrives. */
// ---------------------------------------------------------------------------
// Phase 23 (promoted from Phase 21's scratch investigation, verified there
// to genuinely produce a nonzero in-bounds proposal — a design lesson from
// that phase: a fully-enclosed picture-frame produces NO proposal at all,
// correctly, since nothing reaches the border; an explicit gap wide enough
// to defeat SILHOUETTE_RADIUS_PX's gap-closing (>6px) is required to
// reproduce the real INCREDI-BOWLS/Split-Disturbers topology).
// ---------------------------------------------------------------------------

/** Adversarial: a picture-frame with a narrow-but-unsafe (16px) gap cut through the top bar, exposing a thin corridor of true in-bounds proposal. */
export function veryThinStripArtwork(): RgbaImage {
  const image = createCanvas(200, 200, NEAR_BLACK);
  fillRect(image, 20, 20, 160, 30, WHITE);
  fillRect(image, 20, 20, 30, 160, WHITE);
  fillRect(image, 150, 20, 30, 160, WHITE);
  fillRect(image, 20, 150, 160, 30, WHITE);
  fillRect(image, 92, 0, 16, 50, NEAR_BLACK);
  return image;
}

/** Adversarial: a long (140px) thin slit cut through a white field's top edge — a proposal strip requiring multiple preserve taps to fully cover, mirroring the real ribbon-shadow finding. */
export function longThinStripArtwork(): RgbaImage {
  const image = createCanvas(260, 100, NEAR_BLACK);
  fillRect(image, 10, 10, 240, 80, WHITE);
  fillRect(image, 60, 10, 140, 4, NEAR_BLACK);
  fillRect(image, 60, 0, 4, 14, NEAR_BLACK);
  return image;
}

/** Adversarial: two open interior pockets joined by a narrow (4px) neck — proves a preserve tap on one pocket should not automatically also preserve the other at a conservative cap. */
export function narrowNeckArtwork(): RgbaImage {
  const image = createCanvas(240, 160, NEAR_BLACK);
  fillRect(image, 20, 20, 200, 30, WHITE);
  fillRect(image, 20, 20, 30, 120, WHITE);
  fillRect(image, 190, 20, 30, 120, WHITE);
  fillRect(image, 20, 110, 200, 30, WHITE);
  fillRect(image, 104, 0, 16, 50, NEAR_BLACK);
  fillRect(image, 110, 50, 20, 26, WHITE);
  fillRect(image, 118, 76, 4, 8, NEAR_BLACK);
  return image;
}

/** Adversarial: a red ink block sitting directly against in-bounds proposal background, no buffer — proves preserving the background never alters the adjacent ink's RGB. */
export function proposalAdjacentToInkArtwork(): RgbaImage {
  const image = createCanvas(200, 200, NEAR_BLACK);
  fillRect(image, 20, 20, 160, 30, WHITE);
  fillRect(image, 20, 20, 30, 160, WHITE);
  fillRect(image, 150, 20, 30, 160, WHITE);
  fillRect(image, 20, 150, 160, 30, WHITE);
  fillRect(image, 92, 0, 16, 50, NEAR_BLACK);
  fillRect(image, 60, 60, 60, 60, RED);
  return image;
}

/** Adversarial: a small (256px) isolated in-bounds proposal pocket reached by a corridor — proves a single tap cleanly selects a tiny pocket without spilling further. */
export function tinyProposalPocketArtwork(): RgbaImage {
  const image = createCanvas(200, 200, NEAR_BLACK);
  fillRect(image, 20, 20, 160, 160, WHITE);
  fillRect(image, 90, 90, 14, 14, NEAR_BLACK);
  fillRect(image, 88, 0, 10, 90, NEAR_BLACK);
  return image;
}

/** Adversarial: an annulus (ring) with a wide gap in the ring wall — the enclosed interior connects to the exterior via that one gap, directly mirroring the real INCREDI-BOWLS/Split-Disturbers ring topology. */
export function curvedBandWithGapArtwork(): RgbaImage {
  const image = createCanvas(240, 240, NEAR_BLACK);
  fillEllipse(image, 120, 120, 100, 100, WHITE);
  fillEllipse(image, 120, 120, 80, 80, NEAR_BLACK);
  fillRect(image, 110, 20, 20, 20, NEAR_BLACK);
  return image;
}

/** Adversarial: two separate small in-bounds proposal targets separated by a wide field of genuinely-removable substrate — preserving one must not preserve the other or the substrate between them. */
export function twoProposalTargetsSeparatedArtwork(): RgbaImage {
  const image = createCanvas(300, 150, NEAR_BLACK);
  fillRect(image, 20, 20, 80, 110, WHITE);
  fillRect(image, 200, 20, 80, 110, WHITE);
  fillRect(image, 70, 110, 20, 20, NEAR_BLACK);
  fillRect(image, 210, 110, 20, 20, NEAR_BLACK);
  return image;
}

/** Adversarial: a wide-open gapped frame interior with one small deliberate accent inside it — a "large open field" case where one broad decision should efficiently cover the bulk of the proposal. */
export function largeOpenProposalFieldArtwork(): RgbaImage {
  const image = createCanvas(280, 280, NEAR_BLACK);
  fillRect(image, 20, 20, 240, 30, WHITE);
  fillRect(image, 20, 20, 30, 240, WHITE);
  fillRect(image, 230, 20, 30, 240, WHITE);
  fillRect(image, 20, 230, 240, 30, WHITE);
  fillRect(image, 132, 0, 16, 50, NEAR_BLACK);
  fillRect(image, 130, 130, 20, 20, NEAR_BLACK);
  return image;
}

/** Adversarial: the artwork's own ink starts flush with the canvas edge (x=0, y=0), with an in-bounds gap that also touches that same edge — stress-tests that inkBounds/silhouette/proposal computation never index out of bounds when `artworkBounds.left === 0` / `.top === 0`. */
export function edgeTouchingArtwork(): RgbaImage {
  const image = createCanvas(160, 160, NEAR_BLACK);
  fillRect(image, 0, 0, 140, 20, WHITE);
  fillRect(image, 0, 0, 20, 140, WHITE);
  fillRect(image, 120, 0, 20, 140, WHITE);
  fillRect(image, 0, 120, 140, 20, WHITE);
  // Gap in the top bar, itself starting at y=0 — the interior connects to
  // the exterior at the very first row of the canvas, not just somewhere
  // safely inside it.
  fillRect(image, 60, 0, 16, 20, NEAR_BLACK);
  return image;
}

/**
 * Phase 23B: OPEN LINE ART. The one adversarial case Phase 23's own
 * checkpoint report explicitly flagged as not yet covered by a dedicated
 * fixture.
 *
 * Distinct from `curvedBandWithGapArtwork` (a THICK, solid-filled annulus):
 * this is genuine thin-stroke line work — an open bracket/frame drawn with
 * 8px strokes, plus a small serif for "meaningful foreground line art"
 * rather than a bare geometric ring — enclosing a background-colored
 * (NEAR_BLACK, same as the true exterior) interior. One wall of the frame
 * has a deliberate 30px gap, far wider than `SILHOUETTE_RADIUS_PX`'s 6px
 * gap-closing threshold, connecting that interior directly to the true
 * exterior. Because the interior is the SAME colour as the exterior, it is
 * invisible to any color-distance classifier; only its FLOOD-CONNECTIVITY
 * through the gap (with the frame's own ink fully enclosing it, so it sits
 * inside `artworkBounds`) is what makes it exactly the class of topology
 * that falsified "border-connected == safe" (Phase 17).
 *
 * A second, disconnected far corner is left untouched so a genuinely safe,
 * unconditionally-removable exterior point exists for comparison.
 */
export function openLineArtFrameArtwork(): RgbaImage {
  const image = createCanvas(260, 260, NEAR_BLACK);

  // The frame: three complete walls...
  fillRect(image, 60, 60, 140, 8, WHITE); // top
  fillRect(image, 60, 60, 8, 140, WHITE); // left
  fillRect(image, 60, 192, 140, 8, WHITE); // bottom
  // ...and a right wall with a deliberate 30px gap in the middle.
  fillRect(image, 192, 60, 8, 55, WHITE); // right, upper segment
  fillRect(image, 192, 145, 8, 55, WHITE); // right, lower segment (gap: y in [115,145))

  // A small serif off the top-left corner — "meaningful foreground line
  // art", not just a bare rectangle outline.
  fillRect(image, 45, 60, 15, 6, WHITE);

  return image;
}

/**
 * Phase 23B Section 7 (staleness): the SAME open-line-art frame, same
 * overall footprint and a deliberately similar pixel count, but with the
 * gap moved from the right wall to the left wall — a genuinely different
 * proposal MASK shape that a bounds/pixelCount-only identity could still
 * mistake for the same proposal. Exists specifically to prove
 * `computeProposalHash` (which hashes the exact canonical mask, not
 * summary stats) correctly treats this as a different proposal.
 */
export function openLineArtFrameGapDriftedArtwork(): RgbaImage {
  const image = createCanvas(260, 260, NEAR_BLACK);
  fillRect(image, 60, 60, 140, 8, WHITE); // top
  fillRect(image, 60, 60, 8, 55, WHITE); // left, upper segment
  fillRect(image, 60, 145, 8, 55, WHITE); // left, lower segment (gap: y in [115,145))
  fillRect(image, 60, 192, 140, 8, WHITE); // bottom
  fillRect(image, 192, 60, 8, 140, WHITE); // right, now solid (no gap)
  fillRect(image, 45, 60, 15, 6, WHITE); // same serif
  return image;
}

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
