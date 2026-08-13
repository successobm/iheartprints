/**
 * Existing Artwork → Print Ready Phase 1: deterministic background isolation.
 *
 * THE CENTRAL RULE, and the reason this is a flood fill rather than a colour
 * threshold: a pixel is removed only when the system has AFFIRMATIVE EVIDENCE
 * that it belongs to the detected background. Colour similarity alone is never
 * enough.
 *
 * The reference case makes the difference concrete. The audited bowling logo
 * is a near-black exterior touching all four edges, ~593k removable pixels —
 * and thousands of pixels of the SAME near-black that are intentional interior
 * strokes, shadows, and enclosed detail. "Remove every black pixel" would
 * delete the customer's line work.
 *
 * There are exactly two ways a region can earn that evidence, and they are
 * deliberately separate passes:
 *
 *   1. REACHABILITY from the image border (`computeExteriorMask`, below) —
 *      the exterior background.
 *   2. ENCLOSED CAVITY evidence (`background-cavities.ts`) — background that
 *      a foreground structure sealed off from the border, such as the counter
 *      inside a letterform or the open middle of a ring. Enclosure and colour
 *      alone are NOT sufficient there either; see that module for the full
 *      evidence list and for why a bowling ball's finger holes survive it.
 *
 * Everything here is pure: no I/O, no codec, no provider, no randomness. The
 * same bytes in always produce the same bytes out, which is what lets the
 * whole algorithm be pinned by fixture tests instead of by eyeballing.
 */

import type { RgbaImage } from "@/capabilities/final-artwork/raster-transform";
import {
  expandMaskWithBackgroundCavities,
  type BackgroundCavityResult,
} from "./background-cavities";
import {
  expandMaskWithBackgroundSpeckle,
  type BackgroundSpeckleResult,
} from "./background-speckle";
import type {
  ArtworkBounds,
  BackgroundPreparationRecord,
  RgbColor,
} from "./contracts";
import {
  buildGuidedRemovalHighlight,
  findGuidedRemovalRegionByKey,
  type GuidedCleanupHighlight,
} from "./guided-cleanup-candidate";
import {
  applyGuidedRemovals,
  computeGuidedRemovalCandidates,
  identifyGuidedRemovalRegion,
  type GuidedRemovalApplication,
  type GuidedRemovalCandidates,
  type GuidedRemovalPoint,
  type GuidedRemovalRecord,
  type GuidedRemovalResolution,
} from "./guided-removal";
import {
  channelDistance,
  colorDistance,
  matchesBackgroundColor,
  SOLID_REFERENCE_MIN_DISTANCE,
  VISIBLE_ALPHA_THRESHOLD,
} from "./pixel-metrics";

export { SOLID_REFERENCE_MIN_DISTANCE, VISIBLE_ALPHA_THRESHOLD };

/**
 * Baseline colour tolerance, as a per-channel (Chebyshev) distance in 0–255.
 * 12 is the audited value for the reference artwork: it absorbs the encoder
 * noise in a "solid" near-black export without reaching the customer's
 * darkest intentional strokes.
 */
export const BASE_BACKGROUND_TOLERANCE = 12;

/**
 * Hard ceiling on the adaptive tolerance. Past this, "background" stops
 * being a colour and starts being a guess — such images are classified
 * `NEEDS_REVIEW` rather than aggressively masked.
 */
export const MAX_BACKGROUND_TOLERANCE = 40;

/**
 * How far from the removed exterior the fringe pass is allowed to reach, in
 * pixels. Two covers ordinary anti-aliasing at real export resolutions while
 * staying far too narrow to erode a stroke.
 */
export const FRINGE_RADIUS_PX = 2;

/** Window (radius, in pixels) searched for that solid reference. */
const SOLID_REFERENCE_SEARCH_RADIUS = 2;

/** Alpha at or above this makes a pixel eligible to BE a solid reference. */
const SOLID_REFERENCE_MIN_ALPHA = 200;

/**
 * A fringe pixel already this close to the solid colour is left completely
 * alone: it is the artwork, not a blend of artwork and background. This is
 * the guard that keeps intentional outlines intact.
 */
const FRINGE_PRESERVE_RATIO = 0.98;

/**
 * How far a fringe pixel may sit OFF the straight line between background `B`
 * and foreground `F` and still be treated as a composite of the two —
 * expressed as a share of its own distance from the background, plus a small
 * absolute floor for encoder noise.
 *
 * The composite model `C = a·F + (1−a)·B` says a blended pixel lies ON that
 * line segment. A pixel that is its own colour does not, and decontaminating
 * it divides by a coverage that was never real.
 *
 * This is not theoretical. A 3px-wide dark outline — the customer's measured
 * (16,8,0) against a (1,1,1) background, with the letter's white fill within
 * the 2px reference window — resolves to a coverage of 0.038, and
 * `B + (C−B)/0.038` blows its slight warm tint up to a saturated
 * (255,183,0) at alpha 10. The outline gets punched through. Its residual
 * from the grey B→F line is 12.2 against a background distance of 16.6, so
 * this check rejects it and the pixel is preserved untouched.
 *
 * Thick dark outlines were already safe by accident: with no high-contrast
 * pixel inside `SOLID_REFERENCE_SEARCH_RADIUS`, `findSolidReference` returns
 * null and the pass declines. Only thin ones reach the broken path.
 */
const FRINGE_COMPOSITE_RESIDUAL_RATIO = 0.25;
const FRINGE_COMPOSITE_RESIDUAL_FLOOR = 3;

/** Below this estimated coverage a fringe pixel is essentially pure background. */
const FRINGE_FULL_REMOVAL_RATIO = 0.02;

/**
 * Phase 1.6 — RGB-ONLY EDGE DECONTAMINATION.
 *
 * ALPHA IS TOPOLOGY. RGB IS EDGE COLOUR.
 *
 * The composite model above is the right tool when a fringe pixel really is
 * `a·F + (1−a)·B`. It is not the only way a dark background contaminates an
 * edge. Light artwork anti-aliased over a near-black background produces edge
 * pixels whose channels CLIP on the way down: the audited bowling swoosh runs
 * (11,5,0) → (18,11,0) → (42,30,14) → (79,66,47) → gold across four pixels,
 * and the second of those sits 9.9 off the B→F line against a background
 * distance of 19.7 — `liesOnComposite` rejects it, correctly, because dividing
 * it by a coverage of 0.18 would invent a colour. It is also outside the fill
 * tolerance, so the exterior pass correctly keeps it.
 *
 * The result is a fully-opaque ring of the old background baked into the
 * artwork. It is invisible on a black garment and reads as dark stipple on a
 * white one. The audit measured ~8,231 such pixels against ~6,324 pixels of
 * legitimate dark ink in the same image, and proved that every ALPHA-based
 * remedy destroys the second population to reach the first: widening the
 * tolerance costs 34–46% of the real ink, deleting near-black pixels costs the
 * bowling ball's finger holes, eroding the edge costs the tagline.
 *
 * So this pass never touches alpha. The mask is already structurally correct;
 * what is wrong is the COLOUR of pixels that are legitimately opaque. It
 * recolours them from the artwork's own inward colour and writes nothing else.
 *
 * It runs ONLY where the composite model above declined, and demands six
 * independent pieces of evidence — see `decontaminateEdgeRgb`. Where the
 * evidence is ambiguous the pixel is preserved: the audit found ~557 edge
 * pixels with neither a clean ramp nor a clean plateau, and this pass is
 * deliberately not in the business of guessing about them.
 */

