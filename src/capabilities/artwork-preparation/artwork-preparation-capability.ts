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

import { isolateBackground, passThroughTransparentArtwork } from "./background-isolation";
import type { ArtworkAnalysis, RepairabilityAssessment } from "./contracts";
import { decodePngUpload, encodeRgbaToPng } from "./image-decode";
import { analyzeArtwork } from "./image-analysis";
import {
  describeArtworkForCustomer,
  type ArtworkPreparationCustomerView,
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
  /** Production context already recorded for this project. */
  productSummary: string | null;
  productColor: string | null;
  printPlacement: PrintPlacement | null;
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

    return {
      preparationId: preparation.id,
      status: preparation.status,
      originalFilename: preparation.originalFilename,
      classification: assessment.classification,
      customer: describeArtworkForCustomer(analysis, assessment),
      hasPreparedArtwork: preparation.preparedAssetId !== null,
      approved: preparation.status === "approved",
      widthPx: analysis.widthPx,
      heightPx: analysis.heightPx,
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

      const downloaded = await assets.downloadAssetBytes(preparation.originalAssetId);
      if (!downloaded) {
        throw new ArtworkPreparationStateError(
          "We couldn't find the artwork you uploaded. Please upload it again.",
        );
      }

      const decoded = decodePngUpload(downloaded.bytes);
      const isolated =
        assessment.backgroundTreatment === "already_transparent"
          ? passThroughTransparentArtwork(
              decoded.image,
              analysis.estimatedBackgroundColor,
              analysis.backgroundTolerance,
            )
          : isolateBackground(decoded.image, {
              backgroundColor: analysis.estimatedBackgroundColor,
              tolerance: analysis.backgroundTolerance,
            });

      assertPreservesGeometry(decoded.image, isolated.image);

      const preparedBytes = encodeRgbaToPng(isolated.image);
      const preparedAsset = await assets.uploadCustomerArtwork(designId, {
        conceptId: `prepared-${preparation.id}`,
        bytes: preparedBytes,
        contentType: "image/png",
        widthPx: isolated.image.width,
        heightPx: isolated.image.height,
        hasTransparency: true,
        kind: "png",
        metadata: {
          // Lineage lives on the preparation row; this mirror exists purely
          // so an asset can be traced back without a join.
          derivedFromAssetId: preparation.originalAssetId,
          artworkPreparationId: preparation.id,
          preparation: isolated.record as unknown as Record<string, unknown>,
        },
      });

      const updated = await repo.updateArtworkPreparation(preparation.id, {
        status: "prepared",
        preparedAssetId: preparedAsset.id,
        preparation: isolated.record as unknown as Record<string, unknown>,
      });

      return toView(updated, brief);
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

function randomSuffix(): string {
  return Math.floor(Math.random() * 0xffffff)
    .toString(36)
    .padStart(4, "0");
}

export { ArtworkUploadRejectedError };
