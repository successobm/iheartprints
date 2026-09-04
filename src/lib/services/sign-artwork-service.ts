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

import { decodePngUpload } from "@/capabilities/artwork-preparation/image-decode";
import { getCapabilityGraph } from "@/capabilities/composition";
import type {
  ExhaustedSignProviderResultRecovery,
  SignPostProviderResumeResult,
} from "@/capabilities/final-artwork-worker";
import {
  analyzeSignFitToProduction,
  applyCorrectionsToCanvas,
  buildEdgeIntentClassificationRecord,
  computeSignWandSelection,
  decodeEdgeIntentClassificationRecords,
  decodeSignCompositionPlanToOperatorChoices,
  describeSignPlanForCustomer,
  encodeEdgeIntentClassificationRecord,
  encodeMoveRegionParams,
  encodeReplaceMaskedRegionWithBackgroundParams,
  encodeReplaceRegionWithBackgroundParams,
  encodeSignPlate,
  encodeSignWandMaskForBounds,
  getSignResolutionPolicyById,
  measureUniformSurroundingBackground,
  renderSignSelectionOverlayCrop,
  resolveCurrentEdgeIntentClassifications,
  type SignCompositionOperatorInput,
  type SignEdge,
  type SignEdgeIntentClassification,
  type SignFitToProductionResult,
  type SignRepairPlan,
  type SignRepairStep,
} from "@/capabilities/sign-preparation";
import type { ToleranceLevel } from "@/capabilities/shared/flood-fill-selection";
import type { SignOperatorRegionBoundary } from "@/capabilities/sign-preparation/sign-operator-structural-override";
import { loadSignPlanOperatorReview, type SignPlanOperatorReview } from "@/capabilities/sign-preparation/sign-plan-operator-review";
import type { RgbaImage } from "@/capabilities/final-artwork/raster-transform";
import type { FinalArtworkJobStatus } from "@/lib/domain/types";
import { getProjectRepository } from "@/lib/db";
import { maybeTriggerLocalFinalArtworkWorker } from "@/lib/services/local-final-artwork-trigger";
import { buildPrintReadyFilename } from "@/lib/services/print-ready-filename";
import { cacheDecodedCandidate, getCachedDecodedCandidate } from "@/lib/services/sign-wand-candidate-cache";
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

// ---------------------------------------------------------------------------
// Operator Production Correction UX: "Smart Remove" / "Move" corrections —
// preview (fast, in-memory, never persisted, never dispatches Topaz) and
// commit (governed: appends to the plan's own moves/replacements and
// rebuilds through the SAME `buildSignCompositionPlan` every other
// canvas-first plan uses, producing a new, independently re-authorizable
// planKey — Section K governance).
// ---------------------------------------------------------------------------

/**
 * One operator-selected correction, in the CURRENT production candidate's
 * own pixel coordinate space (never browser/CSS coordinates — the client
 * is responsible for that mapping before ever calling this service).
 *
 * `"remove"` colour is deliberately NOT supplied by the caller — the
 * surrounding background is always independently MEASURED server-side
 * (`measureUniformSurroundingBackground`), exactly the "system
 * independently examines surrounding background" requirement. `"move"`
 * mirrors the existing `SignCompositionPlanForm` numeric move fieldset
 * exactly (full canvas-width horizontal bands only, V1). `"classify"`
 * (Edge-Intent Correction Phase) marks an exact region EDGE_INTENT_ARTWORK
 * or PROTECTED — a governance action, never a pixel modification: it
 * changes what Fit to Production measures, not the artwork itself.
 */