/**
 * Longest dark run, perpendicular to the edge, that can still be contamination.
 * The audit's discriminator: a run of 1–2 dark pixels at the silhouette is the
 * anti-aliasing signature, a run of 3+ is a stroke the customer drew. Thick
 * outlines are protected BY this number, so it is a ceiling, not a tuning knob.
 */
const FRINGE_RGB_MAX_DARK_RUN_PX = 2;

/** Rec. 709 luminance below which a pixel counts as "dark" for the run test. */
const FRINGE_RGB_DARK_LUMA = 64;

/**
 * How much brighter the inward artwork reference must be than the candidate.
 * This is the guard that stops an edge from being recoloured when the artwork
 * BEHIND it is itself dark — i.e. when the dark pixel is the artwork.
 */
const FRINGE_RGB_REFERENCE_MIN_LUMA_GAIN = 24;

/** Alpha at or above which a pixel may serve as the inward artwork reference. */
const FRINGE_RGB_REFERENCE_MIN_ALPHA = 200;

/**
 * Phase 1.6B — RESIDUAL EDGE ISLANDS.
 *
 * Phase 1.6 reads its evidence along ONE inward normal: the first fixed-order
 * direction with removed background behind it. That is the right shape for a
 * contaminated pixel sitting on a straight silhouette, and the forensic audit
 * measured what it leaves behind — 3,288 dark pixels still touching confirmed
 * exterior transparency in the real bowling output, rejected as:
 *
 *   1071  the dark run down that one normal is 3+ deep
 *    821  the composite model handled it (softened alpha), not the fallback's
 *    529  local dark thickness over the limit — intentional stroke, hands off
 *    408  the luminance profile is not strictly rising — ambiguous by design
 *    305  the pixel inward along that normal is itself transparent
 *    154  the pixel outward along that normal is not darker
 *
 * The last three are not statements about the artwork. They are statements
 * about a SINGLE CHOSEN DIRECTION: at a corner, a tip, or a one-pixel sliver
 * the chosen normal points along the silhouette instead of across it, and the
 * ramp test then asks a question the geometry cannot answer.
 *
 * This pass replaces the directional question with a topological one. It looks
 * at the whole 8-connected DARK COMPONENT in the output rather than at a pixel
 * and a direction, and recolours it only when the component is provably a
 * fleck of leftover matte rather than part of a mark:
 *
 *   I.   Every pixel of it was DECLINED by the composite model — so every
 *        pixel is inside the same 2px fringe band that pass already owns, and
 *        none of them is a pixel the proven path is handling.
 *   II.  The component TOUCHES confirmed exterior transparency.
 *   III. The component is SMALL — at most `FRINGE_RGB_RESIDUAL_MAX_ISLAND_PX`.
 *   IV.  Every pixel is dark in the ORIGINAL and passes the SAME
 *        `localDarkThickness` guard Phase 1.6 uses. A stroke stays a stroke.
 *   V.   Every pixel has its own materially brighter opaque artwork neighbour
 *        to take colour from.
 *
 * Because the component is MAXIMAL among dark pixels, "brighter all around" is
 * structural rather than sampled: any dark neighbour would be in the component.
 * And because I bounds the WHOLE component to the fringe band, recolouring it
 * cannot leave a dark remainder just outside the pass's reach — the inverted
 * ring that a merely-deeper ramp search would produce.
 *
 * WHY THIS CANNOT REACH THE FINGER HOLES. Measured, not asserted: the three
 * holes are 439/716/437 dark pixels forming components of 503/822/480, none of
 * which touches exterior transparency at all — they are preserved cavities deep
 * inside the ball. They fail II and III by two orders of magnitude. The audited
 * sweep recoloured 0 hole pixels at EVERY island size from 1 to 128.
 *
 * WHY IT CANNOT REACH INTENTIONAL OUTLINES. Guard IV is Phase 1.6's own
 * thickness test, unchanged. Against the 9,987 pixels the orientation-
 * independent ink classifier calls intentional stroke, this pass changes 0.
 *
 * What it does NOT solve, and deliberately: of the 3,288 residual pixels,
 * 1,208 have a local dark thickness of 3 or more. Those are the artwork's own
 * dark outlines and shadows meeting the silhouette, and the audit found no
 * evidence separating them from any other intentional dark stroke. They stay.
 */
const FRINGE_RGB_RESIDUAL_MAX_ISLAND_PX = 8;

/**
 * How far the RGB of retained pixels is bled outward into the now-transparent
 * exterior. Transparent pixels still carry colour, and every downstream
 * resample in this codebase interpolates RGB independently of alpha
 * (`raster-transform.ts` is straight, not premultiplied) — so leaving the
 * original near-black RGB behind a zero alpha is exactly how a dark halo
 * reappears during Phase 2 upscaling. Bleeding a two-pixel guard band costs
 * nothing visually (alpha stays 0) and removes the failure mode.
 */
const HALO_GUARD_RADIUS_PX = 2;

export interface ExteriorMaskOptions {
  backgroundColor: RgbColor;
  tolerance: number;
}

export interface ExteriorMaskResult {
  /** 1 = exterior background (reachable from the border), 0 = keep. */
  mask: Uint8Array;
  exteriorCount: number;
  /**
   * Pixels whose colour matches the background but which NO border-connected
   * path reaches. These are the customer's interior line work, and they are
   * never removed. The single most important number this module reports.
   */
  disconnectedMatchCount: number;
  /** Bounds of everything the mask leaves behind. `null` when nothing survives. */
  bounds: ArtworkBounds | null;
}

/**
 * Adaptive tolerance. Stays at the audited baseline for a genuinely uniform
 * export (the reference artwork's edge sigma of ≈0.53 resolves to exactly
 * 12) and widens only as measured edge noise grows, up to a hard ceiling.
 */
export function resolveBackgroundTolerance(
  maxChannelStandardDeviation: number,
): number {
  const widened =
    BASE_BACKGROUND_TOLERANCE +
    2 * Math.max(0, maxChannelStandardDeviation - 1);
  return Math.min(
    MAX_BACKGROUND_TOLERANCE,
    Math.max(BASE_BACKGROUND_TOLERANCE, Math.round(widened)),
  );
}

/**
 * Multi-seeded, 4-connected flood fill from EVERY border pixel that already
 * reads as background.
 *
 * Seeding from all four edges (rather than the four corners, or one edge) is
 * what stops a single unusual pixel from defining the region, and 4- rather
 * than 8-connectivity is deliberate: diagonal connectivity lets a fill squeeze
 * through a one-pixel anti-aliased gap in an outline and flood the interior of
 * a design, which is the classic way this kind of tool eats artwork.
 */
