/**
 * Existing Artwork → Print Ready Phase 1: provider-neutral contracts for the
 * `ArtworkPreparationCapability`.
 *
 * Nothing in here is customer-facing copy. Every field is internal
 * diagnostics — flood-fill tolerances, edge sigmas, mask pixel counts — and
 * `preparation-copy.ts` is the ONE place any of it becomes a sentence a
 * customer reads (Constitution §6.6: hide technical complexity).
 */

import type { PrintPlacement } from "@/lib/domain/types";

/** RGB in 0–255, straight (non-premultiplied). */
export interface RgbColor {
  r: number;
  g: number;
  b: number;
}

/** Per-channel statistics over the image's outermost pixel ring. */
export interface EdgeStatistics {
  /** How many pixels the border ring contains. */
  sampleCount: number;
  /** Mean colour of the ring, in 0–255. The bowling reference measures ≈ (0.78, 0.78, 0.78). */
  meanColor: RgbColor;
  /** Per-channel standard deviation, in 0–255. The bowling reference measures ≈ 0.53. */
  standardDeviation: RgbColor;
  /** The largest of the three channel deviations — the single number the classifier gates on. */
  maxChannelStandardDeviation: number;
  /**
   * The robust background estimate: the dominant quantized edge colour,
   * refined to the mean of every edge pixel near it. Deliberately NOT the
   * plain mean — one bright pixel in a corner must never define the
   * background.
   */
  dominantColor: RgbColor;
  /** Fraction of edge pixels within tolerance of `dominantColor` (0–1). */
  dominantColorCoverage: number;
  /** Fraction of edge pixels that are already transparent (0–1). */
  transparentFraction: number;
}

/** Where the artwork actually is, in source pixels. `right`/`bottom` exclusive. */
export interface ArtworkBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

/**
 * Whether the artwork carries enough real pixels for a given placement's
 * production target. Pure arithmetic against
 * `shared/print-placement-dimensions.ts` — this module never invents a
 * second sizing table.
 */
export interface PixelSufficiency {
  placement: PrintPlacement;
  targetWidthIn: number;
  targetPpi: number;
  /** `targetWidthIn * targetPpi`, rounded — e.g. 3150px for 10.5" at 300 PPI. */
  requiredWidthPx: number;
  /** The VISIBLE artwork's width, not the canvas width — padding is not resolution. */
  availableWidthPx: number;
  sufficient: boolean;
  /** `availableWidthPx / requiredWidthPx`, capped for readability at 99. */
  coverageRatio: number;
}

/** How the exterior background should be treated, if at all. */
export type BackgroundTreatment =
  /** A uniform, edge-connected background we can remove deterministically. */
  | "remove_exterior"
  /** The upload already has usable transparency; nothing to remove. */
  | "already_transparent"
  /** Too complex/ambiguous to remove safely without a different method. */
  | "manual_review"
  /** There is no meaningful artwork to isolate at all. */
  | "none";

/**
 * The conservative Phase 1 verdict. Ordered from best to worst; when more
 * than one applies, `repairability.ts` documents the precedence.
 */
export type RepairabilityClassification =
  | "PRINT_READY_ALREADY"
  | "REPAIRABLE_AUTOMATICALLY"
  | "REQUIRES_ENHANCEMENT"
  | "NEEDS_REVIEW"
  | "NOT_REPAIRABLE";

/** Stable machine reasons behind a classification. Never customer-facing strings. */
export type RepairabilityReasonCode =
  | "already_transparent"
  | "uniform_exterior_background"
  | "insufficient_pixels_for_target"
  | "complex_exterior_background"
  | "background_not_edge_connected"
  | "mask_would_remove_almost_everything"
  | "mask_would_remove_almost_nothing"
  | "no_visible_artwork";

/**
 * The complete deterministic analysis of one uploaded image. Computed with
 * pure pixel math — no AI, no network, no provider.
 */
export interface ArtworkAnalysis {
  widthPx: number;
  heightPx: number;
  /** Always `"image/png"` in Phase 1 — the one format this pipeline decodes. */
  format: string;
  byteSize: number;
  /** The PNG's colour type declares an alpha channel. A hint only. */
  declaresAlphaChannel: boolean;
  /** MEASURED: at least one pixel has alpha < 255. */
  hasTransparency: boolean;
  /** MEASURED: every pixel has alpha 255. */
  fullyOpaque: boolean;
  /** MEASURED: no pixel has meaningful alpha — there is nothing to print. */
  fullyTransparent: boolean;
  edge: EdgeStatistics;
  /** The background colour the isolation pass would use, from `edge.dominantColor`. */
  estimatedBackgroundColor: RgbColor;
  /**
   * Colour-distance tolerance the isolation pass would use, derived from
   * `edge.maxChannelStandardDeviation`. The bowling reference resolves to 12.
   */
  backgroundTolerance: number;
  /** Fraction of the canvas an edge-connected fill from the border would remove (0–1). */
  exteriorMaskFraction: number;
  /**
   * Pixels that MATCH the background colour but are NOT reachable from the
   * border — intentional interior blacks, enclosed shapes, outlines. The
   * bowling reference has ≈5,835 of these, and destroying them is the
   * single worst thing this pipeline could do.
   */
  disconnectedBackgroundColoredPixels: number;
  /** True when the border ring is dominated by one colour that a fill can actually spread through. */
  backgroundIsEdgeConnected: boolean;
  /** Bounds of everything the exterior mask would leave behind. `null` when nothing survives. */
  artworkBounds: ArtworkBounds | null;
  /** Fraction of the canvas that is NOT visible artwork (0–1) — padding, not content. */
  deadCanvasFraction: number;
  /** 0–1. How confident the deterministic pass is that automatic removal is safe. */
  backgroundConfidence: number;
  /** `null` when no print placement is known yet — never guessed. */
  pixelSufficiency: PixelSufficiency | null;
}

