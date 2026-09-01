/**
 * Signs Phase S4.1 / S4.2A: the narrow boundary that RESOLVES authoritative
 * inputs (never trusts a caller's claim), RUNS the deterministic
 * preservation checks (`sign-preservation-deterministic-checks.ts`) and,
 * when structural authority is valid, semantic preservation verification
 * (`sign-preservation-semantic-provider.ts`), and PERSISTS/REUSES the
 * resulting `SignPreservationVerification` record.
 *
 * It must NOT, and does not:
 *   - call Topaz or any provider network surface
 *   - dispatch a semantic call when deterministic structural authority is
 *     invalid, or when a catastrophic anomaly was already proven
 *   - approve any review risk (Signs Phase S4.3)
 *   - mark a project/job `print_ready`
 *   - duplicate PrintValidation's own physical-production rules
 *   - mutate the approved repair plan
 *
 * Deliberately NOT wired into `FinalArtworkWorkerCapability`'s worker
 * orchestration yet — see ARCHITECTURE.md's "Signs Phase S4.2A" section.
 * This capability is independently constructible and testable; a future
 * phase wires it into the production worker pipeline.
 *
 * `verifyDeterministicPreservation` (Signs Phase S4.1, reviewed and
 * integrated) is UNCHANGED — same behavior, same persisted identity
 * (`SIGN_PRESERVATION_ALGORITHM_VERSION`), same inability to ever produce
 * `"preserved"`. `verifyPreservation` (Signs Phase S4.2A, new) is an
 * ADDITIVE sibling method on the same capability, reusing the identical
 * input-resolution and deterministic-check logic internally rather than
 * duplicating it, but persisting under a separate, combined identity
 * (`buildCombinedVerificationAlgorithmVersion`) that can produce
 * `"preserved"` only when BOTH deterministic structural authority is valid
 * AND a well-formed semantic verdict of `"preserved"` was reached.
 */

import { PNG } from "pngjs";
import { createHash } from "node:crypto";

import type { RgbaImage } from "@/capabilities/final-artwork/raster-transform";
import { isReconstructionIntermediateAsset } from "@/capabilities/final-artwork/production-request-identity";
import { ProviderError } from "@/capabilities/providers/provider-error";
import type { AssetCapability } from "@/capabilities/assets";
import type { AssetRecord, FinalArtworkJob, SignPreparation } from "@/lib/domain/types";
import type { ProjectRepository } from "@/lib/db/repository";
import type {
  SignPreservationStatus,
  SignPreservationVerification,
} from "@/lib/domain/types";

import {
  buildCombinedVerificationAlgorithmVersion,
  deriveSemanticVerdict,
  SIGN_PRESERVATION_ALGORITHM_VERSION,
  SIGN_PRESERVATION_PROMPT_VERSION,
  SIGN_PRESERVATION_SEMANTIC_SCHEMA_VERSION,
  validateSemanticAnswers,
  type SignPreservationDeterministicEvidence,
  type SignPreservationSemanticEvidence,
} from "./contracts";
import {
  aggregateDeterministicEvidence,
  checkExtensionRegions,
  checkPerimeterTileExtensionRegions,
  checkParametricFrameRegions,
  checkLineage,
  checkReconstructionToFinalRgb,
  checkSourceSimilarity,
  deriveContentRegion,
  deriveParametricFrameContentRegion,
  overallStatusFromDeterministicEvidence,
  replayLocalGeometrySteps,
  type PadStepGeometry,
  type SignPreservationFrameBand,
  type SignPreservationFrameHole,
} from "./sign-preservation-deterministic-checks";
import { deriveSemanticComparisonImages } from "./sign-preservation-image-derivation";
import type { SignPreservationSemanticProvider } from "./sign-preservation-semantic-provider";

export interface SignPreservationCapability {
  /**
   * Runs (or reuses, if one already exists for this exact identity)
   * deterministic preservation verification for one final rigid-sign
   * production asset. Idempotent: a second call with the same
   * `finalAssetId` under the same algorithm version returns the existing
   * record rather than recomputing anything.
   *
   * Two distinct fail-closed modes, per `SignPreservationVerification`'s
   * own NOT NULL foreign keys:
   *
   *   - When a required ASSET ROW cannot be resolved at all (the final
   *     asset itself, its job/sign-preparation/plan, its source asset row,
   *     or its reconstruction-intermediate row) there is no valid identity
   *     left to bind a record to — this throws `SignPreservationStateError`
   *     rather than fabricate a row referencing something that doesn't
   *     exist.
   *   - Once every required row is resolved, anything ELSE going wrong
   *     (unreadable bytes, a SHA/planKey mismatch, an unmappable content
   *     region) is captured as ordinary deterministic-check evidence and
   *     DOES persist — as `status: "unknown"` (or `"changed"` for a proven
   *     structural impossibility), never as an exception.
   *
   * S4.1 — never produces `"preserved"`.
   */
  verifyDeterministicPreservation(
    finalAssetId: string,
  ): Promise<SignPreservationVerification>;

  /**
   * Signs Phase S4.2A: the full deterministic + semantic pipeline.
   *
   * Persists under a COMBINED identity
   * (`buildCombinedVerificationAlgorithmVersion`) distinct from
   * `verifyDeterministicPreservation`'s own — a provider/model/prompt/
   * schema/grid change is encoded directly in the identity string, so it
   * can never silently reuse incompatible old evidence.
   *
   * Dispatch discipline (Signs Phase S4.2A §6/§9), in order:
   *   1. Resolve inputs and run the SAME deterministic checks
   *      `verifyDeterministicPreservation` runs (never duplicated logic).
   *   2. If required structural authority is invalid (lineage / region
   *      mapping / reconstruction→final RGB / extension regions not all
   *      `"pass"`, or a catastrophic anomaly was already proven): persist
   *      immediately with `status` derived from deterministic evidence
   *      alone (`"changed"` or `"unknown"`) — the semantic provider is
   *      NEVER called. Zero paid dispatches for an already-broken asset.
   *   3. Otherwise, derive the bounded, fixed 14-image comparison set and
   *      call the injected semantic provider exactly once.
   *   4. A well-formed, schema-valid response composes with the
   *      (already-valid) deterministic evidence into the final `status` —
   *      `"preserved"` only when the semantic verdict is ALSO
   *      `"preserved"`. A malformed/schema-invalid response, or any
   *      provider error (timeout/network/5xx/rate-limit/refusal), is NOT a
   *      completed verification — nothing is persisted, and the thrown
   *      error propagates so a later call may retry cleanly.
   *
   * Throws `SignPreservationStateError` if no semantic provider was
   * configured on this capability instance, or for the same
   * identity-cannot-be-resolved cases `verifyDeterministicPreservation`
   * throws for.
   */
  verifyPreservation(finalAssetId: string): Promise<SignPreservationVerification>;

