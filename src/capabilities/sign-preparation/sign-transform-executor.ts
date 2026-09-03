/**
 * Signs Phase S2: the deterministic rigid-sign transform EXECUTOR.
 *
 * Replays a persisted `SignRepairPlan`'s steps, exactly and in order, against
 * the immutable source image. It does not plan, does not decide, and does
 * not reinterpret — it is the smallest component that turns "here is a
 * plan" into "here are the pixels that plan describes," nothing more.
 *
 * S2 EXECUTES exactly six step kinds: `extend_uniform_background`,
 * `pad_uniform_background`, `reconstruct_perimeter_structure`,
 * `proportional_resample`, `downsample`, `rotate_90`. `reconstruct_resolution`
 * and `approved_crop` are NEVER executed here — encountering either in the
 * plan is an immediate, honest refusal before any pixel is touched
 * (Constitution §16A.3: S2 performs zero provider reconstruction;
 * `approved_crop` remains approval-gated, and no approval mechanism exists
 * yet).
 *
 * Never performs: crop, seam blending, content-aware fill, arbitrary color
 * invention, generative reconstruction, redraw, or text change. A fill color
 * the plan itself could not determine (`params.color === "unconfirmed"`) is
 * refused rather than invented. `reconstruct_perimeter_structure` is the one
 * deliberate, narrow exception to "never performs... reconstruction" — see
 * its own doc below and `perimeter-reconstruction.ts` (Constitution §16A.3
 * amendment 3.1): it tiles COLOURS THE PLAN ALREADY MEASURED from the real
 * source, never anything generated, inferred, or blended, so it is
 * mechanically no different from `executeExtend`'s existing flat-fill blit —
 * only the fill pattern the plan supplies differs.
 */

import { PNG } from "pngjs";

import type { RgbaImage } from "@/capabilities/final-artwork/raster-transform";
import { hasAnyTransparentPixel, resampleExact } from "@/capabilities/final-artwork/raster-transform";

import type { SignRepairPlan, SignRepairStep, SignRepairStepKind } from "./contracts";
import { deriveUniformBackgroundExtension } from "./sign-geometry";
import { tiledRowColor, type SignPerimeterBandMeasurement, type SignPerimeterBandRow } from "./perimeter-reconstruction";
import { frameDepthAt, type SignFrameBand } from "./frame-structure-model";
import { COMPOSITION_STEP_KINDS, executeCompositionSteps, isCompositionStepKind } from "./sign-composition-steps";

/**
 * Rejected-Final Regeneration Phase: the deterministic identity of THIS
 * MODULE'S pixel-producing implementation — the executor-side sibling of
 * `sign-preservation/contracts.ts`'s `SIGN_PRESERVATION_ALGORITHM_VERSION`
 * (which identifies how output is VERIFIED, never how it is PRODUCED).
 * Stamped into every sign final production asset's own `rigidSign`
 * metadata at persist time, so the worker can distinguish "same plan,
 * produced by the current implementation" from "same plan, produced by a
 * since-corrected implementation" — the real incident this exists for: a
 * final asset rendered by the pre-correction parametric-frame executor
 * (its aspect-correction gap painted with the flat `fillColor` fallback)
 * shares the plan's own `planKey` with a corrected rendering, and planKey
 * alone must never keep such an asset reusable forever once the
 * implementation that drew it has been fixed.
 *
 * Versioning discipline: `"sign-execution-v1"` is RETROACTIVE — the
 * pre-correction implementation never stamped anything, so an ABSENT value
 * means v1. Bump this whenever any admitted step's pixel-producing
 * behavior changes (never for refactors that leave output byte-identical).
 * Kept path-safe (lowercase, dashes) because it also qualifies the final
 * asset's deterministic storage-grouping id — a corrected regeneration
 * must land at a DIFFERENT deterministic object key than the stale final
 * it supersedes (create-only storage semantics; the historical object is
 * never overwritten).
 *
 * `"sign-execution-v3"` (Signs Phase 3A): `reflow_structural_layout` is now
 * admitted and executed for the first time — a genuinely new pixel-
 * producing behavior (every prior version refuses it outright as
 * `unsupported_step_kind`), so a v3 bump is required by this module's own
 * discipline above. A final asset produced under v1/v2 never satisfies a
 * v3-scoped consumer's identity check; nothing about v1/v2's own admitted
 * step outputs changes.
 *
 * `"sign-execution-v4"` (Signs Phase 3B, Canvas-First Correction): the
 * four composition primitives (`crop_region`, `fit_artwork_to_canvas`,
 * `move_region`, `fill_rect` — `sign-composition-steps.ts`) are now
 * admitted and executed — a genuinely different pixel-producing engine
 * (canvas created FIRST from the ordered spec alone, artwork fit into it,
 * never the reverse) than every step kind v1-v3 ever admitted. A final
 * asset produced under v1/v2/v3 never satisfies a v4-scoped consumer's
 * identity check, and this bump never reinterprets a historical v1/v2/v3
 * asset as v4 — those assets, their plans, and their own executor code
 * paths remain fully intact and auditable; this bump only changes what
 * the CURRENT build stamps onto and requires of NEW production assets.
 */
export const SIGN_EXECUTION_IMPLEMENTATION_VERSION = "sign-execution-v4";

export interface SignExecutionBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type SignExecutionRefusalReason =
  | "contains_reconstruct_resolution"
  | "contains_approved_crop"
  | "source_transparent"
  | "unconfirmed_fill_color"
  | "unsupported_step_kind"
  | "output_geometry_mismatch"
  | "output_not_opaque";

export type SignExecutionResult =
  | {
      status: "executed";
      image: RgbaImage;
      /** The original source content's own bounds, in OUTPUT image coordinates — every original pixel lies within this rectangle, and every added region lies outside it. */
      contentBounds: SignExecutionBounds;
    }
  | { status: "refused"; reason: SignExecutionRefusalReason; detail: string };

const ADMITTED_STEP_KINDS = new Set<SignRepairStep["kind"]>([
  "extend_uniform_background",
  "pad_uniform_background",
  "reconstruct_perimeter_structure",
  "reconstruct_parametric_frame",
  "reflow_structural_layout",
  "proportional_resample",
  "downsample",
  "rotate_90",
  // Signs Phase 3B: the four composition primitives — see
  // `sign-composition-steps.ts`'s own module doc. Admitted here so
  // `planContainsOnlyAdmittedSteps`/`planRequiresBoundedReconstruction`
  // recognize a canvas-first plan as executable; actual dispatch for
  // these kinds never goes through this module's own per-step `executeStep`
  // switch (see `executeAdmittedSignSteps`'s composition-aware branch
  // below) — they are executed as a single, order-sensitive segment by
  // `executeCompositionSteps`, never individually.
  ...COMPOSITION_STEP_KINDS,
]);

/** True iff every step in the plan is one of S2's admitted, executable kinds. */
export function planContainsOnlyAdmittedSteps(plan: SignRepairPlan): boolean {
  return plan.steps.every((step) => ADMITTED_STEP_KINDS.has(step.kind));
}

/**
 * Signs Phase S3A: true iff `plan` contains exactly one `reconstruct_resolution`
 * step and every OTHER step (before or after it — `rotate_90`, when present,
 * always precedes it; `extend_uniform_background`/`pad_uniform_background`/
 * `downsample`/`proportional_resample` always follow it, per the planner's
 * own "reconstruct FIRST [among resolution/geometry steps], extend SECOND"
 * ordering) is one of S2's admitted deterministic kinds. Distinct from
 * `planContainsOnlyAdmittedSteps` (which is false for any such plan, since
 * `reconstruct_resolution` itself is never S2-admitted): this predicate
 * identifies the plan shape S3A's bounded-provider-reconstruction dispatch
 * exists for, as opposed to a plan that is genuinely unsupported (e.g. one
 * containing `approved_crop`, or a plan with `reconstruct_resolution`
 * appearing more than once — never produced by the current planner, but not
 * trusted here either).
 */
export function planRequiresBoundedReconstruction(plan: SignRepairPlan): boolean {
  const reconstructCount = plan.steps.filter((step) => step.kind === "reconstruct_resolution").length;
  if (reconstructCount !== 1) return false;
  return plan.steps.every(
    (step) => step.kind === "reconstruct_resolution" || ADMITTED_STEP_KINDS.has(step.kind),
  );
}

/**
 * Semantic Worker Wiring Phase: the GENERALIZED question — "does executing
 * this plan produce pixels whose meaning a human/semantic check must
 * confirm, rather than pixels a deterministic proof alone already covers?"
 * — deliberately distinct from `planRequiresBoundedReconstruction`, which
 * answers a narrower, Topaz-specific question ("does this plan need S3A's
 * bounded PROVIDER dispatch and idempotency machinery?").
 *
 * Both `reconstruct_resolution` (provider-synthesized pixels) and
 * `reconstruct_perimeter_structure` (deterministically tiled, but still
 * SYNTHESIZED — not a byte-for-byte carry of customer pixels the way
 * `extend_uniform_background`/`pad_uniform_background`'s flat fill is)
 * answer "yes" here. Every other step kind (flat-colour extension,
 * resample, downsample, rotate) is provably self-verifying by construction
 * — a flat fill is fully checked by exact-colour-match deterministic
 * evidence alone, so it answers "no".
 *
 * This is the ONLY predicate the finalization worker should read to decide
 * whether to call `SignPreservationCapability.verifyPreservation` — never
 * `planRequiresBoundedReconstruction` (that remains the Topaz-dispatch-only
 * question) and never a raw `resolutionProvenance === "reconstructed"`
 * check (that conflates "a provider touched this" with "this needs
 * verification", which is exactly the gap that left `reconstruct_
 * perimeter_structure` permanently unable to reach `print_ready`).
 */
