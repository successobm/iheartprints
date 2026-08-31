/**
 * Signs Phase S4.1: the narrow boundary that RESOLVES authoritative inputs
 * (never trusts a caller's claim), RUNS the deterministic preservation
 * checks (`sign-preservation-deterministic-checks.ts`), and PERSISTS/REUSES
 * the resulting `SignPreservationVerification` record.
 *
 * It must NOT, and does not:
 *   - call Topaz or any provider network surface
 *   - call any multimodal/semantic verification provider (Signs Phase S4.2)
 *   - approve any review risk (Signs Phase S4.3)
 *   - mark a project/job `print_ready`
 *   - duplicate PrintValidation's own physical-production rules
 *   - mutate the approved repair plan
 *
 * Deliberately NOT wired into `FinalArtworkWorkerCapability`'s worker
 * orchestration yet — see ARCHITECTURE.md's "Signs Phase S4.1" section for
 * why. This capability is independently constructible and testable; a
 * future phase (S4.2) wires it into the production worker pipeline once
 * semantic verification exists to actually reach `"preserved"`.
 */

import { PNG } from "pngjs";
import { createHash } from "node:crypto";

import type { RgbaImage } from "@/capabilities/final-artwork/raster-transform";
import { isReconstructionIntermediateAsset } from "@/capabilities/final-artwork/production-request-identity";
import type { AssetCapability } from "@/capabilities/assets";
import type { ProjectRepository } from "@/lib/db/repository";
import type {
  SignPreservationStatus,
  SignPreservationVerification,
} from "@/lib/domain/types";

import {
  SIGN_PRESERVATION_ALGORITHM_VERSION,
  type SignPreservationDeterministicEvidence,
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
   */
  verifyDeterministicPreservation(
    finalAssetId: string,
  ): Promise<SignPreservationVerification>;
}

export type SignPreservationCapabilityError =
  | "final_asset_not_found"
  | "not_a_reconstructed_sign_asset"
  | "final_artwork_job_not_found"
  | "sign_preparation_not_found"
  | "plan_missing"
  | "source_asset_row_not_found"
  | "intermediate_asset_row_not_found";

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

export function createSignPreservationCapability(
  repo: ProjectRepository,
  assets: AssetCapability,
): SignPreservationCapability {
  return {
    async verifyDeterministicPreservation(finalAssetId) {
      // --- Idempotent reuse: never re-verify an identity already on file. ---
      const existing = await repo.getSignPreservationVerification(
        finalAssetId,
        SIGN_PRESERVATION_ALGORITHM_VERSION,
      );
      if (existing) return existing;

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
        // The asset ROW itself is missing — there is no valid id left to
        // satisfy `source_asset_id`'s NOT NULL foreign key. Nothing can be
        // persisted; this is categorically different from "the row exists
        // but its bytes could not be read", which DOES persist below.
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
          (a) =>
            a.finalArtworkJobId === job.id && isReconstructionIntermediateAsset(a),
        ) ?? null;
      if (!intermediateAsset) {
        // Same reasoning as above, for `intermediate_asset_id`. A
        // `resolutionProvenance: "reconstructed"` asset should always have
        // one (Signs Phase S3A/S3D) — if it structurally does not, that is
        // itself a serious lineage contradiction, not an ordinary retry
        // case, so this refuses rather than persist an unbindable row.
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
            finalImage.data.copy(
              contentSubImage.data,
              destStart,
              srcStart,
              srcStart + width * 4,
            );
          }
          sourceSimilarity = checkSourceSimilarity(sourceImage, contentSubImage);
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

      // --- S4.1's own hard invariant: never "preserved". ---
      const status: SignPreservationStatus = overallStatusFromDeterministicEvidence(
        deterministicEvidence,
      );

      return repo.createSignPreservationVerification(projectId, {
        signPreparationId: preparation.id,
        sourceAssetId: sourceAsset.id,
        sourceSha256: rehashedSourceSha256,
        intermediateAssetId: intermediateAsset.id,
        finalAssetId,
        finalAssetSha256,
        planKey: preparation.planKey,
        verificationAlgorithmVersion: SIGN_PRESERVATION_ALGORITHM_VERSION,
        deterministicEvidence: deterministicEvidence as unknown as Record<string, unknown>,
        semanticEvidence: null,
        status,
        reasons: deterministicEvidence.concerns,
      });
    },
  };
}