export type PendingSignCorrection =
  | { kind: "remove"; xPx: number; yPx: number; widthPx: number; heightPx: number; contextDepthPx: number }
  | { kind: "move"; sourceStartYPx: number; heightPx: number; destStartYPx: number }
  | { kind: "classify"; classificationKind: "edge_intent" | "protected"; edges: SignEdge[]; xPx: number; yPx: number; widthPx: number; heightPx: number }
  /**
   * Wand-First Correction UX Phase: the mask-shaped sibling of `"remove"` —
   * an operator wand (flood-fill) selection, never widened to its bounding
   * rectangle for the actual pixel write (see
   * `replace_masked_region_with_background`'s own doc). `maskBase64` is the
   * exact persisted selection, sized to `[xPx,yPx,widthPx,heightPx]`, as
   * produced by `encodeSignWandMaskForBounds` from the SAME wand-select
   * response the operator is looking at — never re-derived or re-clicked
   * server-side.
   */
  | { kind: "wand_delete"; xPx: number; yPx: number; widthPx: number; heightPx: number; maskBase64: string; contextDepthPx: number };

export interface SignCorrectionPreviewResult {
  /**
   * `"no_candidate"` — nothing to correct right now (no blocked candidate
   * exists; e.g. the plan already reads `print_ready`, or no job has
   * completed yet). `"refused"` — one correction (`failingIndex`) could not
   * be safely applied; every correction BEFORE it was still applied and is
   * reflected in the preview/`fitToProduction` below. `"previewed"` — every
   * correction applied.
   */
  status: "no_candidate" | "refused" | "previewed";
  appliedCount: number;
  /** One entry per corrections[0..appliedCount), `null` for a "move" entry. */
  measuredColors: ({ r: number; g: number; b: number } | null)[];
  failingIndex: number | null;
  failingDetail: string | null;
  /** Base64 PNG (no data: prefix), cropped to the affected area at full native resolution — never the whole multi-megapixel canvas. `null` alongside `"no_candidate"`. */
  beforeCropPngBase64: string | null;
  afterCropPngBase64: string | null;
  cropBounds: { xPx: number; yPx: number; widthPx: number; heightPx: number } | null;
  /**
   * Fit to Production, recomputed against the FULL corrected canvas (not
   * merely the crop) — Section M's "immediate recheck" — reflecting exactly
   * the corrections successfully applied (`appliedCount`), never the ones
   * past a refusal. `null` alongside `"no_candidate"`.
   */
  fitToProduction: SignFitToProductionResult | null;
}

/** Padding (px), each side, around the corrections' own bounding box for the before/after preview crop — generous enough to show real surrounding context without transferring the whole canvas. */
const CORRECTION_PREVIEW_CROP_PAD_PX = 150;

function cropRgbaImage(image: RgbaImage, x0: number, y0: number, x1: number, y1: number): RgbaImage {
  const width = Math.max(1, x1 - x0);
  const height = Math.max(1, y1 - y0);
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    const srcStart = ((y0 + y) * image.width + x0) * 4;
    const destStart = y * width * 4;
    image.data.copy(data, destStart, srcStart, srcStart + width * 4);
  }
  return { width, height, data };
}

/**
 * Wand Performance Optimization Phase: `candidate` resolution and
 * `preparation` lookup are fully independent of each other (neither's
 * input depends on the other's output) — running them concurrently
 * overlaps two real Supabase round trips instead of paying both in
 * series, a safe, zero-semantic-risk win regardless of caching. WHICH
 * asset id is the project's current blocked candidate is always resolved
 * fresh, every call, exactly as before this phase — never cached, never
 * approximated (see `sign-wand-candidate-cache.ts`'s own doc for why only
 * the DECODED PIXELS behind an already-resolved, immutable asset id are
 * safe to cache, and why that alone is the dominant cost here). A cache
 * hit skips the download+decode entirely; a miss downloads+decodes once
 * and populates the cache for every subsequent call against this exact
 * asset id, in this request or any other.
 */
