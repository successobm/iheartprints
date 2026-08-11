/**
 * Existing Artwork → Print Ready Phase 1.2: user-guided background removal.
 *
 * ## Why this exists
 *
 * The automatic cavity pass removes an enclosed background-coloured region
 * only when it can PROVE the region is background. The audit of the real
 * bowling artwork established that for one whole family of regions no such
 * proof is available:
 *
 *   the counters inside large display lettering    wall/inradius 2.11 – 5.29
 *   the bowling ball's finger holes                wall/inradius 2.89 – 4.69
 *
 * Those populations are NESTED. There is no threshold on that statistic — or
 * on any reparameterization of it — that removes the letter counters and keeps
 * the finger holes, and getting it wrong destroys artwork the customer cannot
 * recreate. Guessing harder is not a strategy.
 *
 * So the system stops guessing and asks. The customer can see, instantly and
 * without any vocabulary, which black is background and which black is their
 * bowling ball. One click is a cheaper thing to ask for than a wrong answer is
 * to recover from.
 *
 * ## THE SAFETY INVARIANT IS UNCHANGED
 *
 * > Pixels are removed only when the system has AFFIRMATIVE EVIDENCE that they
 * > belong to the detected background.
 *
 * A click is not a licence to delete pixels. It supplies exactly ONE missing
 * piece of evidence — the topological judgement the geometry could not make —
 * and every other requirement still has to hold. A guided removal may only
 * ever act on a region that the AUTOMATIC pass already identified as an
 * enclosed background-coloured candidate and then declined on geometry alone.
 * That set is computed here from the same background model, the same
 * tolerance, and the same code (`background-cavities.ts`) the automatic pass
 * used. Nothing else in the image is clickable, so:
 *
 *   - clicking the bowling ball's gold body       → refused, it is not a candidate
 *   - clicking a dark outline stroke              → refused, it is not enclosed
 *   - clicking a FINGER HOLE                      → allowed
 *
 * That last one is not a mistake, and it is worth being explicit about. A
 * finger hole IS an enclosed background-coloured region; the automatic pass
 * preserved it because the geometry was ambiguous, which is the same reason it
 * preserved the letter counters. The system genuinely cannot tell them apart —
 * that is the finding this whole module answers. What protects the finger
 * holes is therefore NOT a rule here, it is the customer: they are looking at
 * their own bowling ball and they will not click it. What this module
 * guarantees is that a click can never do something the customer did not see
 * and could not undo — the region is bounded, it is previewed, and
 * `undoGuidedRemoval` takes it back.
 *
 * `identifyGuidedRemovalRegion` is what makes that guarantee checkable: it
 * reports the exact region a click would affect BEFORE anything is removed.
 *
 * ## Coordinates, not ids
 *
 * The browser sends an image-space point. It never sends a region id, a pixel
 * mask, an asset path, or an alpha value. There is consequently nothing to
 * forge: a made-up coordinate resolves to whatever is genuinely at that
 * coordinate, and if that is artwork the answer is "no". The canonical region
 * key this module returns is DERIVED from the resolved region (its lowest
 * pixel index), never accepted from a caller — which is also what makes
 * repeat-click idempotency exact rather than approximate.
 *
 * Pure: no I/O, no codec, no provider, no randomness, no repository.
 */

import type { RgbaImage } from "@/capabilities/final-artwork/raster-transform";

import type {
  BackgroundCavityRegion,
  BackgroundCavityResult,
} from "./background-cavities";
import type { ArtworkBounds, RgbColor } from "./contracts";
import { matchesBackgroundColor } from "./pixel-metrics";

/** A point in SOURCE IMAGE pixels. Origin top-left, `x` right, `y` down. */
export interface GuidedRemovalPoint {
  x: number;
  y: number;
}

/**
 * One recorded guided removal. `regionKey` is the canonical identity of the
 * region the point resolved to; `point` is what the customer actually did.
 * Both are stored: the key is what makes repeats idempotent, the point is what
 * makes the record replayable and auditable.
 */
export interface GuidedRemovalRecord {
  point: GuidedRemovalPoint;
  regionKey: string;
  pixelCount: number;
}

export type GuidedRemovalOutcome =
  /** Resolved to an enclosed background candidate the automatic pass preserved. */
  | "eligible"
  /** The point is not on the canvas at all. */
  | "outside_image"
  /** Already transparent — exterior background, or a region a previous pass removed. */
  | "already_removed"
  /** Not an enclosed background-coloured region. This is the artwork. */
  | "not_background";

/** What a click resolved to. The region is present exactly when it is removable. */
export interface GuidedRemovalRegion {
  regionKey: string;
  bounds: ArtworkBounds;
  pixelCount: number;
}

