/**
 * Signs Phase S1: orchestration + persistence for rigid-sign inspection,
 * diagnosis, and repair PLANNING (Constitution §16A / §16B).
 *
 * OPERATOR/INTERNAL ONLY. No HTTP route exposes this capability in S1 — it
 * is invoked by tests and by future explicitly-approved Signs phases, so it
 * neither creates a new unauthenticated endpoint nor widens the
 * project-UUID bearer surface (S0.5 security ledger).
 *
 * Structural properties, mirroring `ArtworkPreparationCapability`:
 *
 *   - depends on `ProjectRepository` + `AssetCapability` and NO provider
 *     port of any kind — nothing in this module can make a network call,
 *     and S1 never changes a pixel;
 *   - the uploaded original is immutable; inspection and planning are
 *     recomputed from those exact bytes on every planning pass rather than
 *     trusting stored state as authority;
 *   - the ordered size is human-confirmed, both dimensions, fail-closed
 *     (§16A.2) — nothing here defaults or infers a dimension;
 *   - all reads are project-scoped; a cross-project id resolves to
 *     not-found, never to another project's data.
 */

import { createHash } from "node:crypto";

import type { AssetCapability } from "@/capabilities/assets";
import {
  decodePngUpload,
} from "@/capabilities/artwork-preparation/image-decode";
import {
  sanitizeUploadFilename,
  validateUploadBytes,
} from "@/capabilities/artwork-preparation/upload-limits";
import type { ProjectRepository } from "@/lib/db/repository";
import type { SignPreparation } from "@/lib/domain/types";

import type {
  SignInspectionReport,
  SignPlanningResult,
} from "./contracts";
import {
  resolveSignResolutionPolicy,
  getSignResolutionPolicyById,
} from "./resolution-policy";
import { isValidOrderedDimensionIn, resolveSignProductionSpec } from "./sign-spec";
import { diagnoseSpecResolution } from "./sign-diagnosis";
import { inspectSignArtwork } from "./sign-inspection";
import { planSignRepair } from "./sign-repair-planner";

/** Operator-facing state errors. Messages are safe, non-technical sentences. */
export class SignPreparationStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SignPreparationStateError";
  }
}

export interface UploadSignArtworkInput {
  bytes: Buffer;
  declaredContentType: string | null;
  filename: string | null;
}

export interface SignPlanningOutcome {
  preparation: SignPreparation;
  inspection: SignInspectionReport;
  result: SignPlanningResult;
}

export interface SignPreparationCapability {
  /**
   * Ingest a sign customer's artwork: validate, decode, store the immutable
   * original, run the deterministic spec-independent inspection, and
   * persist the preparation record. Refuses a second upload for the same
   * project — different source bytes are a new preparation on a new
   * project, never a silent original swap.
   */
  uploadSignArtwork(
    designId: string,
    input: UploadSignArtworkInput,
  ): Promise<SignPreparation>;
  getSignPreparation(designId: string): Promise<SignPreparation | null>;
  /**
   * Records the HUMAN confirmation of the ordered physical size — both
   * dimensions, explicitly (§16A.2). Fails closed on invalid dimensions and
   * on sizes no rigid-sign resolution policy covers, and stamps the
   * governing policy id so later policy revisions cannot silently
   * re-govern this order. Re-runs inspection under the confirmed spec.
   */
  confirmSignProductionSpec(
    designId: string,
    orderedWidthIn: number,
    orderedHeightIn: number,
  ): Promise<SignPreparation>;
  /**
   * Formulates (never executes) the repair plan. Fails closed — returns a
   * `blocked` result with explicit defects and persists NO plan — when the
   * ordered size is unconfirmed or no admitted repair exists. On success
   * persists the plan and its canonical key and moves status to `planned`.
   */
  planSignRepair(designId: string): Promise<SignPlanningOutcome>;
}

