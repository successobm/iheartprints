/**
 * Signs Phase S1: the vocabulary of rigid-sign inspection, diagnosis, and
 * repair PLANNING for the admitted rigid_sign_raster production profile
 * (Constitution 3.0 §16A / §16B).
 *
 * Three deliberately separated layers, never collapsed:
 *
 *   OBSERVATION  — `SignInspectionReport`: deterministic measurements of the
 *                  supplied artwork against the ordered substrate. Facts.
 *   DIAGNOSIS    — `SignDefect[]`: explicit, bounded-vocabulary conclusions
 *                  drawn from the observations. Never buried in UI prose.
 *   REPAIR PLAN  — `SignRepairPlan`: the ordered, closed-vocabulary,
 *                  deterministically replayable operations that WOULD make
 *                  the artwork printable. S1 never executes one.
 *
 * Everything here is pure data. No provider, no I/O, no pixels are changed
 * anywhere in this capability.
 */

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

/** Bumped whenever inspection semantics change enough that stored reports must not be compared across versions. */
export const SIGN_INSPECTION_VERSION = "sign-inspection:v1";

/** Bumped whenever the plan schema or step vocabulary changes meaning. Part of plan identity. */
export const SIGN_REPAIR_PLAN_SCHEMA_VERSION = "sign-repair-plan:v1";

/** The admitted profile this capability serves — never the dormant `signage` placeholder. */
export const RIGID_SIGN_CATEGORY = "rigid_sign_raster" as const;

// ---------------------------------------------------------------------------
// Ordered-size authority (Constitution §16A.2)
// ---------------------------------------------------------------------------

/**
 * The human-confirmed ordered physical sign. BOTH dimensions are
 * authoritative; nothing here is ever defaulted or inferred from artwork,
 * aspect ratio, filename, prose, or the dormant `signage` placeholder.
 */
export interface SignProductionSpec {
  category: typeof RIGID_SIGN_CATEGORY;
  orderedWidthIn: number;
  orderedHeightIn: number;
  /** When a human explicitly confirmed this exact size. The consent provenance. */
  confirmedAt: string;
  /** The resolution policy governing this order, stamped at confirm time. */
  resolutionPolicyId: string;
}

/**
 * Structural Layout Reflow Phase 1 (Foundations): the physical production
 * canvas's own shape, in the closed vocabulary V1 admits. `straight_
 * rectangle` is the ONLY member — deliberately no speculative future
 * shapes added ahead of a real, separately-authorized need. See
 * `SignProductionTemplate`'s own doc for why nothing derived from customer
 * artwork may ever select a value here.
 */
export type SignProductionTemplateShape = "straight_rectangle";

/**
 * Structural Layout Reflow Phase 1 (Foundations): the AUTHORITATIVE
 * physical production canvas — real Signs acceptance incident: the
 * pipeline had been treating the customer's own drawn perimeter (frame
 * bands, corner rounding, a decorative border) as though it defined the
 * finished substrate. It never does. The ordered dimensions ALONE define
 * the physical cut area, and for V1 that cut area is always a straight
 * rectangle — Print'em All ships rigid-sign production files this way
 * regardless of any rounded/decorative treatment drawn INSIDE the
 * artwork. `buildSignProductionTemplate` (`sign-production-template.ts`)
 * is the only constructor, and it is built from `SignProductionSpec` +
 * `SignResolutionPolicy` alone — no inspection report, no measured frame
 * model, no pixel of customer artwork is ever a parameter, which is what
 * makes it structurally impossible for a customer's rounded corner, frame
 * radius, or hole placement to select `shape` or otherwise redefine this
 * template.
 */
export interface SignProductionTemplate {
  widthIn: number;
  heightIn: number;
  shape: SignProductionTemplateShape;
  /** See `SIGN_MINIMUM_SAFE_INSET_IN` (`resolution-policy.ts`) — a policy figure, carried here so every consumer reads one authoritative value rather than re-importing the policy separately. */
  minimumSafeInsetIn: number;
}

