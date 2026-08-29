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

/**
 * Phase 2A: a component's own fraction-below-floor pair, computed from ITS
 * OWN ridge sample distribution against caller-supplied physical-width
 * floors. Process-neutral: this type has no opinion about what the floors
 * MEAN — see `measureFeatureIntegrity`'s `structuralFractionThresholds`
 * input and `shared/dtf-feature-integrity-profile.ts`'s
 * `classifyStructuralFragility` for how DTF turns these numbers into a
 * structural-vs-incidental judgment. `null` when the caller supplied no
 * thresholds for this category (fractions were never computed) or the
 * component had no measurable ridge.
 */
export interface StructuralFractions {
  /** Fraction of this component's own ridge samples below the blocking-floor threshold it was measured against. */
  fractionBelowBlockingFloor: number;
  /** Fraction below the warning-floor threshold. Always >= `fractionBelowBlockingFloor` (the warning floor is never stricter than the blocking floor). */
  fractionBelowWarningFloor: number;
}

/** One measured positive-ink connected component. */
export interface PositiveFeatureComponent {
  id: number;
  pixelArea: number;
  boundsPx: ComponentBounds;
  physicalAreaMm2: number;
  /**
   * The minimum ridge (medial-axis) stroke width found anywhere in this
   * component, in production-raster pixels. `null` when the component had no
   * measurable ridge (can happen for a component smaller than the distance-
   * transform's own resolution — effectively a single-pixel speck, which
   * `isolated`'s component analysis already characterizes separately).
   */
  minStrokeWidthPx: number | null;
  minStrokeWidthMm: number | null;
  /**
   * Phase 2A (Section 3): the width distribution across this component's own
   * ridge, not just its minimum. A large, mostly-robust shape with one thin
   * appendage has a low minimum but a normal `p25`/`median`; a shape that is
   * predominantly narrow has all three clustered low. Equal-weight-per-
   * ridge-pixel statistics are used deliberately rather than any additional
   * length-weighting scheme — see `measure-feature-integrity.ts`'s module
   * doc comment (Section 4) for why ridge-sample density already
   * approximates medial-axis arc length, so a short terminal tip naturally
   * contributes only a few samples relative to a long stroke's many.
   */
  p25StrokeWidthMm: number | null;
  medianStrokeWidthMm: number | null;
  /** This component's own `StructuralFractions`, or `null` when no thresholds were supplied for this measurement run. */
  structuralFractions: StructuralFractions | null;
  /** How many ridge pixels the distribution above was drawn from — low counts mean the whole distribution rests on very little evidence. */
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
  /**
   * Phase 2A: the single component whose OWN `fractionBelowBlockingFloor` is
   * highest (ties broken by `fractionBelowWarningFloor`), computed from the
   * full per-component list BEFORE it is capped to
   * `FEATURE_INTEGRITY_MAX_RECORDS_PER_CATEGORY` — so this can never be
   * starved by capping the way a value derived from an already-capped,
   * cross-category list could be. This is the pair of numbers DTF's
   * structural-vs-incidental classification is actually computed from
   * (`print-validation-capability.ts`), always drawn from ONE real
   * component rather than mixing one component's minimum with a different
   * component's fraction. `null` when no component had `structuralFractions`
   * computed (no thresholds supplied, or no components at all).
   */
  worstStructuralComponent: {
    minStrokeWidthMm: number | null;
    fractionBelowBlockingFloor: number;
    fractionBelowWarningFloor: number;
  } | null;
}

/** One measured negative-space channel — either an enclosed cavity (a hole/counter) or an open channel between separate ink components. */
export interface NegativeSpaceChannel {
  id: number;
  pixelArea: number;
  boundsPx: ComponentBounds;
  physicalAreaMm2: number;
  /** `true` for a cavity fully enclosed by ink (e.g. a letter counter); `false` for a narrow channel that is still open to the surrounding background (e.g. the gap between two letters). */
  enclosed: boolean;
  minGapWidthPx: number | null;
  minGapWidthMm: number | null;
  /** Phase 2A (Section 8) — same distributional principle as `PositiveFeatureComponent`, applied to one negative-space channel's own ridge. */
  p25GapWidthMm: number | null;
  medianGapWidthMm: number | null;
  structuralFractions: StructuralFractions | null;
  ridgeSampleCount: number;
}

export interface NegativeSpaceGeometry {
  components: NegativeSpaceChannel[];
  totalComponentCount: number;
  globalMinGapWidthMm: number | null;
  percentile5GapWidthMm: number | null;
  /** Phase 2A — same principle as `PositiveFeatureGeometry.worstStructuralComponent`, computed pre-cap from the full negative-space channel list. */
  worstStructuralComponent: {
    minGapWidthMm: number | null;
    fractionBelowBlockingFloor: number;
    fractionBelowWarningFloor: number;
  } | null;
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

/**
 * Phase 2A (Section 7): aggregate diagnostics over ISOLATED MICRO
 * components — small, disconnected printable pieces, as a POPULATION rather
 * than individually. Distinct from `PositiveFeatureComponent`'s per-
 * component width distribution: this describes how much of the plate's
 * printed area consists of many small separate objects (which may be
 * intentional distress, legitimate isolated detail, or background-removal
 * residue/anti-alias noise — this module does not and cannot tell those
 * apart) versus one connected structure with internal narrow geometry.
 *
 * `MICRO_COMPONENT_DIAGNOSTIC_DIAMETER_MM` is a DIAGNOSTIC categorization
 * boundary for this aggregate only — never a print-readiness threshold
 * (those are `DTF_ISOLATED_COMPONENT_*_DIAMETER_MM` in
 * `shared/dtf-feature-integrity-profile.ts`, a deliberately separate,
 * smaller pair of numbers). Changing one never has to touch the other.
 */
export interface MicroComponentAggregate {
  microComponentCount: number;
  totalMicroComponentPixelArea: number;
  totalMicroComponentPhysicalAreaMm2: number;
  /** Total micro-component area as a fraction of ALL strong-ink pixels on the plate (0 when there is no ink at all). */
  fractionOfPrintedArea: number;
  /** Mean partial-alpha fraction across micro components — near 0 means crisp small marks; higher means faint/soft residue. */
  meanPartialAlphaFraction: number;
}

export interface IsolatedComponentGeometry {
  /** Worst-first (smallest `equivalentDiameterMm` first), capped. */
  components: IsolatedComponent[];
  totalComponentCount: number;
  smallestEquivalentDiameterMm: number | null;
  /** Population-level view of the smallest components — see `MicroComponentAggregate`. */
  microComponents: MicroComponentAggregate;
}

/**
 * Phase 2A (Section 7): the diagnostic size boundary used ONLY to decide
 * which isolated components count toward `MicroComponentAggregate` — never a
 * print-readiness threshold. See that type's own doc comment.
 */
export const MICRO_COMPONENT_DIAGNOSTIC_DIAMETER_MM = 2.0;

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
 * Phase 2A: physical-width floors injected by the CALLER so the engine can
 * compute `StructuralFractions` without persisting raw per-pixel ridge
 * samples (Section 3: "do not scatter DTF thresholds into the pure
 * measurement engine"). The engine treats these as opaque numbers — it has
 * no idea they are DTF's numbers specifically, and a future DTG/screen
 * profile could supply entirely different values through the exact same
 * parameter. The actual VALUES are owned exclusively by
 * `shared/dtf-feature-integrity-profile.ts`; nothing in this module ever
 * hardcodes or re-derives them.
 */
export interface StructuralFractionThresholds {
  blockingFloorMm: number;
  warningFloorMm: number;
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