async function resolveCurrentCandidateImage(projectId: string): Promise<{
  image: RgbaImage;
  orderedWidthIn: number;
  orderedHeightIn: number;
  minimumSafeInsetIn: number;
  candidateAssetId: string;
  planKey: string;
  /** Governed classifications ALREADY persisted for this exact candidate/plan — re-validated fresh, never trusted merely for existing. */
  existingClassifications: SignEdgeIntentClassification[];
} | null> {
  const graph = getCapabilityGraph();
  // SIGNS CANDIDATE AUTHORITY: this correction (Smart Remove / edge-intent
  // classification) is a WRITE deriving from whichever candidate is
  // returned — the trustworthy-repair-parent question, never "what should
  // an operator merely look at" (`resolveBlockedSignProductionCandidate`,
  // deliberately left alone for that separate purpose).
  const [candidate, preparation] = await Promise.all([
    graph.finalArtwork.resolveTrustworthySignRepairParent(projectId),
    graph.signPreparation.getSignPreparation(projectId),
  ]);
  if (!candidate) return null;
  if (!preparation || preparation.orderedWidthIn === null || preparation.orderedHeightIn === null || !preparation.resolutionPolicyId || !preparation.planKey) {
    return null;
  }
  const policy = getSignResolutionPolicyById(preparation.resolutionPolicyId);
  if (!policy) return null;

  let image = getCachedDecodedCandidate(candidate.assetId);
  if (!image) {
    const downloaded = await graph.assets.downloadAssetBytes(candidate.assetId);
    if (!downloaded) return null;
    image = decodePngUpload(downloaded.bytes).image;
    cacheDecodedCandidate(candidate.assetId, image);
  }

  const existingClassifications = resolveCurrentEdgeIntentClassifications(
    decodeEdgeIntentClassificationRecords(preparation.edgeIntentClassifications),
    candidate.assetId,
    preparation.planKey,
  );
  return {
    image,
    orderedWidthIn: preparation.orderedWidthIn,
    orderedHeightIn: preparation.orderedHeightIn,
    minimumSafeInsetIn: policy.minimumSafeInsetIn,
    candidateAssetId: candidate.assetId,
    planKey: preparation.planKey,
    existingClassifications,
  };
}

/**
 * Wand-First Correction UX Phase: the read-only, zero-provider-call
 * response to one operator wand click. Reuses `computeSignWandSelection`
 * (the SAME `floodFillSelect` DTF's own Magic Wand runs, extracted to
 * `@/capabilities/shared/flood-fill-selection`) against the CURRENT blocked
 * candidate's own pixels — never a second image, never re-derived from a
 * stale copy. Returns everything the client needs to render the selection
 * and decide which actions to offer, WITHOUT ever sending the (potentially
 * ~20MB) full-image mask over the wire: the overlay is cropped to the
 * selection's own bounding rectangle, and the persisted mask (for a
 * subsequent Delete/Keep) is the SAME crop, base64-encoded — the exact
 * shape `replace_masked_region_with_background`'s own params expect.
 */
export interface SignWandSelectionPreview {
  status: "no_candidate" | "out_of_bounds" | "selected";
  pixelCount: number;
  bounds: { xPx: number; yPx: number; widthPx: number; heightPx: number } | null;
  touchesEdge: boolean;
  broad: boolean;
  /** Section N safety gate — see `sign-wand-selection.ts`'s own doc. Only a `true` selection may become a governed edge-intent classification. */
  rectExact: boolean;
  /** Whether this selection is small enough to be persisted as a masked Delete (`MAX_MASKED_REGION_PIXELS`). */
  eligibleForMaskedDelete: boolean;
  touchedCanvasEdges: SignEdge[];
  /** Base64 PNG (no data: prefix), alpha-transparent, cropped to `bounds` — draw at `(bounds.xPx, bounds.yPx)` on the workspace's overlay canvas. `null` alongside a non-`"selected"` status. */
  overlayPngBase64: string | null;
  /** Base64 of the raw selection mask, cropped to `bounds` (`widthPx*heightPx` bytes) — pass straight through as `maskBase64` on a subsequent `"wand_delete"`/classify correction referencing this exact selection. `null` alongside a non-`"selected"` status. */
  maskBase64: string | null;
}