/**
 * Discriminated on `outcome`, so a caller cannot reach `region` without first
 * having established that the click was eligible. The type is the guard.
 */
export type GuidedRemovalResolution =
  | { outcome: "eligible"; region: GuidedRemovalRegion }
  | {
      outcome: Exclude<GuidedRemovalOutcome, "eligible">;
      region: null;
    };

export interface BackgroundModel {
  backgroundColor: RgbColor;
  tolerance: number;
}

/**
 * The set of regions a click is allowed to resolve to, computed once from the
 * ORIGINAL image. Exposed so a caller answering several clicks against one
 * upload does not re-run the flood fill each time.
 */
export interface GuidedRemovalCandidates {
  width: number;
  height: number;
  /** Region index per pixel, or -1. Indexes into `regions`. */
  labels: Int32Array;
  regions: BackgroundCavityRegion[];
  /** Canonical key per region — its lowest pixel index. */
  keys: string[];
  /** True when the automatic pass already removed that region. */
  removedByAutomatic: boolean[];
  /** 1 = the exterior fill already removed this pixel. */
  exteriorMask: Uint8Array;
}

/**
 * Indexes the automatic pass's enclosed-candidate regions for click
 * resolution. Deterministic and side-effect free, so the same upload plus the
 * same background model always yields the same regions and the same keys.
 *
 * Takes the exterior mask and the cavity result the caller ALREADY computed
 * rather than recomputing them, which is both cheaper and the reason this
 * module never imports `background-isolation.ts` — the dependency runs one
 * way, from the pipeline into here.
 */
export function computeGuidedRemovalCandidates(
  image: RgbaImage,
  exteriorMask: Uint8Array,
  cavities: BackgroundCavityResult,
  model: BackgroundModel,
): GuidedRemovalCandidates {
  const { width, height } = image;

  // Re-derive the labelling with the SAME membership test, the SAME
  // connectivity and the SAME scan order `background-cavities.ts` uses, so
  // region index i here is region index i there. That module returns per-region
  // evidence but not the pixel map, and duplicating the walk is cheaper than
  // widening its contract — the assertion inside guarantees they agree.
  const labels = labelCavityPixels(image, exteriorMask, cavities.regions, model);

  const keys = cavities.regions.map(() => "");
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const label = labels[pixel]!;
    if (label < 0) continue;
    if (keys[label] === "") keys[label] = `p${pixel}`;
  }

  return {
    width,
    height,
    labels,
    regions: cavities.regions,
    keys,
    removedByAutomatic: cavities.regions.map((region) => region.removed),
    exteriorMask,
  };
}

/**
 * What one click would do, without doing it.
 *
 * The ONLY way a caller learns that a point is removable. A caller that skips
 * this and removes a point directly is a bug: `applyGuidedRemovals` resolves
 * every point through this same function precisely so that no second, looser
 * path can exist.
 */
export function identifyGuidedRemovalRegion(
  candidates: GuidedRemovalCandidates,
  point: GuidedRemovalPoint,
  applied: readonly GuidedRemovalRecord[] = [],
): GuidedRemovalResolution {
  const { width, height } = candidates;
  const x = Math.floor(point.x);
  const y = Math.floor(point.y);

  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return { outcome: "outside_image", region: null };
  }
  if (x < 0 || y < 0 || x >= width || y >= height) {
    return { outcome: "outside_image", region: null };
  }

  const pixel = y * width + x;
  if (candidates.exteriorMask[pixel] === 1) {
    return { outcome: "already_removed", region: null };
  }

  const label = candidates.labels[pixel]!;
  if (label < 0) {
    // Not an enclosed background-coloured candidate at all. This is artwork.
    return { outcome: "not_background", region: null };
  }
  if (candidates.removedByAutomatic[label]) {
    return { outcome: "already_removed", region: null };
  }

  const regionKey = candidates.keys[label]!;
  if (applied.some((record) => record.regionKey === regionKey)) {
    return { outcome: "already_removed", region: null };
  }

  const region = candidates.regions[label]!;
  return {
    outcome: "eligible",
    region: {
      regionKey,
      bounds: region.bounds,
      pixelCount: region.pixelCount,
    },
  };
}

export interface GuidedRemovalApplication {
  /** The input mask UNION every resolved, eligible region. */
  mask: Uint8Array;
  /** Records for the points that resolved to a region, in the order given. */
  applied: GuidedRemovalRecord[];
  /** Points that resolved to nothing removable. Reported, never fatal. */
  rejected: Array<{ point: GuidedRemovalPoint; outcome: GuidedRemovalOutcome }>;
  removedRegionCount: number;
  removedPixelCount: number;
}