export function planRequiresSemanticPreservationVerification(plan: SignRepairPlan): boolean {
  return plan.steps.some(
    (step) =>
      step.kind === "reconstruct_resolution" ||
      step.kind === "reconstruct_perimeter_structure" ||
      step.kind === "reconstruct_parametric_frame" ||
      // Signs Phase 3A: reflow moves and redistributes real pixels (region
      // translation, gap fill extension) — the identical "pixels moved, a
      // human/semantic check must confirm the composition still means the
      // same thing" reasoning every other entry here already answers "yes"
      // to, even though — unlike the other three — it never touches a
      // provider and its own deterministic checks are exact-match (never
      // advisory-only), never merely a proxy for "provider touched this."
      step.kind === "reflow_structural_layout" ||
      // Signs Phase 3B: every composition primitive moves, crops, fits, or
      // fills real pixels — the identical "a human/semantic check must
      // confirm the composition still means the same thing" reasoning
      // every entry above already answers "yes" to. Tolerant of the
      // AUTHORIZED movement/cropping itself (Section 16's own semantic
      // verification discipline); this predicate only decides whether the
      // one-call check runs at all.
      isCompositionStepKind(step.kind),
  );
}

/**
 * Signs Phase S3A: splits a plan satisfying `planRequiresBoundedReconstruction`
 * into the steps to execute locally BEFORE the provider reconstruction (e.g.
 * a review-gated `rotate_90`), the reconstruction step itself, and the steps
 * to execute locally AFTER it (e.g. `pad_uniform_background`). `null` when
 * the plan does not have exactly that shape — callers must check
 * `planRequiresBoundedReconstruction` first.
 */
export function splitPlanAroundReconstruction(
  plan: SignRepairPlan,
): { before: SignRepairStep[]; reconstruct: SignRepairStep; after: SignRepairStep[] } | null {
  if (!planRequiresBoundedReconstruction(plan)) return null;
  const index = plan.steps.findIndex((step) => step.kind === "reconstruct_resolution");
  return {
    before: plan.steps.slice(0, index),
    reconstruct: plan.steps[index]!,
    after: plan.steps.slice(index + 1),
  };
}

/**
 * Executes an ORDERED SUBSET of S2-admitted steps (never
 * `reconstruct_resolution`/`approved_crop`) against `image`/`bounds`,
 * refusing immediately on the first step this executor cannot honor.
 * Exported (Signs Phase S3A) so a caller that needs to run part of a plan
 * around an out-of-band operation — S3A's provider reconstruction sits
 * between `before` and `after` — can do so without duplicating the
 * step-dispatch switch `executeSignRepairPlan` itself uses for the ordinary,
 * fully-local case.
 */
export function executeAdmittedSignSteps(
  image: RgbaImage,
  bounds: SignExecutionBounds,
  steps: SignRepairStep[],
): SignExecutionResult {
  // Signs Phase 3B: a segment containing ANY composition primitive is
  // delegated WHOLESALE to `executeCompositionSteps` — never folded
  // step-by-step through `executeStep` below, because `move_region`/
  // `fill_rect` need a single fixed base-canvas snapshot shared across the
  // whole segment (see `sign-composition-steps.ts`'s own doc for exactly
  // why the ordinary fold would corrupt a genuine reflow). Mixing a
  // composition primitive into the same segment as a legacy v1-v3 step
  // kind is never an admitted shape — refused before any pixel is touched.
  if (steps.some((step) => isCompositionStepKind(step.kind))) {
    if (!steps.every((step) => isCompositionStepKind(step.kind))) {
      return {
        status: "refused",
        reason: "unsupported_step_kind",
        detail:
          "Composition primitives (crop_region/fit_artwork_to_canvas/move_region/fill_rect) cannot be mixed " +
          "with legacy geometry step kinds in the same execution segment.",
      };
    }
    return executeCompositionSteps(image, bounds, steps);
  }

  let currentImage = image;
  let currentBounds = bounds;
  for (const step of steps) {
    const result = executeStep(currentImage, currentBounds, step);
    if (result.status === "refused") return result;
    currentImage = result.image;
    currentBounds = result.contentBounds;
  }
  return { status: "executed", image: currentImage, contentBounds: currentBounds };
}

/**
 * The tail of every execution, local-only or S3A-continued alike: the
 * executed output's geometry and opacity must match what the caller
 * declares as expected before it is ever persisted. Exported (Signs Phase
 * S3A) so the worker's post-reconstruction continuation applies the exact
 * same final checks `executeSignRepairPlan` applies to a fully-local
 * execution.
 *
 * Signs Phase S3C: takes `expectedWidthPx`/`expectedHeightPx` explicitly
 * rather than a whole `SignRepairPlan` — for a fully-local execution these
 * are always `plan.expectedOutputWidthPx`/`expectedOutputHeightPx`
 * (unchanged, see `executeSignRepairPlan` below), but a reconstruction-
 * continued execution may need to check against ACTUAL-reconstruction-
 * derived dimensions instead (see
 * `adaptGeometryStepsToActualReconstruction`) when the provider's admitted
 * output diverged from what the plan predicted — the plan's own persisted
 * `expectedOutputWidthPx`/`expectedOutputHeightPx` stay untouched either
 * way; only what THIS check validates against can differ.
 */
export function finalizeSignExecution(
  image: RgbaImage,
  bounds: SignExecutionBounds,
  expectedWidthPx: number,
  expectedHeightPx: number,
): SignExecutionResult {
  if (image.width !== expectedWidthPx || image.height !== expectedHeightPx) {
    return {
      status: "refused",
      reason: "output_geometry_mismatch",
      detail:
        `Executed output is ${image.width}x${image.height}px, but the expected output is ` +
        `${expectedWidthPx}x${expectedHeightPx}px. Refusing rather than persisting a plate the plan does not describe.`,
    };
  }
  if (hasAnyTransparentPixel(image)) {
    return {
      status: "refused",
      reason: "output_not_opaque",
      detail:
        "Executed output carries transparency despite an opaque, verified-opaque source and fill colours with full alpha. Refusing rather than persisting an unexpectedly non-opaque plate.",
    };
  }
  return { status: "executed", image, contentBounds: bounds };
}

/**
 * Replays `plan.steps`, in order, against `source`. `source` must already be
 * verified (by the caller) to be the exact bytes `plan.sourceSha256`
 * describes — this function performs no lineage check of its own; it only
 * refuses to execute plans it structurally cannot honor.
 */
export function executeSignRepairPlan(
  source: RgbaImage,
  plan: SignRepairPlan,
): SignExecutionResult {
  const reconstructStep = plan.steps.find((step) => step.kind === "reconstruct_resolution");
  if (reconstructStep) {
    return {
      status: "refused",
      reason: "contains_reconstruct_resolution",
      detail:
        "Plan requires provider reconstruction. S2 performs zero provider reconstruction — refusing before any pixel is touched, and no provider was dispatched.",
    };
  }
  const cropStep = plan.steps.find((step) => step.kind === "approved_crop");
  if (cropStep) {
    return {
      status: "refused",
      reason: "contains_approved_crop",
      detail:
        "Plan requires an approved crop. approved_crop remains approval-gated and is not part of S2 automatic execution.",
    };
  }
  if (hasAnyTransparentPixel(source)) {
    return {
      status: "refused",
      reason: "source_transparent",
      detail:
        "Source artwork carries transparency. No S2 step flattens transparency or invents a fill colour, so a legally opaque plate cannot be produced from it.",
    };
  }

  // The original content's own bounds, tracked through every transform in
  // OUTPUT coordinates. Starts as the whole source frame; extension/padding
  // offsets it, resample/downsample/rotation scale or reorient it, but no
  // step ever shrinks it to exclude a real source pixel.
  const initialBounds: SignExecutionBounds = { x: 0, y: 0, width: source.width, height: source.height };
  const executed = executeAdmittedSignSteps(source, initialBounds, plan.steps);
  if (executed.status === "refused") return executed;
  return finalizeSignExecution(executed.image, executed.contentBounds, plan.expectedOutputWidthPx, plan.expectedOutputHeightPx);
}

// ---------------------------------------------------------------------------
// Signs Phase S3C: adaptive post-reconstruction geometry.
// ---------------------------------------------------------------------------

export type AdaptGeometryStepsOutcome =
  | {
      status: "unchanged" | "adapted";
      steps: SignRepairStep[];
      /** What to validate the final executed output against — see `finalizeSignExecution`'s own doc comment. */
      expectedOutputWidthPx: number;
      expectedOutputHeightPx: number;
    }
  | { status: "refused"; reason: string; detail: string };

/**
 * Signs Phase S3C: re-derives the geometry-stage step(s) that follow a
 * `reconstruct_resolution` step (`extend_uniform_background`/
 * `pad_uniform_background`) from the ACTUAL admitted reconstruction
 * dimensions, when they diverge from what the plan's `reconstruct_resolution`
 * step requested — the real S3B Ruth acceptance run proved a real provider
 * (Topaz) can honestly return more than requested (its own proven 4x
 * ceiling, proportionally, `validateReconstructedGeometry`'s "sufficiency,
 * not exact sizing" contract) while the plan's baked-in pad amounts assumed
 * the exact requested size.
 *
 * NEVER mutates the persisted plan, never changes plan identity/`planKey`,
 * never re-plans, never invents an operation the plan did not already
 * approve. It only recomputes the NUMBER OF PIXELS the plan's own approved
 * semantic operation ("extend axis X, centered, in colour C, to reach the
 * ordered aspect") requires for the actual input — axis, alignment
 * convention, and fill colour are carried over from the persisted step
 * UNCHANGED; only `leadingPx`/`trailingPx` (and, only in the returned
 * result, the expected final canvas) are recomputed.
 *
 * Refuses — never silently reinterprets — the instant the actual input
 * would require a DIFFERENT axis than the plan approved, or a geometry
 * step the plan never included at all. Both are defensive: proportional
 * reconstruction (already enforced by `validateReconstructedGeometry`
 * before this ever runs) preserves aspect ratio exactly, so the axis
 * decision is invariant under it — these branches exist to fail closed on
 * an assumption violation, not because either is expected to fire.
 */
