/**
 * DTF Feature Integrity: the measurement orchestrator.
 *
 * Ties together alpha classification, distance transforms, ridge detection,
 * and connected-component labelling into one deterministic
 * `FeatureIntegrityMeasurement` for a production raster at its confirmed
 * physical size. Pure — no I/O, no PNG codec (the caller decodes bytes into
 * an `RgbaImage` first, exactly like every other pure module in this
 * capability).
 *
 * MEASURES ONLY. This module has no concept of "pass," "warning," or
 * "blocking" — that classification is a separate, profile-owned decision
 * (`shared/dtf-feature-integrity-profile.ts`). See that module's doc comment
 * for why the split matters.
 *
 * WHY POSITIVE AND NEGATIVE GEOMETRY ARE MEASURED DIFFERENTLY:
 *
 *   - Positive ink components (letters, decorative marks, distressed
 *     fragments) are already discrete objects — `strongInk`'s own connected
 *     components ARE the things to measure, individually.
 *   - The background has no equivalent natural objects. After production
 *     trimming, almost all of it is ONE connected region (the open margin
 *     around the artwork, contiguous with every gap between separate ink
 *     shapes) plus a handful of genuinely enclosed cavities (letter
 *     counters, holes). Splitting that one open region into per-channel
 *     diagnostics needs a different technique: cluster only its ridge
 *     pixels that are already locally narrower than
 *     `DIAGNOSTIC_CLUSTERING_WIDTH_FRACTION` of the raster's shorter side —
 *     wide-open ridge points (the ordinary margin) never survive that
 *     filter, which is what prevents the entire canvas from being reported
 *     as one giant "channel." This constant is a CLUSTERING AID for
 *     producing legible diagnostic regions, never a print-readiness
 *     threshold (those live in the DTF profile) — it only decides how
 *     diagnostic bounding boxes are grouped, never a check's pass/fail
 *     outcome, which is always computed from the raw measured widths.
 *
 * Phase 2A — WHY MINIMUM WIDTH ALONE IS NOT STRUCTURAL FRAGILITY:
 *
 * The first real benchmark (Incredi-Bowls) showed that a single 4-connected
 * component can legitimately contain both the bulk of a robust design AND a
 * thin distressed crack or serif tip, because they really are one connected
 * shape. Reporting that whole component's risk as "as fragile as its single
 * thinnest pixel" conflates two very different situations:
 *
 *   INCIDENTAL fragility — a small, low-arc-length dip in an otherwise
 *   robust structure (a terminal tip, a thin crack, a decorative flourish
 *   attached to bold lettering).
 *
 *   STRUCTURAL fragility — the structure's geometry is predominantly narrow;
 *   the "minimum" is representative of the whole, not an outlier.
 *
 * This module answers that by keeping each component's full ridge WIDTH
 * DISTRIBUTION (min / p25 / median) rather than only its minimum, plus — when
 * the caller supplies physical-width floors via `structuralFractionThresholds`
 * — the FRACTION of that component's own ridge length below each floor.
 * Classifying structural-vs-incidental from those fractions is the DTF
 * profile's job (`shared/dtf-feature-integrity-profile.ts`'s
 * `classifyStructuralFragility`); this module only measures the geometry.
 *
 * WHY EQUAL-WEIGHT-PER-RIDGE-SAMPLE NEEDS NO ADDITIONAL LENGTH WEIGHTING
 * (Section 4): ridge (medial-axis) detection via non-maximum suppression
 * already produces roughly one ridge pixel per unit of arc length along a
 * shape's skeleton — a long stroke's centerline naturally contributes many
 * ridge samples, while a short terminal tip contributes only as many samples
 * as its own short extent. Fraction-below-floor and percentile statistics
 * computed with equal weight per ridge SAMPLE are therefore already
 * approximately weighted by medial-axis LENGTH, with no separate weighting
 * scheme required: a tiny appendage's few thin samples can only ever pull a
 * large component's fraction up by a small amount, while a genuinely
 * lengthy thin structure (most of a small tagline's own strokes, for
 * example) contributes proportionally many thin samples and correctly
 * dominates its own fraction.
 */