export function computeExteriorMask(
  image: RgbaImage,
  options: ExteriorMaskOptions,
): ExteriorMaskResult {
  const { width, height, data } = image;
  const total = width * height;
  const mask = new Uint8Array(total);
  const queue = new Int32Array(total);
  let queueHead = 0;
  let queueTail = 0;

  const matches = (pixel: number): boolean =>
    matchesBackgroundColor(
      data,
      pixel * 4,
      options.backgroundColor,
      options.tolerance,
    );

  const seed = (pixel: number): void => {
    if (mask[pixel] === 1 || !matches(pixel)) return;
    mask[pixel] = 1;
    queue[queueTail++] = pixel;
  };

  for (let x = 0; x < width; x += 1) {
    seed(x);
    seed((height - 1) * width + x);
  }
  for (let y = 0; y < height; y += 1) {
    seed(y * width);
    seed(y * width + width - 1);
  }

  while (queueHead < queueTail) {
    const pixel = queue[queueHead++]!;
    const x = pixel % width;
    const y = (pixel - x) / width;

    if (x > 0) seed(pixel - 1);
    if (x < width - 1) seed(pixel + 1);
    if (y > 0) seed(pixel - width);
    if (y < height - 1) seed(pixel + width);
  }

  let exteriorCount = 0;
  let disconnectedMatchCount = 0;
  let left = width;
  let top = height;
  let right = -1;
  let bottom = -1;

  for (let pixel = 0; pixel < total; pixel += 1) {
    if (mask[pixel] === 1) {
      exteriorCount += 1;
      continue;
    }

    const idx = pixel * 4;
    if (data[idx + 3]! < VISIBLE_ALPHA_THRESHOLD) continue;

    if (channelDistance(data, idx, options.backgroundColor) <= options.tolerance) {
      disconnectedMatchCount += 1;
    }

    const x = pixel % width;
    const y = (pixel - x) / width;
    if (x < left) left = x;
    if (x > right) right = x;
    if (y < top) top = y;
    if (y > bottom) bottom = y;
  }

  const bounds: ArtworkBounds | null =
    right < 0 || bottom < 0
      ? null
      : {
          left,
          top,
          right: right + 1,
          bottom: bottom + 1,
          width: right + 1 - left,
          height: bottom + 1 - top,
        };

  return { mask, exteriorCount, disconnectedMatchCount, bounds };
}

export interface BackgroundIsolationOptions {
  backgroundColor: RgbColor;
  tolerance: number;
  /** Pre-computed mask, when the caller already ran analysis. Recomputed when absent. */
  mask?: ExteriorMaskResult;
  /**
   * Existing Artwork → Print Ready Phase 1.2: image-space points the CUSTOMER
   * clicked to say "this is background too".
   *
   * Empty or absent for every automatic preparation, which is why the
   * automatic result is unchanged by this option existing. Each point may only
   * ever resolve to an enclosed candidate region the automatic cavity pass
   * already found and then declined on geometry — see `guided-removal.ts` for
   * why a click supplies evidence rather than authority.
   */
  guidedRemovalPoints?: readonly GuidedRemovalPoint[];
}

export interface BackgroundIsolationResult {
  image: RgbaImage;
  record: BackgroundPreparationRecord;
  /**
   * Per-region cavity evidence. Not persisted — the summary counts on
   * `record` are — but exposed so acceptance tooling can report exactly which
   * enclosed regions were removed, which were preserved, and why.
   */
  cavities: BackgroundCavityResult;
  /** Phase 1.2: which isolated near-background islands the speckle pass took. */
  speckle: BackgroundSpeckleResult;
  /**
   * Phase 1.2: which customer-clicked points resolved to a removable region
   * and which were refused. The capability persists only the accepted records.
   */
  guided: GuidedRemovalApplication;
}

/**
 * Phase 1.2 / 1.3: what one customer click would remove, without removing it.
 *
 * Lives here rather than in `guided-removal.ts` because answering the question
 * needs the exterior fill, and the dependency between those two modules runs
 * one way. This is the single entry point the capability uses both to PREVIEW
 * a click and to validate one before recording it.
 */
export function resolveGuidedRemovalAt(
  image: RgbaImage,
  point: GuidedRemovalPoint,
  options: {
    backgroundColor: RgbColor;
    tolerance: number;
    applied?: readonly GuidedRemovalRecord[];
  },
): GuidedRemovalResolution {
  return identifyGuidedRemovalRegion(
    buildGuidedCandidates(image, options),
    point,
    options.applied ?? [],
  );
}

export interface GuidedRemovalPreviewResult {
  resolution: GuidedRemovalResolution;
  /** Present only when the click is eligible — exact pixels that would go. */
  highlight: GuidedCleanupHighlight | null;
  /** The candidate index used to build the highlight; for confirm revalidation. */
  candidates: GuidedRemovalCandidates;
}

/**
 * Phase 1.3: identify + exact-region highlight for a click, still without
 * mutating anything. The highlight is derived from the same labels confirm
 * will re-check, so the UI cannot advertise a different set of pixels than
 * the server would remove.
 */
export function previewGuidedRemovalAt(
  image: RgbaImage,
  point: GuidedRemovalPoint,
  options: {
    backgroundColor: RgbColor;
    tolerance: number;
    applied?: readonly GuidedRemovalRecord[];
  },
): GuidedRemovalPreviewResult {
  const candidates = buildGuidedCandidates(image, options);
  const resolution = identifyGuidedRemovalRegion(
    candidates,
    point,
    options.applied ?? [],
  );
  if (resolution.outcome !== "eligible" || !resolution.region) {
    return { resolution, highlight: null, candidates };
  }
  return {
    resolution,
    highlight: buildGuidedRemovalHighlight(candidates, resolution.region.regionKey),
    candidates,
  };
}

/**
 * Phase 1.3: re-check a previously previewed candidate against the CURRENT
 * prepared state. Returns the live region when that canonical key is still
 * eligible; otherwise a refusal. The signed token already bound the key to
 * this preparation — this step only asks whether it is still removable.
 */
export function revalidateGuidedRemovalCandidate(
  image: RgbaImage,
  options: {
    backgroundColor: RgbColor;
    tolerance: number;
    applied?: readonly GuidedRemovalRecord[];
    regionKey: string;
    point: GuidedRemovalPoint;
  },
): GuidedRemovalResolution {
  const candidates = buildGuidedCandidates(image, options);
  const applied = options.applied ?? [];
  const byKey = findGuidedRemovalRegionByKey(
    candidates,
    options.regionKey,
    applied,
  );
  if (byKey) {
    return { outcome: "eligible", region: byKey };
  }

  const labelIndex = candidates.keys.indexOf(options.regionKey);
  if (
    labelIndex >= 0 &&
    (candidates.removedByAutomatic[labelIndex] ||
      applied.some((record) => record.regionKey === options.regionKey))
  ) {
    return { outcome: "already_removed", region: null };
  }

  // Also accept "already removed" when the original point now lands on
  // transparent / previously-cleared pixels (exterior or prior guided).
  const atPoint = identifyGuidedRemovalRegion(candidates, options.point, applied);
  if (atPoint.outcome === "already_removed") {
    return atPoint;
  }

  return { outcome: "already_removed", region: null };
}

function buildGuidedCandidates(
  image: RgbaImage,
  options: { backgroundColor: RgbColor; tolerance: number },
): GuidedRemovalCandidates {
  const model = {
    backgroundColor: options.backgroundColor,
    tolerance: options.tolerance,
  };
  const exterior = computeExteriorMask(image, model);
  const cavities = expandMaskWithBackgroundCavities(image, exterior.mask, model);
  return computeGuidedRemovalCandidates(image, exterior.mask, cavities, model);
}

