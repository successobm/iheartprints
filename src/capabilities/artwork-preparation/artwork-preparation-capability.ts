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
 * never updated; every transformation produces a new, separate asset.
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

import type { AssetCapability } from "@/capabilities/assets";
import type { DesignBriefCapability } from "@/capabilities/design-brief";
import type { ProjectRepository } from "@/lib/db/repository";
import type {
  ArtworkPreparation,
  PrintPlacement,
  TShirtDesignBrief,
} from "@/lib/domain/types";

import {
  isolateBackground,
  passThroughTransparentArtwork,
  resolveGuidedRemovalAt,
} from "./background-isolation";
import type { ArtworkAnalysis, RepairabilityAssessment } from "./contracts";
import type {
  GuidedRemovalPoint,
  GuidedRemovalRecord,
} from "./guided-removal";
import { decodePngUpload, encodeRgbaToPng } from "./image-decode";
import { analyzeArtwork } from "./image-analysis";
import {
  describeArtworkForCustomer,
  describeGuidedCleanupOutcome,
  type ArtworkPreparationCustomerView,
  type GuidedCleanupOutcomeCode,
} from "./preparation-copy";
import { classifyRepairability } from "./repairability";
import {
  ArtworkUploadRejectedError,
  sanitizeUploadFilename,
  validateUploadBytes,
} from "./upload-limits";

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
}

export interface GuidedCleanupStateView {
  /** True while cleanup is possible at all: prepared, not yet approved. */
  available: boolean;
  /** How many areas the customer has removed. Drives "Undo" being offered. */
  removalCount: number;
}

/** The result of one guided-cleanup action. */
export interface GuidedCleanupResult {
  outcome: GuidedCleanupOutcomeCode;
  /** Already-phrased. The UI renders this verbatim. */
  message: string;
  view: ArtworkPreparationView;
}

/** Persisted shape of `ArtworkPreparation.guidedCleanup`. */
interface GuidedCleanupRecord {
  removals: GuidedRemovalRecord[];
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
   * Existing Artwork → Print Ready Phase 1.2: the customer points at an area
   * of their prepared artwork that should also be see-through.
   *
   * A click is EVIDENCE, not authority: it may only ever resolve to an
   * enclosed background-coloured region the automatic pass already identified
   * and then declined on ambiguous geometry. A click that lands on artwork is
   * refused and nothing changes. Idempotent — clicking the same area twice is
   * harmless and produces no second asset.
   *
   * Refuses once the preparation is approved: an approved prepared asset is
   * history and is never rewritten.
   */
  applyGuidedCleanup(
    designId: string,
    point: GuidedRemovalPoint,
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
    const removals = readGuidedRemovals(preparation);

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
   * Runs the deterministic pipeline over the IMMUTABLE original and persists
   * the result as a NEW asset.
   *
   * The single derivation path: automatic preparation calls it with no clicks,
   * guided cleanup calls it with the customer's whole click history. That is
   * what makes the two produce byte-identical output for the same inputs, and
   * what makes a reload safe — the prepared asset is always a pure function of
   * (original bytes, background model, click list), never of how many times
   * anything ran.
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
    guidedRemovalPoints: readonly GuidedRemovalPoint[],
  ) {
    const image = await loadOriginalImage(preparation);
    const isolated =
      assessment.backgroundTreatment === "already_transparent"
        ? passThroughTransparentArtwork(
            image,
            analysis.estimatedBackgroundColor,
            analysis.backgroundTolerance,
          )
        : isolateBackground(image, {
            backgroundColor: analysis.estimatedBackgroundColor,
            tolerance: analysis.backgroundTolerance,
            guidedRemovalPoints,
          });

    assertPreservesGeometry(image, isolated.image);

    const asset = await assets.uploadCustomerArtwork(designId, {
      conceptId: `prepared-${preparation.id}-${isolated.guided.applied.length}`,
      bytes: encodeRgbaToPng(isolated.image),
      contentType: "image/png",
      widthPx: isolated.image.width,
      heightPx: isolated.image.height,
      hasTransparency: true,
      kind: "png",
      metadata: {
        // Lineage lives on the preparation row; this mirror exists purely so
        // an asset can be traced back without a join. The click list is
        // included because it is the other half of "what produced these
        // bytes" — the original alone no longer explains them.
        derivedFromAssetId: preparation.originalAssetId,
        artworkPreparationId: preparation.id,
        preparation: isolated.record as unknown as Record<string, unknown>,
        guidedRemovals: isolated.guided.applied as unknown as Record<
          string,
          unknown
        >[],
      },
    });

    return { asset, isolated };
  }