import type { RgbaImage } from "../raster-transform";
import { buildAlphaMasks } from "./alpha-masks";
import {
  chamferDistanceTransform,
  nearestSeedTransform,
  ridgeMask,
} from "./distance-transform";
import { labelConnectedComponents, type ComponentBounds } from "./connected-components";
import {
  FEATURE_INTEGRITY_ALGORITHM_VERSION,
  FEATURE_INTEGRITY_MAX_RECORDS_PER_CATEGORY,
  MICRO_COMPONENT_DIAGNOSTIC_DIAMETER_MM,
  type FeatureIntegrityMeasurement,
  type IsolatedComponent,
  type MicroComponentAggregate,
  type NegativeSpaceChannel,
  type PartialAlphaComponent,
  type PositiveFeatureComponent,
  type StructuralFractionThresholds,
  type StructuralFractions,
} from "./feature-integrity-types";

const MM_PER_INCH = 25.4;
/** Fraction of the raster's shorter side used to decide which background ridge pixels are worth clustering into a discrete diagnostic channel. See module doc comment — a clustering aid, never a print-readiness threshold. */
const DIAGNOSTIC_CLUSTERING_WIDTH_FRACTION = 0.05;
/** Relative difference between horizontal and vertical pixel pitch above which non-square physical pixels are called out explicitly (Section 7). */
const PIXEL_PITCH_ANISOTROPY_NOTE_THRESHOLD = 0.01;

export interface MeasureFeatureIntegrityInput {
  image: RgbaImage;
  confirmedWidthIn: number;
  confirmedHeightIn: number;
  /**
   * Phase 2A: optional physical-width floors used ONLY to compute each
   * component's `StructuralFractions` — see this module's and
   * `feature-integrity-types.ts`'s doc comments. Omitted entirely (both
   * default to `undefined`) means every `structuralFractions` field in the
   * output is `null` and no `worstStructuralComponent` is computed — the
   * measurement otherwise behaves exactly as it did before this option
   * existed.
   */
  positiveFeatureThresholds?: StructuralFractionThresholds;
  negativeSpaceThresholds?: StructuralFractionThresholds;
}

/** A width sample plus which component it belongs to — collected once per ridge pixel, reduced into per-component distributions, then discarded (never persisted; Section 6). */
interface ComponentDistribution {
  widthsMm: number[];
}