/**
 * Removes the detected background and cleans the boundary it leaves behind.
 * The source image is never modified — a new buffer is always returned (the
 * customer's upload is pixel-authoritative and immutable).
 *
 * Six passes, in a deliberate order, each narrow.
 *
 * THE FIRST FOUR ONLY EVER GROW THE MASK. They decide WHICH pixels are
 * background; not one of them reads or writes a colour. Only then do the last
 * two touch pixels. That split is what keeps the audited edge behaviour
 * singular: an exterior pixel, a cavity pixel, a customer-clicked pixel and a
 * speckle pixel are indistinguishable by the time any colour is computed, so
 * there is one fringe pass and one halo guard rather than four variants.
 *
 *   0. EXTERIOR — reachability from the border (`computeExteriorMask`).
 *   1. CAVITIES — background-coloured regions a foreground structure sealed
 *      off from the border, but ONLY where the evidence in
 *      `background-cavities.ts` proves they are background.
 *   2. GUIDED — regions the CUSTOMER clicked. Runs after cavities because a
 *      click is only ever allowed to name a region the cavity pass already
 *      identified and then declined on ambiguous geometry
 *      (`guided-removal.ts`). Absent for every automatic preparation.
 *   3. SPECKLE — isolated near-background flecks the tolerance just missed
 *      (`background-speckle.ts`). Runs LAST of the mask passes, because
 *      "surrounded entirely by removed background" is its only evidence and
 *      that is not knowable until the mask is final. Removing a large counter
 *      in pass 2 can strand a fleck inside it; this is the pass that then
 *      sees it.
 *   4. ERASE — every masked pixel goes to alpha 0. Nothing else is touched,
 *      so interior background-coloured line work that earned no evidence at
 *      all survives untouched by construction.
 *   5. FRINGE — for pixels within `FRINGE_RADIUS_PX` of the removed region,
 *      recover the anti-aliasing the original composite baked in. For a pixel
 *      `C` that is a blend of foreground `F` over background `B`,
 *      `C = a*F + (1-a)*B`, so `a ≈ |C-B| / |F-B|` and the uncontaminated
 *      colour is `B + (C-B)/a`. `F` is taken from a nearby genuinely-solid
 *      pixel. When no such reference exists, when the pixel is already
 *      essentially solid, or when it does not lie on the B→F line
 *      (`liesOnComposite`), it is PRESERVED UNCHANGED — artwork fidelity
 *      outranks cleanup, always.
 *   5b. RGB-ONLY EDGE DECONTAMINATION (Phase 1.6) — for the pixels pass 5 just
 *      DECLINED, one narrower question: is this an opaque remnant of the
 *      removed dark background baked into an anti-aliased edge? Answered from
 *      the ORIGINAL's luminance ramp along the edge normal, and answered "no"
 *      whenever the evidence is thin. A yes recolours the pixel from the
 *      artwork behind it and WRITES NO ALPHA AT ALL.
 *   6. HALO GUARD — bleed retained RGB a short way into the transparent
 *      exterior so a later resample cannot pull the old background colour
 *      back in. Alpha stays 0; only the (invisible) colour changes.
 *
 * WHY THE COMPOSITE GUARD CANNOT BE BYPASSED BY THE NEW PASSES. Passes 2 and
 * 3 add pixels to the mask and stop. They never write RGB and never write
 * alpha, so every pixel that survives them still enters pass 5 through the
 * one code path, and `liesOnComposite` still decides whether its colour may
 * be divided by a coverage. On the audited artwork that guard rejects 10,449
 * fully opaque dark line-work pixels; nothing here moves that number by
 * changing what the guard sees, only by changing which pixels are background
 * before it runs.
 */
export function isolateBackground(
  image: RgbaImage,
  options: BackgroundIsolationOptions,
): BackgroundIsolationResult {
  const { width, height } = image;
  const maskResult =
    options.mask ??
    computeExteriorMask(image, {
      backgroundColor: options.backgroundColor,
      tolerance: options.tolerance,
    });

  const model = {
    backgroundColor: options.backgroundColor,
    tolerance: options.tolerance,
  };

  const cavities = expandMaskWithBackgroundCavities(image, maskResult.mask, model);

  // The candidate index is only built when there is a click to answer — an
  // automatic preparation pays nothing for this pass existing.
  const guidedPoints = options.guidedRemovalPoints ?? [];
  const guided =
    guidedPoints.length === 0
      ? emptyGuidedApplication(cavities.mask)
      : applyGuidedRemovals(
          computeGuidedRemovalCandidates(image, maskResult.mask, cavities, model),
          cavities.mask,
          guidedPoints,
        );

  const speckle = expandMaskWithBackgroundSpeckle(image, guided.mask, model);
  const mask = speckle.mask;

  const output: RgbaImage = {
    width,
    height,
    data: Buffer.from(image.data),
  };

  for (let pixel = 0; pixel < width * height; pixel += 1) {
    if (mask[pixel] === 1) output.data[pixel * 4 + 3] = 0;
  }

  const fringe = cleanFringe(image, output, mask, options.backgroundColor);
  const haloGuardPixels = bleedColorIntoTransparent(output, mask);

  return {
    image: output,
    cavities,
    speckle,
    guided,
    record: {
      backgroundRemoved: true,
      backgroundColor: options.backgroundColor,
      tolerance: options.tolerance,
      exteriorPixelsRemoved: maskResult.exteriorCount,
      // Only the pixels that were STILL preserved after every mask pass. The
      // exterior mask's raw disconnected count is the candidate pool, not the
      // outcome, and reporting it here would overstate what survived.
      interiorBackgroundColoredPixelsPreserved:
        maskResult.disconnectedMatchCount -
        cavities.removedVisiblePixelCount -
        guided.removedPixelCount -
        speckle.removedPixelCount,
      enclosedCavityRegionsRemoved: cavities.removedRegionCount,
      enclosedCavityPixelsRemoved: cavities.removedPixelCount,
      enclosedCavityRegionsPreserved: cavities.preservedRegionCount,
      guidedRegionsRemoved: guided.removedRegionCount,
      guidedPixelsRemoved: guided.removedPixelCount,
      speckleIslandsRemoved: speckle.removedIslandCount,
      specklePixelsRemoved: speckle.removedPixelCount,
      featheredEdgePixels: fringe.featheredEdgePixels,
      decontaminatedPixels: fringe.decontaminatedPixels,
      fringeRgbFallbackCandidates: fringe.rgbFallbackCandidates,
      fringeRgbFallbackPixels: fringe.rgbFallbackPixels,
      fringeRgbFallbackPreservedAmbiguous: fringe.rgbFallbackPreservedAmbiguous,
      fringeRgbResidualCandidates: fringe.rgbResidualCandidates,
      fringeRgbResidualPixels: fringe.rgbResidualPixels,
      fringeRgbResidualPreservedAmbiguous: fringe.rgbResidualPreservedAmbiguous,
      haloGuardPixels,
      outputWidthPx: width,
      outputHeightPx: height,
      aspectRatioPreserved: true,
    },
  };
}

function emptyGuidedApplication(mask: Uint8Array): GuidedRemovalApplication {
  return {
    mask,
    applied: [],
    rejected: [],
    removedRegionCount: 0,
    removedPixelCount: 0,
  };
}

interface FringeResult {
  featheredEdgePixels: number;
  decontaminatedPixels: number;
  rgbFallbackCandidates: number;
  rgbFallbackPixels: number;
  rgbFallbackPreservedAmbiguous: number;
  rgbResidualCandidates: number;
  rgbResidualPixels: number;
  rgbResidualPreservedAmbiguous: number;
}

/**
 * Matte decontamination, applied ONLY within `FRINGE_RADIUS_PX` of the
 * removed exterior. Reads colours from `source` (the untouched original) and
 * writes to `target`, so one corrected pixel can never seed the correction of
 * the next — the pass is order-independent and therefore deterministic.
 */