export function adaptGeometryStepsToActualReconstruction(
  afterSteps: SignRepairStep[],
  actualReconstructedWidthPx: number,
  actualReconstructedHeightPx: number,
  requestedReconstructionWidthPx: number,
  requestedReconstructionHeightPx: number,
  orderedWidthIn: number,
  orderedHeightIn: number,
  plannedExpectedOutputWidthPx: number,
  plannedExpectedOutputHeightPx: number,
): AdaptGeometryStepsOutcome {
  if (
    actualReconstructedWidthPx === requestedReconstructionWidthPx &&
    actualReconstructedHeightPx === requestedReconstructionHeightPx
  ) {
    // The provider returned EXACTLY what was requested — the plan's own
    // steps and expected dimensions already apply verbatim. Zero behavior
    // change from before S3C for this (the previously only-tested) case.
    return {
      status: "unchanged",
      steps: afterSteps,
      expectedOutputWidthPx: plannedExpectedOutputWidthPx,
      expectedOutputHeightPx: plannedExpectedOutputHeightPx,
    };
  }

  const geometryStepIndex = afterSteps.findIndex(
    (step) =>
      step.kind === "extend_uniform_background" ||
      step.kind === "pad_uniform_background" ||
      step.kind === "reconstruct_parametric_frame" ||
      // Signs Phase 3A: recognized here so a divergent actual-vs-requested
      // reconstruction is never mistaken for "no geometry step to adapt"
      // (the branch below, which refuses outright) — but never rewritten
      // like the others: `executeReflowStructuralLayout` re-derives every
      // pixel amount itself, directly from whatever image it actually
      // receives, using the step's own `sourceWidthPx`/`sourceHeightPx` —
      // see the early return just below.
      step.kind === "reflow_structural_layout",
  );

  if (geometryStepIndex === -1) {
    // The plan expected reconstruction ALONE to already land on the
    // ordered aspect — no geometry step to adapt. Proportionality
    // (enforced upstream) means the actual output is still exact-aspect
    // too, so its own dimensions are simply the expected output. If that
    // assumption is ever wrong, refuse rather than invent an extension
    // step the plan never approved.
    const geometry = deriveUniformBackgroundExtension(
      actualReconstructedWidthPx,
      actualReconstructedHeightPx,
      orderedWidthIn,
      orderedHeightIn,
    );
    if (geometry.needsExtension) {
      return {
        status: "refused",
        reason: "unapproved_geometry_step_required",
        detail:
          `The actual reconstruction (${actualReconstructedWidthPx}x${actualReconstructedHeightPx}px) requires a background ` +
          "extension the approved plan never included — refusing rather than inventing an unapproved operation.",
      };
    }
    return {
      status: "adapted",
      steps: afterSteps,
      expectedOutputWidthPx: actualReconstructedWidthPx,
      expectedOutputHeightPx: actualReconstructedHeightPx,
    };
  }

  const geometryStep = afterSteps[geometryStepIndex]!;
  const plannedAxis = geometryStep.params.axis;
  const geometry = deriveUniformBackgroundExtension(
    actualReconstructedWidthPx,
    actualReconstructedHeightPx,
    orderedWidthIn,
    orderedHeightIn,
  );
  if (!geometry.needsExtension || geometry.axis !== plannedAxis) {
    return {
      status: "refused",
      reason: "axis_or_extension_mismatch",
      detail:
        `The approved plan's geometry step assumed axis "${plannedAxis}", but the actual reconstruction ` +
        `(${actualReconstructedWidthPx}x${actualReconstructedHeightPx}px) requires ` +
        `${geometry.needsExtension ? `axis "${geometry.axis}"` : "no extension at all"} — refusing rather than ` +
        "silently reinterpreting the approved plan.",
    };
  }

  if (geometryStep.kind === "reflow_structural_layout") {
    // Self-adapting by construction — `executeReflowStructuralLayout`
    // computes its own scale factor from the ACTUAL image it receives vs
    // its own recorded `sourceHeightPx`, and its own total-added-height
    // from the ACTUAL image vs the ordered template, exactly the same
    // `deriveUniformBackgroundExtension` re-derivation this function just
    // performed above. Nothing in the step's own params needs rewriting;
    // only the expected output dimensions this caller needs are returned.
    return {
      status: "adapted",
      steps: afterSteps,
      expectedOutputWidthPx: geometry.plateWidthPx,
      expectedOutputHeightPx: geometry.plateHeightPx,
    };
  }

  // Axis, alignment convention, and fill colour/`"unconfirmed"` carry over
  // UNCHANGED from the approved step — only the pixel amounts are
  // recomputed. A step whose colour was never confirmed stays
  // `"unconfirmed"` here too, so the existing `executeExtend` refusal for
  // that case is entirely unaffected by this adaptation.
  //
  // Height/Redistribution Policy: `reconstruct_parametric_frame` never
  // trusts `deriveUniformBackgroundExtension`'s own default (roughly
  // even) leading/trailing split — its plan-time-measured `leadingShare`
  // (a stable RATIO, not an absolute pixel amount, so it needs no
  // adaptation of its own) re-splits the SAME total pad this geometry
  // re-derived, preserving the artwork's own measured proportions
  // regardless of what the provider's actual output size turned out to be.
  const totalPad = geometry.leadingPx + geometry.trailingPx;
  const leadingShare = typeof geometryStep.params.leadingShare === "number" ? geometryStep.params.leadingShare : null;
  const adaptedLeadingPx =
    geometryStep.kind === "reconstruct_parametric_frame" && leadingShare !== null
      ? Math.round(totalPad * leadingShare)
      : geometry.leadingPx;
  const adaptedTrailingPx = totalPad - adaptedLeadingPx;
  const adaptedStep: SignRepairStep = {
    ...geometryStep,
    params: { ...geometryStep.params, leadingPx: adaptedLeadingPx, trailingPx: adaptedTrailingPx },
  };
  const adaptedSteps = [...afterSteps];
  adaptedSteps[geometryStepIndex] = adaptedStep;

  return {
    status: "adapted",
    steps: adaptedSteps,
    expectedOutputWidthPx: geometry.plateWidthPx,
    expectedOutputHeightPx: geometry.plateHeightPx,
  };
}

// ---------------------------------------------------------------------------
// Signs Phase S3C review follow-up: DERIVED EXECUTION GEOMETRY EVIDENCE.
// ---------------------------------------------------------------------------

/**
 * The approved, persisted `SignRepairPlan` is APPROVAL/AUDIT AUTHORITY —
 * immutable, never rewritten, its `planKey` never recomputed to match
 * whatever actually executed. When `adaptGeometryStepsToActualReconstruction`
 * adapts a geometry step's pixel amounts, the plan's own recorded step
 * (e.g. `leadingPx: 153`) and what actually executed (e.g. `leadingPx: 256`)
 * genuinely differ — this record exists so that fact is never silently
 * elided. It is PRODUCTION PROVENANCE, not a second authority: it records
 * what happened; it never authorizes anything the approved plan's own
 * semantic intent (axis, fill colour, risk classification) did not already
 * permit — `adaptGeometryStepsToActualReconstruction` enforces that
 * constraint before this evidence is ever built, not this type.
 */
export interface SignExecutionGeometryEvidence {
  /** Why re-derivation happened — currently the only reason this architecture admits. */
  reason: "provider_output_geometry_diverged_from_requested";
  /** The plan's own `reconstruct_resolution` step's requested target — what the persisted plan predicted. */
  reconstructionRequestedWidthPx: number;
  reconstructionRequestedHeightPx: number;
  /** What the provider actually returned (already validated sufficient + proportional before this is ever built). */
  reconstructionActualWidthPx: number;
  reconstructionActualHeightPx: number;
  /**
   * The geometry-stage step as ACTUALLY executed, with its pixel amounts
   * re-derived — `null` when the plan had no geometry step at all (the
   * reconstruction alone, at its actual size, already reached the ordered
   * aspect). `kind`/`axis`/fill colour are always identical to the approved
   * plan's own step; only `leadingPx`/`trailingPx` ever differ.
   */
  executedStep: {
    kind: SignRepairStepKind;
    axis: string | null;
    leadingPx: number | null;
    trailingPx: number | null;
    colorR: number | null;
    colorG: number | null;
    colorB: number | null;
    color: string | null;
  } | null;
  outputWidthPx: number;
  outputHeightPx: number;
}

/**
 * Builds the persisted evidence record for an adapted execution — `null`
 * when `adaptation.status !== "adapted"` (nothing diverged from the plan's
 * own recorded prediction, so the plan's own steps already are the
 * complete, truthful transformation record; recording a redundant copy
 * would be noise, not evidence).
 */