export async function previewSignWandSelection(
  projectId: string,
  seedXPx: number,
  seedYPx: number,
  toleranceLevel: ToleranceLevel,
): Promise<SignWandSelectionPreview> {
  const empty: SignWandSelectionPreview = {
    status: "no_candidate",
    pixelCount: 0,
    bounds: null,
    touchesEdge: false,
    broad: false,
    rectExact: false,
    eligibleForMaskedDelete: false,
    touchedCanvasEdges: [],
    overlayPngBase64: null,
    maskBase64: null,
  };
  const resolved = await resolveCurrentCandidateImage(projectId);
  if (!resolved) return empty;
  const { image } = resolved;
  if (!Number.isInteger(seedXPx) || !Number.isInteger(seedYPx) || seedXPx < 0 || seedXPx >= image.width || seedYPx < 0 || seedYPx >= image.height) {
    return { ...empty, status: "out_of_bounds" };
  }

  const selection = computeSignWandSelection(image, { x: seedXPx, y: seedYPx }, toleranceLevel);

  // Wand Performance Optimization Phase (Section G/H): a selection whose
  // bounding box exceeds `MAX_MASKED_REGION_PIXELS` is ALREADY
  // `eligibleForMaskedDelete: false` — no cheaper transport is worth
  // building for a mask the operator can never use for Delete regardless.
  // Rendering/encoding a full-bounding-box overlay AND mask for a broad,
  // near-canvas-sized selection (a real click on this candidate's own
  // background measured a 3717x4321px bounding box — ~16M px, a ~21MB
  // base64 mask) is exactly the transport cost Section C's real-candidate
  // benchmark found dominating a click's wall-clock time once the fixed
  // decode/download cost was cached away. Skipping both here changes
  // nothing about what the selection MEANS or what Delete/Keep may act on
  // — `eligibleForMaskedDelete`/`rectExact`/`touchedCanvasEdges` are still
  // computed and returned exactly as before; only the (already-unusable)
  // pixel payload is omitted. The client falls back to an outline-only
  // visual for this case — never a silently different geometry.
  const skipHeavyTransport = !selection.eligibleForMaskedDelete;
  const overlayPngBase64 = skipHeavyTransport
    ? null
    : encodeSignPlate(renderSignSelectionOverlayCrop(selection.mask, image.width, selection.bounds)).toString("base64");
  const maskBase64 = skipHeavyTransport
    ? null
    : encodeSignWandMaskForBounds(selection.mask, image.width, selection.bounds);

  return {
    status: "selected",
    pixelCount: selection.pixelCount,
    bounds: {
      xPx: selection.bounds.left,
      yPx: selection.bounds.top,
      widthPx: selection.bounds.width,
      heightPx: selection.bounds.height,
    },
    touchesEdge: selection.touchesEdge,
    broad: selection.broad,
    rectExact: selection.rectExact,
    eligibleForMaskedDelete: selection.eligibleForMaskedDelete,
    touchedCanvasEdges: selection.touchedCanvasEdges,
    overlayPngBase64,
    maskBase64,
  };
}

function buildCorrectionStep(
  correction: Extract<PendingSignCorrection, { kind: "remove" | "move" | "wand_delete" }>,
  measuredColor: { r: number; g: number; b: number } | null,
): SignRepairStep {
  if (correction.kind === "move") {
    return {
      kind: "move_region",
      params: encodeMoveRegionParams({
        sourceStartYPx: correction.sourceStartYPx,
        heightPx: correction.heightPx,
        destStartYPx: correction.destStartYPx,
      }),
      risk: "review_required",
      reasons: ["Operator Production Correction UX: operator-selected move, resolving a Fit to Production safe-inset violation."],
    };
  }
  const color = measuredColor!;
  if (correction.kind === "wand_delete") {
    return {
      kind: "replace_masked_region_with_background",
      params: encodeReplaceMaskedRegionWithBackgroundParams({
        xPx: correction.xPx,
        yPx: correction.yPx,
        widthPx: correction.widthPx,
        heightPx: correction.heightPx,
        colorR: color.r,
        colorG: color.g,
        colorB: color.b,
        contextDepthPx: correction.contextDepthPx,
        maskBase64: correction.maskBase64,
      }),
      risk: "review_required",
      reasons: ["Wand-First Correction UX: operator wand selection removed, background independently measured before removal, restricted to the exact selected shape."],
    };
  }
  return {
    kind: "replace_region_with_background",
    params: encodeReplaceRegionWithBackgroundParams({
      xPx: correction.xPx,
      yPx: correction.yPx,
      widthPx: correction.widthPx,
      heightPx: correction.heightPx,
      colorR: color.r,
      colorG: color.g,
      colorB: color.b,
      contextDepthPx: correction.contextDepthPx,
    }),
    risk: "review_required",
    reasons: ["Operator Production Correction UX: operator-selected Smart Remove, background independently measured before removal."],
  };
}

