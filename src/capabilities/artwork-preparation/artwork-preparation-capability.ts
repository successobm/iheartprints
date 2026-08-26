/**
 * `ArtworkPreparationCapability` — the second first-class iHeartPrints
 * workflow: the customer already HAS artwork and wants that artwork made
 * print-ready.
 *
 * ## The preservation contract
 *
 * Uploaded artwork is PIXEL-AUTHORITATIVE. The customer is not asking to have
 * it redesigned. This capability may decode, measure, isolate an exterior
 * background, and clean the boundary that isolation leaves behind. It may
 * never change wording, redraw an object, shift a colour globally, alter
 * composition, invent an element, or regenerate anything — and it never calls
 * an image model, a segmentation service, or any other network provider.
 * Every operation is local, deterministic, and pure pixel math.
 *
 * The original upload is IMMUTABLE. Its `AssetRecord` is written once and
 * never updated; every transformation produces a new, separate asset with a
 * unique storage object identity (never a removal-count-keyed path).
 *
 * ## What this is NOT
 *
 * It is not concept generation. It creates no `GenerationJob`, calls no
 * `ConceptGenerationProvider`, and produces no `ArtworkVersion` of kind
 * `"concept"`. Uploaded artwork is never labelled AI-generated (Constitution
 * §16 — provenance is never inferred).
 *
 * It is also not finalization. An approved preparation is a faithful
 * transparent PNG of the customer's own artwork, nothing more. It is not
 * enhanced, not upscaled, not print-validated, and never described as
 * print-ready (Constitution §15). Phase 2 consumes
 * `preparedArtworkVersionId` and owns all of that.
 *
 * ## Dependencies
 *
 * `ProjectRepository`, `AssetCapability`, and `DesignBriefCapability` — the
 * last only to record the production context (product, garment colour, print
 * location) the customer states in this flow, through the one boundary that
 * is allowed to mutate a brief. No provider port of any kind exists here, by
 * construction.
 */

import { createHash, randomUUID } from "node:crypto";

import type { AssetCapability } from "@/capabilities/assets";
import type { DesignBriefCapability } from "@/capabilities/design-brief";
import type { RgbaImage } from "@/capabilities/final-artwork/raster-transform";
import type { ProjectRepository } from "@/lib/db/repository";
import type {
  ArtworkPreparation,
  PrintPlacement,
  TShirtDesignBrief,
} from "@/lib/domain/types";

import {
  previewGuidedRemovalAt,
  revalidateGuidedRemovalCandidate,
} from "./background-isolation";
import {
  isToleranceLevel,
  MAGIC_WAND_ALGORITHM_VERSION,
  type CorrectionAction,
  type Point,
  type ToleranceLevel,
} from "./magic-wand-algorithm";
import {
  acceptSessionOperation,
  clearSession as clearCorrectionSession,
  computeCurrentResult as computeCorrectionResult,
  computeSelectionPreview as computeCorrectionSelectionPreview,
  getOrCreateSession,
  getSession as getCorrectionSession,
  hasFreshSession,
  resetSessionOperations,
  undoLastSessionOperation,
  type CorrectionOperationRecord,
} from "./magic-wand-correction";
import type { ArtworkAnalysis, RepairabilityAssessment } from "./contracts";
import {
  buildSelectionHighlight,
  isMagicSelectCandidateClaims,
  mintGuidedCleanupCandidateToken,
  mintMagicSelectCandidateToken,
  verifyGuidedCleanupCandidateToken,
  type GuidedCleanupHighlight,
} from "./guided-cleanup-candidate";
import {
  derivePreparedFromOperations,
  isMagicColorOperation,
  parseGuidedCleanupOperations,
  regionOperations,
  type GuidedCleanupOperation,
  type GuidedCleanupTool,
} from "./guided-cleanup-operations";
import { measureExteriorRemovalEnclosure } from "./enclosure-evidence";
import type { GuidedRemovalPoint } from "./guided-removal";
import { decodePngUpload, encodeRgbaToPng } from "./image-decode";
import { analyzeArtwork } from "./image-analysis";
import {
  clampMagicSelectTolerance,
  MAGIC_SELECT_DEFAULT_TOLERANCE,
  selectConnectedMagicColor,
  selectMagicColor,
  selectMagicColorByMode,
} from "./magic-color-selection";
import {
  describeArtworkForCustomer,
  describeGuidedCleanupOutcome,
  describePreparedArtworkReview,
  type ArtworkPreparationCustomerView,
  type GuidedCleanupOutcomeCode,
  type PreparedArtworkReviewCopy,
} from "./preparation-copy";
import { resolveGarmentColor } from "@/capabilities/shared/production-treatment";
import { opaquePreparedRevision } from "./prepared-revision";
import { classifyRepairability } from "./repairability";
import {
  buildSeparationMaster,
  CAP_RULE_VERSION_V1,
  computeRegionMap,
  runSeparationPostChecks,
  SNAP_RULE_VERSION_V1,
  type ProposalAuthority,
} from "./region-separation";
import type {
  RegionMap,
  SeparationDecisionSet,
  SeparationReviewView,
  SubmitProposalDecisionRequest,
  SubmitRegionDecisionsRequest,
} from "./region-separation-contracts";
import {
  assessSeparationReviewState,
  buildSeparationReviewView,
  effectiveProposalDecision,
  isDecisionSetStale,
  isReadyForFinalApproval,
  mergeProposalDecision,
  mergeRegionDecisions,
  validateSubmitProposalDecision,
  validateSubmitRegionDecisions,
} from "./separation-review";
import {
  ArtworkUploadRejectedError,
  sanitizeUploadFilename,
  validateUploadBytes,
} from "./upload-limits";

export type { GuidedCleanupTool };

/**
 * Thrown when a request is well-formed but the current preparation state
 * cannot honor it (already approved, not analyzable, wrong project). Distinct
 * from `ArtworkUploadRejectedError`, which is always about the bytes.
 */
export class ArtworkPreparationStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtworkPreparationStateError";
  }
}

export interface UploadArtworkInput {
  bytes: Buffer;
  /** What the browser claimed. Cross-checked against the real signature, never trusted. */
  declaredContentType: string | null;
  /** The customer's filename. Sanitized for display; never used as a storage path. */
  filename: string | null;
}

/**
 * The full, already-phrased state of one preparation. The single shape the
 * service layer and UI consume — neither ever reads raw analysis numbers.
 */
export interface ArtworkPreparationView {
  preparationId: string;
  status: ArtworkPreparation["status"];
  originalFilename: string | null;
  classification: RepairabilityAssessment["classification"];
  customer: ArtworkPreparationCustomerView;
  /** True once a derived, transparent PNG exists to compare against the original. */
  hasPreparedArtwork: boolean;
  /** True once the customer explicitly approved the prepared artwork. */
  approved: boolean;
  /** Source pixel dimensions — the only raw figures the customer ever sees, and only as "your file is this big". */
  widthPx: number;
  heightPx: number;
  /**
   * Existing Artwork → Print Ready Phase 2: the VISIBLE artwork's own
   * dimensions, in source pixels — never the padded canvas. `null` when the
   * analyzer found no artwork bounds at all.
   *
   * Exposed because the print-ready size shown before finalization must be
   * derived from the same thing production sizes from: the artwork's own
   * aspect ratio. Using `widthPx`/`heightPx` would quote a height that
   * includes whatever transparent margin the customer's file happens to
   * carry, and the finished plate would then disagree with the figure they
   * were shown. Still not customer-facing pixel counts — the client passes
   * these to the server-side size describer, never renders them.
   */
  visibleArtworkWidthPx: number | null;
  visibleArtworkHeightPx: number | null;
  /** Production context already recorded for this project. */
  productSummary: string | null;
  productColor: string | null;
  printPlacement: PrintPlacement | null;
  /**
   * Existing Artwork → Print Ready Phase 1.2: how much background the customer
   * has removed by hand, and whether they may still do so. Counts only —
   * never region geometry, never coordinates, never anything the client could
   * turn back into a removal request.
   */
  guidedCleanup: GuidedCleanupStateView;
  /**
   * What to tell the customer about the PREPARED asset before they approve
   * it, derived from evidence `isolateBackground` already recorded. `null`
   * until a prepared asset exists. Advisory: it never blocks approval.
   */
  preparedReview: PreparedArtworkReviewCopy | null;
  /**
   * Phase 1.4: opaque identity of the current prepared derivation. Changes on
   * every confirm/undo (new prepared asset). Unchanged by cleanup_preview.
   * Used only so the browser can reload the prepared image — never a storage
   * key and never accepted back as an input.
   */
  preparedRevision: string | null;
}