export function buildSignExecutionGeometryEvidence(
  adaptation: AdaptGeometryStepsOutcome,
  requestedReconstructionWidthPx: number,
  requestedReconstructionHeightPx: number,
  actualReconstructionWidthPx: number,
  actualReconstructionHeightPx: number,
): SignExecutionGeometryEvidence | null {
  if (adaptation.status !== "adapted") return null;

  const executedStep = adaptation.steps.find(
    (step) =>
      step.kind === "extend_uniform_background" ||
      step.kind === "pad_uniform_background" ||
      step.kind === "reconstruct_parametric_frame",
  );

  return {
    reason: "provider_output_geometry_diverged_from_requested",
    reconstructionRequestedWidthPx: requestedReconstructionWidthPx,
    reconstructionRequestedHeightPx: requestedReconstructionHeightPx,
    reconstructionActualWidthPx: actualReconstructionWidthPx,
    reconstructionActualHeightPx: actualReconstructionHeightPx,
    executedStep: executedStep
      ? {
          kind: executedStep.kind,
          axis: typeof executedStep.params.axis === "string" ? executedStep.params.axis : null,
          leadingPx: typeof executedStep.params.leadingPx === "number" ? executedStep.params.leadingPx : null,
          trailingPx: typeof executedStep.params.trailingPx === "number" ? executedStep.params.trailingPx : null,
          colorR: typeof executedStep.params.colorR === "number" ? executedStep.params.colorR : null,
          colorG: typeof executedStep.params.colorG === "number" ? executedStep.params.colorG : null,
          colorB: typeof executedStep.params.colorB === "number" ? executedStep.params.colorB : null,
          color: typeof executedStep.params.color === "string" ? executedStep.params.color : null,
        }
      : null,
    outputWidthPx: adaptation.expectedOutputWidthPx,
    outputHeightPx: adaptation.expectedOutputHeightPx,
  };
}

function executeStep(
  image: RgbaImage,
  bounds: SignExecutionBounds,
  step: SignRepairStep,
): SignExecutionResult {
  switch (step.kind) {
    case "rotate_90":
      return { status: "executed", image: rotate90(image), contentBounds: rotateBounds(bounds, image) };
    case "downsample":
    case "proportional_resample":
      return executeResample(image, bounds, step);
    case "extend_uniform_background":
    case "pad_uniform_background":
      return executeExtend(image, bounds, step);
    case "reconstruct_perimeter_structure":
      return executeReconstructPerimeter(image, bounds, step);
    case "reconstruct_parametric_frame":
      return executeReconstructParametricFrame(image, bounds, step);
    case "reflow_structural_layout":
      return executeReflowStructuralLayout(image, step);
    default:
      return {
        status: "refused",
        reason: "unsupported_step_kind",
        detail: `Step kind "${step.kind}" is not part of S2's admitted execution vocabulary.`,
      };
  }
}

function requirePositiveInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || !Number.isInteger(value)) {
    return null;
  }
  return value;
}

function executeResample(
  image: RgbaImage,
  bounds: SignExecutionBounds,
  step: SignRepairStep,
): SignExecutionResult {
  const targetWidthPx = requirePositiveInt(step.params.targetWidthPx);
  const targetHeightPx = requirePositiveInt(step.params.targetHeightPx);
  if (targetWidthPx === null || targetHeightPx === null) {
    return {
      status: "refused",
      reason: "unsupported_step_kind",
      detail: `Step "${step.kind}" is missing valid targetWidthPx/targetHeightPx parameters.`,
    };
  }
  const { image: resampled } = resampleExact(image, targetWidthPx, targetHeightPx);
  const scaleX = targetWidthPx / image.width;
  const scaleY = targetHeightPx / image.height;
  return {
    status: "executed",
    image: resampled,
    contentBounds: {
      x: Math.round(bounds.x * scaleX),
      y: Math.round(bounds.y * scaleY),
      width: Math.round(bounds.width * scaleX),
      height: Math.round(bounds.height * scaleY),
    },
  };
}

function executeExtend(
  image: RgbaImage,
  bounds: SignExecutionBounds,
  step: SignRepairStep,
): SignExecutionResult {
  const axis = step.params.axis;
  if (axis !== "horizontal" && axis !== "vertical") {
    return {
      status: "refused",
      reason: "unsupported_step_kind",
      detail: `Step "${step.kind}" has an invalid axis parameter.`,
    };
  }
  if (step.params.color === "unconfirmed") {
    return {
      status: "refused",
      reason: "unconfirmed_fill_color",
      detail:
        "Plan step has no confirmed fill colour (no affirmatively uniform background was measured). Refusing rather than inventing one.",
    };
  }
  const leadingPx = requirePositiveIntOrZero(step.params.leadingPx);
  const trailingPx = requirePositiveIntOrZero(step.params.trailingPx);
  const colorR = requireByteChannel(step.params.colorR);
  const colorG = requireByteChannel(step.params.colorG);
  const colorB = requireByteChannel(step.params.colorB);
  if (
    leadingPx === null ||
    trailingPx === null ||
    colorR === null ||
    colorG === null ||
    colorB === null
  ) {
    return {
      status: "refused",
      reason: "unconfirmed_fill_color",
      detail: `Step "${step.kind}" is missing valid leadingPx/trailingPx/colour parameters.`,
    };
  }

  const outputWidth = axis === "horizontal" ? image.width + leadingPx + trailingPx : image.width;
  const outputHeight = axis === "vertical" ? image.height + leadingPx + trailingPx : image.height;
  const offsetX = axis === "horizontal" ? leadingPx : 0;
  const offsetY = axis === "vertical" ? leadingPx : 0;

  const data = Buffer.alloc(outputWidth * outputHeight * 4);
  for (let i = 0; i < outputWidth * outputHeight; i++) {
    data[i * 4] = colorR;
    data[i * 4 + 1] = colorG;
    data[i * 4 + 2] = colorB;
    data[i * 4 + 3] = 255;
  }
  // Blit the CURRENT image verbatim at the exact expected offset — original
  // content pixels are copied byte-for-byte, never touched.
  for (let y = 0; y < image.height; y++) {
    const srcRowStart = y * image.width * 4;
    const destRowStart = ((y + offsetY) * outputWidth + offsetX) * 4;
    image.data.copy(data, destRowStart, srcRowStart, srcRowStart + image.width * 4);
  }

  return {
    status: "executed",
    image: { width: outputWidth, height: outputHeight, data },
    contentBounds: { x: bounds.x + offsetX, y: bounds.y + offsetY, width: bounds.width, height: bounds.height },
  };
}

function requirePositiveIntOrZero(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
    return null;
  }
  return value;
}

/**
 * Reads one measured band's rows back out of a step's flat params —
 * `perimeter-reconstruction.ts` never round-trips through this module
 * (planning and execution stay separate, same as every other step), so the
 * flat `{prefix}Row{i}R/G/B` encoding `sign-repair-planner.ts` writes is the
 * ONLY channel these colours travel through. Missing/malformed data at any
 * index refuses the WHOLE step — a partially-reconstructed band is never
 * silently completed with fewer rows than planned.
 */
function decodeBandRows(
  params: Record<string, number | string>,
  prefix: "leading" | "trailing",
  depth: number,
): SignPerimeterBandRow[] | null {
  const rows: SignPerimeterBandRow[] = [];
  for (let i = 0; i < depth; i++) {
    const r = requireByteChannel(params[`${prefix}Row${i}R`]);
    const g = requireByteChannel(params[`${prefix}Row${i}G`]);
    const b = requireByteChannel(params[`${prefix}Row${i}B`]);
    if (r === null || g === null || b === null) return null;
    rows.push({ r, g, b });
  }
  return rows;
}

function executeReconstructPerimeter(
  image: RgbaImage,
  bounds: SignExecutionBounds,
  step: SignRepairStep,
): SignExecutionResult {
  const axis = step.params.axis;
  if (axis !== "horizontal" && axis !== "vertical") {
    return {
      status: "refused",
      reason: "unsupported_step_kind",
      detail: `Step "${step.kind}" has an invalid axis parameter.`,
    };
  }
  const leadingPx = requirePositiveIntOrZero(step.params.leadingPx);
  const trailingPx = requirePositiveIntOrZero(step.params.trailingPx);
  const leadingBandDepthPx = requirePositiveIntOrZero(step.params.leadingBandDepthPx);
  const trailingBandDepthPx = requirePositiveIntOrZero(step.params.trailingBandDepthPx);
  if (
    leadingPx === null ||
    trailingPx === null ||
    leadingBandDepthPx === null ||
    trailingBandDepthPx === null ||
    leadingBandDepthPx === 0 ||
    trailingBandDepthPx === 0
  ) {
    return {
      status: "refused",
      reason: "unsupported_step_kind",
      detail: `Step "${step.kind}" is missing valid leadingPx/trailingPx/band-depth parameters.`,
    };
  }
  const leadingRows = decodeBandRows(step.params, "leading", leadingBandDepthPx);
  const trailingRows = decodeBandRows(step.params, "trailing", trailingBandDepthPx);
  if (!leadingRows || !trailingRows) {
    return {
      status: "refused",
      reason: "unsupported_step_kind",
      detail: `Step "${step.kind}" is missing a measured line colour for one of its bands.`,
    };
  }
  const leadingBand: SignPerimeterBandMeasurement = {
    edge: axis === "vertical" ? "top" : "left",
    bandDepthPx: leadingBandDepthPx,
    rows: leadingRows,
    reconstructable: true,
    reason: "",
  };
  const trailingBand: SignPerimeterBandMeasurement = {
    edge: axis === "vertical" ? "bottom" : "right",
    bandDepthPx: trailingBandDepthPx,
    rows: trailingRows,
    reconstructable: true,
    reason: "",
  };

  const outputWidth = axis === "horizontal" ? image.width + leadingPx + trailingPx : image.width;
  const outputHeight = axis === "vertical" ? image.height + leadingPx + trailingPx : image.height;
  const offsetX = axis === "horizontal" ? leadingPx : 0;
  const offsetY = axis === "vertical" ? leadingPx : 0;

  const data = Buffer.alloc(outputWidth * outputHeight * 4);

  // Fill every line of the added region with its own tiled colour — the
  // interior (original) region is overwritten below, verbatim, so any
  // extra work here for interior rows/columns is harmless.
  if (axis === "vertical") {
    for (let y = 0; y < leadingPx; y++) {
      const color = tiledRowColor(leadingBand, leadingPx - 1 - y);
      fillRow(data, outputWidth, y, color);
    }
    for (let y = 0; y < trailingPx; y++) {
      const color = tiledRowColor(trailingBand, y);
      fillRow(data, outputWidth, offsetY + image.height + y, color);
    }
  } else {
    for (let x = 0; x < leadingPx; x++) {
      const color = tiledRowColor(leadingBand, leadingPx - 1 - x);
      fillColumn(data, outputWidth, outputHeight, x, color);
    }
    for (let x = 0; x < trailingPx; x++) {
      const color = tiledRowColor(trailingBand, x);
      fillColumn(data, outputWidth, outputHeight, offsetX + image.width + x, color);
    }
  }

  // Blit the CURRENT image verbatim at the exact expected offset — original
  // content pixels are copied byte-for-byte, never touched. Identical to
  // `executeExtend`'s own blit — only what fills the added region differs.
  for (let y = 0; y < image.height; y++) {
    const srcRowStart = y * image.width * 4;
    const destRowStart = ((y + offsetY) * outputWidth + offsetX) * 4;
    image.data.copy(data, destRowStart, srcRowStart, srcRowStart + image.width * 4);
  }

  return {
    status: "executed",
    image: { width: outputWidth, height: outputHeight, data },
    contentBounds: { x: bounds.x + offsetX, y: bounds.y + offsetY, width: bounds.width, height: bounds.height },
  };
}

function requireInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) return null;
  return value;
}

/**
 * Decodes one `reconstruct_parametric_frame` step's flat params back into
 * the measured band sequence + optional corner/hole geometry — the exact
 * inverse of `sign-repair-planner.ts`'s own `encodeFrameStructuralModelParams`
 * (never round-tripped through a shared type; planning and execution stay
 * separate, the same discipline every other step kind already follows).
 * `null` on any missing/malformed field — a partially-reconstructed frame
 * is never silently completed with fewer bands or invented geometry.
 */
interface DecodedFrameStructuralModelParams {
  bands: SignFrameBand[];
  fillColor: { r: number; g: number; b: number };
  outerBackgroundColor: { r: number; g: number; b: number } | null;
  cornerRadiusPx: number | null;
  hole: {
    ringColor: { r: number; g: number; b: number };
    interiorColor: { r: number; g: number; b: number };
    radiusPx: number;
    offsetFromCornerXPx: number;
    offsetFromCornerYPx: number;
  } | null;
  modelSourceWidthPx: number;
  modelSourceHeightPx: number;
}

function decodeFrameStructuralModelParams(params: Record<string, number | string>): DecodedFrameStructuralModelParams | null {
  const modelSourceWidthPx = requireInt(params.modelSourceWidthPx);
  const modelSourceHeightPx = requireInt(params.modelSourceHeightPx);
  const bandCount = requireInt(params.bandCount);
  const fillColorR = requireByteChannel(params.fillColorR);
  const fillColorG = requireByteChannel(params.fillColorG);
  const fillColorB = requireByteChannel(params.fillColorB);
  const cornerRadiusRaw = requireInt(params.cornerRadiusPx);
  if (
    modelSourceWidthPx === null ||
    modelSourceHeightPx === null ||
    bandCount === null ||
    bandCount <= 0 ||
    fillColorR === null ||
    fillColorG === null ||
    fillColorB === null ||
    cornerRadiusRaw === null
  ) {
    return null;
  }
  const bands: SignFrameBand[] = [];
  for (let i = 0; i < bandCount; i++) {
    const r = requireByteChannel(params[`band${i}R`]);
    const g = requireByteChannel(params[`band${i}G`]);
    const b = requireByteChannel(params[`band${i}B`]);
    const thicknessPx = requirePositiveIntOrZero(params[`band${i}ThicknessPx`]);
    if (r === null || g === null || b === null || thicknessPx === null) return null;
    bands.push({ color: { r, g, b }, thicknessPx });
  }
  const cornerRadiusPx = cornerRadiusRaw < 0 ? null : cornerRadiusRaw;
  let outerBackgroundColor: { r: number; g: number; b: number } | null = null;
  if (cornerRadiusPx !== null) {
    const r = requireByteChannel(params.outerBackgroundColorR);
    const g = requireByteChannel(params.outerBackgroundColorG);
    const b = requireByteChannel(params.outerBackgroundColorB);
    if (r === null || g === null || b === null) return null;
    outerBackgroundColor = { r, g, b };
  }
  let hole: DecodedFrameStructuralModelParams["hole"] = null;
  if (params.hasHole === "true") {
    const radiusPx = requirePositiveIntOrZero(params.holeRadiusPx);
    const offsetFromCornerXPx = requirePositiveIntOrZero(params.holeOffsetXPx);
    const offsetFromCornerYPx = requirePositiveIntOrZero(params.holeOffsetYPx);
    const ringR = requireByteChannel(params.holeRingColorR);
    const ringG = requireByteChannel(params.holeRingColorG);
    const ringB = requireByteChannel(params.holeRingColorB);
    const intR = requireByteChannel(params.holeInteriorColorR);
    const intG = requireByteChannel(params.holeInteriorColorG);
    const intB = requireByteChannel(params.holeInteriorColorB);
    if (
      radiusPx === null ||
      offsetFromCornerXPx === null ||
      offsetFromCornerYPx === null ||
      ringR === null || ringG === null || ringB === null ||
      intR === null || intG === null || intB === null
    ) {
      return null;
    }
    hole = {
      radiusPx,
      offsetFromCornerXPx,
      offsetFromCornerYPx,
      ringColor: { r: ringR, g: ringG, b: ringB },
      interiorColor: { r: intR, g: intG, b: intB },
    };
  }
  return {
    bands,
    fillColor: { r: fillColorR, g: fillColorG, b: fillColorB },
    outerBackgroundColor,
    cornerRadiusPx,
    hole,
    modelSourceWidthPx,
    modelSourceHeightPx,
  };
}

/**
 * True iff (x,y) on a canvas of size `w`x`h` falls within the hole-ring or
 * hole-interior anomaly at ANY of the 4 corners — mirrors
 * `frame-structure-model.ts`'s own hole placement convention (centre
 * offset from the TRUE corner, along each axis) at whatever scale `hole`
 * has already been pre-scaled to by the caller.
 */
function holeColorAt(
  x: number,
  y: number,
  w: number,
  h: number,
  hole: { radiusPx: number; offsetFromCornerXPx: number; offsetFromCornerYPx: number; ringColor: { r: number; g: number; b: number }; interiorColor: { r: number; g: number; b: number } },
): { r: number; g: number; b: number } | null {
  const corners: [number, number, 1 | -1, 1 | -1][] = [
    [0, 0, 1, 1],
    [w - 1, 0, -1, 1],
    [0, h - 1, 1, -1],
    [w - 1, h - 1, -1, -1],
  ];
  for (const [cx, cy, sx, sy] of corners) {
    const centerX = cx + sx * hole.offsetFromCornerXPx;
    const centerY = cy + sy * hole.offsetFromCornerYPx;
    const d = Math.sqrt((x - centerX) ** 2 + (y - centerY) ** 2);
    if (d <= hole.radiusPx) return hole.interiorColor;
    if (d <= hole.radiusPx + 2) return hole.ringColor;
  }
  return null;
}

/**
 * Parametric Frame Geometry Defect Correction Phase (real Signs acceptance
 * incident: semantic verification's own `perimeter_edge_alignment`
 * category correctly caught "large blank red extensions above and below
 * the artwork, leaving the original inner border/frame system visibly
 * inset from the new outer panel boundary"): identical to the shared
 * `bandColorAtDepth` (`frame-structure-model.ts`) EXCEPT for what happens
 * once `depth` exceeds every measured band's own cumulative thickness.
 *
 * The shared function falls back to a flat `fillColor` there — correct for
 * its OTHER caller (`findHoleNearCorner`'s hole-anomaly detection, where
 * that depth range is essentially never reached: on an un-extended axis
 * the protected interior begins exactly where the measured band stack
 * ends, so `fillColor` was always closer to vestigial insurance than a
 * visible design element). This executor is different: an aspect-correcting
 * `leadingPx`/`trailingPx` extension (`adaptGeometryStepsToActualReconstruction`'s
 * own measured `leadingShare` re-split — itself correct and untouched by
 * this fix, see that function's own doc) can push the interior's own start
 * well past where the measured band stack ends, leaving a wide gap on
 * exactly the extended axis. That gap belongs to the FRAME, never an
 * unrelated flat fill colour.
 *
 * The fix: extend `bands[0]` — the OUTERMOST, edge-adjacent band, i.e. the
 * measured design's own dominant/background field
 * (`frame-structure-model.ts`'s own `outerBandColor` convention,
 * `measureFrameStructuralModel`'s `bands[0]`) — all the way to the
 * interior, so the finished frame visually reaches the true substrate
 * boundary on every side with no seam and no unrelated colour patch. Every
 * OTHER band keeps its exact measured thickness and relative position
 * (the geometry-defect-correction requirement that "measured border-band
 * relationships remain visually consistent") — only the dominant
 * background band absorbs the aspect-correction gap, never an accent
 * band, and never by scaling every band proportionally (which would make
 * accent bands implausibly thick whenever the gap is large relative to
 * the original frame depth, exactly the real case here: leadingPx=444 vs.
 * a frame depth far smaller).
 *
 * Deliberately a LOCAL helper, never a change to the shared
 * `bandColorAtDepth` itself — that function's other caller (hole-anomaly
 * detection) must never be affected by a fix scoped to this executor's own
 * aspect-correction rendering.
 */
