/**
 * Existing Artwork → Print Ready Phase 1: enclosed background cavities.
 *
 * ## The problem this exists to solve
 *
 * The exterior fill removes background that is REACHABLE FROM THE IMAGE
 * BORDER. That is the right rule, and it is what keeps a customer's
 * intentional black line work alive. But it is also, by construction, blind to
 * background that a foreground shape has topologically SEALED OFF from the
 * border:
 *
 *   - the counters inside letterforms (D, R, B, P, O, and the interiors of
 *     small wording, where a 3px stroke is all that separates the counter
 *     from the exterior)
 *   - the open middle of a ring, loop, or badge
 *   - the area a border or frame encloses
 *   - any cavity in a graphic composition that the background shows through
 *
 * On the audited bowling logo the exterior went transparent while the letter
 * counters stayed black. Nothing was wrong with the fill; it simply never had
 * a seed inside those regions.
 *
 * ## THE SAFETY INVARIANT
 *
 * > Background removal may remove pixels only when the system has AFFIRMATIVE
 * > EVIDENCE that they belong to the detected background.
 * >
 * > Colour similarity alone is insufficient.
 * > Enclosure alone is insufficient.
 *
 * The negative control is the bowling ball's finger holes: enclosed, black,
 * the same colour as the background, surrounded by foreground — and they are
 * the customer's artwork. "Enclosed + background-coloured" describes a letter
 * counter and a finger hole equally well, so it can never be the test.
 *
 * ## The evidence this pass requires, all of it, for every region
 *
 * 1. A CONFIRMED EXTERIOR BACKGROUND EXISTS. With no exterior fill there is no
 *    background model, and this pass does nothing at all.
 * 2. COLOUR: every pixel in the region satisfies the SAME membership test the
 *    exterior fill used (`matchesBackgroundColor`, same colour, same
 *    tolerance). Regions are grown with that predicate, so this holds by
 *    construction.
 * 3. A REAL FOREGROUND WALL: the region is enclosed by pixels that are
 *    genuinely distinct from the background, not by more almost-background.
 *    This is what stops the pass from carving into near-black artwork that
 *    sits on a near-black background.
 * 4. SHALLOW ENCLOSURE: the thinnest wall separating the region from the
 *    confirmed exterior background is no thicker than the region itself
 *    (`wall <= 1.75 * inradius + 4`).
 *
 * Rule 4 is the one that does the real work, and it is a statement about
 * TOPOLOGY, not typography. Background shows through a hole in a foreground
 * STRUCTURE — a stroke, a ring, a border — so the wall around it is on the
 * order of the hole. A dark feature that is part of a solid object sits deep
 * in that object's mass, with far more foreground between it and the outside
 * world than its own size. That single ratio separates:
 *
 *   letter counter    stroke 18px around a 21px-inradius counter → REMOVED
 *   ring interior     wall 15px around a 25px-inradius opening    → REMOVED
 *   finger hole       81px of ball around a 14px-inradius hole    → PRESERVED
 *   interior outline  27px of gold around a 4px-inradius stroke   → PRESERVED
 *   drop shadow       110px of plate around a 12px-inradius band  → PRESERVED
 *
 * No letter is ever identified, no glyph is ever matched, nothing is OCR'd,
 * and no colour is special-cased. A white background behind a dark logo runs
 * the identical code path.
 *
 * ## Direction of error
 *
 * Every threshold is set so that AMBIGUITY PRESERVES. A missed cavity is a
 * visible blemish the customer can point at; a destroyed one is artwork we
 * cannot recreate. Very heavy strokes around very small counters are
 * therefore left alone rather than guessed at.
 *
 * Pure: no I/O, no codec, no provider, no randomness.
 */

import type { RgbaImage } from "@/capabilities/final-artwork/raster-transform";

import type { ArtworkBounds, RgbColor } from "./contracts";
import {
  colorDistance,
  matchesBackgroundColor,
  SOLID_REFERENCE_MIN_DISTANCE,
  VISIBLE_ALPHA_THRESHOLD,
} from "./pixel-metrics";

/**
 * How much wall a cavity is allowed to have, per pixel of its own inradius.
 *
 * 1.75 covers ordinary and bold typography — a bold counter is enclosed by a
 * stroke roughly as wide as the counter is, and the small counters that
 * triggered this work are enclosed by 3–5px — while leaving a large margin
 * against the negative controls, whose walls run 3–20x their cavity size.
 * Raising it buys very little (extremely heavy display faces) and spends the
 * entire safety margin, so it stays where the audited cases put it.
 */