export interface GuidedCleanupStateView {
  /** True while cleanup is possible at all: prepared, not yet approved. */
  available: boolean;
  /** How many areas the customer has removed. Drives "Undo" being offered. */
  removalCount: number;
}

/** The result of one guided-cleanup mutation (confirm or undo). */
export interface GuidedCleanupResult {
  outcome: GuidedCleanupOutcomeCode;
  /** Already-phrased. The UI renders this verbatim. */
  message: string;
  view: ArtworkPreparationView;
}

/**
 * Phase 1.3: the result of a non-mutating preview click. When eligible, the
 * browser holds `candidateToken` until the customer confirms; nothing about
 * the preparation has changed yet.
 */
export interface GuidedCleanupPreviewResult {
  outcome: GuidedCleanupOutcomeCode;
  message: string;
  view: ArtworkPreparationView;
  /** Opaque redeemable token. Null when the click was refused. */
  candidateToken: string | null;
  /** Exact-region overlay. Null when the click was refused. */
  highlight: GuidedCleanupHighlight | null;
  /** Phase 1.7: pixel count for Magic Select status copy. */
  selectedPixelCount?: number;
}

export interface GuidedCleanupPreviewInput {
  point: GuidedRemovalPoint;
  /** Defaults to Select Area (`region`). */
  tool?: GuidedCleanupTool;
  /** Magic Select only. Clamped server-side. */
  tolerance?: number;
}

/** The production context an uploaded-artwork customer states. Never a creative brief. */
export interface UploadedArtworkContextInput {
  productSummary?: string | null;
  productColor?: string | null;
  printPlacement?: PrintPlacement | null;
}

export interface ArtworkPreparationCapability {
  /**
   * Ingests one uploaded image: validates the bytes, decodes within safe
   * bounds, persists the IMMUTABLE original, runs deterministic analysis, and
   * records the preparation. Never mutates artwork and never calls a provider.
   */
  uploadOriginal(
    designId: string,
    input: UploadArtworkInput,
  ): Promise<ArtworkPreparationView>;
  /** The project's current preparation, already phrased. `null` for a Create New Artwork project. */
  getPreparation(designId: string): Promise<ArtworkPreparationView | null>;
  /**
   * Records the production context (what we're printing, garment colour,
   * print location) through `DesignBriefCapability`, then re-analyzes — the
   * placement is what makes a print-size statement possible at all, so the
   * verdict must be recomputed once it is known.
   */
  setProductionContext(
    designId: string,
    input: UploadedArtworkContextInput,
  ): Promise<ArtworkPreparationView>;
  /**
   * Runs deterministic background isolation and persists the result as a NEW
   * transparent PNG asset. Refuses when the analyzer did not conclude the
   * artwork is safely preparable. Idempotent: a second call reuses the
   * existing prepared asset rather than producing a second one.
   */
  prepareBackground(designId: string): Promise<ArtworkPreparationView>;
  /**
   * Existing Artwork → Print Ready Phase 1.3: identify what a click would
   * remove, without removing it.
   *
   * Returns an exact-region highlight and a signed candidate token the
   * customer must explicitly confirm. Never writes guided_cleanup, never
   * derives an asset, never creates a version. A click on artwork is refused
   * with customer-safe copy and no confirmation surface.
   */
  previewGuidedCleanup(
    designId: string,
    input: GuidedRemovalPoint | GuidedCleanupPreviewInput,
  ): Promise<GuidedCleanupPreviewResult>;
  /**
   * Existing Artwork → Print Ready Phase 1.3 / 1.7: redeem a preview token and
   * apply the guided-cleanup persistence path (region or magic_color).
   *
   * Revalidates the candidate against the current preparation before any
   * write. Stale, forged, cross-project, or already-removed tokens do not
   * mutate. Idempotent under double-confirm.
   */
  confirmGuidedCleanup(
    designId: string,
    candidateToken: string,
  ): Promise<GuidedCleanupResult>;
  /** Takes back the customer's most recent guided removal. Idempotent when there is none. */
  undoGuidedCleanup(designId: string): Promise<GuidedCleanupResult>;
  /**
   * The customer's explicit "this prepared version faithfully represents the
   * artwork I uploaded". Creates the `prepared_upload` `ArtworkVersion` that
   * Phase 2 will consume. Idempotent.
   */
  approvePreparedArtwork(designId: string): Promise<ArtworkPreparationView>;
  /**
   * Resolves the asset id behind a preparation's original or prepared image,
   * scoped to the owning project. Returns `null` on any miss so callers can
   * render one indistinguishable 404.
   */
  resolveImageAssetId(
    designId: string,
    role: "original" | "prepared",
  ): Promise<string | null>;

  /**
   * Intelligent Separation Phase 9: the current consequential-region review
   * state, recomputed from the immutable original on every call (Goal 3) and
   * merged with whatever decision set is persisted. Never throws for "no
   * consequential regions" — that is `review_not_required`, a normal answer.
   *
   * NOT internally gated — callers (routes) enforce internal-only access, the
   * same pattern the production-treatment preview route already uses. This
   * capability has no concept of "internal" by design (see the module's
   * Dependencies section); adding one here would be a second place that gate
   * could be forgotten.
   */
  getSeparationReview(designId: string): Promise<SeparationReviewView>;
  /**
   * Records an operator's region decisions. Fails closed on any region id,
   * intent, or hash the CURRENT region map does not recognise (Goal 22) —
   * never applies a partial write. Recomputes the master and post-checks
   * immediately so the caller can render a live preview without a second
   * round trip.
   */
  submitRegionDecisions(
    designId: string,
    request: SubmitRegionDecisionsRequest,
  ): Promise<SeparationReviewView>;
  /**
   * Phase 23: records the operator's decision about the unified in-bounds
   * removal proposal — `"pending"`/`"remove_with_exceptions"`/
   * `"preserve_all"` — plus any new preserve taps to add or existing
   * operation ids to remove. Fails closed on any hash mismatch, exactly like
   * `submitRegionDecisions`. The client submits only raw tap coordinates and
   * the chosen decision — never a mask, alpha value, or pixel list; the
   * actual selection is always recomputed here, server-side, from
   * `selectPreserveException`.
   */
  submitProposalDecision(
    designId: string,
    request: SubmitProposalDecisionRequest,
  ): Promise<SeparationReviewView>;
  /**
   * THE FINAL APPROVAL (Goal 18). Requires the decision set to be current
   * and, when an in-bounds proposal exists, that proposal to be explicitly
   * resolved (not `"pending"`) — Phase 22B Issue 2: consequential-region
   * completeness is NOT required, since an undecided isolated region already
   * retains its pixels exactly as an explicit "ink"/"uncertain" decision
   * would. Builds the master deterministically, uploads it as a NEW asset,
   * and repoints `preparedAssetId`/`preparedArtworkVersionId` at it — the
   * exact same fields `approvePreparedArtwork` sets, so
   * `final-artwork-worker` and every downstream consumer need no changes at
   * all (Goal: production routing changed? NO).
   */
  approveSeparationMaster(designId: string): Promise<SeparationReviewView>;