function cleanFringe(
  source: RgbaImage,
  target: RgbaImage,
  mask: Uint8Array,
  background: RgbColor,
): FringeResult {
  const { width, height } = source;
  let featheredEdgePixels = 0;
  let decontaminatedPixels = 0;

  const distanceToExterior = computeDistanceToMask(mask, width, height, FRINGE_RADIUS_PX);

  /**
   * Pixels the composite model looked at and REFUSED — either because no solid
   * reference existed to reason against, or because the pixel does not lie on
   * the B→F line. This is the only population the RGB fallback below is
   * allowed to consider, which is what makes it a fallback rather than a
   * second opinion: every pixel the proven path handles is already gone from
   * the set before the fallback sees anything.
   *
   * The preserve-ratio exit is deliberately NOT recorded. That one is an
   * affirmative finding — "this pixel IS the artwork colour" — not a decline.
   */
  const compositeDeclined = new Uint8Array(width * height);

  for (let pixel = 0; pixel < width * height; pixel += 1) {
    if (mask[pixel] === 1) continue;
    const distance = distanceToExterior[pixel]!;
    if (distance === 0 || distance > FRINGE_RADIUS_PX) continue;

    const idx = pixel * 4;
    const originalAlpha = source.data[idx + 3]!;
    if (originalAlpha < VISIBLE_ALPHA_THRESHOLD) continue;

    const solid = findSolidReference(source, mask, pixel, background);
    if (!solid) {
      compositeDeclined[pixel] = 1;
      continue;
    }

    const pixelDistance = colorDistance(source.data, idx, background);
    if (pixelDistance >= solid.distance * FRINGE_PRESERVE_RATIO) continue;

    const coverage = clamp01(pixelDistance / solid.distance);

    // Is this pixel actually a composite of THIS foreground over THIS
    // background? A blend lies on the line between them; its own colour does
    // not. Checked before any alpha is touched, so a misjudged pixel is
    // preserved whole rather than feathered.
    if (!liesOnComposite(source.data, idx, background, solid.color, coverage, pixelDistance)) {
      compositeDeclined[pixel] = 1;
      continue;
    }

    if (coverage <= FRINGE_FULL_REMOVAL_RATIO) {
      target.data[idx + 3] = 0;
      featheredEdgePixels += 1;
      continue;
    }

    target.data[idx + 3] = Math.round(originalAlpha * coverage);
    featheredEdgePixels += 1;

    // Undo the background composite: B + (C - B) / coverage.
    for (let channel = 0; channel < 3; channel += 1) {
      const backgroundChannel = channelOf(background, channel);
      const observed = source.data[idx + channel]!;
      const recovered = backgroundChannel + (observed - backgroundChannel) / coverage;
      target.data[idx + channel] = clampByte(recovered);
    }
    decontaminatedPixels += 1;
  }

  const fallback = decontaminateEdgeRgb(
    source,
    target,
    mask,
    distanceToExterior,
    compositeDeclined,
  );

  // Phase 1.6B runs strictly after Phase 1.6 and reads the state it left, so a
  // pixel the directional pass already corrected is bright by the time this one
  // looks for dark components — it cannot be re-examined, and it can serve as
  // the brighter reference its neighbours needed.
  const residual = decontaminateResidualEdgeIslands(source, target, mask, compositeDeclined);

  return {
    featheredEdgePixels,
    decontaminatedPixels,
    rgbFallbackCandidates: fallback.candidates,
    rgbFallbackPixels: fallback.recoloured,
    rgbFallbackPreservedAmbiguous: fallback.candidates - fallback.recoloured,
    rgbResidualCandidates: residual.candidates,
    rgbResidualPixels: residual.recoloured,
    rgbResidualPreservedAmbiguous: residual.candidates - residual.recoloured,
  };
}

/**
 * Phase 1.6: the RGB-only fallback. See `FRINGE_RGB_MAX_DARK_RUN_PX` above for
 * why this exists and why it may not touch alpha.
 *
 * A pixel is recoloured only with ALL SIX of these in hand:
 *
 *   A. It is VISIBLE. Transparent pixels are the halo guard's business.
 *   B. It sits at distance exactly 1 from CONFIRMED exterior transparency, per
 *      the same distance map the composite pass used. Never inferred from
 *      darkness — that inference is what deletes finger holes.
 *   C. The composite model DECLINED it (`compositeDeclined`).
 *   D. Its dark run, measured perpendicular to the edge, is <= 2px. A run of
 *      3+ is intentional ink and is left exactly as it is.
 *   E. The ORIGINAL luminance profile along that normal RISES STRICTLY, from
 *      the background pixel outside it, through the candidate, to the artwork
 *      behind it. That monotone ramp is the actual evidence that this pixel is
 *      light artwork composited over a dark background rather than dark
 *      artwork in its own right.
 *   F. The inward artwork reference is MATERIALLY lighter than the candidate.
 *      An edge whose interior is equally dark is an edge of dark artwork.
 *
 * The ORIGINAL is the authority for D, E and F. Guided cleanup and the
 * composite pass may both have altered neighbouring pixels by now; only the
 * upload still carries evidence of the ramp the customer's file actually had.
 *
 * Determinism: the ramp is read from the immutable `source`, and the
 * replacement COLOUR from a snapshot of `target` taken before the first write.
 * No pixel this pass produces can ever become the reference for another, so
 * the result does not depend on scan order.
 *
 * Exported so the ALPHA INVARIANT can be tested as the property it is —
 * snapshot the alpha plane, run this, compare byte for byte — rather than
 * inferred from whatever the surrounding passes happened to leave behind.
 * `isolateBackground` remains the only caller in production.
 */
export function decontaminateEdgeRgb(
  source: RgbaImage,
  target: RgbaImage,
  mask: Uint8Array,
  distanceToExterior: Uint8Array,
  compositeDeclined: Uint8Array,
): { candidates: number; recoloured: number } {
  const { width, height } = source;
  const transparent = resolveTransparentTopology(target, mask);

  // The replacement colour is read from the state the composite pass left, so
  // no pixel this loop writes can become another pixel's reference.
  const reference = Buffer.from(target.data);
  let candidates = 0;
  let recoloured = 0;

  for (let pixel = 0; pixel < width * height; pixel += 1) {
    if (compositeDeclined[pixel] !== 1) continue; // C
    // B — bounded by the SAME reach the composite pass used. Not widened.
    if (distanceToExterior[pixel] > FRINGE_RADIUS_PX) continue;
    const idx = pixel * 4;
    if (target.data[idx + 3]! < VISIBLE_ALPHA_THRESHOLD) continue; // A
    if (luminanceAt(source.data, idx) >= FRINGE_RGB_DARK_LUMA) continue;

    const inward = inwardDirection(transparent, width, height, pixel);
    if (!inward) continue;

    candidates += 1;

    // D — thick stroke in any orientation. Hands off.
    if (
      localDarkThickness(source, transparent, width, height, pixel) >
      FRINGE_RGB_MAX_DARK_RUN_PX
    ) {
      continue;
    }

    const artwork = resolveInwardRamp(source, transparent, pixel, inward);
    if (artwork === null) continue; // D, E, F — or ambiguous, which preserves

    // F, re-checked against THE ACTUAL BYTES about to be copied rather than
    // against the original they were derived from. The composite pass may have
    // recovered this reference's colour and softened its alpha in the same
    // step; the softened alpha is a coverage fact and says nothing about
    // whether the colour is right, but the colour itself must still be a
    // materially lighter piece of artwork or there is nothing to fix here.
    if (reference[artwork * 4 + 3]! < VISIBLE_ALPHA_THRESHOLD) continue;
    const referenceLuma = luminanceAt(reference, artwork * 4);
    if (referenceLuma < FRINGE_RGB_DARK_LUMA) continue;
    if (referenceLuma - luminanceAt(reference, idx) < FRINGE_RGB_REFERENCE_MIN_LUMA_GAIN) {
      continue;
    }

    // RGB ONLY. `idx + 3` is not written here, and must never be.
    target.data[idx] = reference[artwork * 4]!;
    target.data[idx + 1] = reference[artwork * 4 + 1]!;
    target.data[idx + 2] = reference[artwork * 4 + 2]!;
    recoloured += 1;
  }

  return { candidates, recoloured };
}