export function measureFeatureIntegrity(
  input: MeasureFeatureIntegrityInput,
): FeatureIntegrityMeasurement {
  const { image, confirmedWidthIn, confirmedHeightIn } = input;
  const { width, height } = image;
  const limitations: string[] = [];

  const pixelPitchXMm = (confirmedWidthIn * MM_PER_INCH) / width;
  const pixelPitchYMm = (confirmedHeightIn * MM_PER_INCH) / height;
  const pitchAnisotropy =
    Math.abs(pixelPitchXMm - pixelPitchYMm) / Math.max(pixelPitchXMm, pixelPitchYMm);
  if (pitchAnisotropy > PIXEL_PITCH_ANISOTROPY_NOTE_THRESHOLD) {
    limitations.push(
      `Horizontal and vertical pixel pitch differ by ${(pitchAnisotropy * 100).toFixed(1)}% ` +
        `(${pixelPitchXMm.toFixed(4)}mm vs ${pixelPitchYMm.toFixed(4)}mm per pixel); physical widths use their geometric mean, which is an approximation for a feature at an arbitrary angle.`,
    );
  }
  // Geometric mean: for a feature at an arbitrary angle, this is a reasonable
  // single physical-size-per-pixel figure when pitch is (as expected for a
  // proportionally resampled production plate) close to square. Area
  // conversions below always use the exact `pixelPitchXMm * pixelPitchYMm`
  // product instead, which is correct regardless of anisotropy.
  const isotropicPitchMm = Math.sqrt(pixelPitchXMm * pixelPitchYMm);
  const areaMmPerPx = pixelPitchXMm * pixelPitchYMm;

  const masks = buildAlphaMasks(image);

  let visibleArtPixelCount = 0;
  let partialAlphaPixelCount = 0;
  let strongInkPixelCount = 0;
  for (let i = 0; i < width * height; i += 1) {
    if (masks.visibleArt[i]) visibleArtPixelCount += 1;
    if (masks.partialAlpha[i]) partialAlphaPixelCount += 1;
    if (masks.strongInk[i]) strongInkPixelCount += 1;
  }

  // ---------------------------------------------------------------------
  // Positive feature geometry
  // ---------------------------------------------------------------------
  // Stroke thickness is meaningless without at least one background pixel
  // anywhere in the raster to measure distance TO — an unseeded distance
  // transform over an all-ink canvas has no finite answer. This is not a
  // realistic production case (normalization always leaves a small
  // transparent safety margin around trimmed artwork — see
  // `final-artwork/alpha-trim.ts`), but a raw or otherwise fully-opaque
  // input must fail honestly rather than report a fabricated width.
  const hasAnyBackground = visibleArtPixelCount < width * height;
  if (!hasAnyBackground && width * height > 0) {
    limitations.push(
      "Every pixel is visible artwork with no transparent margin anywhere; positive-feature stroke width could not be measured (this is not expected for a normalized production plate).",
    );
  }
  const inkLabelled = hasAnyBackground
    ? labelConnectedComponents(masks.strongInk, width, height)
    : { labels: new Int32Array(width * height).fill(-1), components: [] };
  const inkDt = hasAnyBackground
    ? chamferDistanceTransform(masks.strongInk, width, height)
    : new Float64Array(width * height);
  const inkRidge = hasAnyBackground
    ? ridgeMask(masks.strongInk, inkDt, width, height)
    : new Uint8Array(width * height);

  const positiveDistributions: ComponentDistribution[] = inkLabelled.components.map(() => ({
    widthsMm: [],
  }));
  for (let i = 0; i < width * height; i += 1) {
    if (!inkRidge[i]) continue;
    const id = inkLabelled.labels[i]!;
    positiveDistributions[id]!.widthsMm.push(inkDt[i]! * 2 * isotropicPitchMm);
  }

  const positiveComponents: PositiveFeatureComponent[] = inkLabelled.components.map((c, id) => {
    const stats = distributionStats(positiveDistributions[id]!.widthsMm, input.positiveFeatureThresholds);
    return {
      id,
      pixelArea: c.pixelCount,
      boundsPx: c.bounds,
      physicalAreaMm2: c.pixelCount * areaMmPerPx,
      minStrokeWidthPx: stats.minMm === null ? null : stats.minMm / isotropicPitchMm,
      minStrokeWidthMm: stats.minMm,
      p25StrokeWidthMm: stats.p25Mm,
      medianStrokeWidthMm: stats.medianMm,
      structuralFractions: stats.fractions,
      ridgeSampleCount: stats.sampleCount,
    };
  });

  const positiveWidthsMm = positiveComponents
    .map((c) => c.minStrokeWidthMm)
    .filter((v): v is number => v !== null);
  if (inkLabelled.components.length > 0 && positiveWidthsMm.length === 0) {
    limitations.push(
      "No ink component was large enough to produce a measurable ridge; positive-feature width could not be determined for any component.",
    );
  }
  const worstPositiveStructural = worstStructuralComponent(
    positiveComponents.map((c) => ({ minMm: c.minStrokeWidthMm, fractions: c.structuralFractions })),
  );

  // ---------------------------------------------------------------------
  // Negative space geometry
  // ---------------------------------------------------------------------
  // Meaningless when there is no visible artwork at all — the whole canvas
  // is then one undifferentiated background with no ink to be "enclosed by
  // or between" (Section 4), and an unseeded distance transform over an
  // all-background mask has no finite answer to give.
  const hasVisibleArt = visibleArtPixelCount > 0;
  if (!hasVisibleArt) {
    limitations.push("No visible artwork was found; negative-space geometry is not applicable.");
  }
  const gapLabelled = hasVisibleArt
    ? labelConnectedComponents(masks.background, width, height)
    : { labels: new Int32Array(width * height).fill(-1), components: [] };
  const gapDt = hasVisibleArt
    ? chamferDistanceTransform(masks.background, width, height)
    : new Float64Array(width * height);
  const gapRidge = hasVisibleArt
    ? ridgeMask(masks.background, gapDt, width, height)
    : new Uint8Array(width * height);

  const negativeComponents: NegativeSpaceChannel[] = [];
  let negativeChannelId = 0;

  // (a) Enclosed cavities: background components that never touch the
  // raster border (a letter's counter, a fully surrounded hole).
  for (const cavity of gapLabelled.components) {
    if (cavity.touchesBorder) continue;
    const widthsMm: number[] = [];
    for (let y = cavity.bounds.top; y < cavity.bounds.bottom; y += 1) {
      for (let x = cavity.bounds.left; x < cavity.bounds.right; x += 1) {
        const i = y * width + x;
        if (gapLabelled.labels[i] !== cavity.id || !gapRidge[i]) continue;
        widthsMm.push(gapDt[i]! * 2 * isotropicPitchMm);
      }
    }
    const stats = distributionStats(widthsMm, input.negativeSpaceThresholds);
    negativeComponents.push({
      id: negativeChannelId++,
      pixelArea: cavity.pixelCount,
      boundsPx: cavity.bounds,
      physicalAreaMm2: cavity.pixelCount * areaMmPerPx,
      enclosed: true,
      minGapWidthPx: stats.minMm === null ? null : stats.minMm / isotropicPitchMm,
      minGapWidthMm: stats.minMm,
      p25GapWidthMm: stats.p25Mm,
      medianGapWidthMm: stats.medianMm,
      structuralFractions: stats.fractions,
      ridgeSampleCount: stats.sampleCount,
    });
  }

  // (b) Open channels: within the border-touching background region(s),
  // cluster only the ridge pixels already narrower than the diagnostic
  // clustering cutoff — see module doc comment for why this is necessary
  // and why it never affects the raw global measurement below.
  const clusteringCutoffPx = Math.min(width, height) * DIAGNOSTIC_CLUSTERING_WIDTH_FRACTION;
  const narrowOpenRidge = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i += 1) {
    if (!gapRidge[i]) continue;
    const owner = gapLabelled.components[gapLabelled.labels[i]!]!;
    if (!owner.touchesBorder) continue; // handled as a cavity above
    if (gapDt[i]! * 2 < clusteringCutoffPx) narrowOpenRidge[i] = 1;
  }
  const openClusters = labelConnectedComponents(narrowOpenRidge, width, height);
  // Phase 2A: a narrow cluster is, by construction, a group of pixels that
  // ALREADY passed a "this is narrow" filter — its OWN fraction-below-floor
  // is therefore always ~100% no matter what it contains, which would make
  // structural-vs-incidental classification meaningless for open channels
  // specifically (unlike ink components or enclosed cavities, which are
  // measured over their own COMPLETE, unfiltered pixel set). Structural
  // fractions for an open channel are instead computed from a WIDER local
  // context window around the narrow cluster — every gap ridge pixel
  // (narrow or not) within that window, belonging to the SAME background
  // region — so a brief pinch surrounded by a genuinely wide corridor
  // correctly reads as a small fraction of its own local context, while a
  // corridor that is narrow for its whole length still reads as
  // predominantly narrow. `minGapWidthMm`/`p25`/`median` stay computed from
  // the TIGHT cluster itself (the actual measured risk spot); only the
  // fraction pair looks at the wider context.
  const structuralContextMarginPx = Math.round(clusteringCutoffPx * 4);
  for (const cluster of openClusters.components) {
    const widthsMm: number[] = [];
    let ownerBackgroundLabel = -1;
    for (let y = cluster.bounds.top; y < cluster.bounds.bottom; y += 1) {
      for (let x = cluster.bounds.left; x < cluster.bounds.right; x += 1) {
        const i = y * width + x;
        if (openClusters.labels[i] !== cluster.id) continue;
        widthsMm.push(gapDt[i]! * 2 * isotropicPitchMm);
        if (ownerBackgroundLabel < 0) ownerBackgroundLabel = gapLabelled.labels[i]!;
      }
    }
    const stats = distributionStats(widthsMm, undefined);

    let fractions: StructuralFractions | null = null;
    if (input.negativeSpaceThresholds) {
      const contextWidthsMm: number[] = [];
      const ctxTop = Math.max(0, cluster.bounds.top - structuralContextMarginPx);
      const ctxBottom = Math.min(height, cluster.bounds.bottom + structuralContextMarginPx);
      const ctxLeft = Math.max(0, cluster.bounds.left - structuralContextMarginPx);
      const ctxRight = Math.min(width, cluster.bounds.right + structuralContextMarginPx);
      for (let y = ctxTop; y < ctxBottom; y += 1) {
        for (let x = ctxLeft; x < ctxRight; x += 1) {
          const i = y * width + x;
          if (!gapRidge[i] || gapLabelled.labels[i] !== ownerBackgroundLabel) continue;
          contextWidthsMm.push(gapDt[i]! * 2 * isotropicPitchMm);
        }
      }
      fractions = distributionStats(contextWidthsMm, input.negativeSpaceThresholds).fractions;
    }

    negativeComponents.push({
      id: negativeChannelId++,
      pixelArea: cluster.pixelCount,
      boundsPx: cluster.bounds,
      physicalAreaMm2: cluster.pixelCount * areaMmPerPx,
      enclosed: false,
      minGapWidthPx: stats.minMm === null ? null : stats.minMm / isotropicPitchMm,
      minGapWidthMm: stats.minMm,
      p25GapWidthMm: stats.p25Mm,
      medianGapWidthMm: stats.medianMm,
      structuralFractions: fractions,
      ridgeSampleCount: stats.sampleCount,
    });
  }

  // The TRUE global minimum/percentile is read directly off every gap ridge
  // pixel, independent of the diagnostic clustering above — clustering
  // exists only to produce legible bounding boxes, never to gate which
  // pixels count toward the honest aggregate measurement.
  const allGapRidgeWidthsMm: number[] = [];
  for (let i = 0; i < width * height; i += 1) {
    if (gapRidge[i]) allGapRidgeWidthsMm.push(gapDt[i]! * 2 * isotropicPitchMm);
  }
  const worstNegativeStructural = worstStructuralComponent(
    negativeComponents.map((c) => ({ minMm: c.minGapWidthMm, fractions: c.structuralFractions })),
  );

  // ---------------------------------------------------------------------
  // Isolated component geometry (reuses the ink components above)
  // ---------------------------------------------------------------------
  const inkComponentCount = inkLabelled.components.length;
  let nearestNeighborMmByComponent: Array<number | null> = inkLabelled.components.map(() => null);

  if (inkComponentCount > 1) {
    const seedLabel = new Int32Array(width * height).fill(-1);
    for (let i = 0; i < width * height; i += 1) {
      if (masks.strongInk[i]) seedLabel[i] = inkLabelled.labels[i]!;
    }
    const { distance: nearestInkDistance, nearestLabel } = nearestSeedTransform(
      seedLabel,
      width,
      height,
    );
    const best: Array<number | null> = inkLabelled.components.map(() => null);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const i = y * width + x;
        if (masks.strongInk[i]) continue; // only background pixels sit between two components
        const ownLabel = nearestLabel[i]!;
        if (ownLabel < 0) continue;
        const neighbors = [
          x > 0 ? i - 1 : -1,
          x < width - 1 ? i + 1 : -1,
          y > 0 ? i - width : -1,
          y < height - 1 ? i + width : -1,
        ];
        for (const ni of neighbors) {
          if (ni < 0 || masks.strongInk[ni]) continue;
          const otherLabel = nearestLabel[ni]!;
          if (otherLabel < 0 || otherLabel === ownLabel) continue;
          // This pixel sits on the boundary between two components' nearest
          // regions — roughly equidistant from both, so twice its distance
          // approximates the gap between the two components.
          const estimate = nearestInkDistance[i]! * 2;
          if (best[ownLabel] === null || estimate < best[ownLabel]!) best[ownLabel] = estimate;
        }
      }
    }
    nearestNeighborMmByComponent = best.map((v) => (v === null ? null : v * isotropicPitchMm));
  }

  const isolatedComponents: IsolatedComponent[] = inkLabelled.components.map((c, id) => {
    const areaMm2 = c.pixelCount * areaMmPerPx;
    let partialCount = 0;
    for (let y = c.bounds.top; y < c.bounds.bottom; y += 1) {
      for (let x = c.bounds.left; x < c.bounds.right; x += 1) {
        const i = y * width + x;
        if (inkLabelled.labels[i] !== id) continue;
        if (masks.partialAlpha[i]) partialCount += 1;
      }
    }
    return {
      id,
      pixelArea: c.pixelCount,
      boundsPx: c.bounds,
      physicalAreaMm2: areaMm2,
      widthMm: c.bounds.width * pixelPitchXMm,
      heightMm: c.bounds.height * pixelPitchYMm,
      equivalentDiameterMm: 2 * Math.sqrt(areaMm2 / Math.PI),
      distanceToNearestNeighborMm: nearestNeighborMmByComponent[id] ?? null,
      // NOTE: this component is drawn from `strongInk`, so its own pixel
      // count never includes partial-alpha pixels; this fraction instead
      // measures partial-alpha pixels immediately within its bounding box,
      // as a soft/faint-edge signal for that component. `0` is the honest
      // answer for a crisply-filled component.
      partialAlphaFraction: c.pixelCount > 0 ? partialCount / c.pixelCount : 0,
    };
  });

  // Phase 2A (Section 7): population-level view of the smallest isolated
  // components — see `MicroComponentAggregate`'s doc comment for why this is
  // kept distinct from `structuralFractions` (a population of separate tiny
  // OBJECTS is a different diagnostic question than narrow geometry INSIDE
  // one larger object).
  const microComponents = isolatedComponents.filter(
    (c) => c.equivalentDiameterMm < MICRO_COMPONENT_DIAGNOSTIC_DIAMETER_MM,
  );
  const microComponentAggregate: MicroComponentAggregate = {
    microComponentCount: microComponents.length,
    totalMicroComponentPixelArea: microComponents.reduce((sum, c) => sum + c.pixelArea, 0),
    totalMicroComponentPhysicalAreaMm2: microComponents.reduce((sum, c) => sum + c.physicalAreaMm2, 0),
    fractionOfPrintedArea:
      strongInkPixelCount > 0
        ? microComponents.reduce((sum, c) => sum + c.pixelArea, 0) / strongInkPixelCount
        : 0,
    meanPartialAlphaFraction: microComponents.length
      ? microComponents.reduce((sum, c) => sum + c.partialAlphaFraction, 0) / microComponents.length
      : 0,
  };

  // ---------------------------------------------------------------------
  // Partial-alpha geometry
  // ---------------------------------------------------------------------
  const partialLabelled = labelConnectedComponents(masks.partialAlpha, width, height);
  const partialComponents: PartialAlphaComponent[] = partialLabelled.components.map((c) => {
    let alphaSum = 0;
    for (let y = c.bounds.top; y < c.bounds.bottom; y += 1) {
      for (let x = c.bounds.left; x < c.bounds.right; x += 1) {
        const i = y * width + x;
        if (partialLabelled.labels[i] !== c.id) continue;
        alphaSum += image.data[i * 4 + 3]!;
      }
    }
    const areaMm2 = c.pixelCount * areaMmPerPx;
    return {
      id: c.id,
      pixelArea: c.pixelCount,
      boundsPx: c.bounds,
      meanAlpha: c.pixelCount > 0 ? alphaSum / c.pixelCount : 0,
      widthMm: c.bounds.width * pixelPitchXMm,
      heightMm: c.bounds.height * pixelPitchYMm,
      equivalentDiameterMm: 2 * Math.sqrt(areaMm2 / Math.PI),
    };
  });

  return {
    algorithmVersion: FEATURE_INTEGRITY_ALGORITHM_VERSION,
    productionWidthPx: width,
    productionHeightPx: height,
    confirmedWidthIn,
    confirmedHeightIn,
    pixelPitchXMm,
    pixelPitchYMm,
    positive: {
      components: capWorstFirst(positiveComponents, (c) => c.minStrokeWidthMm),
      totalComponentCount: positiveComponents.length,
      globalMinStrokeWidthMm: positiveWidthsMm.length ? Math.min(...positiveWidthsMm) : null,
      percentile5StrokeWidthMm: percentile(positiveWidthsMm, 0.05),
      worstStructuralComponent: worstPositiveStructural && {
        minStrokeWidthMm: worstPositiveStructural.minMm,
        fractionBelowBlockingFloor: worstPositiveStructural.fractions.fractionBelowBlockingFloor,
        fractionBelowWarningFloor: worstPositiveStructural.fractions.fractionBelowWarningFloor,
      },
    },
    negative: {
      components: capWorstFirst(negativeComponents, (c) => c.minGapWidthMm),
      totalComponentCount: negativeComponents.length,
      globalMinGapWidthMm: allGapRidgeWidthsMm.length ? Math.min(...allGapRidgeWidthsMm) : null,
      percentile5GapWidthMm: percentile(allGapRidgeWidthsMm, 0.05),
      worstStructuralComponent: worstNegativeStructural && {
        minGapWidthMm: worstNegativeStructural.minMm,
        fractionBelowBlockingFloor: worstNegativeStructural.fractions.fractionBelowBlockingFloor,
        fractionBelowWarningFloor: worstNegativeStructural.fractions.fractionBelowWarningFloor,
      },
    },
    isolated: {
      components: capWorstFirst(isolatedComponents, (c) => c.equivalentDiameterMm),
      totalComponentCount: isolatedComponents.length,
      smallestEquivalentDiameterMm: isolatedComponents.length
        ? Math.min(...isolatedComponents.map((c) => c.equivalentDiameterMm))
        : null,
      microComponents: microComponentAggregate,
    },
    partialAlpha: {
      partialAlphaFractionOfVisible:
        visibleArtPixelCount > 0 ? partialAlphaPixelCount / visibleArtPixelCount : 0,
      components: capWorstFirst(partialComponents, (c) => c.equivalentDiameterMm),
      totalComponentCount: partialComponents.length,
      smallestEquivalentDiameterMm: partialComponents.length
        ? Math.min(...partialComponents.map((c) => c.equivalentDiameterMm))
        : null,
    },
    limitations,
  };
}