function bandColorAtDepthWithOuterExtension(
  depth: number | null,
  bands: SignFrameBand[],
  outerBackgroundColor: { r: number; g: number; b: number } | null,
): { r: number; g: number; b: number } {
  if (bands.length === 0) {
    return outerBackgroundColor ?? { r: 0, g: 0, b: 0 };
  }
  if (depth === null) return outerBackgroundColor ?? bands[0]!.color;
  let acc = 0;
  for (const band of bands) {
    if (depth < acc + band.thicknessPx) return band.color;
    acc += band.thicknessPx;
  }
  // Beyond every measured band: the gap belongs to the frame's own
  // outermost/dominant band, never an unrelated fill colour — see this
  // function's own doc comment.
  return bands[0]!.color;
}

/**
 * Parametric Perimeter Frame Reconstruction Phase (Constitution §16A.3
 * amendment 3.1's own bounded carve-out, extended). Unlike every other
 * step here, this one does NOT simply blit the current image verbatim
 * into a larger canvas — it CROPS OUT the measured protected interior
 * (discarding the OLD frame band entirely; those pixels are never copied
 * anywhere in the output) and redraws the SAME measured band sequence,
 * corner rounding, and hole geometry at the new finished-substrate
 * boundary, with the interior repositioned inside it. This is what makes
 * "no residual old corner arc, no duplicate hole indicator" true BY
 * CONSTRUCTION rather than by careful masking: the old frame's pixels
 * simply never appear in the output at all.
 *
 * Every colour drawn comes from the plan's own already-measured model
 * (`sign-repair-planner.ts`'s `encodeFrameStructuralModelParams`) — never
 * generated, inferred, or blended. Band thicknesses/corner radius/hole
 * geometry are scaled by `image.width / modelSourceWidthPx` — the exact,
 * deterministic ratio between the model's own source resolution and
 * whatever resolution `image` actually is when this step runs (1.0 when
 * no preceding `reconstruct_resolution` step ran; the provider's actual
 * — not merely requested — scale otherwise, re-derived fresh every time
 * this executes rather than trusting a plan-time prediction).
 */
function executeReconstructParametricFrame(
  image: RgbaImage,
  // Unlike every other step, this one never extends the INCOMING bounds —
  // it replaces them outright with the freshly-cropped interior's own
  // placement (see the returned `contentBounds` below), so the incoming
  // value is intentionally never read.
  _bounds: SignExecutionBounds,
  step: SignRepairStep,
): SignExecutionResult {
  const axis = step.params.axis;
  if (axis !== "horizontal" && axis !== "vertical") {
    return { status: "refused", reason: "unsupported_step_kind", detail: `Step "${step.kind}" has an invalid axis parameter.` };
  }
  const leadingPx = requirePositiveIntOrZero(step.params.leadingPx);
  const trailingPx = requirePositiveIntOrZero(step.params.trailingPx);
  if (leadingPx === null || trailingPx === null) {
    return { status: "refused", reason: "unsupported_step_kind", detail: `Step "${step.kind}" is missing valid leadingPx/trailingPx parameters.` };
  }
  const decoded = decodeFrameStructuralModelParams(step.params);
  if (!decoded) {
    return { status: "refused", reason: "unsupported_step_kind", detail: `Step "${step.kind}" is missing valid frame structural model parameters.` };
  }
  const { bands, outerBackgroundColor, cornerRadiusPx, hole, modelSourceWidthPx } = decoded;

  // The scale between the model's own SOURCE resolution and whatever
  // resolution `image` actually is right now — re-derived fresh at
  // execution time (never trusting a plan-time prediction), exactly the
  // same "recompute from the actual input, not the request" discipline
  // `adaptGeometryStepsToActualReconstruction` already applies to
  // leadingPx/trailingPx for this same step.
  const scaleFactor = image.width / modelSourceWidthPx;
  const scaledBands: SignFrameBand[] = bands.map((b) => ({
    color: b.color,
    thicknessPx: Math.max(0, Math.round(b.thicknessPx * scaleFactor)),
  }));
  const oldFrameDepthPxScaled = scaledBands.reduce((s, b) => s + b.thicknessPx, 0);
  const scaledCornerRadius = cornerRadiusPx !== null ? Math.round(cornerRadiusPx * scaleFactor) : 0;
  const scaledHole = hole
    ? {
        radiusPx: Math.max(1, Math.round(hole.radiusPx * scaleFactor)),
        offsetFromCornerXPx: Math.round(hole.offsetFromCornerXPx * scaleFactor),
        offsetFromCornerYPx: Math.round(hole.offsetFromCornerYPx * scaleFactor),
        ringColor: hole.ringColor,
        interiorColor: hole.interiorColor,
      }
    : null;

  const interiorWidth = image.width - 2 * oldFrameDepthPxScaled;
  const interiorHeight = image.height - 2 * oldFrameDepthPxScaled;
  if (interiorWidth <= 0 || interiorHeight <= 0) {
    return {
      status: "refused",
      reason: "unsupported_step_kind",
      detail: `Step "${step.kind}": the scaled frame depth leaves no positive-area protected interior to preserve.`,
    };
  }

  const outputWidth = axis === "horizontal" ? image.width + leadingPx + trailingPx : image.width;
  const outputHeight = axis === "vertical" ? image.height + leadingPx + trailingPx : image.height;
  const interiorOffsetX = axis === "horizontal" ? leadingPx + oldFrameDepthPxScaled : oldFrameDepthPxScaled;
  const interiorOffsetY = axis === "vertical" ? leadingPx + oldFrameDepthPxScaled : oldFrameDepthPxScaled;

  const data = Buffer.alloc(outputWidth * outputHeight * 4);
  for (let y = 0; y < outputHeight; y++) {
    for (let x = 0; x < outputWidth; x++) {
      const i = (y * outputWidth + x) * 4;
      const inInteriorX = x >= interiorOffsetX && x < interiorOffsetX + interiorWidth;
      const inInteriorY = y >= interiorOffsetY && y < interiorOffsetY + interiorHeight;
      let color: { r: number; g: number; b: number };
      if (inInteriorX && inInteriorY) {
        const srcX = x - interiorOffsetX + oldFrameDepthPxScaled;
        const srcY = y - interiorOffsetY + oldFrameDepthPxScaled;
        const si = (srcY * image.width + srcX) * 4;
        color = { r: image.data[si]!, g: image.data[si + 1]!, b: image.data[si + 2]! };
      } else {
        const holeColor = scaledHole ? holeColorAt(x, y, outputWidth, outputHeight, scaledHole) : null;
        if (holeColor) {
          color = holeColor;
        } else {
          const depth = frameDepthAt(x, y, outputWidth, outputHeight, scaledCornerRadius);
          color = bandColorAtDepthWithOuterExtension(depth, scaledBands, outerBackgroundColor);
        }
      }
      data[i] = color.r;
      data[i + 1] = color.g;
      data[i + 2] = color.b;
      data[i + 3] = 255;
    }
  }

  return {
    status: "executed",
    image: { width: outputWidth, height: outputHeight, data },
    contentBounds: { x: interiorOffsetX, y: interiorOffsetY, width: interiorWidth, height: interiorHeight },
  };
}

function fillRow(data: Buffer, width: number, y: number, color: SignPerimeterBandRow): void {
  for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    data[i] = color.r;
    data[i + 1] = color.g;
    data[i + 2] = color.b;
    data[i + 3] = 255;
  }
}

// ---------------------------------------------------------------------------
// Signs Phase 3A: `reflow_structural_layout` — the first executable version.
// ---------------------------------------------------------------------------

interface DecodedReflowRegion {
  role: "top_anchor" | "middle" | "bottom_anchor";
  sourceStartYPx: number;
  sourceHeightPx: number;
  fillEdgeReaching: boolean;
  fillColor: SignPerimeterBandRow | null;
}

interface DecodedReflowGap {
  sourceHeightPx: number;
  fillColor: SignPerimeterBandRow;
}

interface DecodedStructuralReflow {
  sourceWidthPx: number;
  sourceHeightPx: number;
  templateWidthIn: number;
  templateHeightIn: number;
  templateShape: string;
  regions: DecodedReflowRegion[];
  gaps: DecodedReflowGap[];
  /**
   * Phase 2C: the SOURCE-image-absolute analysis window segmentation was
   * restricted to, when one was used — `null` for an unwindowed (full-
   * image) scan. Present here ONLY so this executor can preserve the
   * SOURCE rows OUTSIDE it (typically a measured decorative frame border,
   * on a framed sign) verbatim — see `executeReflowStructuralLayout`'s own
   * doc. Never otherwise interpreted; this executor never reads frame
   * band colours, corner radius, or hole geometry from it.
   */
  analysisWindowYPx: number | null;
  analysisWindowHeightPx: number | null;
}

/**
 * The exact inverse of `sign-repair-planner.ts`'s own
 * `encodeStructuralReflowParams` — `null` on any missing/malformed field, a
 * region/gap count mismatch, or a `regionCount`/`gapCount` relationship
 * other than `gapCount === regionCount - 1` (the same invariant
 * `SignStructuralLayoutSegmentationResult`'s own `"measured"` variant
 * documents). Never round-tripped through a shared type — planning and
 * execution stay separate, the same discipline every other step kind
 * already follows. `contentStartYPx`/`contentHeightPx`/`expandable` are
 * NOT decoded here: this executor places and fills by REGION (source)
 * bounds only, never by the narrower content bounds — see this section's
 * own module doc for why translation-only placement never needs them.
 */