export const CAVITY_WALL_INRADIUS_RATIO = 1.75;

/**
 * Wall allowance that does not scale with cavity size, in pixels.
 *
 * A one- or two-pixel counter in small wording has an inradius near zero, so
 * the ratio alone would refuse it forever. This term is the floor that lets
 * the rule reach hairline counters at all.
 *
 * MEASURED ON THE REAL CUSTOMER ARTWORK, not on the fixture. The audit of the
 * real bowling logo found two genuine tagline counters — the enclosed slots in
 * the `R` and the `B` of "DISTURBING FROM DAY ONE", 5x9px each — that the
 * automatic pass refused:
 *
 *     inradius 1, wall 7   →  allowance 1.75 * 1 + 4 = 5.75  <  7  → refused
 *     inradius 1, wall 7   →  allowance 1.75 * 1 + 6 = 7.75  >= 7  → removed
 *
 * Six is therefore the measured width of a hairline counter's surrounding
 * stroke at this artwork's export resolution, not a number chosen to make one
 * file pass: at inradius 1 the ratio term contributes under two pixels, so for
 * the very smallest cavities this base IS the rule.
 *
 * WHY THIS DOES NOT WEAKEN THE MASS-VS-HOLE SAFETY RULE. The base is a
 * CONSTANT, so it matters only where the cavity is near-zero-sized; it is
 * swamped by `CAVITY_WALL_INRADIUS_RATIO * inradius` everywhere else. The
 * governing negative control is unmoved:
 *
 *     bowling-ball finger hole: inradius 9, wall 26
 *       allowance 1.75 * 9 + 6 = 21.75  <  26  → still preserved
 *
 * `CAVITY_WALL_INRADIUS_RATIO` is deliberately NOT touched. The real-file
 * audit proved the wall/inradius statistic cannot separate large letter
 * counters (2.11–5.29) from finger holes (2.89–4.69) at any threshold — the
 * populations are nested — so raising the ratio to reach the large counters
 * would destroy the finger holes first. Those large counters are handled by
 * `guided-removal.ts`, where the customer is the authority, not by a threshold.
 */
export const CAVITY_WALL_BASE_PX = 6;

/**
 * Share of a candidate region's enclosing boundary that must be affirmatively
 * OUTSIDE the background model before the region can be considered a hole in
 * something.
 *
 * The predicate is `matchesBackgroundColor` — the same background-membership
 * contract the exterior fill uses — and NOT a brightness or contrast
 * threshold. That distinction is the whole point:
 *
 * This gate used to require `SOLID_REFERENCE_MIN_DISTANCE` (48 Euclidean)
 * from the background, and on the real bowling artwork that rejected 129 of
 * 136 genuine counters. Real typography is outlined in DARK ink — measured
 * values (16,8,0) and (24,8,0) against a (1,1,1) background — which is
 * unambiguously not background under the model (Chebyshev 15 and 23, against
 * a tolerance of 12) while sitting only ~17 and ~25 Euclidean away from it.
 * 48 is a fringe-decontamination number: it answers "is there enough colour
 * separation here to divide by?", which is a different question from "is this
 * pixel foreground structure?". Borrowing it for topology silently required
 * customer artwork to be high-contrast.
 *
 * FOREGROUND STRUCTURE DOES NOT NEED TO BE HIGH-CONTRAST. IT ONLY NEEDS TO BE
 * AFFIRMATIVELY OUTSIDE THE BACKGROUND MODEL.
 */
export const CAVITY_BOUNDARY_FOREGROUND_FRACTION = 0.75;

/**
 * Sanity ceiling on the COMBINED mask. If exterior plus cavities would leave
 * essentially nothing, the background model was wrong about something and no
 * cavity is removed at all. Mirrors `MAX_MEANINGFUL_MASK_FRACTION` in
 * `image-analysis.ts`, which applies the same ceiling to the exterior alone.
 */
export const MAX_COMBINED_MASK_FRACTION = 0.995;