  /**
   * Phase 27E: the graduated Magic Wand correction workspace. A correction
   * session's "base" image is exactly the CURRENT `preparedAssetId` bytes —
   * this never re-runs `computeRegionMap`/`buildSeparationMaster` or any
   * other automatic-removal logic (Phase 27E §2). Sessions live only in
   * server memory (never persisted) until `finalizeCorrection` is called;
   * closing the workspace without finalizing leaves the project's
   * authoritative prepared artwork completely untouched.
   *
   * NOT internally gated here, same as `getSeparationReview` — callers
   * (routes) enforce internal-only access.
   */
  previewCorrectionSelection(designId: string, request: CorrectionSelectionRequest): Promise<CorrectionSelectionResult>;
  /** Persists (in memory only, for this session) the raw click list + mode + tolerance — never a mask. */
  acceptCorrectionOperation(designId: string, request: CorrectionAcceptRequest): Promise<{ operationId: string; algorithmVersion: string }>;
  undoCorrectionOperation(designId: string): Promise<void>;
  /** Resets the session's operations to empty — back to the CURRENT prepared asset, unmodified. Never touches the original. */
  resetCorrectionSession(designId: string): Promise<void>;
  /** Read-only PNG bytes of the immutable original, for the workspace's "compare to original" panel. */
  getCorrectionOriginalPng(designId: string): Promise<Buffer>;
  /** Read-only PNG bytes of the session's current result — the damaged/base image with every accepted operation replayed. Recomputed fresh every call. */
  getCorrectionResultPng(designId: string): Promise<Buffer>;
  /**
   * Read-only: how many operations are currently accepted in this
   * project's correction session. Exists so the workspace UI can seed its
   * "Corrections applied" counter from server truth on mount — the session
   * itself is always correct (see `computeCorrectionResult`); without this,
   * a component that unmounts and remounts (e.g. "Back to Editing") would
   * have no way to know the count without re-deriving it from a diff.
   */
  getCorrectionSessionInfo(designId: string): Promise<{ operationCount: number }>;
  /**
   * "Use This Artwork" — THE authoritative handoff (Phase 27E §7). Replays
   * every accepted operation deterministically from the session's base,
   * uploads the exact resulting pixels as a NEW asset (never overwrites
   * anything), creates a matching new `prepared_upload` `ArtworkVersion`,
   * and repoints `preparedAssetId`/`preparedArtworkVersionId` at it — the
   * same pair `approveSeparationMaster` repoints together, so
   * `final-artwork-worker`'s `primaryAssetId === sourceAsset.id` check
   * keeps passing with no changes anywhere downstream. Clears the session
   * on success. Throws if there is no prepared artwork yet, or no active
   * session (nothing to finalize).
   */
  finalizeCorrection(designId: string): Promise<ArtworkPreparationView>;
}

export interface CorrectionSelectionRequest {
  clicks: Point[];
  mode: CorrectionAction;
  toleranceLevel: ToleranceLevel;
  removeAt?: Point;
}
export interface CorrectionAcceptRequest {
  clicks: Point[];
  mode: CorrectionAction;
  toleranceLevel: ToleranceLevel;
}
export interface CorrectionSelectionResult {
  pixelCount: number;
  bounds: { left: number; top: number; width: number; height: number } | null;
  touchesEdge: boolean;
  broad: boolean;
  overlayPng: Buffer;
  effectiveClicks: Point[];
}