function decodeStructuralReflowParams(params: Record<string, number | string>): DecodedStructuralReflow | null {
  const sourceWidthPx = requirePositiveInt(params.sourceWidthPx);
  const sourceHeightPx = requirePositiveInt(params.sourceHeightPx);
  const templateWidthIn = typeof params.templateWidthIn === "number" ? params.templateWidthIn : null;
  const templateHeightIn = typeof params.templateHeightIn === "number" ? params.templateHeightIn : null;
  const templateShape = typeof params.templateShape === "string" ? params.templateShape : null;
  const scalingMode = params.scalingMode;
  const regionCount = requirePositiveInt(params.regionCount);
  const gapCount = requirePositiveIntOrZero(params.gapCount);
  if (
    sourceWidthPx === null ||
    sourceHeightPx === null ||
    templateWidthIn === null ||
    templateHeightIn === null ||
    templateShape === null ||
    scalingMode !== "none" ||
    regionCount === null ||
    gapCount === null ||
    gapCount !== regionCount - 1
  ) {
    return null;
  }

  const regions: DecodedReflowRegion[] = [];
  for (let i = 0; i < regionCount; i++) {
    const role = params[`region${i}Role`];
    if (role !== "top_anchor" && role !== "middle" && role !== "bottom_anchor") return null;
    const sourceStartYPx = requirePositiveIntOrZero(params[`region${i}SourceStartYPx`]);
    const regionSourceHeightPx = requirePositiveInt(params[`region${i}SourceHeightPx`]);
    const fillEdgeReachingRaw = params[`region${i}FillEdgeReaching`];
    if (fillEdgeReachingRaw !== "true" && fillEdgeReachingRaw !== "false") return null;
    const fillEdgeReaching = fillEdgeReachingRaw === "true";
    if (sourceStartYPx === null || regionSourceHeightPx === null) return null;

    // `fillColor` is decoded on a best-effort basis ONLY (never required,
    // never a decode failure when absent) — see `DecodedReflowRegion`'s
    // own doc: this executor's translation-only placement never reads a
    // region's own fill colour at all (unlike a gap's, which every gap
    // genuinely needs to paint). A real anchor may legitimately have no
    // internal fill margin of its own (proven against the real cc6cfc4b-...
    // acceptance sign) — `fillEdgeReaching` alone is what this executor's
    // own leading/trailing-band contiguity check (below) actually relies on.
    const r = requireByteChannel(params[`region${i}FillColorR`]);
    const g = requireByteChannel(params[`region${i}FillColorG`]);
    const b = requireByteChannel(params[`region${i}FillColorB`]);
    const fillColor: SignPerimeterBandRow | null = r !== null && g !== null && b !== null ? { r, g, b } : null;
    regions.push({ role, sourceStartYPx, sourceHeightPx: regionSourceHeightPx, fillEdgeReaching, fillColor });
  }

  const gaps: DecodedReflowGap[] = [];
  for (let i = 0; i < gapCount; i++) {
    const gapSourceHeightPx = requirePositiveInt(params[`gap${i}SourceHeightPx`]);
    const r = requireByteChannel(params[`gap${i}FillColorR`]);
    const g = requireByteChannel(params[`gap${i}FillColorG`]);
    const b = requireByteChannel(params[`gap${i}FillColorB`]);
    if (gapSourceHeightPx === null || r === null || g === null || b === null) return null;
    gaps.push({ sourceHeightPx: gapSourceHeightPx, fillColor: { r, g, b } });
  }

  const analysisWindowYPxRaw = params.analysisWindowYPx;
  const analysisWindowHeightPxRaw = params.analysisWindowHeightPx;
  const analysisWindowYPx = typeof analysisWindowYPxRaw === "number" ? requirePositiveIntOrZero(analysisWindowYPxRaw) : null;
  const analysisWindowHeightPx =
    typeof analysisWindowHeightPxRaw === "number" ? requirePositiveInt(analysisWindowHeightPxRaw) : null;
  // Both-or-neither — a plan carrying only one of the pair is malformed,
  // never partially trusted.
  if ((analysisWindowYPxRaw !== undefined) !== (analysisWindowHeightPxRaw !== undefined)) return null;
  if (analysisWindowYPxRaw !== undefined && (analysisWindowYPx === null || analysisWindowHeightPx === null)) return null;

  return {
    sourceWidthPx,
    sourceHeightPx,
    templateWidthIn,
    templateHeightIn,
    templateShape,
    regions,
    gaps,
    analysisWindowYPx,
    analysisWindowHeightPx,
  };
}

type ReflowSequenceItem =
  | { kind: "region"; region: DecodedReflowRegion }
  | { kind: "gap"; gap: DecodedReflowGap }
  /**
   * Phase 2C analysis-window leading/trailing SOURCE rows OUTSIDE the
   * windowed segmentation domain (on a framed sign, this is the measured
   * decorative frame border itself, corner rounding and hole indicators
   * included) — copied byte-for-byte, exactly like a region, at its own
   * unchanged (scaled) height. Never independently colour-validated (this
   * executor never asserts these rows are any particular colour or
   * uniform at all — they are real pixels, preserved verbatim, not
   * measured evidence) and NEVER resized: only declared regions/gaps ever
   * absorb added height. Constitution §16A/§16A.3: the decorative frame
   * is artwork, never redrawn as substrate geometry — this is what keeps
   * it that way, rather than silently discarding it outside the analysis
   * window's own bounds.
   */
  | { kind: "band"; sourceHeightPx: number };

/**
 * Executes an authorized, planner-proposed `reflow_structural_layout` step
 * — the FIRST version of this step this codebase ever executes (Signs
 * Phase 3A; every prior phase only ever planned it). Deliberately never
 * receives `bounds`: like `reconstruct_parametric_frame`, this step's own
 * placement is derived entirely from the CURRENT image and the plan's own
 * measured evidence, never from an incoming padding-tracking rectangle a
 * simpler step (extend/pad) would have produced — and reflow is never
 * combined with those steps in the same plan (the planner's own
 * `reflow_structural_layout` branch is exclusive of them for its axis).
 *
 * ALGORITHM (translation + gap redistribution only — see the step kind's
 * own contract doc in `contracts.ts` for why this is never a redraw or a
 * resample of meaningful content):
 *
 *   1. Decode the plan's measured regions/gaps, in SOURCE-image-absolute
 *      pixel coordinates relative to the plan's own recorded
 *      `sourceWidthPx`/`sourceHeightPx`.
 *   2. Compute `scaleY = image.height / sourceHeightPx` — 1 when `image`
 *      is still the untouched original, or the ACTUAL proportional
 *      reconstruction scale a preceding `reconstruct_resolution` step
 *      produced (never the plan's own PREDICTED scale — this executor
 *      only ever trusts the image it was actually handed). Every region/
 *      gap boundary is scaled via CUMULATIVE rounding (never independently
 *      per-item) so the scaled sequence tiles `image`'s own height exactly,
 *      with no rounding-drift gap or overlap.
 *   3. Re-derive the OUTPUT canvas size from the CURRENT image's own actual
 *      dimensions vs the ordered template (`deriveUniformBackgroundExtension`
 *      — the SAME re-derivation `adaptGeometryStepsToActualReconstruction`
 *      already applies for every other geometry step), never from the
 *      plan's own predicted pad amount.
 *   4. Redistribute the ACTUAL added height EQUALLY across gaps ONLY —
 *      never proportional to each gap's own original height (a short
 *      original gap is not proof of a deliberately smaller design intent
 *      there; see this function's own doc for why proportional
 *      redistribution produces a visually wrong result on an asymmetric
 *      gap pair, proven directly against the real cc6cfc4b-... acceptance
 *      sign). A largest-remainder correction on the LAST gap keeps the
 *      sum exactly equal to the added height.
 *   5. Place: every REGION is copied byte-for-byte (a row-range `Buffer
 *      .copy`, never resampled) from its scaled source position to its new
 *      output position — translation only, meaningful content is never
 *      independently stretched. Every GAP is filled flat with its own
 *      independently measured colour, at its NEW (larger) height.
 *
 * LEADING/TRAILING BAND PRESERVATION (Phase 2C analysis window): when
 * segmentation used a windowed domain narrower than the full source (a
 * framed sign — `resolveFrameAnalysisWindow`'s own reason for existing),
 * the SOURCE rows OUTSIDE that window (`[0, analysisWindowYPx)` and
 * `[analysisWindowYPx + analysisWindowHeightPx, sourceHeightPx)`) are
 * real image content this executor must never silently drop — a
 * measured decorative frame border, corner rounding, and any corner-hole
 * indicators live there. They are copied byte-for-byte at their own
 * (scaled) height, exactly like a region, as the FIRST and LAST items of
 * the placement sequence — never resized, never treated as fill needing
 * independent colour validation (a frame border scanned across the FULL
 * source width is essentially never a single uniform colour — narrow
 * strokes near the edges, gaps/holes elsewhere — so it could not be
 * validated as "fill" even if this executor tried). Before placing
 * anything, this function verifies the FIRST region's own `sourceStartYPx`
 * exactly equals the leading band's own height, and the LAST region's own
 * end exactly equals the trailing band's own start — both are already
 * structurally guaranteed by `evaluateStructuralReflow`'s own eligibility
 * bar (an anchor must touch the analysis domain's own edge to qualify as
 * `fillEdgeReaching`), but re-verified here rather than assumed, so a
 * corrupted or hand-edited plan is refused rather than silently
 * misplacing content.
 */