/**
 * Phase 1.6B: the residual-island pass. See `FRINGE_RGB_RESIDUAL_MAX_ISLAND_PX`
 * above for the evidence it demands and the measurements behind it.
 *
 * Exported for the same reason `decontaminateEdgeRgb` is: the alpha invariant
 * is a property of THIS function and is tested as one, by snapshotting the
 * alpha plane around a direct call. `cleanFringe` remains the only production
 * caller.
 */
export function decontaminateResidualEdgeIslands(
  source: RgbaImage,
  target: RgbaImage,
  mask: Uint8Array,
  compositeDeclined: Uint8Array,
): { candidates: number; recoloured: number } {
  const { width, height } = source;
  const total = width * height;
  const transparent = resolveTransparentTopology(target, mask);

  // Read colours from the state Phase 1.6 left, before this pass writes
  // anything. Islands are 8-connected components of DARK pixels and references
  // must be bright, so no reference can ever be an island member — but the
  // snapshot makes the pass order-independent by construction rather than by
  // argument.
  const reference = Buffer.from(target.data);

  const dark = new Uint8Array(total);
  for (let pixel = 0; pixel < total; pixel += 1) {
    if (transparent[pixel] === 1) continue;
    if (luminanceAt(reference, pixel * 4) >= FRINGE_RGB_DARK_LUMA) continue;
    dark[pixel] = 1;
  }

  const visited = new Uint8Array(total);
  const stack = new Int32Array(total);
  const island: number[] = [];
  let candidates = 0;
  let recoloured = 0;

  for (let seed = 0; seed < total; seed += 1) {
    if (dark[seed] !== 1 || visited[seed] === 1) continue;

    // Flood the WHOLE component. Size is evidence, so it may not be truncated:
    // abandoning early would let a thick outline masquerade as a small island.
    island.length = 0;
    let top = 0;
    stack[top++] = seed;
    visited[seed] = 1;
    let touchesTransparency = false;

    while (top > 0) {
      const pixel = stack[--top]!;
      island.push(pixel);
      const x = pixel % width;
      const y = (pixel - x) / width;

      for (const [dx, dy] of INWARD_PROBE_DIRECTIONS) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        if (transparent[ny * width + nx] === 1) touchesTransparency = true;
      }

      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const neighbor = ny * width + nx;
          if (dark[neighbor] !== 1 || visited[neighbor] === 1) continue;
          visited[neighbor] = 1;
          stack[top++] = neighbor;
        }
      }
    }

    // II and III — topology. A component that fails either is not a fleck.
    if (!touchesTransparency) continue;
    if (island.length > FRINGE_RGB_RESIDUAL_MAX_ISLAND_PX) continue;

    // I — every pixel must be one the composite model declined. This is also
    // what bounds the component to the fringe band: `compositeDeclined` is only
    // ever set within `FRINGE_RADIUS_PX` of the removed exterior.
    let eligible = true;
    for (const pixel of island) {
      if (compositeDeclined[pixel] !== 1) {
        eligible = false;
        break;
      }
    }
    if (!eligible) continue;

    candidates += island.length;

    // IV and V — the per-pixel evidence. Resolved for the WHOLE island before
    // anything is written: a partially-corrected island is exactly the
    // half-erased mark this pass must never produce.
    const replacements: number[] = [];
    for (const pixel of island) {
      const idx = pixel * 4;
      if (luminanceAt(source.data, idx) >= FRINGE_RGB_DARK_LUMA) {
        eligible = false;
        break;
      }
      if (
        localDarkThickness(source, transparent, width, height, pixel) >
        FRINGE_RGB_MAX_DARK_RUN_PX
      ) {
        eligible = false;
        break;
      }
      const artwork = brightestArtworkNeighbor(reference, transparent, width, height, pixel);
      if (artwork === null) {
        eligible = false;
        break;
      }
      if (
        luminanceAt(reference, artwork * 4) - luminanceAt(reference, idx) <
        FRINGE_RGB_REFERENCE_MIN_LUMA_GAIN
      ) {
        eligible = false;
        break;
      }
      replacements.push(pixel, artwork);
    }
    if (!eligible) continue;

    for (let i = 0; i < replacements.length; i += 2) {
      const idx = replacements[i]! * 4;
      const from = replacements[i + 1]! * 4;
      // RGB ONLY. `idx + 3` is not written here, and must never be.
      target.data[idx] = reference[from]!;
      target.data[idx + 1] = reference[from + 1]!;
      target.data[idx + 2] = reference[from + 2]!;
      recoloured += 1;
    }
  }

  return { candidates, recoloured };
}

/**
 * The brightest opaque, genuinely-light artwork pixel touching `pixel`, or null
 * when the neighbourhood offers nothing to take colour from — which preserves
 * the whole island.
 *
 * Brightest rather than nearest-in-colour: the defect being corrected is
 * darkness, and picking the neighbour that is least dark is the choice that
 * cannot half-fix a pixel by copying another barely-qualifying one.
 */
function brightestArtworkNeighbor(
  reference: Buffer,
  transparent: Uint8Array,
  width: number,
  height: number,
  pixel: number,
): number | null {
  const x = pixel % width;
  const y = (pixel - x) / width;
  let best: number | null = null;
  let bestLuma = -1;

  for (let dy = -1; dy <= 1; dy += 1) {
    const ny = y + dy;
    if (ny < 0 || ny >= height) continue;
    for (let dx = -1; dx <= 1; dx += 1) {
      if (dx === 0 && dy === 0) continue;
      const nx = x + dx;
      if (nx < 0 || nx >= width) continue;

      const neighbor = ny * width + nx;
      if (transparent[neighbor] === 1) continue;
      if (reference[neighbor * 4 + 3]! < FRINGE_RGB_REFERENCE_MIN_ALPHA) continue;

      const luma = luminanceAt(reference, neighbor * 4);
      if (luma < FRINGE_RGB_DARK_LUMA) continue;
      if (luma > bestLuma) {
        bestLuma = luma;
        best = neighbor;
      }
    }
  }

  return best;
}

/**
 * What counts as "confirmed exterior transparency" for this pass: the removed
 * mask, PLUS the pixels the composite pass just proved were essentially pure
 * background and feathered to nothing.
 *
 * Both are topology, established by evidence — neither is inferred from a
 * pixel being dark, which is the inference that deletes finger holes. Widening
 * the set makes this pass STRICTLY more careful, because it is what the
 * intentional-ink survey below walks outward from as well.
 *
 * Safe to read once here: the composite pass has finished, and nothing after
 * it writes alpha.
 */
