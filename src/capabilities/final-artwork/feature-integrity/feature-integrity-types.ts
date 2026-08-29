/**
 * DTF Feature Integrity Phase 1: the deterministic measurement model.
 *
 * Deliberately process-neutral geometry, not a DTF verdict. This module
 * describes measured production-raster geometry in physical units; whether a
 * given measurement is risky for a given production process is a separate,
 * profile-owned decision (`shared/dtf-feature-integrity-profile.ts` for the
 * provisional DTF profile; a future DTG/screen/embroidery profile would read
 * the exact same measurement shape). See ARCHITECTURE.md's "DTF Feature
 * Integrity" section.
 *
 * No single "quality score" is produced — structured measurements only
 * (Section 2 of this phase's plan).
 */

import type { ComponentBounds } from "./connected-components";

export const FEATURE_INTEGRITY_ALGORITHM_VERSION = "iheartprints_feature_integrity_v1";

/** How many per-category component/channel records the engine keeps, worst-first. Section 17: keep payload sizes reasonable — never persist millions of coordinates. */
export const FEATURE_INTEGRITY_MAX_RECORDS_PER_CATEGORY = 40;

export type { ComponentBounds };

/** One measured positive-ink connected component. */
export interface PositiveFeatureComponent {
  id: number;
  pixelArea: number;
  boundsPx: ComponentBounds;
  /**
   * The minimum ridge (medial-axis) stroke width found anywhere in this
   * component, in production-raster pixels. `null` when the component had no
   * measurable ridge (can happen for a component smaller than the distance-
   * transform's own resolution — effectively a single-pixel speck, which
   * `isolated`'s component analysis already characterizes separately).
   */
  minStrokeWidthPx: number | null;
  minStrokeWidthMm: number | null;
  /** How many ridge pixels the minimum was drawn from — low counts mean the minimum rests on very little evidence. */
  ridgeSampleCount: number;
}

export interface PositiveFeatureGeometry {
  /** Worst-first (narrowest `minStrokeWidthMm` first), capped at `FEATURE_INTEGRITY_MAX_RECORDS_PER_CATEGORY`. */
  components: PositiveFeatureComponent[];
  /** Total ink components found, before capping — so a capped list is never mistaken for a complete one. */
  totalComponentCount: number;
  globalMinStrokeWidthMm: number | null;
  /** 5th percentile of per-component minimum stroke widths — a robustness view alongside the single global minimum. */
  percentile5StrokeWidthMm: number | null;
}

/** One measured negative-space channel — either an enclosed cavity (a hole/counter) or an open channel between separate ink components. */
export interface NegativeSpaceChannel {
  id: number;
  pixelArea: number;
  boundsPx: ComponentBounds;
  /** `true` for a cavity fully enclosed by ink (e.g. a letter counter); `false` for a narrow channel that is still open to the surrounding background (e.g. the gap between two letters). */
  enclosed: boolean;
  minGapWidthPx: number | null;
  minGapWidthMm: number | null;
  ridgeSampleCount: number;
}

export interface NegativeSpaceGeometry {
  components: NegativeSpaceChannel[];
  totalComponentCount: number;
  globalMinGapWidthMm: number | null;
  percentile5GapWidthMm: number | null;
}

/** One small or isolated printable ink component — distinct from `PositiveFeatureComponent`'s stroke-width view of the SAME underlying components; this view is area/isolation-based, not thickness-based (Section 5: bounding box and area alone are not enough to judge a stroke, but ARE what "isolated component" means). */
export interface IsolatedComponent {
  id: number;
  pixelArea: number;
  boundsPx: ComponentBounds;
  physicalAreaMm2: number;
  widthMm: number;
  heightMm: number;
  /** Diameter of a circle with the same pixel area — a single comparable size number for an irregular fragment. */
  equivalentDiameterMm: number;
  /** Distance, in mm, to the nearest other strong-ink component's pixels. `null` when this is the only ink component (nothing to be isolated from). */
  distanceToNearestNeighborMm: number | null;
  /** Fraction of this component's pixels that are partial-alpha rather than strong ink — a soft/faint fragment reads differently than a crisp small one. */
  partialAlphaFraction: number;
}

export interface IsolatedComponentGeometry {
  /** Worst-first (smallest `equivalentDiameterMm` first), capped. */
  components: IsolatedComponent[];
  totalComponentCount: number;
  smallestEquivalentDiameterMm: number | null;
}

/** One connected region of partial-alpha (soft/faint) artwork, measured separately from strong ink. */
export interface PartialAlphaComponent {
  id: number;
  pixelArea: number;
  boundsPx: ComponentBounds;
  meanAlpha: number;
  widthMm: number;
  heightMm: number;
  equivalentDiameterMm: number;
}

export interface PartialAlphaGeometry {
  /** Fraction of all visible-art pixels (strong ink + partial alpha) that are partial alpha. */
  partialAlphaFractionOfVisible: number;
  /** Worst-first (smallest `equivalentDiameterMm` first), capped. */
  components: PartialAlphaComponent[];
  totalComponentCount: number;
  smallestEquivalentDiameterMm: number | null;
}

/**
 * The full deterministic Feature Integrity measurement for one production
 * raster at its confirmed physical size. Always computed against the FINAL
 * production raster (post-reconstruction, post-normalization) — never the
 * original source pixels (Section 15).
 */
export interface FeatureIntegrityMeasurement {
  algorithmVersion: string;
  productionWidthPx: number;
  productionHeightPx: number;
  confirmedWidthIn: number;
  confirmedHeightIn: number;
  /** Physical size of one production pixel, in mm. Not assumed square — derived independently per axis from the confirmed physical dimensions and the actual raster dimensions. */
  pixelPitchXMm: number;
  pixelPitchYMm: number;
  positive: PositiveFeatureGeometry;
  negative: NegativeSpaceGeometry;
  isolated: IsolatedComponentGeometry;
  partialAlpha: PartialAlphaGeometry;
  /** Honest, human-readable notes about what this measurement could not determine or where it truncated output. Never silent. */
  limitations: string[];
}
