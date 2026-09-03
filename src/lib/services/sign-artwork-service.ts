/**
 * LIVE PRODUCT BLOCKER #1: the customer-facing bridge from the Existing
 * Artwork upload into the Signs production authority.
 *
 * The customer uploads ONE file through the ordinary Existing Artwork
 * upload step, before knowing (or being asked) whether it is DTF/apparel
 * or a sign — see `uploaded-artwork-flow.ts`'s `choose_artwork_type` step.
 * When they identify it as a Sign, this is the ONE place that turns those
 * SAME already-uploaded bytes into the Signs profile's own immutable
 * original (`SignPreparationCapability.uploadSignArtwork` — never a second
 * customer upload, never two sources of truth for "what did the customer
 * upload") and then records the human-confirmed ordered size on it
 * (`confirmSignProductionSpec`, Constitution §16A.2 — both dimensions,
 * explicit, never defaulted or inferred).
 *
 * Deliberately its own service file rather than folded into
 * `artwork-preparation-service.ts`: this composes TWO capabilities
 * (`ArtworkPreparationCapability` for the already-uploaded source,
 * `SignPreparationCapability` for the sign authority itself), and neither
 * capability may depend on the other (`ARCHITECTURE.md`'s
 * `SignPreparationCapability` dependency list is `ProjectRepository` +
 * `AssetCapability` only). That composition belongs at the app layer, same
 * as every other cross-capability orchestration in this file's siblings.
 */

import { getCapabilityGraph } from "@/capabilities/composition";
import type {
  ExhaustedSignProviderResultRecovery,
  SignPostProviderResumeResult,
} from "@/capabilities/final-artwork-worker";
import { describeSignPlanForCustomer, type SignCompositionOperatorInput } from "@/capabilities/sign-preparation";
import type { SignOperatorRegionBoundary } from "@/capabilities/sign-preparation/sign-operator-structural-override";
import { loadSignPlanOperatorReview, type SignPlanOperatorReview } from "@/capabilities/sign-preparation/sign-plan-operator-review";
import type { FinalArtworkJobStatus } from "@/lib/domain/types";
import { getProjectRepository } from "@/lib/db";
import { maybeTriggerLocalFinalArtworkWorker } from "@/lib/services/local-final-artwork-trigger";
import { buildPrintReadyFilename } from "@/lib/services/print-ready-filename";
import {
  getConversation,
  type ApiProjectSnapshot,
} from "@/lib/services/conversation-service";

export class SignArtworkBridgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SignArtworkBridgeError";
  }
}

/**
 * Idempotent: a second call for a project that already has a
 * `SignPreparation` re-confirms the (possibly changed) size against the
 * SAME sign original rather than adopting the upload a second time —
 * `SignPreparationCapability.uploadSignArtwork` refuses a second upload for
 * one project by construction, so this only ever bridges once.
 */
export async function confirmSignArtworkSize(
  projectId: string,
  input: { orderedWidthIn: number; orderedHeightIn: number },
): Promise<ApiProjectSnapshot> {
  const graph = getCapabilityGraph();

  let signPreparation = await graph.signPreparation.getSignPreparation(projectId);
  if (!signPreparation) {
    const reference =
      await graph.artworkPreparation.getOriginalAssetReference(projectId);
    if (!reference) {
      throw new SignArtworkBridgeError(
        "Upload your artwork before choosing a sign size.",
      );
    }
    const downloaded = await graph.assets.downloadAssetBytes(reference.assetId);
    if (!downloaded) {
      throw new SignArtworkBridgeError(
        "We couldn't read your uploaded artwork. Please try uploading again.",
      );
    }
    signPreparation = await graph.signPreparation.uploadSignArtwork(projectId, {
      bytes: downloaded.bytes,
      declaredContentType: downloaded.contentType,
      filename: reference.filename,
    });
  }

  await graph.signPreparation.confirmSignProductionSpec(
    projectId,
    input.orderedWidthIn,
    input.orderedHeightIn,
  );

  const snapshot = await getConversation(projectId);
  if (!snapshot) {
    throw new SignArtworkBridgeError("Project not found");
  }
  return snapshot;
}