/** Why one candidate region was removed, or why it was not. Internal diagnostics. */
export type CavityDecision =
  /** All four kinds of evidence present. */
  | "removed_enclosed_background"
  /** Wall is thicker than the region is wide — a feature inside an object, not a hole in one. */
  | "preserved_wall_thicker_than_cavity"
  /** The enclosing boundary is not convincingly foreground (near-background artwork). */
  | "preserved_boundary_not_foreground"
  /** No path of foreground reaches this region from the exterior at all. */
  | "preserved_unreachable_from_exterior"
  /** Removal would have consumed essentially the whole canvas. */
  | "preserved_combined_mask_guard";

/** One connected, fully-enclosed, background-coloured region, with the evidence measured for it. */
export interface BackgroundCavityRegion {
  /** Every pixel in the region. */
  pixelCount: number;
  /** Those with meaningful alpha — the ones removal actually changes. */
  visiblePixelCount: number;
  bounds: ArtworkBounds;
  /** Half-thickness of the region: max 4-connected distance from its own boundary. */
  inradiusPx: number;
  /**
   * Thinnest foreground separating the region from the confirmed exterior
   * background, measured through non-candidate pixels only. `null` when no
   * such path exists.
   */
  wallThicknessPx: number | null;
  /** Share of the enclosing boundary that is affirmatively outside the background model (0–1). */
  boundaryForegroundFraction: number;
  /**
   * Share of the enclosing boundary that is also HIGH-CONTRAST against the
   * background (>= `SOLID_REFERENCE_MIN_DISTANCE`). Diagnostic only — never a
   * gate. On real dark-inked typography this runs 0.29–0.52 while
   * `boundaryForegroundFraction` is 1, which is exactly the gap that used to
   * refuse genuine counters.
   */
  boundaryHighContrastFraction: number;
  /** Mean colour of the region — recorded so the background match is auditable, not asserted. */
  meanColor: RgbColor;
  removed: boolean;
  decision: CavityDecision;
}

export interface BackgroundCavityOptions {
  backgroundColor: RgbColor;
  tolerance: number;
}

export interface BackgroundCavityResult {
  /** The exterior mask UNION every region this pass confidently classified as background. */
  mask: Uint8Array;
  /** Every candidate region considered, removed or not. Ordered by first pixel, so it is stable. */
  regions: BackgroundCavityRegion[];
  removedRegionCount: number;
  removedPixelCount: number;
  /** Removed pixels that were actually visible — what the customer sees change. */
  removedVisiblePixelCount: number;
  preservedRegionCount: number;
  preservedPixelCount: number;
  /** True when the combined-mask ceiling forced every candidate to be preserved. */
  combinedMaskGuardTripped: boolean;
}

/**
 * Finds background-coloured regions the border-connected fill could not reach
 * and adds only the confidently-classified ones to the mask.
 *
 * Never mutates `exteriorMask`; the returned mask is a copy. The image is
 * read-only throughout.
 */