export type SignSpecMissing =
  | "ordered_width"
  | "ordered_height"
  | "confirmation"
  | "resolution_policy";

/**
 * Fail-closed resolution of a preparation's spec fields. `unconfirmed`
 * carries exactly what is missing so the caller can say so honestly;
 * planning refuses on anything but `confirmed`.
 */
export type SignSpecResolution =
  | { status: "confirmed"; spec: SignProductionSpec }
  | { status: "unconfirmed"; missing: SignSpecMissing[] };

// ---------------------------------------------------------------------------
// Edge inspection (deterministic — no model, no provider)
// ---------------------------------------------------------------------------

export type SignEdge = "top" | "right" | "bottom" | "left";

/**
 * What a source edge BAND (not a single pixel line) provably contains.
 *
 *   uniform_background — affirmative evidence the band is one flat
 *                        background colour. The only classification that can
 *                        make an extension along this edge AUTO_SAFE.
 *   foreground_bleed   — a dominant background exists, but content reaches
 *                        the edge region (the Ruth rainbow case). Extension
 *                        is mechanically possible but leaves a visible
 *                        termination seam → review.
 *   mixed_or_uncertain — no dominant background the algorithm can prove.
 *                        Unknown NEVER becomes safe automatically.
 */
export type SignEdgeClassification =
  | "uniform_background"
  | "foreground_bleed"
  | "mixed_or_uncertain";

/** Everything needed to explain and replay one edge's classification. */
export interface SignEdgeEvidence {
  edge: SignEdge;
  classification: SignEdgeClassification;
  /** Band depth in pixels, measured inward from the edge. */
  bandDepthPx: number;
  /** Length of the edge in pixels (image width for top/bottom, height for left/right). */
  edgeLengthPx: number;
  /** Mean colour of the dominant colour bucket, or null when none dominates. */
  dominantColor: { r: number; g: number; b: number } | null;
  /** Fraction of band pixels within `tolerance` of `dominantColor`. */
  dominantCoverage: number;
  /** Same membership fraction measured on the outermost pixel line only. */
  outermostCoverage: number;
  /** Largest per-channel standard deviation across the band. */
  maxChannelStdDev: number;
  /** Chebyshev RGB membership tolerance the coverage figures used. */
  tolerance: number;
  /** Longest contiguous non-background run along the outermost line, in px. */
  longestNonBackgroundRunPx: number;
  /** Fraction of band pixels with alpha below full opacity. */
  transparentFraction: number;
  /** Human-readable, internal-only rationale. Never customer copy. */
  reason: string;
}

// ---------------------------------------------------------------------------
// Inspection report (OBSERVATION)
// ---------------------------------------------------------------------------

export type SignOrientation = "portrait" | "landscape" | "square";

/** One truthful proportional placement of the source onto the ordered substrate. */
export interface SignPlacementOption {
  strategy: "contain" | "fill";
  /** Physical size the artwork itself occupies under this placement. */
  artworkWidthIn: number;
  artworkHeightIn: number;
  /** Truthful effective PPI of the SOURCE pixels at this physical size. */
  effectivePpi: number;
  /** contain: substrate area the artwork does NOT cover, per side, inches. */
  paddingIn: { left: number; right: number; top: number; bottom: number };
  /** fill: source pixels that would be cut, per axis (total px). */
  cropSourcePx: { horizontal: number; vertical: number };
  /** Edges the padding (contain) or crop (fill) touches. */
  affectedEdges: SignEdge[];
  /**
   * fill only: whether the crop could remove meaningful content. V1 is
   * deliberately conservative — any non-zero crop is treated as potentially
   * meaningful; only a human approving an exact preview may say otherwise.
   */
  meaningfulContentMayBeAffected: boolean;
}