/**
 * LIVE PRODUCT BLOCKER #3: "Check my artwork" — the customer's explicit
 * request to run the EXISTING, already-built inspection/diagnosis/planning
 * capability (`SignPreparationCapability.planSignRepair`) and see what it
 * found. This function does no diagnosis of its own: it calls the
 * authoritative capability, then translates its ACTUAL result through
 * `describeSignPlanForCustomer` — the same translation `conversation-
 * service.ts` reconstructs from the durable row on every later reload, so
 * there is exactly one customer-copy authority, not two.
 *
 * Idempotent by the capability's own construction: `planSignRepair`
 * recomputes from the immutable original and the confirmed spec every
 * time and overwrites the SAME `SignPreparation` row — repeated clicks
 * never create a second plan or a competing authority.
 */
export async function planSignArtwork(projectId: string): Promise<ApiProjectSnapshot> {
  const graph = getCapabilityGraph();
  const outcome = await graph.signPreparation.planSignRepair(projectId);

  const snapshot = await getConversation(projectId);
  if (!snapshot || !snapshot.signArtwork) {
    throw new SignArtworkBridgeError("Project not found");
  }

  // The re-read snapshot's `signArtwork.plan` reconstructs correctly from
  // the durable row for a PLANNED outcome (safe or needs-review) — but a
  // BLOCKED outcome durably looks identical to "never planned" (see
  // `SignArtworkView.plan`'s doc), so the customer would see nothing for
  // the very click that just told them it's blocked. Overriding with the
  // view built from THIS call's own fresh, authoritative result closes
  // that gap for the immediate response; reload afterward is documented,
  // deliberate, and safe (re-clicking reproduces the identical result).
  return {
    ...snapshot,
    signArtwork: {
      ...snapshot.signArtwork,
      plan: describeSignPlanForCustomer({
        orderedWidthIn: outcome.preparation.orderedWidthIn ?? 0,
        orderedHeightIn: outcome.preparation.orderedHeightIn ?? 0,
        artworkWidthPx: outcome.inspection.source.widthPx,
        artworkHeightPx: outcome.inspection.source.heightPx,
        defectCodes: outcome.result.defects.map((defect) => defect.code),
        plan: outcome.result.status === "planned" ? outcome.result.plan : null,
      }),
    },
  };
}

/**
 * Signs Phase 3A: records (or clears, with `regions: null`) an internal
 * production operator's own confirmed structural regions, then IMMEDIATELY
 * re-plans — the override alone changes nothing an operator would see
 * until `planSignRepair` actually consumes it; a caller that forgot to
 * re-plan would show the operator a plan that does not yet reflect what
 * they just confirmed. Returns the refreshed `SignPlanOperatorReview`
 * (never the customer-facing snapshot — this route is internal-only).
 */
export async function confirmOperatorStructuralLayoutForSign(
  projectId: string,
  regions: SignOperatorRegionBoundary[] | null,
): Promise<SignPlanOperatorReview> {
  const graph = getCapabilityGraph();
  await graph.signPreparation.confirmOperatorStructuralLayout(projectId, regions);
  await graph.signPreparation.planSignRepair(projectId);
  const repo = getProjectRepository();
  return loadSignPlanOperatorReview(repo, projectId);
}

/**
 * Signs Phase 3B (Canvas-First Correction): builds and persists an
 * operator-driven canvas-first composition plan
 * (`SignPreparationCapability.confirmSignCompositionPlan`) — the
 * counterpart to `confirmOperatorStructuralLayoutForSign` above, but for
 * the new crop/fit/move/fill vocabulary instead of the legacy automatic
 * `planSignRepair`. Unlike that two-step (confirm evidence, then
 * separately re-plan) pattern, `confirmSignCompositionPlan` itself already
 * builds and persists the plan in one call — nothing further to re-plan.
 * Returns the refreshed `SignPlanOperatorReview` (internal-only, never the
 * customer-facing snapshot).
 */
export async function confirmSignCompositionPlanForSign(
  projectId: string,
  input: SignCompositionOperatorInput,
): Promise<SignPlanOperatorReview> {
  const graph = getCapabilityGraph();
  await graph.signPreparation.confirmSignCompositionPlan(projectId, input);
  const repo = getProjectRepository();
  return loadSignPlanOperatorReview(repo, projectId);
}