function resolveTransparentTopology(target: RgbaImage, mask: Uint8Array): Uint8Array {
  const transparent = new Uint8Array(mask.length);
  for (let pixel = 0; pixel < mask.length; pixel += 1) {
    transparent[pixel] =
      mask[pixel] === 1 || target.data[pixel * 4 + 3]! < VISIBLE_ALPHA_THRESHOLD ? 1 : 0;
  }
  return transparent;
}

/** Longest dark extent this measurement will follow before giving up. */
const INTENTIONAL_INK_RUN_LIMIT = 64;

/**
 * THE THICK-OUTLINE PROTECTION, and the reason this pass cannot nibble at a
 * stroke the customer drew.
 *
 * Measures LOCAL DARK THICKNESS: the dark extent through the pixel along each
 * axis, both ways, and takes the SMALLER of the two. That minimum is the
 * stroke's thickness regardless of which way the stroke runs — a 3px outline
 * measures 3 across and hundreds along, so its minimum is 3; a 1px
 * contamination ring measures 1 across and hundreds along, so its minimum is
 * 1. Anything at or under `FRINGE_RGB_MAX_DARK_RUN_PX` is thin enough to be
 * anti-aliasing; anything above it is a mark, and this pass leaves it alone.
 *
 * The minimum, specifically, rather than a run measured along one chosen
 * direction. A dark ring following a horizontal edge is 200px "long" when
 * measured sideways, and a directional test that happened to look sideways
 * would call that ring an intentional stroke — protecting exactly the
 * contamination this pass exists to fix, at corners and tips where the first
 * transparent neighbour is beside the pixel rather than behind it. Thickness
 * does not have that ambiguity.
 *
 * Measured on the ORIGINAL, and bounded by `transparent` so it stops at the
 * removed background rather than running out into it.
 */
function localDarkThickness(
  source: RgbaImage,
  transparent: Uint8Array,
  width: number,
  height: number,
  pixel: number,
): number {
  const { data } = source;
  const x = pixel % width;
  const y = (pixel - x) / width;
  let thinnest = INTENTIONAL_INK_RUN_LIMIT;

  for (const [dx, dy] of [
    [1, 0],
    [0, 1],
  ] as const) {
    let extent = 1;
    for (const sign of [1, -1] as const) {
      let cx = x + dx * sign;
      let cy = y + dy * sign;
      while (
        cx >= 0 &&
        cy >= 0 &&
        cx < width &&
        cy < height &&
        extent < INTENTIONAL_INK_RUN_LIMIT
      ) {
        const step = cy * width + cx;
        if (transparent[step] === 1) break;
        if (luminanceAt(data, step * 4) >= FRINGE_RGB_DARK_LUMA) break;
        extent += 1;
        cx += dx * sign;
        cy += dy * sign;
      }
    }
    if (extent < thinnest) thinnest = extent;
  }

  return thinnest;
}

/**
 * The inward normal, derived from topology alone: the first fixed-order
 * direction whose OPPOSITE neighbour is confirmed removed background. Reading
 * it off the mask rather than off colour is what keeps this generic — nothing
 * here knows or cares whether the artwork is gold or the background black.
 */
const INWARD_PROBE_DIRECTIONS: ReadonlyArray<readonly [number, number]> = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
];

function inwardDirection(
  transparent: Uint8Array,
  width: number,
  height: number,
  pixel: number,
): readonly [number, number] | null {
  const x = pixel % width;
  const y = (pixel - x) / width;

  for (const direction of INWARD_PROBE_DIRECTIONS) {
    const ox = x - direction[0];
    const oy = y - direction[1];
    if (ox < 0 || oy < 0 || ox >= width || oy >= height) continue;
    if (transparent[oy * width + ox] === 1) return direction;
  }

  return null;
}

/**
 * Walks inward along the normal in the ORIGINAL image and returns the index of
 * the artwork pixel the candidate should take its colour from — or `null` when
 * the evidence does not hold, which preserves the pixel.
 *
 * Returns null for, specifically: a dark run of 3+ (intentional ink), a
 * luminance profile that is not strictly rising (no ramp — the ambiguous
 * population the audit found and this pass deliberately does not solve), an
 * inward reference that is transparent, and an inward reference that is not
 * materially lighter than the candidate.
 */
function resolveInwardRamp(
  source: RgbaImage,
  transparent: Uint8Array,
  pixel: number,
  direction: readonly [number, number],
): number | null {
  const { width, height, data } = source;
  const x = pixel % width;
  const y = (pixel - x) / width;
  const [dx, dy] = direction;

  // The ramp has to START in the background the fill already removed.
  const outward = (y - dy) * width + (x - dx);
  const candidateLuma = luminanceAt(data, pixel * 4);
  if (luminanceAt(data, outward * 4) >= candidateLuma) return null;

  let previousLuma = candidateLuma;

  for (let step = 1; step <= FRINGE_RGB_MAX_DARK_RUN_PX; step += 1) {
    const nx = x + dx * step;
    const ny = y + dy * step;
    if (nx < 0 || ny < 0 || nx >= width || ny >= height) return null;

    const neighbor = ny * width + nx;
    if (transparent[neighbor] === 1) return null;

    const luma = luminanceAt(data, neighbor * 4);
    if (luma <= previousLuma) return null; // not a strictly rising ramp
    previousLuma = luma;

    // Still inside the dark run: keep walking, up to the ceiling.
    if (luma < FRINGE_RGB_DARK_LUMA) continue;

    if (data[neighbor * 4 + 3]! < FRINGE_RGB_REFERENCE_MIN_ALPHA) return null;
    if (luma - candidateLuma < FRINGE_RGB_REFERENCE_MIN_LUMA_GAIN) return null;
    return neighbor;
  }

  // The run never ended within the ceiling: 3+ dark pixels deep. Real ink.
  return null;
}

/** Rec. 709 relative luminance — the metric the edge audit measured ramps in. */
function luminanceAt(data: Buffer, idx: number): number {
  return 0.2126 * data[idx]! + 0.7152 * data[idx + 1]! + 0.0722 * data[idx + 2]!;
}

interface SolidReference {
  distance: number;
  /** The reference colour itself — `F` in the composite equation. */
  color: RgbColor;
}

/**
 * Whether `C` is plausibly `a·F + (1−a)·B` for the coverage already derived
 * from its distance. Measures the residual perpendicular to the B→F line;
 * a genuine anti-aliased blend sits on it, an outline of its own colour does
 * not. See `FRINGE_COMPOSITE_RESIDUAL_RATIO`.
 */
function liesOnComposite(
  data: Buffer,
  idx: number,
  background: RgbColor,
  foreground: RgbColor,
  coverage: number,
  pixelDistance: number,
): boolean {
  let residual = 0;
  for (let channel = 0; channel < 3; channel += 1) {
    const backgroundChannel = channelOf(background, channel);
    const predicted =
      backgroundChannel + coverage * (channelOf(foreground, channel) - backgroundChannel);
    const delta = data[idx + channel]! - predicted;
    residual += delta * delta;
  }

  return (
    Math.sqrt(residual) <=
    FRINGE_COMPOSITE_RESIDUAL_RATIO * pixelDistance + FRINGE_COMPOSITE_RESIDUAL_FLOOR
  );
}

/**
 * The nearest genuinely-solid artwork colour around a fringe pixel — the `F`
 * in the composite equation. Returns `null` when the neighbourhood contains
 * nothing far enough from the background to reason about, which is the
 * "preserve the pixel" case.
 */