  /**
   * LIVE PRODUCT BLOCKER #3B: the verification-algorithm identity
   * `verifyPreservation` is CURRENTLY authoritative under, resolved from
   * this capability's own configured semantic provider — independent of
   * any specific verification record. Exists so a caller (PrintValidation's
   * evidence, assembled by the worker) can assert "is the record I have
   * still current" without re-deriving the identity-composition logic
   * itself, and without reading the answer off the very record being
   * checked (which would make that comparison trivially circular).
   *
   * Pure and synchronous — no repository call, no provider call. Throws
   * `SignPreservationStateError` (`semantic_provider_not_configured`) under
   * the identical condition `verifyPreservation` throws it for.
   */
  resolveCurrentVerificationAlgorithmVersion(): string;
}

export type SignPreservationCapabilityError =
  | "final_asset_not_found"
  | "not_a_reconstructed_sign_asset"
  | "final_artwork_job_not_found"
  | "sign_preparation_not_found"
  | "plan_missing"
  | "source_asset_row_not_found"
  | "intermediate_asset_row_not_found"
  | "semantic_provider_not_configured";

export class SignPreservationStateError extends Error {
  constructor(public readonly code: SignPreservationCapabilityError, message: string) {
    super(message);
    this.name = "SignPreservationStateError";
  }
}

function decodePng(bytes: Buffer): RgbaImage {
  const png = PNG.sync.read(bytes);
  return { width: png.width, height: png.height, data: png.data };
}

/** Exact, unresampled sub-rectangle crop — never used for anything but re-deriving an already-known interior placement. */
function cropImage(image: RgbaImage, x: number, y: number, width: number, height: number): RgbaImage {
  const data = Buffer.alloc(width * height * 4);
  for (let row = 0; row < height; row += 1) {
    const srcStart = ((y + row) * image.width + x) * 4;
    const destStart = row * width * 4;
    image.data.copy(data, destStart, srcStart, srcStart + width * 4);
  }
  return { width, height, data };
}

function readPadStepFromParams(
  params: Record<string, unknown> | undefined,
): PadStepGeometry | null {
  if (!params) return null;
  const axis = params.axis;
  if (axis !== "horizontal" && axis !== "vertical") return null;
  const leadingPx = params.leadingPx;
  const trailingPx = params.trailingPx;
  if (typeof leadingPx !== "number" || typeof trailingPx !== "number") return null;
  const colorR = typeof params.colorR === "number" ? params.colorR : null;
  const colorG = typeof params.colorG === "number" ? params.colorG : null;
  const colorB = typeof params.colorB === "number" ? params.colorB : null;
  return { axis, leadingPx, trailingPx, colorR, colorG, colorB };
}

/**
 * Reads one `reconstruct_perimeter_structure` step's measured band rows
 * back out of its raw, flat params — mirrors `sign-transform-executor.ts`'s
 * own `decodeBandRows` (never imported; same independent-resolution
 * discipline `readPadStepFromParams` above already follows). Missing/
 * malformed data at any index returns `null` for the WHOLE band, never a
 * partial one.
 */
function readPerimeterBandRows(
  params: Record<string, unknown> | undefined,
  prefix: "leading" | "trailing",
): { r: number; g: number; b: number }[] | null {
  if (!params) return null;
  const depth = params[`${prefix}BandDepthPx`];
  if (typeof depth !== "number" || !Number.isInteger(depth) || depth <= 0) return null;
  const rows: { r: number; g: number; b: number }[] = [];
  for (let i = 0; i < depth; i += 1) {
    const r = params[`${prefix}Row${i}R`];
    const g = params[`${prefix}Row${i}G`];
    const b = params[`${prefix}Row${i}B`];
    if (typeof r !== "number" || typeof g !== "number" || typeof b !== "number") return null;
    rows.push({ r, g, b });
  }
  return rows;
}

/**
 * Reads one `reconstruct_parametric_frame` step's measured band/corner/hole
 * model back out of its raw, flat params — mirrors `sign-repair-planner
 * .ts`'s own `encodeFrameStructuralModelParams` (never imported; same
 * independent-resolution discipline every reader in this file already
 * follows). `null` on any missing/malformed required field.
 */