/**
 * LIVE PRODUCT BLOCKER #4: the durable production-risk authorization for
 * the CURRENT plan. This function does no risk judgment of its own — it
 * calls the authoritative capability
 * (`SignPreparationCapability.authorizeSignRepairPlan`), which is the ONE
 * place `isAuthorizationSufficientForRisk` is enforced (a `review_required`
 * plan refuses a `"customer"` actor outright, regardless of which route
 * called this). Two callers, both server-stamping the actor rather than
 * ever accepting it from a request body:
 *
 *   - `POST /api/projects/[projectId]/sign-artwork/authorize` —
 *     `authorizedBy: "customer"`, the customer's own self-service action.
 *   - `POST /api/internal/projects/[projectId]/sign-artwork/authorize` —
 *     `authorizedBy: "operator"`, gated on the REQUESTER'S OWN session
 *     being verified internal (mirrors `continue-as-internal-job`'s own
 *     reasoning) before this function is ever reached.
 */
export async function authorizeSignArtwork(
  projectId: string,
  authorizedBy: "customer" | "operator",
): Promise<ApiProjectSnapshot> {
  const graph = getCapabilityGraph();
  await graph.signPreparation.authorizeSignRepairPlan(projectId, { authorizedBy });

  const snapshot = await getConversation(projectId);
  if (!snapshot) {
    throw new SignArtworkBridgeError("Project not found");
  }
  return snapshot;
}

export interface PrepareSignArtworkResult {
  jobId: string;
  jobStatus: FinalArtworkJobStatus;
  /** True when an already-queued/running/completed job for this exact plan was reused rather than created. */
  alreadyRequested: boolean;
}

/**
 * LIVE PRODUCT BLOCKER #4B: the operator's "Prepare artwork" action —
 * deliberately separate from "Authorize plan"
 * (`authorizeSignArtwork`/`SignPreparationCapability.authorizeSignRepairPlan`
 * above). This function does no authorization judgment of its own: it
 * calls the ALREADY-BUILT `FinalArtworkCapability.requestSignFinalArtwork`,
 * which is the ONE place the production-risk authorization gate
 * (`isAuthorizationSufficientForRisk`) is enforced before any
 * `FinalArtworkJob` is created — a `review_required` plan with no
 * sufficient operator authorization for its CURRENT `planKey` refuses here,
 * regardless of which route called this.
 *
 * Idempotent on (sign preparation, plan key), by that same capability's own
 * construction (Goal 14's guarantee, applied to signs): a double click, a
 * page reload, or a retry all resolve to the SAME job rather than creating
 * duplicates — this function performs no dedup logic of its own.
 *
 * Mirrors `prepareUploadedArtworkForPrint`'s own shape exactly: after the
 * job is durably queued/reused, kicks the SAME interactive-`next dev`-only
 * local worker trigger — no second worker, no second scheduler exists for
 * signs.
 */
export async function prepareSignArtworkForProduction(
  projectId: string,
): Promise<PrepareSignArtworkResult> {
  const graph = getCapabilityGraph();
  const { job, alreadyRequested } = await graph.finalArtwork.requestSignFinalArtwork(projectId);

  if (job.status === "queued" || job.status === "running" || job.status === "recoverable") {
    maybeTriggerLocalFinalArtworkWorker({
      projectId,
      reason: "prepare_sign_artwork",
    });
  }

  return { jobId: job.id, jobStatus: job.status, alreadyRequested };
}

/**
 * Exhausted Provider Result Recovery Phase (real Signs acceptance
 * incident): the operator-only bridge into
 * `FinalArtworkWorkerCapability.recoverExhaustedSignProviderResult` —
 * deliberately NOT the same code path as `prepareSignArtworkForProduction`
 * above (never calls `requestSignFinalArtwork`, never touches
 * `providerRecoveryAttempts`, never triggers the ordinary local-worker
 * convenience). This function performs NO precondition checks of its
 * own — every one of them (job exists, is failed, its recovery budget is
 * genuinely exhausted, it has an existing provider request, the provider
 * supports resume-only reads) lives in the capability itself, which fails
 * closed (`"refused"`, with a reason) rather than throwing, so a caller
 * can render a precise, honest reason rather than a generic error.
 */
export async function resumeExhaustedSignProviderResult(
  projectId: string,
): Promise<ExhaustedSignProviderResultRecovery> {
  const graph = getCapabilityGraph();
  return graph.finalArtworkWorker.recoverExhaustedSignProviderResult(projectId);
}

