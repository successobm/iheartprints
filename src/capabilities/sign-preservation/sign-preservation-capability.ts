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
  checkLineage,
  checkReconstructionToFinalRgb,
  checkSourceSimilarity,
  deriveContentRegion,
  overallStatusFromDeterministicEvidence,
  type PadStepGeometry,
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
  if (!rigidSignMeta || rigidSignMeta.resolutionProvenance !== "reconstructed") {
    throw new SignPreservationStateError(
      "not_a_reconstructed_sign_asset",
      "Preservation verification only ever applies to a reconstructed rigid-sign final asset.",
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

  const intermediateAsset =
    allAssets.find(
      (a) => a.finalArtworkJobId === job.id && isReconstructionIntermediateAsset(a),
    ) ?? null;
  if (!intermediateAsset) {
    throw new SignPreservationStateError(
      "intermediate_asset_row_not_found",
      "No reconstruction-intermediate asset row could be resolved for this final asset's job.",
    );
  }
  const intermediateBytes = await assets.downloadAssetBytes(intermediateAsset.id);

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
    geometryAdapted,
    executionEvidencePresent: executionGeometry != null,
    intermediateAssetExists: intermediateBytes != null,
    intermediateAssetTiedToSameJob: intermediateAsset.finalArtworkJobId === job.id,
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
  const planSteps = Array.isArray(plan.steps) ? (plan.steps as Array<Record<string, unknown>>) : [];
  const plannedPadStepRaw = planSteps.find(
    (s) => s.kind === "pad_uniform_background" || s.kind === "extend_uniform_background",
  );
  const plannedPadStep = readPadStepFromParams(
    plannedPadStepRaw?.params as Record<string, unknown> | undefined,
  );

  const regionMapping = deriveContentRegion({
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

  if (finalBytes && intermediateBytes && regionMapping.contentRegion) {
    const finalImage = decodePng(finalBytes.bytes);
    const reconstructionImage = decodePng(intermediateBytes.bytes);

    reconstructionToFinalRgb = checkReconstructionToFinalRgb(
      reconstructionImage,
      finalImage,
      regionMapping.contentRegion,
    );

    const activeStep = executedPadStep ?? plannedPadStep;
    const approvedFillRgb =
      activeStep && activeStep.colorR !== null && activeStep.colorG !== null && activeStep.colorB !== null
        ? { r: activeStep.colorR, g: activeStep.colorG, b: activeStep.colorB }
        : null;
    extensionRegions = checkExtensionRegions(finalImage, regionMapping.contentRegion, approvedFillRgb);

    if (sourceBytes) {
      const sourceImage = decodePng(sourceBytes.bytes);
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