interface DistributionStats {
  minMm: number | null;
  p25Mm: number | null;
  medianMm: number | null;
  fractions: StructuralFractions | null;
  sampleCount: number;
}

/** Reduces one component's raw ridge-width samples (transient — never returned or persisted) into its bounded distribution summary. */
function distributionStats(
  widthsMm: number[],
  thresholds: StructuralFractionThresholds | undefined,
): DistributionStats {
  if (widthsMm.length === 0) {
    return { minMm: null, p25Mm: null, medianMm: null, fractions: null, sampleCount: 0 };
  }
  const sorted = [...widthsMm].sort((a, b) => a - b);
  let fractions: StructuralFractions | null = null;
  if (thresholds) {
    let belowBlocking = 0;
    let belowWarning = 0;
    for (const w of sorted) {
      if (w < thresholds.blockingFloorMm) belowBlocking += 1;
      if (w < thresholds.warningFloorMm) belowWarning += 1;
    }
    fractions = {
      fractionBelowBlockingFloor: belowBlocking / sorted.length,
      fractionBelowWarningFloor: belowWarning / sorted.length,
    };
  }
  return {
    minMm: sorted[0]!,
    p25Mm: percentile(sorted, 0.25),
    medianMm: percentile(sorted, 0.5),
    fractions,
    sampleCount: sorted.length,
  };
}