export function createSignPreparationCapability(
  repo: ProjectRepository,
  assets: AssetCapability,
): SignPreparationCapability {
  async function loadOwned(designId: string): Promise<SignPreparation> {
    const snapshot = await repo.getProject(designId);
    if (!snapshot) throw new SignPreparationStateError("Project not found");
    const preparation = await repo.getSignPreparation(designId);
    if (!preparation || preparation.projectId !== designId) {
      throw new SignPreparationStateError(
        "No sign preparation exists for this project yet.",
      );
    }
    return preparation;
  }

  async function decodeOriginal(preparation: SignPreparation) {
    const downloaded = await assets.downloadAssetBytes(
      preparation.originalAssetId,
    );
    if (!downloaded) {
      throw new SignPreparationStateError(
        "The original artwork file could not be loaded.",
      );
    }
    const decoded = decodePngUpload(downloaded.bytes);
    const sha256 = createHash("sha256").update(downloaded.bytes).digest("hex");
    return { decoded, sha256 };
  }

  return {
    async uploadSignArtwork(designId, input) {
      const snapshot = await repo.getProject(designId);
      if (!snapshot) throw new SignPreparationStateError("Project not found");

      const existing = await repo.getSignPreparation(designId);
      if (existing) {
        throw new SignPreparationStateError(
          "Sign artwork already exists for this project. Start a new project to work from a different file.",
        );
      }

      const validated = validateUploadBytes(
        input.bytes,
        input.declaredContentType,
      );
      // Header bounds are checked inside `decodePngUpload` BEFORE any
      // bitmap is allocated — see `image-decode.ts`.
      const decoded = decodePngUpload(validated.bytes);

      // Spec-independent inspection: geometry, edges, transparency. Nothing
      // ordered-size-dependent is computed, because no size exists yet and
      // none may be inferred (§16A.2).
      const inspection = inspectSignArtwork(decoded.image, null, null);

      const originalFilename = sanitizeUploadFilename(input.filename);
      const uploaded = await assets.uploadCustomerArtwork(designId, {
        // A storage-grouping id, never a customer-supplied name.
        conceptId: `sign-${Date.now().toString(36)}-${randomSuffix()}`,
        bytes: validated.bytes,
        contentType: validated.format,
        widthPx: decoded.image.width,
        heightPx: decoded.image.height,
        hasTransparency: inspection.transparency.hasAlphaPixels,
        kind: "customer_upload",
        metadata: {
          originalFilename,
          declaredContentType: input.declaredContentType,
          byteSize: validated.byteSize,
          signPreparation: true,
        },
      });

      return repo.createSignPreparation(designId, {
        originalAssetId: uploaded.id,
        originalFilename,
        inspection: inspection as unknown as Record<string, unknown>,
      });
    },

    async getSignPreparation(designId) {
      const snapshot = await repo.getProject(designId);
      if (!snapshot) return null;
      const preparation = await repo.getSignPreparation(designId);
      if (!preparation || preparation.projectId !== designId) return null;
      return preparation;
    },

    async confirmSignProductionSpec(designId, orderedWidthIn, orderedHeightIn) {
      const preparation = await loadOwned(designId);

      if (
        !isValidOrderedDimensionIn(orderedWidthIn) ||
        !isValidOrderedDimensionIn(orderedHeightIn)
      ) {
        throw new SignPreparationStateError(
          "Both the ordered width and height must be explicit positive measurements in inches.",
        );
      }
      const policy = resolveSignResolutionPolicy(orderedWidthIn, orderedHeightIn);
      if (!policy) {
        throw new SignPreparationStateError(
          "That sign size isn't covered by a supported rigid-sign policy yet.",
        );
      }

      const updated = await repo.updateSignPreparation(preparation.id, {
        orderedWidthIn,
        orderedHeightIn,
        specConfirmedAt: new Date().toISOString(),
        resolutionPolicyId: policy.id,
      });

      // Re-inspect under the confirmed spec so the stored report carries the
      // spec-dependent geometry an operator will read.
      const spec = resolveSignProductionSpec(updated);
      if (spec.status === "confirmed") {
        const { decoded } = await decodeOriginal(updated);
        const inspection = inspectSignArtwork(decoded.image, spec.spec, policy);
        return repo.updateSignPreparation(preparation.id, {
          inspection: inspection as unknown as Record<string, unknown>,
        });
      }
      return updated;
    },

    async planSignRepair(designId) {
      const preparation = await loadOwned(designId);

      const specResolution = resolveSignProductionSpec(preparation);
      if (specResolution.status !== "confirmed") {
        // Fail closed: no plan, no persisted plan state, explicit defects.
        const { decoded } = await decodeOriginal(preparation);
        const inspection = inspectSignArtwork(decoded.image, null, null);
        return {
          preparation,
          inspection,
          result: {
            status: "blocked",
            plan: null,
            defects: diagnoseSpecResolution(specResolution),
          },
        };
      }

      const policy = getSignResolutionPolicyById(
        specResolution.spec.resolutionPolicyId,
      );
      if (!policy) {
        // Structurally unreachable (spec resolution validated the id), but
        // an absence of policy must never plan anything.
        throw new SignPreparationStateError(
          "That sign size isn't covered by a supported rigid-sign policy yet.",
        );
      }

      // Recompute from the immutable original — stored inspection is a
      // diagnostic record, never the authority.
      const { decoded, sha256 } = await decodeOriginal(preparation);
      const inspection = inspectSignArtwork(
        decoded.image,
        specResolution.spec,
        policy,
      );

      const result = planSignRepair({
        spec: specResolution.spec,
        policy,
        inspection,
        sourceAssetId: preparation.originalAssetId,
        sourceSha256: sha256,
      });

      const updated =
        result.status === "planned"
          ? await repo.updateSignPreparation(preparation.id, {
              status: "planned",
              inspection: inspection as unknown as Record<string, unknown>,
              plan: result.plan as unknown as Record<string, unknown>,
              planKey: result.plan.planKey,
            })
          : await repo.updateSignPreparation(preparation.id, {
              inspection: inspection as unknown as Record<string, unknown>,
              plan: null,
              planKey: null,
            });

      return { preparation: updated, inspection, result };
    },
  };
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 10);
}