export function expandMaskWithBackgroundCavities(
  image: RgbaImage,
  exteriorMask: Uint8Array,
  options: BackgroundCavityOptions,
): BackgroundCavityResult {
  const { width, height, data } = image;
  const total = width * height;
  const mask = Uint8Array.from(exteriorMask);

  let exteriorCount = 0;
  for (let pixel = 0; pixel < total; pixel += 1) {
    if (exteriorMask[pixel] === 1) exteriorCount += 1;
  }

  // Evidence 1: no confirmed exterior background means no background model to
  // measure a cavity against, so there is nothing this pass may conclude.
  if (total === 0 || exteriorCount === 0) return emptyResult(mask);

  // Evidence 2: candidates satisfy the SAME membership test the exterior fill
  // used. Colour is a precondition here, never a conclusion.
  const candidate = new Uint8Array(total);
  let candidateCount = 0;
  for (let pixel = 0; pixel < total; pixel += 1) {
    if (exteriorMask[pixel] === 1) continue;
    if (
      matchesBackgroundColor(
        data,
        pixel * 4,
        options.backgroundColor,
        options.tolerance,
      )
    ) {
      candidate[pixel] = 1;
      candidateCount += 1;
    }
  }

  if (candidateCount === 0) return emptyResult(mask);

  const labels = labelComponents(candidate, width, height);
  if (labels.count === 0) return emptyResult(mask);

  const stats = measureComponents(image, candidate, labels, options);
  const scratch = new Int32Array(total);
  const queue = new Int32Array(total);

  measureWallThickness(exteriorMask, candidate, labels, stats, width, height, scratch, queue);
  measureInradius(candidate, labels, stats, width, height, scratch, queue);

  const regions = stats.map((component) => classify(component));

  // Evidence 5: the combined mask must still leave an image behind.
  let removedPixelCount = 0;
  for (const region of regions) {
    if (region.removed) removedPixelCount += region.pixelCount;
  }
  const combinedMaskGuardTripped =
    (exteriorCount + removedPixelCount) / total > MAX_COMBINED_MASK_FRACTION;

  let removedRegionCount = 0;
  let removedVisiblePixelCount = 0;
  let preservedRegionCount = 0;
  let preservedPixelCount = 0;
  removedPixelCount = 0;

  for (let index = 0; index < regions.length; index += 1) {
    const region = regions[index]!;
    if (combinedMaskGuardTripped && region.removed) {
      regions[index] = {
        ...region,
        removed: false,
        decision: "preserved_combined_mask_guard",
      };
    }

    const settled = regions[index]!;
    if (settled.removed) {
      removedRegionCount += 1;
      removedPixelCount += settled.pixelCount;
      removedVisiblePixelCount += settled.visiblePixelCount;
    } else {
      preservedRegionCount += 1;
      preservedPixelCount += settled.pixelCount;
    }
  }

  if (removedRegionCount > 0) {
    const removedLabels = new Uint8Array(regions.length);
    for (let index = 0; index < regions.length; index += 1) {
      if (regions[index]!.removed) removedLabels[index] = 1;
    }
    for (let pixel = 0; pixel < total; pixel += 1) {
      const label = labels.of[pixel]!;
      if (label >= 0 && removedLabels[label] === 1) mask[pixel] = 1;
    }
  }

  return {
    mask,
    regions,
    removedRegionCount,
    removedPixelCount,
    removedVisiblePixelCount,
    preservedRegionCount,
    preservedPixelCount,
    combinedMaskGuardTripped,
  };
}

function emptyResult(mask: Uint8Array): BackgroundCavityResult {
  return {
    mask,
    regions: [],
    removedRegionCount: 0,
    removedPixelCount: 0,
    removedVisiblePixelCount: 0,
    preservedRegionCount: 0,
    preservedPixelCount: 0,
    combinedMaskGuardTripped: false,
  };
}

/**
 * The verdict for one region. Ordered so the recorded reason names the FIRST
 * missing piece of evidence, which is what makes the diagnostics readable.
 */
function classify(component: ComponentStats): BackgroundCavityRegion {
  const boundaryForegroundFraction =
    component.boundarySamples === 0
      ? 0
      : component.boundaryForeground / component.boundarySamples;
  const boundaryHighContrastFraction =
    component.boundarySamples === 0
      ? 0
      : component.boundaryHighContrast / component.boundarySamples;

  const base: Omit<BackgroundCavityRegion, "removed" | "decision"> = {
    pixelCount: component.pixelCount,
    visiblePixelCount: component.visiblePixelCount,
    bounds: {
      left: component.left,
      top: component.top,
      right: component.right + 1,
      bottom: component.bottom + 1,
      width: component.right + 1 - component.left,
      height: component.bottom + 1 - component.top,
    },
    inradiusPx: component.inradius,
    wallThicknessPx: component.wall === Number.POSITIVE_INFINITY ? null : component.wall,
    boundaryForegroundFraction: Number(boundaryForegroundFraction.toFixed(4)),
    boundaryHighContrastFraction: Number(boundaryHighContrastFraction.toFixed(4)),
    meanColor: {
      r: Math.round(component.sumR / component.pixelCount),
      g: Math.round(component.sumG / component.pixelCount),
      b: Math.round(component.sumB / component.pixelCount),
    },
  };

  if (base.wallThicknessPx === null) {
    return { ...base, removed: false, decision: "preserved_unreachable_from_exterior" };
  }

  // Evidence 3: enclosed by real artwork, not by more almost-background.
  if (boundaryForegroundFraction < CAVITY_BOUNDARY_FOREGROUND_FRACTION) {
    return { ...base, removed: false, decision: "preserved_boundary_not_foreground" };
  }

  // Evidence 4: a hole in a structure, not a feature inside a mass.
  const allowedWall =
    CAVITY_WALL_INRADIUS_RATIO * component.inradius + CAVITY_WALL_BASE_PX;
  if (base.wallThicknessPx > allowedWall) {
    return { ...base, removed: false, decision: "preserved_wall_thicker_than_cavity" };
  }

  return { ...base, removed: true, decision: "removed_enclosed_background" };
}