  /**
   * Re-derives the prepared asset from the customer's whole click history and
   * persists both. Shared by apply and undo so there is exactly one way the
   * prepared bytes and the stored click list can change, and they cannot get
   * out of step.
   */
  async function persistGuidedCleanup(
    designId: string,
    preparation: ArtworkPreparation,
    brief: TShirtDesignBrief,
    removals: GuidedRemovalRecord[],
    outcome: GuidedCleanupOutcomeCode,
  ): Promise<GuidedCleanupResult> {
    const analysis = preparation.analysis as unknown as ArtworkAnalysis;
    const assessment = classifyRepairability(analysis);

    const { asset, isolated } = await derivePreparedAsset(
      designId,
      preparation,
      analysis,
      assessment,
      removals.map((removal) => removal.point),
    );

    const updated = await repo.updateArtworkPreparation(preparation.id, {
      preparedAssetId: asset.id,
      preparation: isolated.record as unknown as Record<string, unknown>,
      // Stored as what the pipeline ACCEPTED, not as what the client sent —
      // a point that stopped resolving would otherwise linger forever.
      guidedCleanup:
        isolated.guided.applied.length === 0
          ? null
          : ({ removals: isolated.guided.applied } as unknown as Record<
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

    return { brief, preparation, removals: readGuidedRemovals(preparation) };
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

      // No clicks: automatic preparation is exactly this pipeline with an
      // empty click list, which is why guided cleanup cannot change what an
      // untouched preparation produces.
      const { asset, isolated } = await derivePreparedAsset(
        designId,
        preparation,
        analysis,
        assessment,
        [],
      );

      const updated = await repo.updateArtworkPreparation(preparation.id, {
        status: "prepared",
        preparedAssetId: asset.id,
        preparation: isolated.record as unknown as Record<string, unknown>,
      });

      return toView(updated, brief);
    },

    async applyGuidedCleanup(designId, point) {
      const { brief, preparation, removals } = await requireCleanupTarget(designId);
      const analysis = preparation.analysis as unknown as ArtworkAnalysis;

      const image = await loadOriginalImage(preparation);
      const resolution = resolveGuidedRemovalAt(image, point, {
        backgroundColor: analysis.estimatedBackgroundColor,
        tolerance: analysis.backgroundTolerance,
        applied: removals,
      });

      // Every refusal leaves the preparation byte-for-byte untouched: no new
      // asset, no repository write, nothing to undo. Clicking artwork is a
      // no-op, and so is clicking an area that is already see-through, which
      // is what makes a double click safe.
      if (resolution.outcome !== "eligible") {
        return {
          outcome: resolution.outcome,
          message: describeGuidedCleanupOutcome(resolution.outcome),
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
            point: { x: Math.floor(point.x), y: Math.floor(point.y) },
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
 * Narrows the loosely-typed `guidedCleanup` column back into records.
 *
 * Total and forgiving by design: anything malformed reads as "no cleanup"
 * rather than throwing, because a corrupt diagnostics blob must never make a
 * customer's artwork unopenable. Nothing here is trusted anyway — a stored
 * point is re-resolved against the real image on every derivation, so a bogus
 * coordinate simply resolves to nothing and drops out.
 */
function readGuidedRemovals(preparation: ArtworkPreparation): GuidedRemovalRecord[] {
  const stored = preparation.guidedCleanup as GuidedCleanupRecord | null;
  if (!stored || !Array.isArray(stored.removals)) return [];

  return stored.removals.flatMap((removal) => {
    const x = removal?.point?.x;
    const y = removal?.point?.y;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return [];
    return [
      {
        point: { x: Math.floor(x), y: Math.floor(y) },
        regionKey: typeof removal.regionKey === "string" ? removal.regionKey : "",
        pixelCount: Number.isFinite(removal.pixelCount) ? removal.pixelCount : 0,
      },
    ];
  });
}

function randomSuffix(): string {
  return Math.floor(Math.random() * 0xffffff)
    .toString(36)
    .padStart(4, "0");
}

export { ArtworkUploadRejectedError };