export type SignResolutionStatus =
  | "meets_target"
  | "below_target"
  | "below_minimum";

export interface SignResolutionAssessment {
  /** Native source pixels — never enlarged pixels claimed as detail. */
  sourceWidthPx: number;
  sourceHeightPx: number;
  /** Effective PPI at the truthful contain placement. */
  containEffectivePpi: number;
  targetPpi: number;
  minPpi: number;
  status: SignResolutionStatus;
  /** Uniform scale needed for the contain placement to reach target PPI (1 = already there). */
  requiredScaleToTarget: number;
  /** Uniform scale needed to reach the blocking minimum PPI. */
  requiredScaleToMinimum: number;
}

export interface SignInspectionReport {
  inspectionVersion: typeof SIGN_INSPECTION_VERSION;
  source: { widthPx: number; heightPx: number; aspectRatio: number };
  /** Null when no confirmed spec exists yet — geometry-only inspection. */
  ordered: { widthIn: number; heightIn: number; aspectRatio: number } | null;
  /** Null without a spec. True when source vs ordered aspect differ beyond tolerance. */
  aspectMismatch: boolean | null;
  /** |sourceAspect − orderedAspect| ÷ orderedAspect, when computable. */
  aspectDeltaRatio: number | null;
  orientation: {
    source: SignOrientation;
    ordered: SignOrientation | null;
    /** True when a 90° rotation would bring the aspect within tolerance. */
    rotatedAspectMatches: boolean | null;
  };
  placements: {
    contain: SignPlacementOption | null;
    fill: SignPlacementOption | null;
  };
  resolution: SignResolutionAssessment | null;
  transparency: {
    hasAlphaPixels: boolean;
    transparentPixelFraction: number;
  };
  edges: SignEdgeEvidence[];
}

// ---------------------------------------------------------------------------
// Diagnosis (bounded vocabulary)
// ---------------------------------------------------------------------------

export type SignDefectCode =
  | "missing_confirmed_width"
  | "missing_confirmed_height"
  | "missing_spec_confirmation"
  /** Ordered size has no applicable resolution policy, or the input itself is unusable. */
  | "unsupported_input"
  | "aspect_ratio_mismatch"
  | "resolution_below_target"
  | "resolution_below_minimum"
  /** Even the supported reconstruction ceiling cannot reach the blocking minimum. */
  | "reconstruction_exceeds_supported_scale"
  /** The source carries transparency; rigid-sign production intent is opaque (§16A.2). */
  | "transparency_present"
  /** Foreground provably reaches an edge the geometry repair must extend — visible seam. */
  | "foreground_reaches_extension_edge"
  /**
   * Signs Perimeter Safety Phase: a continuous, near-edge structure on an
   * edge the geometry repair must extend — evidence the artwork's meaning
   * depends on the finished substrate edge (a border, frame, rounded-corner
   * treatment, or similar), not merely a seam-quality risk
   * (`edge-dependence.ts`). Present WHENEVER edge-dependent structure is
   * detected, whether the plan goes on to block outright (no reconstructable
   * pattern — see `perimeter_structure_reconstructed` for the alternative)
   * or to propose bounded reconstruction — the artwork fact is the same
   * either way; what differs is whether an admitted repair for it exists.
   */
  | "perimeter_structure_at_extension_edge"
  /**
   * Production-Aware Perimeter Reconstruction Phase (Constitution §16A.3
   * amendment 3.1): the edge-dependent structure above cleared
   * `perimeter-reconstruction.ts`'s affirmative-uniform-per-line evidence
   * bar, so `reconstruct_perimeter_structure` was proposed instead of an
   * outright block. Always paired with `repair_requires_review` — this
   * repair is never `auto_safe` regardless of evidence strength.
   */
  | "perimeter_structure_reconstructed"
  /**
   * Parametric Perimeter Frame Reconstruction Phase (Constitution §16A.3
   * amendment 3.1's own bounded carve-out, extended): the edge-dependent
   * structure above is a measurable concentric BAND SEQUENCE (a frame —
   * optionally rounded, optionally carrying repeated corner-hole
   * indicators), not a tileable stripe pattern —
   * `frame-structure-model.ts` measured it with real, checkable
   * cross-edge/cross-corner agreement, so `reconstruct_parametric_frame`
   * was proposed instead of an outright block. Always paired with
   * `repair_requires_review` — never `auto_safe` regardless of evidence
   * strength, the same discipline `perimeter_structure_reconstructed`
   * already follows.
   */
  | "parametric_frame_structure_reconstructed"
  /**
   * Structural Layout Reflow Phase 2 (Planner Wiring): the affected axis's
   * edge-dependent/frame-like structure is instead a deterministically
   * measured, banner-style structural layout (`sign-layout-segmentation.ts`
   * — a distinct top/bottom anchor plus ordered middle regions, never a
   * concentric frame band sequence) — proposing `reflow_structural_layout`
   * (translation + source-derived fill extension + proportional gap
   * redistribution onto the authoritative straight-rectangle
   * `SignProductionTemplate`), preferred over `reconstruct_parametric_
   * frame` for this shape because the source's own perimeter never defines
   * the physical substrate boundary (the real Signs acceptance incident
   * this phase corrects). Always paired with `repair_requires_review` —
   * never `auto_safe`, identical discipline to every other perimeter/frame
   * repair code above.
   */
  | "structural_layout_reflow_proposed"
  /** The fill alternative would cut source pixels — never automatic. */
  | "meaningful_crop_required"
  /** The formulated plan needs human judgment before execution. */
  | "repair_requires_review";