export function createArtworkPreparationCapability(
  repo: ProjectRepository,
  assets: AssetCapability,
  designBrief: DesignBriefCapability,
): ArtworkPreparationCapability {
  /**
   * Every entry point re-reads the project and re-checks that the
   * preparation belongs to it. Ownership is verified against the row, never
   * assumed from the fact that a caller supplied an id.
   */
  async function loadOwned(designId: string): Promise<{
    brief: TShirtDesignBrief;
    preparation: ArtworkPreparation;
  }> {
    const snapshot = await repo.getProject(designId);
    if (!snapshot) throw new ArtworkPreparationStateError("Project not found");

    const preparation = await repo.getArtworkPreparation(designId);
    if (!preparation) {
      throw new ArtworkPreparationStateError(
        "This project has no uploaded artwork to prepare.",
      );
    }
    if (preparation.projectId !== designId) {
      throw new ArtworkPreparationStateError("Artwork preparation not found");
    }

    return { brief: snapshot.brief, preparation };
  }

  async function toView(
    preparation: ArtworkPreparation,
    brief: TShirtDesignBrief,
  ): Promise<ArtworkPreparationView> {
    const analysis = preparation.analysis as unknown as ArtworkAnalysis;
    const assessment = classifyRepairability(analysis);
    const removals = readGuidedOperations(preparation);

    return {
      guidedCleanup: {
        // Cleanup edits the CURRENT derived asset, so it needs one to exist
        // and it stops the moment the customer's approval turns that asset
        // into history.
        available:
          preparation.preparedAssetId !== null && preparation.status !== "approved",
        removalCount: removals.length,
      },
      preparationId: preparation.id,
      status: preparation.status,
      originalFilename: preparation.originalFilename,
      classification: assessment.classification,
      customer: describeArtworkForCustomer(analysis, assessment),
      hasPreparedArtwork: preparation.preparedAssetId !== null,
      preparedReview:
        preparation.preparedAssetId === null
          ? null
          : describePreparedArtworkReview(preparation.preparation, {
              // `analysis` is present on every preparation regardless of age,
              // so this context is always available — even for a record made
              // before `exteriorRemovalEnclosureRatio` existed (Goal 15's
              // fallback: unknown ratio, not "safe by absence").
              sourceEvidence: {
                fullyOpaque: analysis.fullyOpaque,
                hasTransparency: analysis.hasTransparency,
                disconnectedBackgroundColoredPixels:
                  analysis.disconnectedBackgroundColoredPixels,
                backgroundIsEdgeConnected: analysis.backgroundIsEdgeConnected,
                backgroundConfidence: analysis.backgroundConfidence,
                estimatedBackgroundColor: analysis.estimatedBackgroundColor,
              },
              // Garment colour is review INTERPRETATION evidence only — it
              // never reaches background removal itself, which ran earlier
              // and is already fixed in `preparation.preparation`.
              garmentRgb: resolveGarmentColor(brief.shirtColor)?.rgb ?? null,
            }),
      preparedRevision: opaquePreparedRevision(preparation.preparedAssetId),
      approved: preparation.status === "approved",
      widthPx: analysis.widthPx,
      heightPx: analysis.heightPx,
      visibleArtworkWidthPx: analysis.artworkBounds?.width ?? null,
      visibleArtworkHeightPx: analysis.artworkBounds?.height ?? null,
      productSummary: brief.productSummary,
      productColor: brief.shirtColor,
      printPlacement: brief.printPlacement,
    };
  }

  /**
   * Re-runs the analyzer over the ORIGINAL bytes. Cheap, deterministic, and
   * the only correct response to the print placement changing: a verdict that
   * mentions a 10.5" full-front target must not survive the customer moving
   * the print to a sleeve.
   */
  async function reanalyzeOriginal(
    preparation: ArtworkPreparation,
    brief: TShirtDesignBrief,
  ): Promise<ArtworkPreparation> {
    const downloaded = await assets.downloadAssetBytes(preparation.originalAssetId);
    if (!downloaded) {
      throw new ArtworkPreparationStateError(
        "We couldn't find the artwork you uploaded. Please upload it again.",
      );
    }

    const decoded = decodePngUpload(downloaded.bytes);
    const analysis = analyzeArtwork({
      image: decoded.image,
      format: "image/png",
      byteSize: downloaded.bytes.length,
      declaresAlphaChannel: decoded.header.declaresAlphaChannel,
      printPlacement: brief.printPlacement,
      intendedPrintWidthIn: brief.intendedPrintWidthIn,
    });

    return repo.updateArtworkPreparation(preparation.id, {
      analysis: analysis as unknown as Record<string, unknown>,
    });
  }

  /** The immutable original, decoded. Never cached — the bytes are the source of truth. */
  async function loadOriginalImage(preparation: ArtworkPreparation) {
    const downloaded = await assets.downloadAssetBytes(preparation.originalAssetId);
    if (!downloaded) {
      throw new ArtworkPreparationStateError(
        "We couldn't find the artwork you uploaded. Please upload it again.",
      );
    }
    return decodePngUpload(downloaded.bytes).image;
  }

  /**
   * Intelligent Separation Phase 9: the original's bytes AND decoded image —
   * the region map's stable identity is pinned against the byte hash, never
   * the decoded pixels, so it agrees with every prior phase's
   * `sourceAssetSha256`.
   */
  async function loadOriginalImageWithHash(preparation: ArtworkPreparation) {
    const downloaded = await assets.downloadAssetBytes(preparation.originalAssetId);
    if (!downloaded) {
      throw new ArtworkPreparationStateError(
        "We couldn't find the artwork you uploaded. Please upload it again.",
      );
    }
    return {
      image: decodePngUpload(downloaded.bytes).image,
      sha256: createHash("sha256").update(downloaded.bytes).digest("hex"),
    };
  }

  /**
   * Phase 27E: makes sure this project has a correction session whose base
   * image is exactly the CURRENT `preparedAssetId` bytes. Downloads and
   * decodes the original + prepared images ONLY when there is no session
   * yet, or the existing one is based on a `preparedAssetId` that has since
   * changed (e.g. a separation re-approval happened in another tab) — never
   * on every click, and never by recomputing a removal.
   */
  async function ensureCorrectionSession(designId: string): Promise<void> {
    const { preparation } = await loadOwned(designId);
    if (!preparation.preparedAssetId) {
      throw new ArtworkPreparationStateError("No prepared artwork exists yet to correct.");
    }
    if (hasFreshSession(designId, preparation.preparedAssetId)) return;

    const { image: original } = await loadOriginalImageWithHash(preparation);
    const preparedDownload = await assets.downloadAssetBytes(preparation.preparedAssetId);
    if (!preparedDownload) {
      throw new ArtworkPreparationStateError("We couldn't find the prepared artwork to correct. Please try again.");
    }
    const base = decodePngUpload(preparedDownload.bytes).image;
    getOrCreateSession(designId, original, base, preparation.preparedAssetId);
  }

  function validateCorrectionRequest(request: { clicks: Point[]; mode: CorrectionAction; toleranceLevel: ToleranceLevel; removeAt?: Point }): void {
    if (!Array.isArray(request.clicks) || request.clicks.length === 0 || !request.clicks.every(isPoint)) {
      throw new ArtworkPreparationStateError("At least one valid click point is required.");
    }
    if (request.mode !== "restore" && request.mode !== "remove") {
      throw new ArtworkPreparationStateError("mode must be 'restore' or 'remove'.");
    }
    if (!isToleranceLevel(request.toleranceLevel)) {
      throw new ArtworkPreparationStateError("toleranceLevel must be 'less', 'default', or 'more'.");
    }
    if (request.removeAt !== undefined && !isPoint(request.removeAt)) {
      throw new ArtworkPreparationStateError("removeAt must be a valid {x,y} point.");
    }
  }

  function isPoint(value: unknown): value is Point {
    return !!value && typeof value === "object" && typeof (value as Point).x === "number" && typeof (value as Point).y === "number";
  }

  /**
   * Recomputes the current region map from the immutable original and reads
   * back the persisted decision set, if any. Pure composition of
   * `computeRegionMap` (region-separation.ts) — never a second source of
   * region identity.
   */
  function computeSeparationState(preparation: ArtworkPreparation, sourceAssetSha256: string, original: RgbaImage) {
    const analysis = preparation.analysis as unknown as ArtworkAnalysis;
    const computation = computeRegionMap(
      original,
      sourceAssetSha256,
      analysis.estimatedBackgroundColor,
      analysis.backgroundTolerance,
    );
    const decisionSet = preparation.separation
      ? (preparation.separation as unknown as SeparationDecisionSet)
      : null;
    return { computation, decisionSet };
  }

  /**
   * Phase 23: the authority `buildSeparationMaster`/`runSeparationPostChecks`
   * need for the in-bounds proposal — derived the SAME way
   * `buildSeparationReviewView` derives what it shows the operator, so the
   * live preview and the persisted authority can never silently disagree.
   * Fail-closed by construction: `effectiveProposalDecision` already resets
   * to `"pending"` (retain everything) on any staleness, and a stale
   * decision set's `proposalPreserveOps` are never read here at all.
   */
  function proposalAuthorityFor(
    regionMap: RegionMap,
    decisionSet: SeparationDecisionSet | null,
  ): ProposalAuthority {
    const decision = effectiveProposalDecision(regionMap, decisionSet) ?? "pending";
    const preserveOperations =
      decisionSet && decisionSet.proposalHash === (regionMap.inBoundsProposal?.proposalHash ?? null)
        ? decisionSet.proposalPreserveOps
        : [];
    return { decision, preserveOperations };
  }

  /**
   * Runs the deterministic pipeline over the IMMUTABLE original and persists
   * the result as a NEW asset.
   *
   * The single derivation path: automatic preparation calls it with no ops,
   * guided cleanup calls it with the customer's whole operation history. That
   * is what makes reload safe — the prepared asset is always a pure function
   * of (original bytes, background model, ordered ops), never of how many
   * times anything ran.
   *
   * A NEW asset every time, never an overwrite: the original is immutable by
   * contract, and a superseded prepared asset stays in place so lineage
   * remains readable.
   */
  async function derivePreparedAsset(
    designId: string,
    preparation: ArtworkPreparation,
    analysis: ArtworkAnalysis,
    assessment: RepairabilityAssessment,
    operations: readonly GuidedCleanupOperation[],
  ) {
    const image = await loadOriginalImage(preparation);
    const derived = derivePreparedFromOperations({
      image,
      backgroundColor: analysis.estimatedBackgroundColor,
      tolerance: analysis.backgroundTolerance,
      alreadyTransparent:
        assessment.backgroundTreatment === "already_transparent",
      operations,
    });

    assertPreservesGeometry(image, derived.image);

    // Intelligent Separation Phase 2: the stronger topological evidence,
    // measured between the immutable original and THIS prepared result and
    // folded into the same record every other preparation diagnostic already
    // lives in — no second evidence object, no migration. Computed here,
    // once, so both call sites (`prepareBackground` and guided cleanup's
    // apply/undo) record it identically rather than each deciding for
    // itself whether to.
    const enclosure = measureExteriorRemovalEnclosure(image, derived.image);
    const derivedWithEvidence = {
      ...derived,
      record: {
        ...derived.record,
        exteriorRemovalEnclosureRatio: enclosure.exteriorRemovalEnclosureRatio,
      },
    };

    // Derived prepared assets are IMMUTABLE. Each persisted derivation needs
    // a unique storage object identity — never `…-${applied.length}` alone.
    // Supabase Storage uses upsert:false; a deterministic key collides with
    // orphans/history and blocks confirm/undo. Application-level idempotency
    // (candidate token + guided_cleanup op list) prevents duplicate
    // successful mutations; storage-path collision must never be that gate.
    //
    // Ordering: upload bytes → create AssetRecord → repoint preparation.
    // If the DB update fails after upload, an orphan object may remain; the
    // next retry uses a fresh UUID and existing DB state stays authoritative.
    const asset = await assets.uploadCustomerArtwork(designId, {
      conceptId: `prepared-${preparation.id}-${randomUUID()}`,
      bytes: encodeRgbaToPng(derived.image),
      contentType: "image/png",
      widthPx: derived.image.width,
      heightPx: derived.image.height,
      hasTransparency: true,
      kind: "png",
      metadata: {
        // Lineage lives on the preparation row; this mirror exists purely so
        // an asset can be traced back without a join. The op list is
        // included because it is the other half of "what produced these
        // bytes" — the original alone no longer explains them.
        derivedFromAssetId: preparation.originalAssetId,
        artworkPreparationId: preparation.id,
        preparation: derivedWithEvidence.record as unknown as Record<string, unknown>,
        guidedRemovals: derived.applied as unknown as Record<string, unknown>[],
      },
    });

    return { asset, derived: derivedWithEvidence };
  }

  /**
   * Working prepared RGBA for the current op list — used by Magic Select
   * preview/confirm so selection matches what the customer sees.
   */
  async function loadWorkingPreparedImage(
    preparation: ArtworkPreparation,
    operations: readonly GuidedCleanupOperation[],
  ) {
    const analysis = preparation.analysis as unknown as ArtworkAnalysis;
    const assessment = classifyRepairability(analysis);
    const image = await loadOriginalImage(preparation);
    return derivePreparedFromOperations({
      image,
      backgroundColor: analysis.estimatedBackgroundColor,
      tolerance: analysis.backgroundTolerance,
      alreadyTransparent:
        assessment.backgroundTreatment === "already_transparent",
      operations,
    }).image;
  }

  /**
   * Re-derives the prepared asset from the customer's whole op history and
   * persists both. Shared by apply and undo so there is exactly one way the
   * prepared bytes and the stored op list can change, and they cannot get
   * out of step.
   */
  async function persistGuidedCleanup(
    designId: string,
    preparation: ArtworkPreparation,
    brief: TShirtDesignBrief,
    operations: GuidedCleanupOperation[],
    outcome: GuidedCleanupOutcomeCode,
  ): Promise<GuidedCleanupResult> {
    const analysis = preparation.analysis as unknown as ArtworkAnalysis;
    const assessment = classifyRepairability(analysis);

    const { asset, derived } = await derivePreparedAsset(
      designId,
      preparation,
      analysis,
      assessment,
      operations,
    );

    const updated = await repo.updateArtworkPreparation(preparation.id, {
      preparedAssetId: asset.id,
      preparation: derived.record as unknown as Record<string, unknown>,
      // Stored as what the pipeline ACCEPTED, not as what the client sent —
      // a point that stopped resolving would otherwise linger forever.
      guidedCleanup:
        derived.applied.length === 0
          ? null
          : ({ removals: derived.applied } as unknown as Record<
              string,
              unknown
            >),
    });

    return {
      outcome,
      message: describeGuidedCleanupOutcome(outcome),
      view: await toView(updated, brief),
    };
  }

  /**
   * Guided cleanup is only meaningful between "prepared" and "approved".
   * Before, there is no derived asset to correct; after, the asset is the
   * thing the customer approved and Phase 2 may already be consuming.
   */
  async function requireCleanupTarget(designId: string) {
    const { brief, preparation } = await loadOwned(designId);

    if (preparation.status === "approved") {
      throw new ArtworkPreparationStateError(
        "You've already approved this artwork. Start a new project to make further changes.",
      );
    }
    if (!preparation.preparedAssetId) {
      throw new ArtworkPreparationStateError(
        "There's nothing to clean up yet — prepare the artwork first.",
      );
    }

    return { brief, preparation, removals: readGuidedOperations(preparation) };
  }

  return {
    async uploadOriginal(designId, input) {
      const snapshot = await repo.getProject(designId);
      if (!snapshot) throw new ArtworkPreparationStateError("Project not found");

      const existing = await repo.getArtworkPreparation(designId);
      if (existing && existing.status === "approved") {
        throw new ArtworkPreparationStateError(
          "You've already approved artwork for this project. Start a new project to work from a different file.",
        );
      }

      const validated = validateUploadBytes(input.bytes, input.declaredContentType);
      // Header bounds are checked inside `decodePngUpload` BEFORE any bitmap
      // is allocated — see `image-decode.ts`.
      const decoded = decodePngUpload(validated.bytes);

      const analysis = analyzeArtwork({
        image: decoded.image,
        format: validated.format,
        byteSize: validated.byteSize,
        declaresAlphaChannel: decoded.header.declaresAlphaChannel,
        printPlacement: snapshot.brief.printPlacement,
        intendedPrintWidthIn: snapshot.brief.intendedPrintWidthIn,
      });

      const originalFilename = sanitizeUploadFilename(input.filename);

      const uploaded = await assets.uploadCustomerArtwork(designId, {
        // A storage-grouping id, never a customer-supplied name (the
        // sanitized filename is display metadata only).
        conceptId: `upload-${Date.now().toString(36)}-${randomSuffix()}`,
        bytes: validated.bytes,
        contentType: validated.format,
        widthPx: analysis.widthPx,
        heightPx: analysis.heightPx,
        hasTransparency: analysis.hasTransparency,
        kind: "customer_upload",
        metadata: {
          originalFilename,
          declaredContentType: input.declaredContentType,
          byteSize: validated.byteSize,
        },
      });

      const preparation = await repo.createArtworkPreparation(designId, {
        originalAssetId: uploaded.id,
        originalFilename,
        analysis: analysis as unknown as Record<string, unknown>,
      });

      return toView(preparation, snapshot.brief);
    },

    async getPreparation(designId) {
      const snapshot = await repo.getProject(designId);
      if (!snapshot) return null;

      const preparation = await repo.getArtworkPreparation(designId);
      if (!preparation || preparation.projectId !== designId) return null;

      return toView(preparation, snapshot.brief);
    },

    async setProductionContext(designId, input) {
      const { preparation } = await loadOwned(designId);

      const brief = await designBrief.setUploadedArtworkContext(designId, {
        productSummary: input.productSummary,
        shirtColor: input.productColor,
        printPlacement: input.printPlacement,
      });

      const reanalyzed = await reanalyzeOriginal(preparation, brief);
      return toView(reanalyzed, brief);
    },

    async prepareBackground(designId) {
      const { brief, preparation } = await loadOwned(designId);

      if (preparation.status === "approved") {
        return toView(preparation, brief);
      }
      // Idempotent: the prepared asset already exists, so re-running the
      // transform could only produce a second copy of the same bytes.
      if (preparation.preparedAssetId) {
        return toView(preparation, brief);
      }

      const analysis = preparation.analysis as unknown as ArtworkAnalysis;
      const assessment = classifyRepairability(analysis);
      if (!assessment.canPrepareAutomatically) {
        throw new ArtworkPreparationStateError(
          "We can't prepare this artwork automatically. A designer needs to look at it first.",
        );
      }

      // No ops: automatic preparation is exactly this pipeline with an empty
      // operation list, which is why guided cleanup cannot change what an
      // untouched preparation produces.
      const { asset, derived } = await derivePreparedAsset(
        designId,
        preparation,
        analysis,
        assessment,
        [],
      );

      const updated = await repo.updateArtworkPreparation(preparation.id, {
        status: "prepared",
        preparedAssetId: asset.id,
        preparation: derived.record as unknown as Record<string, unknown>,
      });

      return toView(updated, brief);
    },

    async previewGuidedCleanup(designId, input) {
      const previewInput = normalizeGuidedCleanupPreviewInput(input);
      const tool: GuidedCleanupTool = previewInput.tool ?? "region";
      const point = previewInput.point;
      const { brief, preparation, removals } = await requireCleanupTarget(designId);
      const view = await toView(preparation, brief);

      if (tool === "magic_select") {
        const tolerance = clampMagicSelectTolerance(
          previewInput.tolerance ?? MAGIC_SELECT_DEFAULT_TOLERANCE,
        );
        const working = await loadWorkingPreparedImage(preparation, removals);
        const selected = selectMagicColor(working, point, tolerance);

        if (selected.outcome !== "eligible" || !selected.selection) {
          const refused =
            selected.outcome === "outside_image"
              ? "outside_image"
              : "already_removed";
          return {
            outcome: refused,
            message: describeGuidedCleanupOutcome(refused),
            view,
            candidateToken: null,
            highlight: null,
          };
        }

        const selection = selected.selection;
        if (
          removals.some(
            (op) =>
              isMagicColorOperation(op) && op.selectionKey === selection.selectionKey,
          )
        ) {
          return {
            outcome: "already_removed",
            message: describeGuidedCleanupOutcome("already_removed"),
            view,
            candidateToken: null,
            highlight: null,
          };
        }

        const candidateToken = mintMagicSelectCandidateToken({
          projectId: designId,
          preparationId: preparation.id,
          preparedAssetId: preparation.preparedAssetId!,
          point: selection.point,
          tolerance: selection.tolerance,
          selectionMode: selection.selectionMode,
          ruleVersion: selection.ruleVersion,
          referenceColor: selection.referenceColor,
          selectionKey: selection.selectionKey,
          pixelCount: selection.pixelCount,
          removalCount: removals.length,
        });

        return {
          outcome: "preview",
          message: describeGuidedCleanupOutcome("preview", {
            tool: "magic_select",
            selectedPixelCount: selection.pixelCount,
          }),
          view,
          candidateToken,
          highlight: buildSelectionHighlight(
            selection.mask,
            working.width,
            working.height,
            selection.bounds,
            "solid",
          ),
          selectedPixelCount: selection.pixelCount,
        };
      }

      const analysis = preparation.analysis as unknown as ArtworkAnalysis;
      const image = await loadOriginalImage(preparation);
      const preview = previewGuidedRemovalAt(image, point, {
        backgroundColor: analysis.estimatedBackgroundColor,
        tolerance: analysis.backgroundTolerance,
        applied: regionOperations(removals),
      });

      if (preview.resolution.outcome !== "eligible" || !preview.resolution.region) {
        return {
          outcome: preview.resolution.outcome,
          message: describeGuidedCleanupOutcome(preview.resolution.outcome),
          view,
          candidateToken: null,
          highlight: null,
        };
      }

      const region = preview.resolution.region;
      const candidateToken = mintGuidedCleanupCandidateToken({
        projectId: designId,
        preparationId: preparation.id,
        preparedAssetId: preparation.preparedAssetId!,
        regionKey: region.regionKey,
        point: { x: Math.floor(point.x), y: Math.floor(point.y) },
        pixelCount: region.pixelCount,
        removalCount: removals.length,
      });

      return {
        outcome: "preview",
        message: describeGuidedCleanupOutcome("preview", { tool: "region" }),
        view,
        candidateToken,
        highlight: preview.highlight,
        selectedPixelCount: region.pixelCount,
      };
    },

    async confirmGuidedCleanup(designId, candidateToken) {
      const claims = verifyGuidedCleanupCandidateToken(candidateToken);
      if (!claims || claims.projectId !== designId) {
        const { brief, preparation } = await requireCleanupTarget(designId);
        return {
          outcome: "stale_preview",
          message: describeGuidedCleanupOutcome("stale_preview"),
          view: await toView(preparation, brief),
        };
      }

      const { brief, preparation, removals } = await requireCleanupTarget(designId);

      if (isMagicSelectCandidateClaims(claims)) {
        if (
          removals.some(
            (op) =>
              isMagicColorOperation(op) && op.selectionKey === claims.selectionKey,
          )
        ) {
          return {
            outcome: "already_removed",
            message: describeGuidedCleanupOutcome("already_removed"),
            view: await toView(preparation, brief),
          };
        }

        if (
          preparation.id !== claims.preparationId ||
          preparation.preparedAssetId !== claims.preparedAssetId ||
          removals.length !== claims.removalCount
        ) {
          return {
            outcome: "stale_preview",
            message: describeGuidedCleanupOutcome("stale_preview"),
            view: await toView(preparation, brief),
          };
        }

        const working = await loadWorkingPreparedImage(preparation, removals);
        const selected =
          claims.v === 3
            ? selectMagicColorByMode(
                working,
                claims.point,
                claims.tolerance,
                claims.selectionMode,
              )
            : selectConnectedMagicColor(working, claims.point, claims.tolerance);

        if (
          selected.outcome !== "eligible" ||
          !selected.selection ||
          selected.selection.selectionKey !== claims.selectionKey ||
          selected.selection.pixelCount !== claims.pixelCount ||
          selected.selection.tolerance !== claims.tolerance ||
          selected.selection.referenceColor.r !== claims.referenceColor.r ||
          selected.selection.referenceColor.g !== claims.referenceColor.g ||
          selected.selection.referenceColor.b !== claims.referenceColor.b ||
          (claims.v === 3 &&
            (selected.selection.selectionMode !== claims.selectionMode ||
              selected.selection.ruleVersion !== claims.ruleVersion))
        ) {
          return {
            outcome:
              selected.outcome === "already_removed"
                ? "already_removed"
                : "stale_preview",
            message: describeGuidedCleanupOutcome(
              selected.outcome === "already_removed"
                ? "already_removed"
                : "stale_preview",
            ),
            view: await toView(preparation, brief),
          };
        }

        return persistGuidedCleanup(
          designId,
          preparation,
          brief,
          [
            ...removals,
            {
              kind: "magic_color",
              point: selected.selection.point,
              tolerance: selected.selection.tolerance,
              selectionMode: selected.selection.selectionMode,
              ruleVersion: selected.selection.ruleVersion,
              connectedOnly: selected.selection.connectedOnly,
              referenceColor: selected.selection.referenceColor,
              selectionKey: selected.selection.selectionKey,
              pixelCount: selected.selection.pixelCount,
            },
          ],
          "removed",
        );
      }

      // Idempotent re-confirm: the region is already recorded under this
      // preparation. Prefer this over stale when the prepared asset advanced
      // because THIS confirm already succeeded.
      if (
        removals.some(
          (record) =>
            !isMagicColorOperation(record) &&
            record.regionKey === claims.regionKey,
        )
      ) {
        return {
          outcome: "already_removed",
          message: describeGuidedCleanupOutcome("already_removed"),
          view: await toView(preparation, brief),
        };
      }

      if (
        preparation.id !== claims.preparationId ||
        preparation.preparedAssetId !== claims.preparedAssetId ||
        removals.length !== claims.removalCount
      ) {
        return {
          outcome: "stale_preview",
          message: describeGuidedCleanupOutcome("stale_preview"),
          view: await toView(preparation, brief),
        };
      }

      const analysis = preparation.analysis as unknown as ArtworkAnalysis;
      const image = await loadOriginalImage(preparation);
      const resolution = revalidateGuidedRemovalCandidate(image, {
        backgroundColor: analysis.estimatedBackgroundColor,
        tolerance: analysis.backgroundTolerance,
        applied: regionOperations(removals),
        regionKey: claims.regionKey,
        point: claims.point,
      });

      if (resolution.outcome !== "eligible" || !resolution.region) {
        return {
          outcome:
            resolution.outcome === "already_removed"
              ? "already_removed"
              : "stale_preview",
          message: describeGuidedCleanupOutcome(
            resolution.outcome === "already_removed"
              ? "already_removed"
              : "stale_preview",
          ),
          view: await toView(preparation, brief),
        };
      }

      return persistGuidedCleanup(
        designId,
        preparation,
        brief,
        [
          ...removals,
          {
            kind: "region",
            point: claims.point,
            regionKey: resolution.region.regionKey,
            pixelCount: resolution.region.pixelCount,
          },
        ],
        "removed",
      );
    },

    async undoGuidedCleanup(designId) {
      const { brief, preparation, removals } = await requireCleanupTarget(designId);

      if (removals.length === 0) {
        return {
          outcome: "nothing_to_undo",
          message: describeGuidedCleanupOutcome("nothing_to_undo"),
          view: await toView(preparation, brief),
        };
      }

      return persistGuidedCleanup(
        designId,
        preparation,
        brief,
        removals.slice(0, -1),
        "undone",
      );
    },

    async approvePreparedArtwork(designId) {
      const snapshot = await repo.getProject(designId);
      if (!snapshot) throw new ArtworkPreparationStateError("Project not found");

      const { brief, preparation } = await loadOwned(designId);

      if (preparation.status === "approved") return toView(preparation, brief);

      if (!preparation.preparedAssetId) {
        throw new ArtworkPreparationStateError(
          "There's nothing to approve yet — prepare the artwork first.",
        );
      }

      // Intelligent Separation Phase 10: this path approves `preparedAssetId`
      // as-is — the deterministic background-removal output, with no operator
      // confirmation of consequential regions. When this artwork's region map
      // has consequential regions needing a decision, that is exactly the
      // bowling-logo failure mode (legitimate black artwork touching a black
      // background, silently dropped) this feature exists to prevent, so this
      // path must not be reachable. The gate is here, not just in the UI,
      // because a hidden button is not a security boundary — see
      // `approveSeparationMaster`, the only approval route once review is
      // required.
      const { image: original, sha256 } = await loadOriginalImageWithHash(preparation);
      const { computation, decisionSet } = computeSeparationState(preparation, sha256, original);
      if (assessSeparationReviewState(computation.regionMap, decisionSet) !== "review_not_required") {
        throw new ArtworkPreparationStateError(
          "This artwork has areas that need your confirmation before it can be used. Please complete the separation review above.",
        );
      }

      const nextVersionNumber =
        snapshot.artworkVersions.reduce(
          (highest, version) => Math.max(highest, version.versionNumber),
          0,
        ) + 1;

      const [artworkVersion] = await repo.addArtworkVersions(designId, [
        {
          versionNumber: nextVersionNumber,
          // Never "concept": this is the customer's own artwork.
          kind: "prepared_upload",
          title: "Your artwork, prepared",
          summary:
            "Your uploaded artwork with its background removed. Nothing about the design itself was changed.",
          placeholderLabel: "Your artwork",
          accentColor: "#173F35",
          // No approved Design Brief version authorizes uploaded artwork —
          // the customer's own file does. Left null rather than pointing at
          // an unrelated approval.
          designBriefVersionId: null,
          // No generation job and no provider produced these pixels.
          generationJobId: null,
          providerKey: null,
          primaryAssetId: preparation.preparedAssetId,
          thumbnailAssetId: null,
          // `sourceArtworkVersionId` means "a targeted revision of that
          // artwork version". The source here is an ASSET, not an artwork
          // version, so it stays null and lineage lives on the preparation
          // row where it is true.
          sourceArtworkVersionId: null,
          conceptDirectionKey: null,
        },
      ]);

      const updated = await repo.updateArtworkPreparation(preparation.id, {
        status: "approved",
        preparedArtworkVersionId: artworkVersion!.id,
        approvedAt: new Date().toISOString(),
      });

      // Existing Artwork → Print Ready Phase 2 (Goal 10): the project stops
      // being "intake". An upload customer was never in a design interview,
      // and leaving the project sitting in the status a brand-new,
      // nothing-said-yet project has would misdescribe someone who has
      // uploaded artwork, stated their production context, and explicitly
      // approved a prepared file.
      //
      // `"approved"` is the existing status that already means exactly this in
      // the other workflow: the customer's creative decision is settled and
      // production is the next step (see `submitDesignBriefDecision`, which
      // sets it at the equivalent moment). Reusing it keeps the two workflows
      // describable by one lifecycle rather than adding a speculative
      // `"artwork_approved"` value whose only difference would be its name.
      //
      // Deliberately NOT `"finalizing"`: nothing has been requested yet.
      await repo.setProjectStatus(designId, "approved");

      return toView(updated, brief);
    },

    async getSeparationReview(designId) {
      const { preparation } = await loadOwned(designId);
      const { image: original, sha256 } = await loadOriginalImageWithHash(preparation);
      const { computation, decisionSet } = computeSeparationState(preparation, sha256, original);
      const proposalAuthority = proposalAuthorityFor(computation.regionMap, decisionSet);
      const postCheck = decisionSet
        ? runSeparationPostChecks(
            original,
            buildSeparationMaster(original, computation, decisionSet.decisions, proposalAuthority),
            computation,
            decisionSet.decisions,
            proposalAuthority,
          )
        : null;
      const isProductionAuthoritative =
        Boolean(decisionSet?.approvedAt) &&
        decisionSet?.approvedAssetId !== null &&
        decisionSet?.approvedAssetId === preparation.preparedAssetId;
      return buildSeparationReviewView(computation.regionMap, decisionSet, postCheck, isProductionAuthoritative);
    },

    async submitRegionDecisions(designId, request) {
      const { preparation } = await loadOwned(designId);
      const { image: original, sha256 } = await loadOriginalImageWithHash(preparation);
      const { computation, decisionSet: existing } = computeSeparationState(preparation, sha256, original);

      const validity = validateSubmitRegionDecisions(computation.regionMap, request);
      if (!validity.ok) {
        throw new ArtworkPreparationStateError(validity.reason);
      }

      const merged = mergeRegionDecisions(computation.regionMap, existing, request, new Date().toISOString());
      await repo.updateArtworkPreparation(preparation.id, {
        separation: merged as unknown as Record<string, unknown>,
      });

      const proposalAuthority = proposalAuthorityFor(computation.regionMap, merged);
      const master = buildSeparationMaster(original, computation, merged.decisions, proposalAuthority);
      const postCheck = runSeparationPostChecks(original, master, computation, merged.decisions, proposalAuthority);
      return buildSeparationReviewView(computation.regionMap, merged, postCheck, false);
    },

    async submitProposalDecision(designId, request) {
      const { preparation } = await loadOwned(designId);
      const { image: original, sha256 } = await loadOriginalImageWithHash(preparation);
      const { computation, decisionSet: existing } = computeSeparationState(preparation, sha256, original);

      const validity = validateSubmitProposalDecision(computation.regionMap, request);
      if (!validity.ok) {
        throw new ArtworkPreparationStateError(validity.reason);
      }

      const addTapCount = request.addPreserveTaps?.length ?? 0;
      const newOperationIds = Array.from({ length: addTapCount }, () => randomUUID());
      const merged = mergeProposalDecision(
        computation.regionMap,
        existing,
        request,
        new Date().toISOString(),
        newOperationIds,
        CAP_RULE_VERSION_V1,
        SNAP_RULE_VERSION_V1,
      );
      await repo.updateArtworkPreparation(preparation.id, {
        separation: merged as unknown as Record<string, unknown>,
      });

      const proposalAuthority = proposalAuthorityFor(computation.regionMap, merged);
      const master = buildSeparationMaster(original, computation, merged.decisions, proposalAuthority);
      const postCheck = runSeparationPostChecks(original, master, computation, merged.decisions, proposalAuthority);
      return buildSeparationReviewView(computation.regionMap, merged, postCheck, false);
    },

    async approveSeparationMaster(designId) {
      const snapshot = await repo.getProject(designId);
      if (!snapshot) throw new ArtworkPreparationStateError("Project not found");
      const { preparation } = await loadOwned(designId);
      const { image: original, sha256 } = await loadOriginalImageWithHash(preparation);
      const { computation, decisionSet } = computeSeparationState(preparation, sha256, original);

      if (isDecisionSetStale(computation.regionMap, decisionSet)) {
        throw new ArtworkPreparationStateError(
          "This artwork's separation review is out of date. Reload before approving.",
        );
      }
      if (!isReadyForFinalApproval(computation.regionMap, decisionSet)) {
        throw new ArtworkPreparationStateError(
          computation.regionMap.inBoundsProposal
            ? "Decide what to do with the highlighted removal before this preparation can be used."
            : "Every highlighted area needs a decision before this preparation can be used.",
        );
      }

      const proposalAuthority = proposalAuthorityFor(computation.regionMap, decisionSet);
      const master = buildSeparationMaster(original, computation, decisionSet!.decisions, proposalAuthority);
      const postCheck = runSeparationPostChecks(original, master, computation, decisionSet!.decisions, proposalAuthority);
      if (!postCheck.passed) {
        // Unreachable by construction of `buildSeparationMaster` — verified,
        // never assumed. If it ever fires, refuse rather than silently
        // producing a plate that fails its own pixel-authority guarantee.
        throw new ArtworkPreparationStateError(
          "This preparation could not be safely completed. Please try again or contact support.",
        );
      }

      const asset = await assets.uploadCustomerArtwork(designId, {
        conceptId: `separation-${preparation.id}-${randomUUID()}`,
        bytes: encodeRgbaToPng(master),
        contentType: "image/png",
        widthPx: master.width,
        heightPx: master.height,
        hasTransparency: true,
        kind: "png",
        metadata: {
          // Goal 19 lineage: immutable original -> silhouette algorithm ->
          // region map hash -> operator decisions -> deterministic master.
          derivedFromAssetId: preparation.originalAssetId,
          artworkPreparationId: preparation.id,
          separationLineage: {
            algorithmVersion: computation.regionMap.algorithmVersion,
            regionMapHash: computation.regionMap.regionMapHash,
            silhouetteRadius: computation.regionMap.silhouetteRadius,
            decisions: decisionSet!.decisions,
          },
        },
      });

      const nextVersionNumber =
        snapshot.artworkVersions.reduce((highest, v) => Math.max(highest, v.versionNumber), 0) + 1;
      const [artworkVersion] = await repo.addArtworkVersions(designId, [
        {
          versionNumber: nextVersionNumber,
          kind: "prepared_upload",
          title: "Your artwork, prepared",
          summary:
            "Your uploaded artwork, prepared with operator-confirmed garment-independent separation.",
          placeholderLabel: "Your artwork",
          accentColor: "#173F35",
          designBriefVersionId: null,
          generationJobId: null,
          providerKey: null,
          primaryAssetId: asset.id,
          thumbnailAssetId: null,
          sourceArtworkVersionId: null,
          conceptDirectionKey: null,
        },
      ]);

      const approvedAt = new Date().toISOString();
      const finalDecisionSet = {
        ...decisionSet!,
        approvedAt,
        approvedAssetId: asset.id,
        postCheckAtApproval: postCheck,
      };
      await repo.updateArtworkPreparation(preparation.id, {
        status: "approved",
        preparedAssetId: asset.id,
        preparedArtworkVersionId: artworkVersion!.id,
        approvedAt,
        separation: finalDecisionSet as unknown as Record<string, unknown>,
      });
      await repo.setProjectStatus(designId, "approved");

      return buildSeparationReviewView(computation.regionMap, finalDecisionSet, postCheck, true);
    },

    // --- Phase 27E: graduated Magic Wand correction workspace -------------

    async previewCorrectionSelection(designId, request) {
      validateCorrectionRequest(request);
      await ensureCorrectionSession(designId);
      const result = computeCorrectionSelectionPreview(designId, request.clicks, request.mode, request.toleranceLevel, request.removeAt);
      return {
        pixelCount: result.selection.pixelCount,
        bounds: result.selection.bounds,
        touchesEdge: result.selection.touchesEdge,
        broad: result.selection.broad,
        overlayPng: encodeRgbaToPng(result.overlay),
        effectiveClicks: result.effectiveClicks,
      };
    },

    async acceptCorrectionOperation(designId, request) {
      validateCorrectionRequest(request);
      await ensureCorrectionSession(designId);
      const op: CorrectionOperationRecord = acceptSessionOperation(designId, request.clicks, request.mode, request.toleranceLevel);
      return { operationId: op.operationId, algorithmVersion: op.algorithmVersion };
    },

    async undoCorrectionOperation(designId) {
      await ensureCorrectionSession(designId);
      undoLastSessionOperation(designId);
    },

    async resetCorrectionSession(designId) {
      await ensureCorrectionSession(designId);
      resetSessionOperations(designId);
    },

    async getCorrectionOriginalPng(designId) {
      const { preparation } = await loadOwned(designId);
      const { image } = await loadOriginalImageWithHash(preparation);
      return encodeRgbaToPng(image);
    },

    async getCorrectionResultPng(designId) {
      await ensureCorrectionSession(designId);
      return encodeRgbaToPng(computeCorrectionResult(designId));
    },

    async getCorrectionSessionInfo(designId) {
      await ensureCorrectionSession(designId);
      const session = getCorrectionSession(designId);
      return { operationCount: session?.operations.length ?? 0 };
    },

    async finalizeCorrection(designId) {
      const snapshot = await repo.getProject(designId);
      if (!snapshot) throw new ArtworkPreparationStateError("Project not found");
      const { brief, preparation } = await loadOwned(designId);
      await ensureCorrectionSession(designId);
      const session = getCorrectionSession(designId);
      if (!session) {
        throw new ArtworkPreparationStateError("No active correction session to use.");
      }

      // Deterministic replay from the session's base + immutable original —
      // NEVER a second automatic removal (Phase 27E §2). Byte-exact: this is
      // the SAME function `getCorrectionResultPng`/the workspace preview
      // already called, so what was reviewed is exactly what gets persisted.
      const corrected = computeCorrectionResult(designId);

      const asset = await assets.uploadCustomerArtwork(designId, {
        conceptId: `correction-${preparation.id}-${randomUUID()}`,
        bytes: encodeRgbaToPng(corrected),
        contentType: "image/png",
        widthPx: corrected.width,
        heightPx: corrected.height,
        hasTransparency: true,
        kind: "png",
        metadata: {
          // Lineage mirrors `separationLineage` in `approveSeparationMaster`
          // — raw operator intent only, never a mask (Phase 27E §9).
          derivedFromAssetId: preparation.originalAssetId,
          artworkPreparationId: preparation.id,
          correctionLineage: {
            algorithmVersion: MAGIC_WAND_ALGORITHM_VERSION,
            baseAssetId: session.baseAssetId,
            operations: session.operations,
          },
        },
      });

      const nextVersionNumber = snapshot.artworkVersions.reduce((highest, v) => Math.max(highest, v.versionNumber), 0) + 1;
      const [artworkVersion] = await repo.addArtworkVersions(designId, [
        {
          versionNumber: nextVersionNumber,
          kind: "prepared_upload",
          title: "Your artwork, manually corrected",
          summary: "Your prepared artwork with operator-applied background corrections.",
          placeholderLabel: "Your artwork",
          accentColor: "#173F35",
          designBriefVersionId: null,
          generationJobId: null,
          providerKey: null,
          primaryAssetId: asset.id,
          thumbnailAssetId: null,
          sourceArtworkVersionId: null,
          conceptDirectionKey: null,
        },
      ]);

      const approvedAt = new Date().toISOString();
      await repo.updateArtworkPreparation(preparation.id, {
        status: "approved",
        preparedAssetId: asset.id,
        preparedArtworkVersionId: artworkVersion!.id,
        approvedAt,
      });
      await repo.setProjectStatus(designId, "approved");
      clearCorrectionSession(designId);

      const updated = await repo.getArtworkPreparation(designId);
      if (!updated) throw new ArtworkPreparationStateError("Artwork preparation not found");
      return toView(updated, brief);
    },

    async resolveImageAssetId(designId, role) {
      const preparation = await repo.getArtworkPreparation(designId);
      if (!preparation || preparation.projectId !== designId) return null;

      const assetId =
        role === "original" ? preparation.originalAssetId : preparation.preparedAssetId;
      if (!assetId) return null;

      // Second, independent ownership check: the asset row itself must belong
      // to this project. A preparation row pointing at a foreign asset is a
      // bug, but it must never become a cross-project read.
      const projectAssets = await assets.listAssets(designId);
      return projectAssets.some((asset) => asset.id === assetId) ? assetId : null;
    },
  };
}

