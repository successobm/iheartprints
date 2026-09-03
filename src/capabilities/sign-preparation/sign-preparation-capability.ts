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
import type { SignPlanAuthorizationActor, SignPreparation } from "@/lib/domain/types";

import type {
  SignInspectionReport,
  SignPlanningResult,
  SignRepairPlan,
} from "./contracts";
import {
  resolveSignResolutionPolicy,
  getSignResolutionPolicyById,
} from "./resolution-policy";
import { isValidOrderedDimensionIn, resolveSignProductionSpec } from "./sign-spec";
import { diagnoseSpecResolution } from "./sign-diagnosis";
import { inspectSignArtwork } from "./sign-inspection";
import { computeSignPlanKey } from "./sign-plan-identity";
import { isAuthorizationSufficientForRisk } from "./sign-plan-authorization";
import { planSignRepair } from "./sign-repair-planner";
import { measurePerimeterBand } from "./perimeter-reconstruction";
import { measureCleanFillRunPx, measureFrameStructuralModel } from "./frame-structure-model";
import { resolveFrameAnalysisWindow, segmentStructuralLayout } from "./sign-layout-segmentation";
import {
  resolveOperatorStructuralOverride,
  synthesizeSegmentationFromOperatorOverride,
  type SignOperatorRegionBoundary,
} from "./sign-operator-structural-override";
import type { SignEdge } from "./contracts";