interface ComponentLabels {
  /** Component id per pixel, or -1. */
  of: Int32Array;
  count: number;
}

/** 4-connected labelling — the same connectivity the exterior fill uses, for the same reason. */
function labelComponents(
  candidate: Uint8Array,
  width: number,
  height: number,
): ComponentLabels {
  const total = width * height;
  const of = new Int32Array(total).fill(-1);
  const stack = new Int32Array(total);
  let count = 0;

  for (let start = 0; start < total; start += 1) {
    if (candidate[start] !== 1 || of[start] !== -1) continue;

    const label = count;
    count += 1;
    let top = 0;
    of[start] = label;
    stack[top++] = start;

    while (top > 0) {
      const pixel = stack[--top]!;
      const x = pixel % width;
      const y = (pixel - x) / width;

      const visit = (neighbor: number): void => {
        if (candidate[neighbor] !== 1 || of[neighbor] !== -1) return;
        of[neighbor] = label;
        stack[top++] = neighbor;
      };

      if (x > 0) visit(pixel - 1);
      if (x < width - 1) visit(pixel + 1);
      if (y > 0) visit(pixel - width);
      if (y < height - 1) visit(pixel + width);
    }
  }

  return { of, count };
}

interface ComponentStats {
  pixelCount: number;
  visiblePixelCount: number;
  left: number;
  top: number;
  right: number;
  bottom: number;
  sumR: number;
  sumG: number;
  sumB: number;
  /** Boundary adjacencies sampled, weighted by boundary length. */
  boundarySamples: number;
  boundaryForeground: number;
  boundaryHighContrast: number;
  wall: number;
  inradius: number;
}

function measureComponents(
  image: RgbaImage,
  candidate: Uint8Array,
  labels: ComponentLabels,
  options: BackgroundCavityOptions,
): ComponentStats[] {
  const { width, height, data } = image;
  const total = width * height;
  const stats: ComponentStats[] = [];

  for (let index = 0; index < labels.count; index += 1) {
    stats.push({
      pixelCount: 0,
      visiblePixelCount: 0,
      left: width,
      top: height,
      right: -1,
      bottom: -1,
      sumR: 0,
      sumG: 0,
      sumB: 0,
      boundarySamples: 0,
      boundaryForeground: 0,
      boundaryHighContrast: 0,
      wall: Number.POSITIVE_INFINITY,
      inradius: 0,
    });
  }

  for (let pixel = 0; pixel < total; pixel += 1) {
    const label = labels.of[pixel]!;
    if (label < 0) continue;

    const component = stats[label]!;
    const idx = pixel * 4;
    const x = pixel % width;
    const y = (pixel - x) / width;

    component.pixelCount += 1;
    if (data[idx + 3]! >= VISIBLE_ALPHA_THRESHOLD) component.visiblePixelCount += 1;
    component.sumR += data[idx]!;
    component.sumG += data[idx + 1]!;
    component.sumB += data[idx + 2]!;
    if (x < component.left) component.left = x;
    if (x > component.right) component.right = x;
    if (y < component.top) component.top = y;
    if (y > component.bottom) component.bottom = y;

    // The enclosing boundary: every adjacency from this region into something
    // that is not this region. Counted per adjacency, so a long stretch of
    // wall weighs more than a corner — the fraction is boundary LENGTH, not a
    // pixel set.
    const sample = (neighbor: number): void => {
      if (candidate[neighbor] === 1) return;
      component.boundarySamples += 1;
      const neighborIdx = neighbor * 4;
      if (
        !matchesBackgroundColor(
          data,
          neighborIdx,
          options.backgroundColor,
          options.tolerance,
        )
      ) {
        component.boundaryForeground += 1;
      }
      // Diagnostic only, never a gate: what the old contrast rule would have
      // said. Kept because it is the number that explains why real dark-inked
      // typography used to be refused.
      if (
        colorDistance(data, neighborIdx, options.backgroundColor) >=
        SOLID_REFERENCE_MIN_DISTANCE
      ) {
        component.boundaryHighContrast += 1;
      }
    };

    if (x > 0) sample(pixel - 1);
    if (x < width - 1) sample(pixel + 1);
    if (y > 0) sample(pixel - width);
    if (y < height - 1) sample(pixel + width);
  }

  return stats;
}

