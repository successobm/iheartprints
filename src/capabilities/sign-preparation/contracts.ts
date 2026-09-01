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
   * treatment, or similar), not merely a seam-quality risk. No admitted
   * repair can resolve this automatically (`edge-dependence.ts`); the plan
   * refuses outright rather than offering a repair operator review could
   * (incorrectly) treat as adequate.
   */
  | "perimeter_structure_at_extension_edge"
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