/** What the classifier concluded, plus everything a caller needs to act on it. */
export interface RepairabilityAssessment {
  classification: RepairabilityClassification;
  backgroundTreatment: BackgroundTreatment;
  /**
   * True only when `backgroundTreatment` is a treatment this Phase can
   * perform deterministically. The single gate the capability checks before
   * touching a pixel.
   */
  canPrepareAutomatically: boolean;
  /** True when the artwork needs more real pixels before FINAL production (Phase 2's job). */
  enhancementRequired: boolean;
  reasons: RepairabilityReasonCode[];
}

/** Per-pass record of what background isolation actually did. Internal diagnostics. */
export interface BackgroundPreparationRecord {
  /** `false` for the already-transparent path, which re-encodes without removing anything. */
  backgroundRemoved: boolean;
  backgroundColor: RgbColor;
  tolerance: number;
  /** Pixels the edge-connected fill made fully transparent. */
  exteriorPixelsRemoved: number;
  /**
   * Background-coloured pixels deliberately KEPT: nothing connected them to
   * the border, and they did not earn enclosed-cavity evidence either. The
   * bowling ball's finger holes are counted here, and that is the point.
   */
  interiorBackgroundColoredPixelsPreserved: number;
  /**
   * Enclosed, background-coloured regions that a foreground structure sealed
   * off from the border and that the cavity evidence confirmed ARE background
   * — letter counters, ring interiors, framed areas. See
   * `background-cavities.ts` for the evidence required.
   */
  enclosedCavityRegionsRemoved: number;
  /** Total pixels in those regions. */
  enclosedCavityPixelsRemoved: number;
  /**
   * Enclosed candidate regions the evidence refused to remove. Includes both
   * the customer's intentional interior shapes (a bowling ball's finger holes)
   * and regions whose geometry was simply ambiguous — the latter are exactly
   * what `guidedRegionsRemoved` below can later claim.
   */
  enclosedCavityRegionsPreserved: number;
  /**
   * Phase 1.2: preserved candidate regions the CUSTOMER clicked to say "this
   * is background too". Always 0 for an automatic preparation; a non-zero
   * value is the honest record that these pixels went on the customer's
   * authority rather than on measured evidence. See `guided-removal.ts`.
   */
  guidedRegionsRemoved: number;
  /** Total pixels in those regions. */
  guidedPixelsRemoved: number;
  /**
   * Phase 1.2: isolated near-background flecks removed by
   * `background-speckle.ts` — residue the fill tolerance just missed, each one
   * fully enclosed by already-removed background.
   */
  speckleIslandsRemoved: number;
  /** Total pixels in those islands. */
  specklePixelsRemoved: number;
  /** Pixels whose alpha was softened at the removed boundary (anti-aliasing). */
  featheredEdgePixels: number;
  /** Pixels whose colour was corrected for background matte contamination. */
  decontaminatedPixels: number;
  /**
   * Phase 1.6, RGB-only edge decontamination. Edge pixels the composite model
   * declined and this pass then EXAMINED — the denominator for the two below.
   */
  fringeRgbFallbackCandidates: number;
  /** Of those, how many were recoloured. Alpha is never written by that pass. */
  fringeRgbFallbackPixels: number;
  /**
   * Of those, how many were left exactly as they were because the ramp
   * evidence was ambiguous. Reported rather than inferred: this number staying
   * healthy is what says the pass is still declining to guess.
   */
  fringeRgbFallbackPreservedAmbiguous: number;
  /**
   * Phase 1.6B, residual edge islands. Pixels belonging to a small dark
   * connected component that lies ENTIRELY inside the fringe band and touches
   * confirmed exterior transparency — the denominator for the two below.
   */
  fringeRgbResidualCandidates: number;
  /** Of those, how many were recoloured. Alpha is never written by that pass either. */
  fringeRgbResidualPixels: number;
  /**
   * Of those, how many were preserved because a per-pixel guard refused —
   * thickness, or no materially brighter artwork neighbour to take colour from.
   */
  fringeRgbResidualPreservedAmbiguous: number;
  /** Transparent pixels near the artwork whose RGB was bled outward to stop upscale halos. */
  haloGuardPixels: number;
  outputWidthPx: number;
  outputHeightPx: number;
  /** Always true for this pipeline — asserted, never assumed. */
  aspectRatioPreserved: boolean;
  /**
   * Intelligent Separation Phase 2: `measureExteriorRemovalEnclosure`'s
   * result comparing the immutable original to THIS prepared image —
   * `enclosure-evidence.ts`.
   *
   * OPTIONAL, and appended at the end of the interface, deliberately: this
   * field did not exist before Phase 2, `preparation` is persisted as loosely
   * typed JSON (`ArtworkPreparation.preparation: Record<string, unknown> |
   * null` in `lib/domain/types.ts`), and no migration accompanies it. A
   * record written before this phase simply lacks the key; every reader
   * MUST treat its absence as "not measured", never as "measured zero" —
   * see `readEnclosureRatio` in `preparation-copy.ts`, the one place that
   * distinction is made.
   *
   * `0` means exterior removal never took a pixel enclosed by surviving
   * artwork. `> 0` means it did at least once. Neither value says anything
   * about whether that pixel mattered — see `enclosure-evidence.ts`'s doc
   * comment for the full boundary of what this number can and cannot prove.
   */
  exteriorRemovalEnclosureRatio?: number;
}