/**
 * Post-Provider Resume Phase (real Signs acceptance incident): the
 * operator-only bridge into
 * `FinalArtworkWorkerCapability.resumeSignFromPersistedIntermediate` —
 * mirrors `resumeExhaustedSignProviderResult` immediately above in every
 * respect except which capability method it calls, because it is a
 * genuinely different lifecycle operation: this one requires the provider
 * stage to ALREADY be durably complete (a persisted intermediate exists)
 * and never contacts a provider under any circumstance, where the other
 * requires the provider stage to still need resuming. Every precondition
 * lives in the capability itself, which fails closed (`"refused"`, with a
 * reason) rather than throwing.
 */
export async function resumeSignFromPersistedIntermediate(
  projectId: string,
): Promise<SignPostProviderResumeResult> {
  const graph = getCapabilityGraph();
  return graph.finalArtworkWorker.resumeSignFromPersistedIntermediate(projectId);
}

export interface SignProductionArtworkDownload {
  bytes: Buffer;
  contentType: string;
  filename: string;
}

/**
 * LIVE PRODUCT BLOCKER #4B: streams the project's current, AUTHORITATIVE
 * print-ready sign production PNG — the same "resolve the one exact
 * validated asset, then download its real bytes" shape
 * `getProductionArtworkDownload` (`conversation-service.ts`) already uses
 * for apparel, applied to the sign authority's own parallel resolver
 * (`FinalArtworkCapability.resolveCurrentSignProductionDelivery`) rather
 * than the apparel-shaped one. Returns `null` for every miss — no job yet,
 * a job still in flight, a completed job whose validation is not `"ready"`
 * (including a reconstructed asset whose preservation verification was
 * never `"preserved"`), or a asset that can no longer be read — a caller
 * must not distinguish those cases (Goal 15: no internal reason ever
 * reaches whoever is asking whether a file exists).
 */
export async function getSignProductionArtworkDownload(
  projectId: string,
): Promise<SignProductionArtworkDownload | null> {
  const graph = getCapabilityGraph();
  const delivery = await graph.finalArtwork.resolveCurrentSignProductionDelivery(projectId);
  if (!delivery) return null;

  const downloaded = await graph.assets.downloadAssetBytes(delivery.assetId);
  if (!downloaded) return null;

  const preparation = await graph.signPreparation.getSignPreparation(projectId);
  const mimeType = downloaded.contentType || "image/png";

  return {
    bytes: downloaded.bytes,
    contentType: mimeType,
    filename: buildPrintReadyFilename({
      uploadedFilename: preparation?.originalFilename ?? null,
      exactText: null,
      productSummary: null,
      mimeType,
    }),
  };
}

export interface SignBlockedProductionCandidateDownload {
  bytes: Buffer;
  contentType: string;
  /** Deliberately never `buildPrintReadyFilename` — this is not a print-ready deliverable and must never carry a filename implying otherwise. */
  filename: string;
  jobId: string;
  assetId: string;
  validationId: string;
  validationStatus: string;
}

/**
 * Blocked Production Candidate Inspection Phase (real Signs acceptance
 * incident): streams the project's current BLOCKED sign production
 * candidate — a completed job's exact validation-bound asset when that
 * validation is anything other than `"ready"` — for internal operator
 * visual inspection only. Deliberately calls
 * `FinalArtworkCapability.resolveBlockedSignProductionCandidate`, never
 * `resolveCurrentSignProductionDelivery` — the certified resolver already
 * refuses whenever validation isn't `"ready"`, and this resolver is the
 * exact mirror image: it refuses whenever validation IS `"ready"` (that
 * state has a certified download already, nothing to inspect here).
 * Returns `null` for every miss — same "a caller must not distinguish
 * why" discipline `getSignProductionArtworkDownload` already follows.
 */
export async function getSignBlockedProductionCandidateDownload(
  projectId: string,
): Promise<SignBlockedProductionCandidateDownload | null> {
  const graph = getCapabilityGraph();
  const candidate = await graph.finalArtwork.resolveBlockedSignProductionCandidate(projectId);
  if (!candidate) return null;

  const downloaded = await graph.assets.downloadAssetBytes(candidate.assetId);
  if (!downloaded) return null;

  const mimeType = downloaded.contentType || "image/png";
  const extension = mimeType === "image/png" ? "png" : mimeType.split("/")[1] || "png";

  return {
    bytes: downloaded.bytes,
    contentType: mimeType,
    filename: `BLOCKED-NOT-PRINT-READY-sign-production-candidate.${extension}`,
    jobId: candidate.job.id,
    assetId: candidate.assetId,
    validationId: candidate.validationId,
    validationStatus: candidate.validationStatus,
  };
}