export type SignDefectSeverity = "blocking" | "review" | "info";

export interface SignDefect {
  code: SignDefectCode;
  severity: SignDefectSeverity;
  /** Internal rationale — never customer-facing copy. */
  detail: string;
}

// ---------------------------------------------------------------------------
// Repair plan (closed vocabulary — S1 NEVER executes)
// ---------------------------------------------------------------------------

export type SignRiskClass = "auto_safe" | "review_required" | "blocked";

export type SignRepairStepKind =
  | "reconstruct_resolution"
  | "extend_uniform_background"
  | "pad_uniform_background"
  /**
   * Constitution §16A.3 (amendment 3.1) / `sign-preparation/perimeter-
   * reconstruction.ts`. Extends the canvas along the same axis/leadingPx/
   * trailingPx geometry `extend_uniform_background`/`pad_uniform_
   * background` use, but fills the added region by TILING lines actually
   * measured from the customer's own source pixels near the edge, instead
   * of one flat colour — for artwork whose edge structure is a simple,
   * affirmatively uniform-per-line pattern (e.g. stripes), never a guess.
   * Always `review_required` (never `auto_safe`) by constitutional
   * requirement, regardless of what risk any other step in the same plan
   * would independently receive.
   */
  | "reconstruct_perimeter_structure"
  /**
   * Parametric Perimeter Frame Reconstruction Phase (Constitution §16A.3
   * amendment 3.1's own bounded carve-out, extended) /
   * `sign-preparation/frame-structure-model.ts`. For artwork whose
   * perimeter is a measurable concentric BAND SEQUENCE (a frame —
   * optionally rounded, optionally carrying repeated corner-hole
   * indicators) rather than a tileable stripe pattern
   * (`reconstruct_perimeter_structure`'s own narrower shape): crops out
   * the measured protected interior (removing the OLD frame band
   * entirely — never blitted anywhere in the output), then redraws the
   * SAME measured band sequence/corner rounding/hole geometry — colours
   * and proportions only ever taken from the customer's own source pixels,
   * never generated or invented — at the NEW finished substrate boundary,
   * with the interior repositioned (never resized non-uniformly, never
   * resampled) inside it. Always `review_required` (never `auto_safe`) by
   * constitutional requirement, identical to
   * `reconstruct_perimeter_structure`'s own discipline. May coexist with a
   * preceding `reconstruct_resolution` step (unlike
   * `reconstruct_perimeter_structure`, which is scope-limited against
   * that combination) — see `sign-transform-executor.ts`'s own doc on
   * why: this step re-derives every pixel amount from whatever the prior
   * step's ACTUAL output size is, at EXECUTION time, rather than baking
   * in a plan-time prediction.
   */
  | "reconstruct_parametric_frame"
  /**
   * Structural Layout Reflow Phase 2 (Planner Wiring): `sign-repair-
   * planner.ts` now proposes this step — but ONLY when a caller explicitly
   * supplies `SignPlanningInput.structuralLayoutSegmentation` (an opt-in,
   * additive input, exactly like `frameStructuralModel`/`perimeterBands`
   * before it; a caller that never supplies it gets identical behaviour to
   * every prior phase). `sign-transform-executor.ts` still does not admit
   * or execute it (absent from `ADMITTED_STEP_KINDS`) — planning only, no
   * pixel is ever moved by this phase. Distinct in kind from
   * `reconstruct_parametric_frame`, never an overload of it: that step
   * treats the SOURCE artwork's own measured perimeter/frame geometry as
   * the finished substrate boundary
   * to redraw — the real Signs acceptance incident that motivated this
   * phase proved that model wrong for ordinary rectangular signs (the
   * ORDERED cut template, never the artwork, defines the physical
   * boundary; Print'em All ships these as straight rectangles). This step
   * instead treats the source as a sequence of structural regions
   * (`sign-layout-segmentation.ts`) that TRANSLATE onto the authoritative
   * `SignProductionTemplate`, with their own measured background/fill
   * extended to reach the cut edges where authorized and the redistributed
   * spacing between them derived from the source's own proportions —
   * never a redraw of source perimeter geometry as substrate shape, never
   * non-uniform scaling of meaningful content, never generative fill.
   */
  | "reflow_structural_layout"
  | "proportional_resample"
  | "downsample"
  | "approved_crop"
  | "rotate_90";