/**
 * How much foreground separates each region from the confirmed exterior
 * background.
 *
 * A 4-connected BFS out of the exterior mask that propagates ONLY through
 * non-candidate pixels: the distance it reports is therefore genuinely the
 * thickness of artwork in the way, and a path can never take a shortcut
 * through some other cavity. Regions no such path reaches keep
 * `Number.POSITIVE_INFINITY` and are preserved.
 */
function measureWallThickness(
  exteriorMask: Uint8Array,
  candidate: Uint8Array,
  labels: ComponentLabels,
  stats: ComponentStats[],
  width: number,
  height: number,
  distance: Int32Array,
  queue: Int32Array,
): void {
  const total = width * height;
  distance.fill(-1);
  let head = 0;
  let tail = 0;

  for (let pixel = 0; pixel < total; pixel += 1) {
    if (exteriorMask[pixel] === 1) {
      distance[pixel] = 0;
      queue[tail++] = pixel;
    }
  }

  while (head < tail) {
    const pixel = queue[head++]!;
    const next = distance[pixel]! + 1;
    const x = pixel % width;
    const y = (pixel - x) / width;

    const visit = (neighbor: number): void => {
      const label = labels.of[neighbor]!;
      if (label >= 0) {
        // Reaching a candidate ends the path: record the wall we crossed to
        // get here, and do not spread through it.
        const component = stats[label]!;
        if (next < component.wall) component.wall = next;
        return;
      }
      if (candidate[neighbor] === 1) return;
      if (distance[neighbor] !== -1) return;
      distance[neighbor] = next;
      queue[tail++] = neighbor;
    };

    if (x > 0) visit(pixel - 1);
    if (x < width - 1) visit(pixel + 1);
    if (y > 0) visit(pixel - width);
    if (y < height - 1) visit(pixel + width);
  }
}

/**
 * How big each region is, measured the same way the wall is: a 4-connected
 * BFS inward from the region's own boundary. The maximum distance reached is
 * the region's inradius — its half-thickness — which is the scale the wall is
 * compared against.
 *
 * Using thickness rather than area is deliberate. A long thin stroke and a
 * compact blob can cover the same area while being completely different kinds
 * of thing, and it is thickness that says which.
 */
function measureInradius(
  candidate: Uint8Array,
  labels: ComponentLabels,
  stats: ComponentStats[],
  width: number,
  height: number,
  distance: Int32Array,
  queue: Int32Array,
): void {
  const total = width * height;
  distance.fill(0);
  let head = 0;
  let tail = 0;

  for (let pixel = 0; pixel < total; pixel += 1) {
    if (candidate[pixel] !== 1) continue;

    const x = pixel % width;
    const y = (pixel - x) / width;
    const onBoundary =
      x === 0 ||
      y === 0 ||
      x === width - 1 ||
      y === height - 1 ||
      candidate[pixel - 1] !== 1 ||
      candidate[pixel + 1] !== 1 ||
      candidate[pixel - width] !== 1 ||
      candidate[pixel + width] !== 1;

    if (onBoundary) {
      distance[pixel] = 1;
      queue[tail++] = pixel;
    }
  }

  while (head < tail) {
    const pixel = queue[head++]!;
    const next = distance[pixel]! + 1;
    const x = pixel % width;
    const y = (pixel - x) / width;

    const visit = (neighbor: number): void => {
      if (candidate[neighbor] !== 1) return;
      if (distance[neighbor] !== 0) return;
      distance[neighbor] = next;
      queue[tail++] = neighbor;
    };

    if (x > 0) visit(pixel - 1);
    if (x < width - 1) visit(pixel + 1);
    if (y > 0) visit(pixel - width);
    if (y < height - 1) visit(pixel + width);
  }

  for (let pixel = 0; pixel < total; pixel += 1) {
    const label = labels.of[pixel]!;
    if (label < 0) continue;
    const component = stats[label]!;
    const value = distance[pixel]!;
    if (value > component.inradius) component.inradius = value;
  }
}