/**
 * Fast, in-memory, NEVER-persisted preview of one or more operator
 * corrections applied on top of the CURRENT blocked production candidate —
 * zero writes, zero new assets, zero Topaz calls (no reconstruction step is
 * ever touched; this operates on the already-produced candidate's own
 * pixels). Applies each correction in order using the IDENTICAL primitives
 * (`measureUniformSurroundingBackground`, `applyCorrectionsToCanvas`) real
 * commit/execution uses — Section L: preview and execution never disagree
 * about what a correction does.
 *
 * A `"move"` correction's SOURCE band is read from whatever the PRECEDING
 * correction in this same batch already produced (never the ORIGINAL,
 * pre-batch candidate) — a documented, narrow preview-only approximation
 * that only matters if a second new move in the same batch targets a band
 * an earlier new move/remove in the SAME batch already touched. It never
 * affects the actual committed/executed result: `commitSignCorrections`
 * rebuilds the plan and the real worker always replays the FULL step
 * sequence from the TRUE original source, exactly as it already does for
 * every other canvas-first plan.
 */
export async function previewSignCorrections(
  projectId: string,
  corrections: PendingSignCorrection[],
): Promise<SignCorrectionPreviewResult> {
  const empty: SignCorrectionPreviewResult = {
    status: "no_candidate",
    appliedCount: 0,
    measuredColors: [],
    failingIndex: null,
    failingDetail: null,
    beforeCropPngBase64: null,
    afterCropPngBase64: null,
    cropBounds: null,
    fitToProduction: null,
  };
  if (corrections.length === 0) return empty;

  const resolved = await resolveCurrentCandidateImage(projectId);
  if (!resolved) return empty;
  const { image: original, orderedWidthIn, orderedHeightIn, minimumSafeInsetIn, existingClassifications } = resolved;

  let workingImage: RgbaImage = original;
  const measuredColors: ({ r: number; g: number; b: number } | null)[] = [];
  const queuedClassifications: SignEdgeIntentClassification[] = [];
  let appliedCount = 0;
  let failingIndex: number | null = null;
  let failingDetail: string | null = null;
  let bx0 = original.width, by0 = original.height, bx1 = 0, by1 = 0;
  const extend = (x0: number, y0: number, x1: number, y1: number) => {
    bx0 = Math.min(bx0, x0); by0 = Math.min(by0, y0);
    bx1 = Math.max(bx1, x1); by1 = Math.max(by1, y1);
  };

  for (let i = 0; i < corrections.length; i++) {
    const correction = corrections[i]!;

    if (correction.kind === "classify") {
      // Governance, not pixel modification — no `applyCorrectionsToCanvas`
      // call, no colour measurement. Only affects the Fit to Production
      // recheck below.
      queuedClassifications.push({
        kind: correction.classificationKind, edges: correction.edges,
        xPx: correction.xPx, yPx: correction.yPx, widthPx: correction.widthPx, heightPx: correction.heightPx,
      });
      extend(correction.xPx, correction.yPx, correction.xPx + correction.widthPx, correction.yPx + correction.heightPx);
      measuredColors.push(null);
      appliedCount++;
      continue;
    }

    let measuredColor: { r: number; g: number; b: number } | null = null;
    if (correction.kind === "remove" || correction.kind === "wand_delete") {
      const measured = measureUniformSurroundingBackground(
        workingImage,
        { xPx: correction.xPx, yPx: correction.yPx, widthPx: correction.widthPx, heightPx: correction.heightPx },
        correction.contextDepthPx,
      );
      if (measured.status === "refused") {
        failingIndex = i;
        failingDetail = measured.detail;
        break;
      }
      measuredColor = measured.color;
      extend(correction.xPx, correction.yPx, correction.xPx + correction.widthPx, correction.yPx + correction.heightPx);
    } else {
      extend(0, correction.sourceStartYPx, original.width, correction.sourceStartYPx + correction.heightPx);
      extend(0, correction.destStartYPx, original.width, correction.destStartYPx + correction.heightPx);
    }

    const step = buildCorrectionStep(correction, measuredColor);
    const result = applyCorrectionsToCanvas(workingImage, [step]);
    if (result.status === "refused") {
      failingIndex = i;
      failingDetail = result.detail;
      break;
    }
    workingImage = result.image;
    measuredColors.push(measuredColor);
    appliedCount++;
  }

  const fitToProduction = analyzeSignFitToProduction(
    workingImage, orderedWidthIn, orderedHeightIn, minimumSafeInsetIn,
    [...existingClassifications, ...queuedClassifications],
  );

  let beforeCropPngBase64: string | null = null;
  let afterCropPngBase64: string | null = null;
  let cropBounds: SignCorrectionPreviewResult["cropBounds"] = null;
  if (bx1 > bx0 && by1 > by0) {
    const x0 = Math.max(0, bx0 - CORRECTION_PREVIEW_CROP_PAD_PX);
    const y0 = Math.max(0, by0 - CORRECTION_PREVIEW_CROP_PAD_PX);
    const x1 = Math.min(original.width, bx1 + CORRECTION_PREVIEW_CROP_PAD_PX);
    const y1 = Math.min(original.height, by1 + CORRECTION_PREVIEW_CROP_PAD_PX);
    beforeCropPngBase64 = encodeSignPlate(cropRgbaImage(original, x0, y0, x1, y1)).toString("base64");
    afterCropPngBase64 = encodeSignPlate(cropRgbaImage(workingImage, x0, y0, x1, y1)).toString("base64");
    cropBounds = { xPx: x0, yPx: y0, widthPx: x1 - x0, heightPx: y1 - y0 };
  }

  return {
    status: failingIndex !== null ? "refused" : "previewed",
    appliedCount,
    measuredColors,
    failingIndex,
    failingDetail,
    beforeCropPngBase64,
    afterCropPngBase64,
    cropBounds,
    fitToProduction,
  };
}