/**
 * Aspect ratio and dimensions are preserved BY CONSTRUCTION here (isolation
 * only rewrites channels in place), so this is a cheap assertion that the
 * construction still holds rather than a transformation step. A geometry
 * change would mean the customer's artwork had been reframed, which this
 * capability is never allowed to do.
 */
function assertPreservesGeometry(
  source: { width: number; height: number },
  prepared: { width: number; height: number },
): void {
  if (source.width !== prepared.width || source.height !== prepared.height) {
    throw new ArtworkPreparationStateError(
      "Artwork preparation must never change the size or shape of the uploaded artwork.",
    );
  }
}

/**
 * Narrows the loosely-typed `guidedCleanup` column back into operations.
 *
 * Total and forgiving by design: anything malformed reads as "no cleanup"
 * rather than throwing, because a corrupt diagnostics blob must never make a
 * customer's artwork unopenable. Nothing here is trusted anyway — a stored
 * op is re-resolved against the real image on every derivation, so a bogus
 * coordinate simply resolves to nothing and drops out.
 */
function readGuidedOperations(
  preparation: ArtworkPreparation,
): GuidedCleanupOperation[] {
  return parseGuidedCleanupOperations(preparation.guidedCleanup);
}

function normalizeGuidedCleanupPreviewInput(
  input: GuidedRemovalPoint | GuidedCleanupPreviewInput,
): GuidedCleanupPreviewInput {
  if (
    input &&
    typeof input === "object" &&
    "point" in input &&
    input.point &&
    typeof input.point === "object" &&
    Number.isFinite((input.point as GuidedRemovalPoint).x)
  ) {
    return input;
  }
  return { point: input as GuidedRemovalPoint };
}

function randomSuffix(): string {
  return Math.floor(Math.random() * 0xffffff)
    .toString(36)
    .padStart(4, "0");
}

export { ArtworkUploadRejectedError };