/**
 * One planned operation, with enough structured parameters to replay it
 * deterministically later. Params are flat number/string values so canonical
 * serialization (plan identity) stays trivial and stable.
 */
export interface SignRepairStep {
  kind: SignRepairStepKind;
  params: Record<string, number | string>;
  risk: SignRiskClass;
  /** Internal rationale for the risk class and the parameters. */
  reasons: string[];
}

export interface SignRepairPlan {
  schemaVersion: typeof SIGN_REPAIR_PLAN_SCHEMA_VERSION;
  policyId: string;
  /** Which asset row the plan was formulated against. */
  sourceAssetId: string;
  /** SHA-256 of the exact source bytes — byte-level identity of the input. */
  sourceSha256: string;
  sourceWidthPx: number;
  sourceHeightPx: number;
  orderedWidthIn: number;
  orderedHeightIn: number;
  /** Ordered. Executing them in sequence yields the expected output below. */
  steps: SignRepairStep[];
  expectedOutputWidthPx: number;
  expectedOutputHeightPx: number;
  /** Effective PPI of the expected plate at the ordered physical size. */
  expectedEffectivePpi: number;
  /** max() of step risks plus defect-driven escalations. */
  overallRisk: SignRiskClass;
  /** Defect codes the plan responds to (diagnosis lives beside it, not inside it). */
  defects: SignDefectCode[];
  /** Internal rationale trail. Excluded from plan identity. */
  reasons: string[];
  /** Canonical identity — see `sign-plan-identity.ts`. */
  planKey: string;
}

export type SignPlanningResult =
  | { status: "planned"; plan: SignRepairPlan; defects: SignDefect[] }
  | { status: "blocked"; plan: null; defects: SignDefect[] };