/**
 * Governed commit: reconstructs the CURRENT plan's own operator choices
 * (`decodeSignCompositionPlanToOperatorChoices`), appends `"remove"`/
 * `"move"` corrections to its `moves`/`replacements` arrays and rebuilds
 * through the UNCHANGED `buildSignCompositionPlan`/`confirmSignCompositionPlan`
 * — producing a new, independently re-authorizable plan/planKey (Section
 * K: "changing... must change the appropriate plan identity"; old
 * authorization can never authorize this new plan). `"classify"`
 * corrections are a SEPARATE, parallel governance action — never a plan
 * step — persisted as new `SignEdgeIntentClassificationRecord` entries,
 * bound to the CURRENT candidate/plan identity at the moment of this call
 * (Section F: candidate identity, region, applicable edges, operator
 * decision, audit timestamp). No direct final-image mutation, no manual DB
 * mutation — the only persisted artifacts are a (possibly unchanged) plan
 * and/or a new classification record, both replayed/re-read for real by
 * the ordinary, unmodified worker exactly like every other one.
 *
 * A batch mixing `"classify"` with `"remove"`/`"move"` is honoured, but
 * note the classify record binds to the plan identity BEFORE this call's
 * own plan rebuild — if the SAME batch also changes the plan, the
 * classification becomes stale for the NEW plan/candidate the instant one
 * exists (by the same "never trust a stale binding" discipline every other
 * record here follows) and must be re-applied once the new candidate is
 * produced. The real Section K workflow is deliberately sequential
 * (classify, rerun Fit to Production, inspect) precisely to avoid this.
 */