const ALL_SIGN_EDGES: readonly SignEdge[] = ["top", "right", "bottom", "left"];

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
  /**
   * LIVE PRODUCT BLOCKER #4: the durable production-risk authorization for
   * the CURRENT plan (Constitution §16A.3-adjacent — a genuinely separate
   * decision from planning itself, which only formulates). Refuses fail-
   * closed when: no plan exists; the plan's own recomputed key does not
   * match what is persisted (never trust a stored key — the same
   * plan-replay discipline `planSignRepair`/`FinalArtworkCapability`
   * already apply); or `authorizedBy` is not sufficient for the plan's own
   * `overallRisk` (`isAuthorizationSufficientForRisk` — a customer action
   * alone is never sufficient for a `review_required` plan). Idempotent:
   * a second call for the SAME already-authorized plan is a no-op.
   */
  authorizeSignRepairPlan(
    designId: string,
    input: { authorizedBy: SignPlanAuthorizationActor },
  ): Promise<SignPreparation>;
  /**
   * Signs Phase 3A: records (or clears, with `regions: null`) an internal
   * production operator's own confirmed structural regions for the CURRENT
   * source image — see `sign-operator-structural-override.ts`'s own doc.
   * Independently re-validates the supplied boundaries against the actual
   * current source pixels BEFORE persisting anything (never stores an
   * override this module cannot itself already prove holds up) — throws
   * `SignPreparationStateError` with the specific reason otherwise. Never
   * plans, never authorizes anything on its own; a subsequent
   * `planSignRepair` call is what actually consumes this evidence.
   */
  confirmOperatorStructuralLayout(
    designId: string,
    regions: SignOperatorRegionBoundary[] | null,
  ): Promise<SignPreparation>;
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

      // Semantic Worker Wiring Phase: this was the missing wire from the
      // Production-Aware Perimeter Reconstruction phase — `planSignRepair`
      // (the planner) has always accepted `perimeterBands` as the evidence
      // that admits `reconstruct_perimeter_structure`, and its own unit
      // suite proves admission works, but THIS orchestration call site
      // never computed or supplied them, so no real (non-test) plan could
      // ever reach that step. `measurePerimeterBand` is pure/cheap (a
      // bounded-depth band read, four edges) — always computed alongside
      // inspection, exactly like the planner's own test helper
      // (`sign-repair-planner.test.ts`'s `planWithBands`) already assumed
      // this call site would do.
      const perimeterBands = ALL_SIGN_EDGES.map((edge) => measurePerimeterBand(decoded.image, edge));

      // Parametric Perimeter Frame Reconstruction Phase: the identical
      // wiring gap `perimeterBands` closed above, for the frame-structure
      // primitive — computed alongside inspection, always, exactly like
      // the planner's own test helpers already assume this call site does.
      // Both cheap, bounded-depth/bounded-window pixel reads; neither
      // makes a network call.
      const frameStructuralModel = measureFrameStructuralModel(decoded.image);
      const frameCleanFillRunPx: Partial<Record<SignEdge, number>> = {};
      if (frameStructuralModel.status === "measured") {
        for (const edge of ALL_SIGN_EDGES) {
          frameCleanFillRunPx[edge] = measureCleanFillRunPx(decoded.image, edge, frameStructuralModel.model.frameDepthPx);
        }
      }

      // Structural Layout Reflow Phase 2B (Planning Orchestration Wiring):
      // the identical wiring gap `perimeterBands`/`frameStructuralModel`
      // closed above, for `sign-layout-segmentation.ts`'s own primitive —
      // computed alongside them, always, from the SAME already-decoded
      // `decoded.image` (never a second decode of the source bytes), so it
      // corresponds to exactly the source version/hash this planning pass
      // is considering. Deterministic, pure, provider-free, and bounded by
      // the image's own dimensions — the same cost class as decoding the
      // image itself, not an unbounded or network operation. Computing it
      // unconditionally (rather than gating on a new speculative "is this
      // artwork banner-shaped" heuristic) mirrors this exact precedent: the
      // PLANNER, not this orchestration layer, is the sole authority for
      // whether the evidence is relevant/admissible — `planSignRepair`'s
      // own `evaluateStructuralReflow` (axis, rotation, region count, fill
      // evidence, safe inset) already decides that, and correctly falls
      // back to `reconstruct_parametric_frame` (or further) when this
      // evidence is absent, ambiguous, or inconclusive; this call site
      // only ever supplies evidence, never a decision.
      //
      // Structural Layout Reflow Phase 2C (Frame-Interior-Aware
      // Segmentation): `resolveFrameAnalysisWindow` derives a validated
      // analysis window from the SAME `frameStructuralModel` already
      // measured above (never a second frame measurement, never a
      // different image) — `null` whenever that model doesn't safely
      // support one, in which case segmentation transparently analyzes
      // the full image exactly as it always has. This is what lets a sign
      // surrounded by a continuous decorative frame — whose own left/right
      // bands otherwise defeat full-width row uniformity on every row —
      // still be analyzed for the banner structure that exists WITHIN it.
      // The frame interior only ever becomes an ANALYSIS WINDOW here; it
      // is never read by, or reachable from, `buildSignProductionTemplate`
      // (`sign-production-template.ts`), which remains derived solely from
      // the ordered production spec + policy.
      const structuralAnalysisWindow = resolveFrameAnalysisWindow(
        frameStructuralModel,
        decoded.image.width,
        decoded.image.height,
      );
      const deterministicSegmentation = segmentStructuralLayout(decoded.image, structuralAnalysisWindow ?? undefined);
      // Signs Phase 3A: OPERATOR-CONFIRMED STRUCTURAL EVIDENCE — the
      // precedence is deliberately narrow and one-directional. Deterministic
      // segmentation, when it safely measures a banner structure, is ALWAYS
      // preferred and this override is never even consulted. Only when
      // deterministic evidence is `"ambiguous"` or `"not_present"` does a
      // valid, source-bound operator override (see `resolveOperatorStructural
      // Override`'s own doc — independently re-validated against the CURRENT
      // source and re-measured against the actual pixels, never trusted as
      // typed) become the evidence `evaluateStructuralReflow` judges instead.
      // An operator override never silently supersedes ALREADY-VALID
      // deterministic evidence, and a stale/invalid override never blocks
      // anything beyond where the deterministic result would have blocked on
      // its own — this call site only ever SUPPLIES evidence, exactly like
      // `perimeterBands`/`frameStructuralModel` before it; `planSignRepair`'s
      // own `evaluateStructuralReflow` remains the sole judge of eligibility.
      let structuralLayoutSegmentation = deterministicSegmentation;
      if (deterministicSegmentation.status !== "measured" && preparation.operatorStructuralOverride) {
        const operatorResolution = resolveOperatorStructuralOverride(
          decoded.image,
          preparation.operatorStructuralOverride,
          preparation.originalAssetId,
          sha256,
        );
        if (operatorResolution.status === "usable") {
          structuralLayoutSegmentation = operatorResolution.segmentation;
        }
      }

      const result = planSignRepair({
        spec: specResolution.spec,
        policy,
        inspection,
        sourceAssetId: preparation.originalAssetId,
        sourceSha256: sha256,
        perimeterBands,
        frameStructuralModel,
        frameCleanFillRunPx,
        structuralLayoutSegmentation,
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

    async authorizeSignRepairPlan(designId, input) {
      const preparation = await loadOwned(designId);

      if (preparation.status !== "planned" || !preparation.plan || !preparation.planKey) {
        throw new SignPreparationStateError(
          "A repair plan must be formulated before it can be authorized.",
        );
      }

      // Never trust the stored key alone — recompute from the currently
      // persisted plan fields, the identical discipline `planSignRepair`'s
      // own callers (`FinalArtworkCapability.requestSignFinalArtwork`,
      // `FinalArtworkWorkerCapability`) already apply.
      const plan = preparation.plan as unknown as SignRepairPlan;
      const recomputedKey = computeSignPlanKey(plan);
      if (recomputedKey !== preparation.planKey || recomputedKey !== plan.planKey) {
        throw new SignPreparationStateError(
          "The recorded repair plan could not be verified. Please re-plan this artwork.",
        );
      }

      // Idempotent: already authorized for this EXACT plan — a double
      // click, a page reload, or a retried request all land here rather
      // than re-stamping a new timestamp/actor over an existing decision.
      if (preparation.authorizedPlanKey === recomputedKey) {
        return preparation;
      }

      // The one rule this method exists to enforce, checked at the
      // earliest possible point — BEFORE any durable authorization is
      // ever written, long before `FinalArtworkCapability` or the worker
      // are ever reached.
      if (!isAuthorizationSufficientForRisk(plan.overallRisk, input.authorizedBy)) {
        throw new SignPreparationStateError(
          plan.overallRisk === "review_required"
            ? "This plan requires operator review before it may be authorized for production."
            : "This plan cannot be authorized for production.",
        );
      }

      return repo.updateSignPreparation(preparation.id, {
        authorizedPlanKey: recomputedKey,
        authorizedAt: new Date().toISOString(),
        authorizedBy: input.authorizedBy,
      });
    },

    async confirmOperatorStructuralLayout(designId, regions) {
      const preparation = await loadOwned(designId);

      if (regions === null) {
        return repo.updateSignPreparation(preparation.id, {
          operatorStructuralOverride: null,
          operatorStructuralOverrideCreatedAt: null,
          operatorStructuralOverrideCreatedBy: null,
        });
      }

      const { decoded, sha256 } = await decodeOriginal(preparation);
      const override = {
        sourceAssetId: preparation.originalAssetId,
        sourceSha256: sha256,
        sourceWidthPx: decoded.image.width,
        sourceHeightPx: decoded.image.height,
        // Signs Phase 3A: the operator confirms boundaries against
        // whatever analysis window `planSignRepair` would ITSELF derive
        // from the current frame evidence at the SAME time (never a
        // second, independent frame measurement, and never a window the
        // operator invents) — recomputed fresh here so the persisted
        // override is self-contained and re-validatable without ever
        // reaching back into frame measurement again.
        analysisWindow: resolveFrameAnalysisWindow(
          measureFrameStructuralModel(decoded.image),
          decoded.image.width,
          decoded.image.height,
        ),
        regions,
      };

      const resolution = synthesizeSegmentationFromOperatorOverride(
        decoded.image,
        override,
        preparation.originalAssetId,
        sha256,
      );
      if (resolution.status !== "usable") {
        throw new SignPreparationStateError(
          resolution.status === "unusable"
            ? resolution.reason
            : "No confirmed regions were supplied.",
        );
      }

      return repo.updateSignPreparation(preparation.id, {
        operatorStructuralOverride: override as unknown as Record<string, unknown>,
        operatorStructuralOverrideCreatedAt: new Date().toISOString(),
        operatorStructuralOverrideCreatedBy: "operator",
      });
    },
  };
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 10);
}