function executeReflowStructuralLayout(image: RgbaImage, step: SignRepairStep): SignExecutionResult {
  const decoded = decodeStructuralReflowParams(step.params);
  if (!decoded) {
    return {
      status: "refused",
      reason: "unsupported_step_kind",
      detail: `Step "${step.kind}" has missing or malformed structural reflow parameters.`,
    };
  }
  if (decoded.templateShape !== "straight_rectangle") {
    return {
      status: "refused",
      reason: "unsupported_step_kind",
      detail: 'Structural reflow requires a "straight_rectangle" production template — never a redraw of source perimeter geometry as substrate shape.',
    };
  }
  if (decoded.regions.length === 0 || decoded.gaps.length !== decoded.regions.length - 1) {
    return {
      status: "refused",
      reason: "unsupported_step_kind",
      detail: "Structural reflow requires at least one region and exactly one gap fewer than regions.",
    };
  }

  const scaleY = image.height / decoded.sourceHeightPx;

  const leadingSourceHeight = decoded.analysisWindowYPx ?? 0;
  const trailingSourceStart =
    decoded.analysisWindowYPx !== null && decoded.analysisWindowHeightPx !== null
      ? decoded.analysisWindowYPx + decoded.analysisWindowHeightPx
      : decoded.sourceHeightPx;
  const trailingSourceHeight = decoded.sourceHeightPx - trailingSourceStart;

  const firstRegion = decoded.regions[0]!;
  const lastRegion = decoded.regions[decoded.regions.length - 1]!;
  if (firstRegion.sourceStartYPx !== leadingSourceHeight) {
    return {
      status: "refused",
      reason: "unsupported_step_kind",
      detail:
        `The first region's own source start (${firstRegion.sourceStartYPx}px) does not match the analysis ` +
        `window's own leading edge (${leadingSourceHeight}px) — refusing rather than risk dropping or ` +
        "misplacing source pixels outside it.",
    };
  }
  if (lastRegion.sourceStartYPx + lastRegion.sourceHeightPx !== trailingSourceStart) {
    return {
      status: "refused",
      reason: "unsupported_step_kind",
      detail:
        `The last region's own source end (${lastRegion.sourceStartYPx + lastRegion.sourceHeightPx}px) does not ` +
        `match the analysis window's own trailing edge (${trailingSourceStart}px) — refusing rather than risk ` +
        "dropping or misplacing source pixels outside it.",
    };
  }
  if (trailingSourceHeight < 0) {
    return {
      status: "refused",
      reason: "unsupported_step_kind",
      detail: "The analysis window's own recorded bounds extend past the plan's own recorded source height.",
    };
  }

  const sequence: ReflowSequenceItem[] = [];
  if (leadingSourceHeight > 0) sequence.push({ kind: "band", sourceHeightPx: leadingSourceHeight });
  for (let i = 0; i < decoded.regions.length; i++) {
    sequence.push({ kind: "region", region: decoded.regions[i]! });
    if (i < decoded.gaps.length) sequence.push({ kind: "gap", gap: decoded.gaps[i]! });
  }
  if (trailingSourceHeight > 0) sequence.push({ kind: "band", sourceHeightPx: trailingSourceHeight });

  let cumulativeOriginal = 0;
  const scaledBoundaries: number[] = [0];
  for (const item of sequence) {
    cumulativeOriginal +=
      item.kind === "region" ? item.region.sourceHeightPx : item.kind === "gap" ? item.gap.sourceHeightPx : item.sourceHeightPx;
    scaledBoundaries.push(Math.round(cumulativeOriginal * scaleY));
  }
  // The final boundary is authoritative as `image`'s own actual height —
  // never a rounded approximation of it, since every source row below it
  // is read relative to this exact value.
  scaledBoundaries[scaledBoundaries.length - 1] = image.height;

  const geometry = deriveUniformBackgroundExtension(image.width, image.height, decoded.templateWidthIn, decoded.templateHeightIn);
  if (!geometry.needsExtension || geometry.axis !== "vertical") {
    return {
      status: "refused",
      reason: "output_geometry_mismatch",
      detail:
        `The current image (${image.width}x${image.height}px) does not require vertical structural reflow against the ` +
        `${decoded.templateWidthIn}x${decoded.templateHeightIn}in template.`,
    };
  }
  const outputWidthPx = geometry.plateWidthPx;
  const outputHeightPx = geometry.plateHeightPx;
  const totalAddedPx = geometry.leadingPx + geometry.trailingPx;

  // Signs Phase 3A: EQUAL distribution across gaps, never proportional to
  // each gap's own original (pre-reflow) height. A short measured gap is
  // not proof of a deliberately SMALLER design intent there — on a real
  // banner, the space directly against an anchor's own edge-touching
  // fill is very often incidentally thin (or, for operator-confirmed
  // evidence, the smallest span that could be independently proven
  // uniform at all — a technical necessity, never a design signal), while
  // a background gap elsewhere happens to be much larger for unrelated
  // reasons. Proportional-by-original-size, tried first in an earlier
  // version of this executor, produces a visually wrong result on
  // exactly that asymmetric — and common — shape: nearly all new height
  // concentrates into whichever gap happened to already be largest,
  // producing an obviously-wrong oversized band (proven directly against
  // the real cc6cfc4b-... acceptance sign: a 19px-vs-1px original gap
  // pair drove a 95%/5% split of 612px of new height — an unmistakably
  // wrong result on inspection, not a subtle one). Equal distribution is
  // also the task's own explicitly sanctioned, `review_required`-gated
  // fallback, and the simplest defensible rule — never a bespoke layout
  // optimizer.
  const gapCount = decoded.gaps.length;
  if (gapCount <= 0) {
    return {
      status: "refused",
      reason: "output_geometry_mismatch",
      detail: "No measured gap exists to redistribute the added space into.",
    };
  }
  const gapExtraPx = decoded.gaps.map(() => Math.floor(totalAddedPx / gapCount));
  const assignedExtra = gapExtraPx.slice(0, -1).reduce((a, b) => a + b, 0);
  gapExtraPx[gapExtraPx.length - 1] = totalAddedPx - assignedExtra;
  if (gapExtraPx.some((extra) => extra < 0)) {
    return {
      status: "refused",
      reason: "output_geometry_mismatch",
      detail: "Structural reflow would require shrinking a gap below its own measured height — refusing rather than losing background pixels.",
    };
  }

  const data = Buffer.alloc(outputWidthPx * outputHeightPx * 4);
  let destY = 0;
  let gapIndex = 0;
  for (let i = 0; i < sequence.length; i++) {
    const item = sequence[i]!;
    const scaledStart = scaledBoundaries[i]!;
    const scaledEnd = scaledBoundaries[i + 1]!;
    const scaledHeight = scaledEnd - scaledStart;
    if (item.kind === "region" || item.kind === "band") {
      // Bands (analysis-window leading/trailing SOURCE rows — e.g. a
      // measured decorative frame border) are copied byte-for-byte
      // exactly like a region: never resized, never fill-coloured.
      for (let y = 0; y < scaledHeight; y++) {
        const srcRowStart = (scaledStart + y) * image.width * 4;
        const destRowStart = (destY + y) * outputWidthPx * 4;
        image.data.copy(data, destRowStart, srcRowStart, srcRowStart + image.width * 4);
      }
      destY += scaledHeight;
    } else {
      const newGapHeight = scaledHeight + gapExtraPx[gapIndex]!;
      for (let y = 0; y < newGapHeight; y++) {
        fillRow(data, outputWidthPx, destY + y, item.gap.fillColor);
      }
      destY += newGapHeight;
      gapIndex++;
    }
  }

  if (destY !== outputHeightPx) {
    return {
      status: "refused",
      reason: "output_geometry_mismatch",
      detail: `Structural reflow placement produced ${destY}px of height, expected exactly ${outputHeightPx}px.`,
    };
  }

  return {
    status: "executed",
    image: { width: outputWidthPx, height: outputHeightPx, data },
    // The whole reflowed canvas is authoritative composition — unlike a
    // simple pad/extend (which adds one clearly-synthetic band this field
    // exists to distinguish from real content), every pixel here is either
    // translated original content or a gap fill that already existed in
    // the source, merely resized. There is no single contiguous "this part
    // is fake" region to carve out — see this function's own module doc.
    contentBounds: { x: 0, y: 0, width: outputWidthPx, height: outputHeightPx },
  };
}

function fillColumn(data: Buffer, width: number, height: number, x: number, color: SignPerimeterBandRow): void {
  for (let y = 0; y < height; y++) {
    const i = (y * width + x) * 4;
    data[i] = color.r;
    data[i + 1] = color.g;
    data[i + 2] = color.b;
    data[i + 3] = 255;
  }
}

function requireByteChannel(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 255) {
    return null;
  }
  return value;
}

/** Exact 90° clockwise rotation. Lossless — every pixel is preserved, dimensions swap exactly, no interpolation. */
function rotate90(image: RgbaImage): RgbaImage {
  const outputWidth = image.height;
  const outputHeight = image.width;
  const data = Buffer.alloc(outputWidth * outputHeight * 4);
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const srcIdx = (y * image.width + x) * 4;
      // (x, y) -> (outputWidth - 1 - y, x) for a clockwise rotation.
      const destX = outputWidth - 1 - y;
      const destY = x;
      const destIdx = (destY * outputWidth + destX) * 4;
      data[destIdx] = image.data[srcIdx]!;
      data[destIdx + 1] = image.data[srcIdx + 1]!;
      data[destIdx + 2] = image.data[srcIdx + 2]!;
      data[destIdx + 3] = image.data[srcIdx + 3]!;
    }
  }
  return { width: outputWidth, height: outputHeight, data };
}

function rotateBounds(bounds: SignExecutionBounds, preRotateImage: RgbaImage): SignExecutionBounds {
  const outputWidth = preRotateImage.height;
  // (x, y) -> (outputWidth - 1 - y, x); a rectangle's rotated bounds are
  // derived from its two extreme corners under that same mapping.
  const newX = outputWidth - (bounds.y + bounds.height);
  const newY = bounds.x;
  return { x: newX, y: newY, width: bounds.height, height: bounds.width };
}

/** Encodes an RGBA image to PNG bytes. The single encode path this executor uses. */
export function encodeSignPlate(image: RgbaImage): Buffer {
  const png = new PNG({ width: image.width, height: image.height });
  image.data.copy(png.data);
  return PNG.sync.write(png);
}