/**
 * The component whose own `fractionBelowBlockingFloor` is highest (ties
 * broken by `fractionBelowWarningFloor`), computed from the FULL list before
 * any worst-first capping — see `PositiveFeatureGeometry.worstStructuralComponent`'s
 * doc comment for why that ordering matters.
 */
function worstStructuralComponent(
  candidates: Array<{ minMm: number | null; fractions: StructuralFractions | null }>,
): { minMm: number | null; fractions: StructuralFractions } | null {
  let worst: { minMm: number | null; fractions: StructuralFractions } | null = null;
  for (const c of candidates) {
    if (!c.fractions) continue;
    if (
      !worst ||
      c.fractions.fractionBelowBlockingFloor > worst.fractions.fractionBelowBlockingFloor ||
      (c.fractions.fractionBelowBlockingFloor === worst.fractions.fractionBelowBlockingFloor &&
        c.fractions.fractionBelowWarningFloor > worst.fractions.fractionBelowWarningFloor)
    ) {
      worst = { minMm: c.minMm, fractions: c.fractions };
    }
  }
  return worst;
}

function capWorstFirst<T>(
  items: T[],
  keyFn: (item: T) => number | null,
): T[] {
  const sorted = [...items].sort((a, b) => {
    const ka = keyFn(a);
    const kb = keyFn(b);
    if (ka === null && kb === null) return 0;
    if (ka === null) return 1;
    if (kb === null) return -1;
    return ka - kb;
  });
  return sorted.slice(0, FEATURE_INTEGRITY_MAX_RECORDS_PER_CATEGORY);
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))));
  return sorted[index]!;
}

export type { ComponentBounds };