/**
 * Extends `mask` with every eligible region named by `points`, in order.
 *
 * Order-independent in effect and idempotent by construction: a point whose
 * region is already accounted for resolves to `"already_removed"` and adds
 * nothing, so replaying a customer's whole click history — which is exactly
 * what a reload does — reproduces the same mask byte for byte.
 *
 * Never mutates the input mask; the returned mask is a copy.
 */
export function applyGuidedRemovals(
  candidates: GuidedRemovalCandidates,
  mask: Uint8Array,
  points: readonly GuidedRemovalPoint[],
): GuidedRemovalApplication {
  const next = Uint8Array.from(mask);
  const applied: GuidedRemovalRecord[] = [];
  const rejected: GuidedRemovalApplication["rejected"] = [];

  if (points.length === 0) {
    return {
      mask: next,
      applied,
      rejected,
      removedRegionCount: 0,
      removedPixelCount: 0,
    };
  }

  let removedPixelCount = 0;

  for (const point of points) {
    const resolution = identifyGuidedRemovalRegion(candidates, point, applied);
    if (resolution.outcome !== "eligible" || !resolution.region) {
      rejected.push({ point, outcome: resolution.outcome });
      continue;
    }

    applied.push({
      point: { x: Math.floor(point.x), y: Math.floor(point.y) },
      regionKey: resolution.region.regionKey,
      pixelCount: resolution.region.pixelCount,
    });
    removedPixelCount += resolution.region.pixelCount;
  }

  if (applied.length > 0) {
    const removable = new Set(applied.map((record) => record.regionKey));
    for (let pixel = 0; pixel < candidates.width * candidates.height; pixel += 1) {
      const label = candidates.labels[pixel]!;
      if (label < 0) continue;
      if (removable.has(candidates.keys[label]!)) next[pixel] = 1;
    }
  }

  return {
    mask: next,
    applied,
    rejected,
    removedRegionCount: applied.length,
    removedPixelCount,
  };
}

/**
 * Rebuilds the per-pixel region labelling that `background-cavities.ts`
 * computes internally.
 *
 * Candidate membership and connectivity are reproduced exactly — a pixel is a
 * candidate when the exterior fill did not take it and it satisfies
 * `matchesBackgroundColor`, and components are 4-connected in raster scan
 * order — so region index `i` here is region index `i` there. That
 * correspondence is the load-bearing assumption of this whole module, so it is
 * ASSERTED against each region's own recorded pixel count rather than trusted:
 * if the two ever drift, guided removal fails loudly instead of silently
 * clearing the wrong region.
 */
function labelCavityPixels(
  image: RgbaImage,
  exteriorMask: Uint8Array,
  regions: BackgroundCavityRegion[],
  model: BackgroundModel,
): Int32Array {
  const { width, height, data } = image;
  const total = width * height;
  const labels = new Int32Array(total).fill(-1);
  if (regions.length === 0) return labels;

  const candidate = new Uint8Array(total);
  for (let pixel = 0; pixel < total; pixel += 1) {
    if (exteriorMask[pixel] === 1) continue;
    if (
      matchesBackgroundColor(data, pixel * 4, model.backgroundColor, model.tolerance)
    ) {
      candidate[pixel] = 1;
    }
  }

  const counts = new Int32Array(regions.length);
  const stack = new Int32Array(total);
  let label = 0;

  for (let start = 0; start < total; start += 1) {
    if (candidate[start] !== 1 || labels[start] !== -1) continue;
    if (label >= regions.length) {
      throw new Error("Guided removal found more cavity regions than were reported");
    }

    const current = label;
    label += 1;
    let top = 0;
    labels[start] = current;
    stack[top++] = start;

    while (top > 0) {
      const pixel = stack[--top]!;
      counts[current] += 1;
      const x = pixel % width;
      const y = (pixel - x) / width;
      const visit = (neighbor: number): void => {
        if (candidate[neighbor] !== 1 || labels[neighbor] !== -1) return;
        labels[neighbor] = current;
        stack[top++] = neighbor;
      };
      if (x > 0) visit(pixel - 1);
      if (x < width - 1) visit(pixel + 1);
      if (y > 0) visit(pixel - width);
      if (y < height - 1) visit(pixel + width);
    }
  }

  if (label !== regions.length) {
    throw new Error("Guided removal disagreed with the cavity pass on region count");
  }
  for (let index = 0; index < regions.length; index += 1) {
    if (counts[index] !== regions[index]!.pixelCount) {
      throw new Error("Guided removal disagreed with the cavity pass on region shape");
    }
  }

  return labels;
}