function readFrameModelFromParams(params: Record<string, unknown> | undefined): {
  axis: "horizontal" | "vertical";
  leadingPx: number;
  trailingPx: number;
  modelSourceWidthPx: number;
  bands: SignPreservationFrameBand[];
  fillColor: { r: number; g: number; b: number };
  cornerRadiusPx: number | null;
  outerBackgroundColor: { r: number; g: number; b: number } | null;
  hole: SignPreservationFrameHole | null;
} | null {
  if (!params) return null;
  const axis = params.axis;
  if (axis !== "horizontal" && axis !== "vertical") return null;
  const leadingPx = params.leadingPx;
  const trailingPx = params.trailingPx;
  const modelSourceWidthPx = params.modelSourceWidthPx;
  const bandCount = params.bandCount;
  const fillColorR = params.fillColorR;
  const fillColorG = params.fillColorG;
  const fillColorB = params.fillColorB;
  const cornerRadiusRaw = params.cornerRadiusPx;
  if (
    typeof leadingPx !== "number" ||
    typeof trailingPx !== "number" ||
    typeof modelSourceWidthPx !== "number" ||
    typeof bandCount !== "number" ||
    bandCount <= 0 ||
    typeof fillColorR !== "number" ||
    typeof fillColorG !== "number" ||
    typeof fillColorB !== "number" ||
    typeof cornerRadiusRaw !== "number"
  ) {
    return null;
  }
  const bands: SignPreservationFrameBand[] = [];
  for (let i = 0; i < bandCount; i++) {
    const r = params[`band${i}R`];
    const g = params[`band${i}G`];
    const b = params[`band${i}B`];
    const thicknessPx = params[`band${i}ThicknessPx`];
    if (typeof r !== "number" || typeof g !== "number" || typeof b !== "number" || typeof thicknessPx !== "number") return null;
    bands.push({ color: { r, g, b }, thicknessPx });
  }
  const cornerRadiusPx = cornerRadiusRaw < 0 ? null : cornerRadiusRaw;
  let outerBackgroundColor: { r: number; g: number; b: number } | null = null;
  if (cornerRadiusPx !== null) {
    const r = params.outerBackgroundColorR;
    const g = params.outerBackgroundColorG;
    const b = params.outerBackgroundColorB;
    if (typeof r !== "number" || typeof g !== "number" || typeof b !== "number") return null;
    outerBackgroundColor = { r, g, b };
  }
  let hole: SignPreservationFrameHole | null = null;
  if (params.hasHole === "true") {
    const radiusPx = params.holeRadiusPx;
    const offsetFromCornerXPx = params.holeOffsetXPx;
    const offsetFromCornerYPx = params.holeOffsetYPx;
    const ringR = params.holeRingColorR;
    const ringG = params.holeRingColorG;
    const ringB = params.holeRingColorB;
    const intR = params.holeInteriorColorR;
    const intG = params.holeInteriorColorG;
    const intB = params.holeInteriorColorB;
    if (
      typeof radiusPx !== "number" ||
      typeof offsetFromCornerXPx !== "number" ||
      typeof offsetFromCornerYPx !== "number" ||
      typeof ringR !== "number" || typeof ringG !== "number" || typeof ringB !== "number" ||
      typeof intR !== "number" || typeof intG !== "number" || typeof intB !== "number"
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
  return { axis, leadingPx, trailingPx, modelSourceWidthPx, bands, fillColor: { r: fillColorR, g: fillColorG, b: fillColorB }, cornerRadiusPx, outerBackgroundColor, hole };
}

/**
 * Scales a decoded frame model's band thicknesses/corner radius/hole
 * geometry by `scaleFactor` — the exact, deterministic ratio between the
 * model's own measured source resolution and whatever resolution the
 * INTERMEDIATE asset actually is (1.0 for a native/perimeter-only plan;
 * the provider's own actual — never merely requested — scale otherwise).
 * Mirrors `sign-transform-executor.ts`'s own identical scaling, applied
 * independently here (never imported) for the SAME reason every other
 * duplicated formula in this file exists.
 */
function scaleFrameModel<T extends ReturnType<typeof readFrameModelFromParams>>(
  model: NonNullable<T>,
  scaleFactor: number,
) {
  const scaledBands: SignPreservationFrameBand[] = model.bands.map((b) => ({
    color: b.color,
    thicknessPx: Math.max(0, Math.round(b.thicknessPx * scaleFactor)),
  }));
  const frameDepthPxScaled = scaledBands.reduce((s, b) => s + b.thicknessPx, 0);
  const scaledCornerRadius = model.cornerRadiusPx !== null ? Math.round(model.cornerRadiusPx * scaleFactor) : null;
  const scaledHole: SignPreservationFrameHole | null = model.hole
    ? {
        radiusPx: Math.max(1, Math.round(model.hole.radiusPx * scaleFactor)),
        offsetFromCornerXPx: Math.round(model.hole.offsetFromCornerXPx * scaleFactor),
        offsetFromCornerYPx: Math.round(model.hole.offsetFromCornerYPx * scaleFactor),
        ringColor: model.hole.ringColor,
        interiorColor: model.hole.interiorColor,
      }
    : null;
  return { scaledBands, frameDepthPxScaled, scaledCornerRadius, scaledHole };
}

/**
 * Everything both `verifyDeterministicPreservation` and `verifyPreservation`
 * need — resolved and computed exactly once, never duplicated between them.
 * Throws `SignPreservationStateError` under the identical conditions
 * `verifyDeterministicPreservation`'s own doc comment describes.
 */
interface PreservationContext {
  finalAsset: AssetRecord;
  job: FinalArtworkJob;
  preparation: SignPreparation;
  /** `preparation.planKey`, narrowed to `string` — already null-checked in `resolvePreservationContext`. */
  planKey: string;
  projectId: string;
  sourceAsset: AssetRecord;
  rehashedSourceSha256: string;
  intermediateAsset: AssetRecord;
  finalAssetSha256: string;
  deterministicEvidence: SignPreservationDeterministicEvidence;
  /** `null` whenever any required bytes/content-region were unavailable — mirrors the deterministic checks' own fail-closed branch. */
  decodedImages: {
    sourceImage: RgbaImage;
    /** The FINAL asset's own content-region sub-image — pixel-identical to the reconstruction whenever `reconstructionToFinalRgb.result === "pass"`. */
    contentSubImage: RgbaImage;
  } | null;
}

async function resolvePreservationContext(
  repo: ProjectRepository,
  assets: AssetCapability,
  finalAssetId: string,
): Promise<PreservationContext> {
  const finalAsset = await repo.getAssetById(finalAssetId);
  if (!finalAsset) {
    throw new SignPreservationStateError(
      "final_asset_not_found",
      `No asset exists with id ${finalAssetId}.`,
    );
  }

  const rigidSignMeta =
    (finalAsset.metadata as Record<string, unknown> | null)?.rigidSign as
      | Record<string, unknown>
      | undefined;
  if (!rigidSignMeta) {
    throw new SignPreservationStateError(
      "not_a_reconstructed_sign_asset",
      "Preservation verification only ever applies to a rigid-sign final production asset.",
    );
  }

  if (!finalAsset.finalArtworkJobId) {
    throw new SignPreservationStateError(
      "final_artwork_job_not_found",
      "The final asset carries no final-artwork job reference.",
    );
  }
  const job = await repo.getFinalArtworkJob(finalAsset.finalArtworkJobId);
  if (!job || !job.signPreparationId) {
    throw new SignPreservationStateError(
      "final_artwork_job_not_found",
      "No sign-preparation-bound final-artwork job could be resolved for this asset.",
    );
  }

  const preparation = await repo.getSignPreparationById(job.signPreparationId);
  if (!preparation) {
    throw new SignPreservationStateError(
      "sign_preparation_not_found",
      "No sign preparation could be resolved for this asset's job.",
    );
  }
  const plan = preparation.plan as Record<string, unknown> | null;
  if (!plan || typeof preparation.planKey !== "string") {
    throw new SignPreservationStateError(
      "plan_missing",
      "The sign preparation has no persisted, keyed repair plan.",
    );
  }

  // Semantic Worker Wiring Phase: the GENERALIZED gate — mirrors
  // `sign-preparation/sign-transform-executor.ts`'s own
  // `planRequiresSemanticPreservationVerification`, deliberately duplicated
  // here (never imported) rather than depending on `sign-preparation` at
  // all — this module resolves every fact from raw, independently-read
  // rows, the same discipline `readPadStepFromParams` below already
  // follows for step shape. Replaces the prior `rigidSignMeta.
  // resolutionProvenance !== "reconstructed"` gate, which conflated "a
  // provider touched this" with "this needs verification" — a plan using
  // ONLY the deterministic, non-provider `reconstruct_perimeter_structure`
  // step needs this exact same question asked despite never involving a
  // provider.
  const planSteps = Array.isArray(plan.steps) ? (plan.steps as Array<Record<string, unknown>>) : [];
  const usesProviderReconstruction = planSteps.some((s) => s.kind === "reconstruct_resolution");
  const usesPerimeterReconstruction = planSteps.some((s) => s.kind === "reconstruct_perimeter_structure");
  const usesParametricFrameReconstruction = planSteps.some((s) => s.kind === "reconstruct_parametric_frame");
  if (!usesProviderReconstruction && !usesPerimeterReconstruction && !usesParametricFrameReconstruction) {
    throw new SignPreservationStateError(
      "not_a_reconstructed_sign_asset",
      "Preservation verification only ever applies to a plan whose steps actually require it " +
        "(reconstruct_resolution, reconstruct_perimeter_structure, or reconstruct_parametric_frame).",
    );
  }

  // --- Resolve remaining assets — never trust a caller claim. ---
  const projectId = finalAsset.projectId;
  const allAssets = await repo.listAssets(projectId);

  const sourceAssetId =
    typeof plan.sourceAssetId === "string" ? plan.sourceAssetId : preparation.originalAssetId;
  const sourceAsset = allAssets.find((a) => a.id === sourceAssetId) ?? null;
  if (!sourceAsset) {
    throw new SignPreservationStateError(
      "source_asset_row_not_found",
      "The source asset this plan was formulated against no longer resolves to any asset row.",
    );
  }
  const sourceBytes = await assets.downloadAssetBytes(sourceAsset.id);
  const rehashedSourceSha256 = sourceBytes
    ? createHash("sha256").update(sourceBytes.bytes).digest("hex")
    : "";

  // Semantic Worker Wiring Phase: `reconstruct_perimeter_structure` never
  // dispatches a provider, so no separate `pass1_intermediate` asset exists
  // for it at all — there is nothing TO be tied to this job. For that
  // shape (and only that shape), the immutable SOURCE plays the
  // "reconstruction to diff the final content region against" role
  // directly: the content region for a perimeter-only plan is, by
  // construction, an exact byte-for-byte copy of the source (identical to
  // how `extend_uniform_background`/`pad_uniform_background` already work
  // — the new step only changes what fills the ADDED region, never how the
  // original is placed). No new asset row is created; the already-resolved
  // `sourceAsset`/`sourceBytes` above are reused verbatim.
  const intermediateAsset = usesProviderReconstruction
    ? (allAssets.find(
        (a) => a.finalArtworkJobId === job.id && isReconstructionIntermediateAsset(a),
      ) ?? null)
    : sourceAsset;
  if (!intermediateAsset) {
    throw new SignPreservationStateError(
      "intermediate_asset_row_not_found",
      "No reconstruction-intermediate asset row could be resolved for this final asset's job.",
    );
  }
  const intermediateBytes = usesProviderReconstruction
    ? await assets.downloadAssetBytes(intermediateAsset.id)
    : sourceBytes;
  // Not job-scoped for the perimeter-only substitution — the source is
  // never tied to any one job, and correctly so; there is no per-job
  // "intermediate" identity for this shape to mismatch.
  const intermediateAssetTiedToSameJob = usesProviderReconstruction
    ? intermediateAsset.finalArtworkJobId === job.id
    : true;

  const finalBytes = await assets.downloadAssetBytes(finalAssetId);

  const finalAssetSha256 = finalBytes
    ? createHash("sha256").update(finalBytes.bytes).digest("hex")
    : "";

  // --- A. Lineage ---
  const executionGeometry = rigidSignMeta.executionGeometry as
    | Record<string, unknown>
    | null
    | undefined;
  const geometryAdapted = rigidSignMeta.geometryAdapted === true;

  const lineage = checkLineage({
    sourceAssetExists: sourceBytes != null,
    rehashedSourceSha256,
    planSourceSha256: typeof plan.sourceSha256 === "string" ? plan.sourceSha256 : "",
    finalAssetClaimedSourceSha256:
      typeof rigidSignMeta.sourceSha256 === "string" ? rigidSignMeta.sourceSha256 : "",
    finalAssetBelongsToSignPreparation: job.signPreparationId === preparation.id,
    finalAssetPlanKey: typeof rigidSignMeta.planKey === "string" ? rigidSignMeta.planKey : "",
    currentPlanKey: preparation.planKey,
    resolutionProvenance:
      typeof rigidSignMeta.resolutionProvenance === "string"
        ? rigidSignMeta.resolutionProvenance
        : "",
    expectedResolutionProvenance: usesProviderReconstruction ? "reconstructed" : "native",
    geometryAdapted,
    executionEvidencePresent: executionGeometry != null,
    intermediateAssetExists: intermediateBytes != null,
    intermediateAssetTiedToSameJob,
  });

  // --- B. Region mapping ---
  const reconstructedWidthPx =
    typeof rigidSignMeta.reconstructedWidthPx === "number"
      ? rigidSignMeta.reconstructedWidthPx
      : (intermediateAsset.widthPx ?? 0);
  const reconstructedHeightPx =
    typeof rigidSignMeta.reconstructedHeightPx === "number"
      ? rigidSignMeta.reconstructedHeightPx
      : (intermediateAsset.heightPx ?? 0);

  const executedPadStep = geometryAdapted
    ? readPadStepFromParams(executionGeometry?.executedStep as Record<string, unknown> | undefined)
    : null;
  // `reconstruct_perimeter_structure` included here too — its params carry
  // the same axis/leadingPx/trailingPx geometry `deriveContentRegion`
  // needs; `readPadStepFromParams` correctly reads null colourR/G/B for it
  // (it has no single flat fill colour), which is exactly what routes the
  // extension-region check to the TILED verification below instead of the
  // single-colour one.
  const plannedPadStepRaw = planSteps.find(
    (s) =>
      s.kind === "pad_uniform_background" ||
      s.kind === "extend_uniform_background" ||
      s.kind === "reconstruct_perimeter_structure" ||
      s.kind === "reconstruct_parametric_frame",
  );
  const plannedPadStep = readPadStepFromParams(
    plannedPadStepRaw?.params as Record<string, unknown> | undefined,
  );
  const activeStep = executedPadStep ?? plannedPadStep;

  // Parametric Frame Reconstruction Phase: the frame model itself (bands,
  // corner radius, hole) never changes under S3C-style geometry adaptation
  // — only leadingPx/trailingPx do — so it is always read from the PLANNED
  // step's own params, never from `executionGeometry.executedStep` (which
  // does not carry it at all). Scaled fresh here by the same
  // intermediate-vs-model-source ratio `executeReconstructParametricFrame`
  // itself recomputes at execution time (never trusting a plan-time
  // prediction).
  const plannedFrameModel =
    usesParametricFrameReconstruction && plannedPadStepRaw?.kind === "reconstruct_parametric_frame"
      ? readFrameModelFromParams(plannedPadStepRaw.params as Record<string, unknown> | undefined)
      : null;
  // The image `reconstruct_parametric_frame` actually ran against is NOT
  // reliably `intermediateAsset` — a `downsample` (or other dimension-
  // changing) step can sit BETWEEN the source/Topaz-intermediate and the
  // frame step in a plan that never needed `reconstruct_resolution` at all
  // (S2's own local geometry pipeline, entirely unrelated to Topaz). The
  // one fact that IS always trustworthy is the FINAL asset's own persisted
  // dimensions, together with the step's own (possibly S3C-adapted)
  // axis/leadingPx/trailingPx — `executeReconstructParametricFrame`'s own
  // `outputWidth = axis==="horizontal" ? image.width+leadingPx+trailingPx
  // : image.width` inverts cleanly: the pre-frame-step image's own width is
  // exactly `outputWidth - leadingPx - trailingPx` on the extended axis,
  // and `outputWidth` unchanged on the other — `outputWidth`/`outputHeight`
  // being precisely the FINAL asset's own dimensions.
  const preFrameStepWidthPx =
    activeStep && activeStep.axis === "horizontal"
      ? (finalAsset.widthPx ?? 0) - activeStep.leadingPx - activeStep.trailingPx
      : (finalAsset.widthPx ?? 0);
  const preFrameStepHeightPx =
    activeStep && activeStep.axis === "vertical"
      ? (finalAsset.heightPx ?? 0) - activeStep.leadingPx - activeStep.trailingPx
      : (finalAsset.heightPx ?? 0);
  const frameModelScaleFactor =
    plannedFrameModel && plannedFrameModel.modelSourceWidthPx > 0
      ? preFrameStepWidthPx / plannedFrameModel.modelSourceWidthPx
      : null;
  const scaledFrameModel =
    plannedFrameModel && frameModelScaleFactor !== null
      ? scaleFrameModel(plannedFrameModel, frameModelScaleFactor)
      : null;

  const regionMapping =
    usesParametricFrameReconstruction && plannedPadStepRaw?.kind === "reconstruct_parametric_frame"
      ? scaledFrameModel && activeStep
        ? deriveParametricFrameContentRegion({
            finalWidthPx: finalAsset.widthPx ?? 0,
            finalHeightPx: finalAsset.heightPx ?? 0,
            intermediateWidthPx: preFrameStepWidthPx,
            intermediateHeightPx: preFrameStepHeightPx,
            axis: activeStep.axis,
            leadingPx: activeStep.leadingPx,
            trailingPx: activeStep.trailingPx,
            frameDepthPxScaled: scaledFrameModel.frameDepthPxScaled,
          })
        : {
            result: "unknown" as const,
            finalWidthPx: finalAsset.widthPx ?? 0,
            finalHeightPx: finalAsset.heightPx ?? 0,
            contentRegion: null,
            derivedFrom: "unavailable" as const,
            regionFitsWithinFinalCanvas: false,
            regionDimensionsMatchReconstruction: false,
            reasons: ["The reconstructed frame's own measured band model could not be resolved from the plan's step params."],
          }
      : deriveContentRegion({
          finalWidthPx: finalAsset.widthPx ?? 0,
          finalHeightPx: finalAsset.heightPx ?? 0,
          reconstructedWidthPx,
          reconstructedHeightPx,
          executedPadStep,
          plannedPadStep: executedPadStep ? null : plannedPadStep,
        });

  // --- Decode images only when the lineage/region evidence is usable —
  // never decode/compare against a region we've already proven is
  // wrong, and never crash on a missing asset. ---
  let reconstructionToFinalRgb;
  let extensionRegions;
  let sourceSimilarity: SignPreservationDeterministicEvidence["sourceSimilarity"];
  let decodedImages: PreservationContext["decodedImages"] = null;

  const isParametricFrameStep =
    usesParametricFrameReconstruction && plannedPadStepRaw?.kind === "reconstruct_parametric_frame";
  // `intermediateBytes` (the source, for a plan with no `reconstruct_
  // resolution`; the Topaz output otherwise) is not necessarily the exact
  // pre-frame-step image byte-for-byte — a purely LOCAL, deterministic S2
  // geometry step (`rotate_90`, `downsample`, `proportional_resample`) can
  // sit between it and `reconstruct_parametric_frame` in a plan that never
  // needed a SEPARATE persisted asset row for that intermediate result.
  // Replay those (and only those — never `reconstruct_resolution` itself,
  // whose real output IS `intermediateBytes`) to reproduce the exact input
  // the frame step actually ran against.
  const frameStepIndex = plannedPadStepRaw ? planSteps.indexOf(plannedPadStepRaw) : -1;
  const reconstructResolutionIndex = planSteps.findIndex((s) => s.kind === "reconstruct_resolution");
  const replaySteps =
    isParametricFrameStep && frameStepIndex >= 0
      ? planSteps
          .slice(reconstructResolutionIndex >= 0 ? reconstructResolutionIndex + 1 : 0, frameStepIndex)
          .map((s) => ({ kind: s.kind as string, params: s.params as Record<string, unknown> | undefined }))
      : [];

  // `intermediateUsableForRgbIntegrity` is only false when the REPLAYED
  // pre-frame-step image's own dimensions still fail to match
  // `preFrameStepWidthPx/HeightPx` (a malformed/unreadable replay step) —
  // fail closed to "unknown" rather than compare mismatched-resolution
  // buffers or crash attempting to.
  let intermediateUsableForRgbIntegrity = true;

  if (finalBytes && intermediateBytes && regionMapping.contentRegion) {
    const finalImage = decodePng(finalBytes.bytes);
    const decodedIntermediateImage = decodePng(intermediateBytes.bytes);
    const actualPreFrameStepImage = isParametricFrameStep
      ? replayLocalGeometrySteps(decodedIntermediateImage, replaySteps)
      : decodedIntermediateImage;
    if (
      isParametricFrameStep &&
      (actualPreFrameStepImage.width !== preFrameStepWidthPx || actualPreFrameStepImage.height !== preFrameStepHeightPx)
    ) {
      intermediateUsableForRgbIntegrity = false;
    }
    // `checkReconstructionToFinalRgb` requires the reconstruction image's
    // own dimensions to match the content region exactly — true by
    // construction for every other step (the content region IS the whole
    // reconstruction), but `reconstruct_parametric_frame` crops the interior
    // OUT of the (replayed) pre-frame-step image first. Crop here so the
    // existing check can be reused unmodified, rather than special-casing
    // it.
    //
    // The crop rectangle within that image is NOT `regionMapping
    // .contentRegion` verbatim — that region's x/y are in FINAL
    // (post-padding) image space, which includes `leadingPx` on the
    // extended axis. The pre-frame-step image has no padding yet: its own
    // interior starts at `frameDepthPxScaled` on BOTH axes (the frame
    // surrounds it symmetrically), exactly mirroring
    // `executeReconstructParametricFrame`'s own
    // `srcX = x - interiorOffsetX + oldFrameDepthPxScaled` inverse.
    const reconstructionImage =
      isParametricFrameStep && intermediateUsableForRgbIntegrity && scaledFrameModel
        ? cropImage(
            actualPreFrameStepImage,
            scaledFrameModel.frameDepthPxScaled,
            scaledFrameModel.frameDepthPxScaled,
            regionMapping.contentRegion.width,
            regionMapping.contentRegion.height,
          )
        : decodedIntermediateImage;

    reconstructionToFinalRgb = intermediateUsableForRgbIntegrity
      ? checkReconstructionToFinalRgb(reconstructionImage, finalImage, regionMapping.contentRegion)
      : {
          result: "unknown" as const,
          compared: false,
          reconstructionWidthPx: decodedIntermediateImage.width,
          reconstructionHeightPx: decodedIntermediateImage.height,
          contentRegionWidthPx: regionMapping.contentRegion.width,
          contentRegionHeightPx: regionMapping.contentRegion.height,
          mismatchedPixelCount: 0,
          maxChannelDelta: 0,
          reasons: [
            "Replaying the plan's own local geometry steps (rotate_90/downsample/proportional_resample) between the resolved intermediate and reconstruct_parametric_frame still did not reproduce the image the frame step actually ran against — RGB integrity cannot be checked against it.",
          ],
        };

    if (usesPerimeterReconstruction && plannedPadStepRaw?.kind === "reconstruct_perimeter_structure") {
      const rawParams = plannedPadStepRaw.params as Record<string, unknown> | undefined;
      extensionRegions = checkPerimeterTileExtensionRegions(
        finalImage,
        regionMapping.contentRegion,
        activeStep?.axis ?? null,
        activeStep?.leadingPx ?? null,
        activeStep?.trailingPx ?? null,
        readPerimeterBandRows(rawParams, "leading"),
        readPerimeterBandRows(rawParams, "trailing"),
      );
    } else if (usesParametricFrameReconstruction && plannedPadStepRaw?.kind === "reconstruct_parametric_frame") {
      extensionRegions = checkParametricFrameRegions(
        finalImage,
        regionMapping.contentRegion,
        scaledFrameModel?.scaledCornerRadius ?? null,
        scaledFrameModel?.scaledBands ?? null,
        plannedFrameModel?.fillColor ?? null,
        plannedFrameModel?.outerBackgroundColor ?? null,
        scaledFrameModel?.scaledHole ?? null,
      );
    } else {
      const approvedFillRgb =
        activeStep && activeStep.colorR !== null && activeStep.colorG !== null && activeStep.colorB !== null
          ? { r: activeStep.colorR, g: activeStep.colorG, b: activeStep.colorB }
          : null;
      extensionRegions = checkExtensionRegions(finalImage, regionMapping.contentRegion, approvedFillRgb);
    }

    if (sourceBytes) {
      const decodedSourceImage = decodePng(sourceBytes.bytes);
      const { x, y, width, height } = regionMapping.contentRegion;
      const contentSubImage: RgbaImage = {
        width,
        height,
        data: Buffer.alloc(width * height * 4),
      };
      for (let row = 0; row < height; row += 1) {
        const srcStart = ((y + row) * finalImage.width + x) * 4;
        const destStart = row * width * 4;
        finalImage.data.copy(contentSubImage.data, destStart, srcStart, srcStart + width * 4);
      }
      // `contentSubImage` is the FINAL asset's protected interior ONLY —
      // the frame band is never part of it (`reconstruct_parametric_frame`
      // crops it away by construction). The whole, uncropped source image
      // still HAS its own old frame — comparing it verbatim against an
      // interior-only crop distorts the X/Y scale relationship (a frame's
      // depth is a fixed pixel offset, not a proportional one), which is
      // exactly what previously made `deriveSemanticComparisonImages`
      // conclude "not proportional" for every genuinely-valid frame
      // reconstruction. Crop the source to ITS OWN measured interior first
      // — the plan's own frame model was measured against this exact
      // source asset, at its own (unscaled, scale factor 1) resolution.
      const sourceImage =
        isParametricFrameStep && plannedFrameModel
          ? (() => {
              const sourceFrameDepthPx = plannedFrameModel.bands.reduce((s, b) => s + b.thicknessPx, 0);
              const sourceInteriorWidth = decodedSourceImage.width - 2 * sourceFrameDepthPx;
              const sourceInteriorHeight = decodedSourceImage.height - 2 * sourceFrameDepthPx;
              return sourceInteriorWidth > 0 && sourceInteriorHeight > 0
                ? cropImage(decodedSourceImage, sourceFrameDepthPx, sourceFrameDepthPx, sourceInteriorWidth, sourceInteriorHeight)
                : decodedSourceImage;
            })()
          : decodedSourceImage;
      sourceSimilarity = checkSourceSimilarity(sourceImage, contentSubImage);
      decodedImages = { sourceImage, contentSubImage };
    } else {
      sourceSimilarity = {
        result: "unknown",
        computed: false,
        scaleFactor: null,
        globalMeanAbsoluteError: null,
        worstTileMeanAbsoluteError: null,
        tileGridSize: null,
        reasons: ["The source asset's bytes could not be read — similarity evidence is unavailable."],
      };
    }
  } else {
    reconstructionToFinalRgb = {
      result: "unknown" as const,
      compared: false,
      reconstructionWidthPx: intermediateAsset.widthPx ?? null,
      reconstructionHeightPx: intermediateAsset.heightPx ?? null,
      contentRegionWidthPx: null,
      contentRegionHeightPx: null,
      mismatchedPixelCount: 0,
      maxChannelDelta: 0,
      reasons: ["Required bytes/content-region were unavailable — RGB integrity was not checked."],
    };
    extensionRegions = {
      result: "unknown" as const,
      regionsChecked: 0,
      totalExtensionPixels: 0,
      mismatchedPixelCount: 0,
      approvedFillRgb: null,
      reasons: ["Required bytes/content-region were unavailable — extension regions were not checked."],
    };
    sourceSimilarity = {
      result: "unknown",
      computed: false,
      scaleFactor: null,
      globalMeanAbsoluteError: null,
      worstTileMeanAbsoluteError: null,
      tileGridSize: null,
      reasons: ["Required bytes/content-region were unavailable — similarity evidence was not computed."],
    };
  }

  const deterministicEvidence = aggregateDeterministicEvidence({
    lineage,
    regionMapping,
    reconstructionToFinalRgb,
    extensionRegions,
    sourceSimilarity,
  });

  return {
    finalAsset,
    job,
    preparation,
    // Already null-checked above (`plan_missing` throws otherwise).
    planKey: preparation.planKey as string,
    projectId,
    sourceAsset,
    rehashedSourceSha256,
    intermediateAsset,
    finalAssetSha256,
    deterministicEvidence,
    decodedImages,
  };
}

function structuralAuthorityValid(evidence: SignPreservationDeterministicEvidence): boolean {
  return (
    evidence.lineage.result === "pass" &&
    evidence.regionMapping.result === "pass" &&
    evidence.reconstructionToFinalRgb.result === "pass" &&
    evidence.extensionRegions.result === "pass" &&
    !evidence.catastrophicAnomalyDetected
  );
}

export function createSignPreservationCapability(
  repo: ProjectRepository,
  assets: AssetCapability,
  semanticProvider?: SignPreservationSemanticProvider,
): SignPreservationCapability {
  return {
    resolveCurrentVerificationAlgorithmVersion() {
      if (!semanticProvider) {
        throw new SignPreservationStateError(
          "semantic_provider_not_configured",
          "No semantic preservation provider was configured on this capability instance.",
        );
      }
      return buildCombinedVerificationAlgorithmVersion(
        semanticProvider.providerKey,
        semanticProvider.modelIdentity,
        semanticProvider.transportVersion,
      );
    },

    async verifyDeterministicPreservation(finalAssetId) {
      // --- Idempotent reuse: never re-verify an identity already on file. ---
      const existing = await repo.getSignPreservationVerification(
        finalAssetId,
        SIGN_PRESERVATION_ALGORITHM_VERSION,
      );
      if (existing) return existing;

      const ctx = await resolvePreservationContext(repo, assets, finalAssetId);
      const status: SignPreservationStatus = overallStatusFromDeterministicEvidence(
        ctx.deterministicEvidence,
      );

      return repo.createSignPreservationVerification(ctx.projectId, {
        signPreparationId: ctx.preparation.id,
        sourceAssetId: ctx.sourceAsset.id,
        sourceSha256: ctx.rehashedSourceSha256,
        intermediateAssetId: ctx.intermediateAsset.id,
        finalAssetId,
        finalAssetSha256: ctx.finalAssetSha256,
        planKey: ctx.planKey,
        verificationAlgorithmVersion: SIGN_PRESERVATION_ALGORITHM_VERSION,
        deterministicEvidence: ctx.deterministicEvidence as unknown as Record<string, unknown>,
        semanticEvidence: null,
        status,
        reasons: ctx.deterministicEvidence.concerns,
      });
    },

    async verifyPreservation(finalAssetId) {
      if (!semanticProvider) {
        throw new SignPreservationStateError(
          "semantic_provider_not_configured",
          "No semantic preservation provider was configured on this capability instance.",
        );
      }

      const combinedVersion = buildCombinedVerificationAlgorithmVersion(
        semanticProvider.providerKey,
        semanticProvider.modelIdentity,
        semanticProvider.transportVersion,
      );

      // --- Idempotent reuse under the COMBINED identity. ---
      const existing = await repo.getSignPreservationVerification(finalAssetId, combinedVersion);
      if (existing) return existing;

      const ctx = await resolvePreservationContext(repo, assets, finalAssetId);
      const det = ctx.deterministicEvidence;

      const persistWithoutSemantic = (status: SignPreservationStatus, extraReasons: string[] = []) =>
        repo.createSignPreservationVerification(ctx.projectId, {
          signPreparationId: ctx.preparation.id,
          sourceAssetId: ctx.sourceAsset.id,
          sourceSha256: ctx.rehashedSourceSha256,
          intermediateAssetId: ctx.intermediateAsset.id,
          finalAssetId,
          finalAssetSha256: ctx.finalAssetSha256,
          planKey: ctx.planKey,
          verificationAlgorithmVersion: combinedVersion,
          deterministicEvidence: det as unknown as Record<string, unknown>,
          semanticEvidence: null,
          status,
          reasons: [...det.concerns, ...extraReasons],
        });

      // --- Gate: deterministic structural authority must be valid before
      // the semantic provider is ever consulted. Zero paid dispatches for
      // an already-broken asset (Signs Phase S4.2A §6/§9C). ---
      if (!structuralAuthorityValid(det)) {
        return persistWithoutSemantic(det.catastrophicAnomalyDetected ? "changed" : "unknown");
      }

      if (!ctx.decodedImages) {
        // Should be unreachable given `structuralAuthorityValid` above
        // (a "pass" reconstruction→final-RGB result requires decoded
        // images to have been produced) — fail closed regardless.
        return persistWithoutSemantic("unknown", [
          "Structural checks passed but no decoded comparison images were available — refusing to fabricate a semantic request.",
        ]);
      }

      const imageSet = deriveSemanticComparisonImages(
        ctx.decodedImages.sourceImage,
        ctx.decodedImages.contentSubImage,
      );
      if (!imageSet) {
        return persistWithoutSemantic("unknown", [
          "The reconstruction's X/Y scale relative to the source is not proportional within tolerance — semantic comparison image derivation is unavailable.",
        ]);
      }

      const idempotencyKey = `${combinedVersion}:${finalAssetId}`;
      const requestedAt = new Date().toISOString();

      // --- Exactly one semantic dispatch. Any thrown error (transport,
      // timeout, rate-limit, malformed transport-level response) propagates
      // WITHOUT persisting anything — Signs Phase S4.2A §9B: an incomplete
      // provider attempt is never a completed verification. ---
      const semanticResult = await semanticProvider.compare({
        sourceOverview: imageSet.sourceOverview,
        reconstructionOverview: imageSet.reconstructionOverview,
        sourceCrops: imageSet.sourceCrops,
        reconstructionCrops: imageSet.reconstructionCrops,
        idempotencyKey,
        verificationIdentity: {
          projectId: ctx.projectId,
          finalAssetId,
          sourceAssetId: ctx.sourceAsset.id,
          intermediateAssetId: ctx.intermediateAsset.id,
          planKey: ctx.planKey,
          combinedVerificationAlgorithmVersion: combinedVersion,
        },
      });

      // --- Structural answer-shape validation is ALSO the orchestrator's
      // job — a provider that returns a wrong-shaped answers array without
      // throwing is exactly as incomplete as one that throws. ---
      if (!validateSemanticAnswers(semanticResult.answers)) {
        throw new ProviderError(
          "malformed_response",
          "The semantic preservation provider's answers did not match the required closed-question schema.",
        );
      }

      const verdict = deriveSemanticVerdict(semanticResult.answers);
      const respondedAt = new Date().toISOString();

      const semanticEvidence: SignPreservationSemanticEvidence = {
        providerKey: semanticProvider.providerKey,
        modelIdentity: semanticProvider.modelIdentity,
        promptVersion: SIGN_PRESERVATION_PROMPT_VERSION,
        schemaVersion: SIGN_PRESERVATION_SEMANTIC_SCHEMA_VERSION,
        imageDerivationVersion: imageSet.imageDerivationVersion,
        idempotencyKey,
        providerRequestId: semanticResult.providerRequestId,
        answers: semanticResult.answers,
        verdict,
        rawResponseSummary: semanticResult.rawResponseSummary,
        requestedAt,
        respondedAt,
        tokenUsage: semanticResult.tokenUsage,
      };

      // --- Signs Phase S4.2A §8: preserved requires BOTH deterministic
      // structural authority (already proven valid above) AND a semantic
      // verdict of "preserved" — never either alone. Since structural
      // authority is already confirmed, the composed status is exactly
      // the semantic verdict. ---
      const overallStatus: SignPreservationStatus = verdict;

      return repo.createSignPreservationVerification(ctx.projectId, {
        signPreparationId: ctx.preparation.id,
        sourceAssetId: ctx.sourceAsset.id,
        sourceSha256: ctx.rehashedSourceSha256,
        intermediateAssetId: ctx.intermediateAsset.id,
        finalAssetId,
        finalAssetSha256: ctx.finalAssetSha256,
        planKey: ctx.planKey,
        verificationAlgorithmVersion: combinedVersion,
        deterministicEvidence: det as unknown as Record<string, unknown>,
        semanticEvidence: semanticEvidence as unknown as Record<string, unknown>,
        status: overallStatus,
        reasons: [
          ...det.concerns,
          ...semanticResult.answers.map((a) => `${a.category}: ${a.answer} — ${a.reason}`),
        ],
      });
    },
  };
}