function findSolidReference(
  source: RgbaImage,
  mask: Uint8Array,
  pixel: number,
  background: RgbColor,
): SolidReference | null {
  const { width, height } = source;
  const x = pixel % width;
  const y = (pixel - x) / width;
  let best = 0;
  let bestColor: RgbColor = { r: 0, g: 0, b: 0 };

  for (let dy = -SOLID_REFERENCE_SEARCH_RADIUS; dy <= SOLID_REFERENCE_SEARCH_RADIUS; dy += 1) {
    const ny = y + dy;
    if (ny < 0 || ny >= height) continue;
    for (let dx = -SOLID_REFERENCE_SEARCH_RADIUS; dx <= SOLID_REFERENCE_SEARCH_RADIUS; dx += 1) {
      const nx = x + dx;
      if (nx < 0 || nx >= width) continue;

      const neighbor = ny * width + nx;
      if (mask[neighbor] === 1) continue;
      const idx = neighbor * 4;
      if (source.data[idx + 3]! < SOLID_REFERENCE_MIN_ALPHA) continue;

      const distance = colorDistance(source.data, idx, background);
      if (distance > best) {
        best = distance;
        bestColor = {
          r: source.data[idx]!,
          g: source.data[idx + 1]!,
          b: source.data[idx + 2]!,
        };
      }
    }
  }

  return best >= SOLID_REFERENCE_MIN_DISTANCE
    ? { distance: best, color: bestColor }
    : null;
}

/**
 * 4-connected BFS distance from the mask, capped at `maxDistance`. `0` means
 * "is the mask"; anything beyond the cap is left at `maxDistance + 1`.
 */
function computeDistanceToMask(
  mask: Uint8Array,
  width: number,
  height: number,
  maxDistance: number,
): Uint8Array {
  const total = width * height;
  const distance = new Uint8Array(total).fill(maxDistance + 1);
  const queue = new Int32Array(total);
  let head = 0;
  let tail = 0;

  for (let pixel = 0; pixel < total; pixel += 1) {
    if (mask[pixel] === 1) {
      distance[pixel] = 0;
      queue[tail++] = pixel;
    }
  }

  while (head < tail) {
    const pixel = queue[head++]!;
    const next = distance[pixel]! + 1;
    if (next > maxDistance) continue;

    const x = pixel % width;
    const y = (pixel - x) / width;

    const visit = (neighbor: number): void => {
      if (distance[neighbor]! <= next) return;
      distance[neighbor] = next;
      queue[tail++] = neighbor;
    };

    if (x > 0) visit(pixel - 1);
    if (x < width - 1) visit(pixel + 1);
    if (y > 0) visit(pixel - width);
    if (y < height - 1) visit(pixel + width);
  }

  return distance;
}

/**
 * Copies the colour of nearby retained pixels outward into the transparent
 * exterior (alpha untouched at 0). See `HALO_GUARD_RADIUS_PX` for why an
 * invisible colour still matters.
 */
function bleedColorIntoTransparent(image: RgbaImage, mask: Uint8Array): number {
  const { width, height, data } = image;
  const total = width * height;
  const source = Buffer.from(data);
  const distance = computeDistanceToMask(
    invertMask(mask),
    width,
    height,
    HALO_GUARD_RADIUS_PX,
  );

  let bled = 0;
  for (let pixel = 0; pixel < total; pixel += 1) {
    if (mask[pixel] !== 1) continue;
    const step = distance[pixel]!;
    if (step === 0 || step > HALO_GUARD_RADIUS_PX) continue;

    const donor = findNearestOpaqueColorSource(source, mask, width, height, pixel, step);
    if (donor < 0) continue;

    const idx = pixel * 4;
    data[idx] = source[donor * 4]!;
    data[idx + 1] = source[donor * 4 + 1]!;
    data[idx + 2] = source[donor * 4 + 2]!;
    bled += 1;
  }

  return bled;
}

function invertMask(mask: Uint8Array): Uint8Array {
  const inverted = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i += 1) inverted[i] = mask[i] === 1 ? 0 : 1;
  return inverted;
}

/** Nearest non-masked pixel within `radius`, scanning in a stable order so the result is deterministic. */
function findNearestOpaqueColorSource(
  source: Buffer,
  mask: Uint8Array,
  width: number,
  height: number,
  pixel: number,
  radius: number,
): number {
  const x = pixel % width;
  const y = (pixel - x) / width;
  let best = -1;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (let dy = -radius; dy <= radius; dy += 1) {
    const ny = y + dy;
    if (ny < 0 || ny >= height) continue;
    for (let dx = -radius; dx <= radius; dx += 1) {
      const nx = x + dx;
      if (nx < 0 || nx >= width) continue;

      const neighbor = ny * width + nx;
      if (mask[neighbor] === 1) continue;
      if (source[neighbor * 4 + 3]! === 0) continue;

      const manhattan = Math.abs(dx) + Math.abs(dy);
      if (manhattan < bestDistance) {
        bestDistance = manhattan;
        best = neighbor;
      }
    }
  }

  return best;
}

/**
 * The already-transparent path: the upload keeps its own alpha and is simply
 * re-encoded as a derived asset. No pixel is altered — the customer's
 * transparency IS the answer, and running a removal pass over it could only
 * damage it.
 */
export function passThroughTransparentArtwork(
  image: RgbaImage,
  backgroundColor: RgbColor,
  tolerance: number,
): BackgroundIsolationResult {
  return {
    image: { width: image.width, height: image.height, data: Buffer.from(image.data) },
    cavities: {
      mask: new Uint8Array(image.width * image.height),
      regions: [],
      removedRegionCount: 0,
      removedPixelCount: 0,
      removedVisiblePixelCount: 0,
      preservedRegionCount: 0,
      preservedPixelCount: 0,
      combinedMaskGuardTripped: false,
    },
    speckle: {
      mask: new Uint8Array(image.width * image.height),
      removedIslandCount: 0,
      removedPixelCount: 0,
      preservedIslandCount: 0,
      preservedPixelCount: 0,
    },
    guided: emptyGuidedApplication(new Uint8Array(image.width * image.height)),
    record: {
      backgroundRemoved: false,
      backgroundColor,
      tolerance,
      exteriorPixelsRemoved: 0,
      interiorBackgroundColoredPixelsPreserved: 0,
      enclosedCavityRegionsRemoved: 0,
      enclosedCavityPixelsRemoved: 0,
      enclosedCavityRegionsPreserved: 0,
      guidedRegionsRemoved: 0,
      guidedPixelsRemoved: 0,
      speckleIslandsRemoved: 0,
      specklePixelsRemoved: 0,
      featheredEdgePixels: 0,
      decontaminatedPixels: 0,
      fringeRgbFallbackCandidates: 0,
      fringeRgbFallbackPixels: 0,
      fringeRgbFallbackPreservedAmbiguous: 0,
      fringeRgbResidualCandidates: 0,
      fringeRgbResidualPixels: 0,
      fringeRgbResidualPreservedAmbiguous: 0,
      haloGuardPixels: 0,
      outputWidthPx: image.width,
      outputHeightPx: image.height,
      aspectRatioPreserved: true,
    },
  };
}

function channelOf(color: RgbColor, channel: number): number {
  if (channel === 0) return color.r;
  if (channel === 1) return color.g;
  return color.b;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function clampByte(value: number): number {
  return Math.min(255, Math.max(0, Math.round(value)));
}