export async function commitSignCorrections(
  projectId: string,
  corrections: PendingSignCorrection[],
): Promise<SignPlanOperatorReview> {
  if (corrections.length === 0) {
    throw new SignArtworkBridgeError("No corrections were supplied to commit.");
  }
  const graph = getCapabilityGraph();
  const preparation = await graph.signPreparation.getSignPreparation(projectId);
  if (!preparation || !preparation.plan) {
    throw new SignArtworkBridgeError("This project has no current composition plan to correct.");
  }
  const currentPlan = preparation.plan as unknown as SignRepairPlan;
  const choices = decodeSignCompositionPlanToOperatorChoices(currentPlan);
  if (!choices) {
    throw new SignArtworkBridgeError(
      "This artwork's current plan is not in the canvas-first shape the correction tool can edit.",
    );
  }

  const resolved = await resolveCurrentCandidateImage(projectId);
  if (!resolved) {
    throw new SignArtworkBridgeError("There is no current production candidate to correct.");
  }
  let workingImage: RgbaImage = resolved.image;

  const moves = [...choices.moves];
  const replacements = [...choices.replacements];
  const maskedReplacements = [...choices.maskedReplacements];
  const newClassificationRecords = corrections
    .filter((c): c is Extract<PendingSignCorrection, { kind: "classify" }> => c.kind === "classify")
    .map((c) =>
      buildEdgeIntentClassificationRecord({
        kind: c.classificationKind,
        edges: c.edges,
        xPx: c.xPx, yPx: c.yPx, widthPx: c.widthPx, heightPx: c.heightPx,
        candidateAssetId: resolved.candidateAssetId,
        planKey: resolved.planKey,
      }),
    );
  let planChanged = false;

  for (const correction of corrections) {
    if (correction.kind === "classify") continue; // governance, handled separately above/below — never a plan step.

    let measuredColor: { r: number; g: number; b: number } | null = null;
    if (correction.kind === "remove" || correction.kind === "wand_delete") {
      const measured = measureUniformSurroundingBackground(
        workingImage,
        { xPx: correction.xPx, yPx: correction.yPx, widthPx: correction.widthPx, heightPx: correction.heightPx },
        correction.contextDepthPx,
      );
      if (measured.status === "refused") {
        throw new SignArtworkBridgeError(measured.detail);
      }
      measuredColor = measured.color;
      if (correction.kind === "wand_delete") {
        maskedReplacements.push({
          xPx: correction.xPx, yPx: correction.yPx, widthPx: correction.widthPx, heightPx: correction.heightPx,
          color: measuredColor, contextDepthPx: correction.contextDepthPx, maskBase64: correction.maskBase64,
        });
      } else {
        replacements.push({
          xPx: correction.xPx, yPx: correction.yPx, widthPx: correction.widthPx, heightPx: correction.heightPx,
          color: measuredColor, contextDepthPx: correction.contextDepthPx,
        });
      }
    } else {
      moves.push({ sourceStartYPx: correction.sourceStartYPx, heightPx: correction.heightPx, destStartYPx: correction.destStartYPx });
    }
    planChanged = true;

    const step = buildCorrectionStep(correction, measuredColor);
    const result = applyCorrectionsToCanvas(workingImage, [step]);
    if (result.status === "refused") {
      throw new SignArtworkBridgeError(result.detail);
    }
    workingImage = result.image;
  }

  const repo = getProjectRepository();

  if (newClassificationRecords.length > 0) {
    const existingRaw = Array.isArray(preparation.edgeIntentClassifications) ? preparation.edgeIntentClassifications : [];
    await repo.updateSignPreparation(preparation.id, {
      edgeIntentClassifications: [...existingRaw, ...newClassificationRecords.map(encodeEdgeIntentClassificationRecord)],
    });
  }

  if (planChanged) {
    const input: SignCompositionOperatorInput = {
      reconstruction: choices.reconstruction,
      crop: choices.crop,
      fitBackground: choices.fitBackground,
      fitPlacement: choices.fitPlacement,
      moves,
      fills: choices.fills,
      replacements,
      maskedReplacements,
    };
    await graph.signPreparation.confirmSignCompositionPlan(projectId, input);
  }

  return loadSignPlanOperatorReview(repo, projectId);
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
