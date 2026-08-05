/**
 * Asset management boundary — uploads, references, generated files.
 * Sprint 2H Part 1: backed by real repository persistence instead of a
 * no-op stub. Sprint 2H Part 2A: bytes are now actually uploaded through a
 * configured `AssetStorageProvider` (data URI, local filesystem, or
 * Supabase Storage) and a real thumbnail is generated — this capability is
 * the ONLY thing that knows a storage backend or thumbnail generator
 * exists; the rest of the codebase (including `ConceptGenerationCapability`
 * and every provider adapter) only ever sees `AssetRecord`s.
 */

import type { ProjectRepository } from "@/lib/db/repository";
import type { AssetKind, AssetRecord } from "@/lib/domain/types";
import type { AssetStorageProvider } from "@/capabilities/asset-storage";
import type { ThumbnailGenerator } from "./thumbnail-generator";

/** Signed URLs default to a short lifetime — "Signed URLs should expire." */
export const DEFAULT_SIGNED_URL_EXPIRY_SECONDS = 300;
/** Hard upper bound so callers cannot mint long-lived customer access. */
export const MAX_SIGNED_URL_EXPIRY_SECONDS = 900;

function clampSignedUrlExpirySeconds(expiresInSeconds?: number): number {
  if (
    expiresInSeconds === undefined ||
    !Number.isFinite(expiresInSeconds) ||
    expiresInSeconds <= 0
  ) {
    return DEFAULT_SIGNED_URL_EXPIRY_SECONDS;
  }
  return Math.min(Math.floor(expiresInSeconds), MAX_SIGNED_URL_EXPIRY_SECONDS);
}

export interface UploadConceptAssetInput {
  /**
   * Internal storage-grouping id — see `AssetStorageProvider`'s
   * `UploadAssetInput.conceptId` doc. Not necessarily equal to any
   * database row id.
   */
  conceptId: string;
  bytes: Buffer;
  contentType: string;
  widthPx: number | null;
  heightPx: number | null;
  hasTransparency: boolean | null;
  providerKey: string | null;
  generationJobId: string | null;
  metadata: Record<string, unknown>;
}

export interface UploadConceptAssetResult {
  primary: AssetRecord;
  /** `null` when thumbnail generation wasn't possible — never fatal, see module doc. */
  thumbnail: AssetRecord | null;
}

export interface AssetCapability {
  listAssets(designId: string): Promise<AssetRecord[]>;
  registerAsset(
    designId: string,
    input: Omit<AssetRecord, "id" | "projectId" | "createdAt">,
  ): Promise<AssetRecord | null>;
  /**
   * Sprint 2H Part 2A: uploads real image bytes through the configured
   * storage backend, attempts a thumbnail, and persists both as linked
   * `AssetRecord`s. If persisting the primary asset's metadata fails after
   * its bytes already landed in storage, the upload is cleaned up and the
   * error re-thrown (Asset Cleanup: "prevent orphaned uploads"). A
   * thumbnail failure (generation or its own upload/persist) is never
   * fatal — `thumbnail` is simply `null`.
   */
  uploadConceptImage(
    designId: string,
    input: UploadConceptAssetInput,
  ): Promise<UploadConceptAssetResult>;
  /**
   * A short-lived, expiring URL a browser can fetch directly — never a raw
   * object key. Returns `null` if the asset doesn't exist or has no stored
   * bytes.
   */
  getSignedUrl(
    assetId: string,
    expiresInSeconds?: number,
  ): Promise<string | null>;
  /** Cleanup only — see `ProjectRepository.deleteAsset`'s doc. */
  deleteAsset(assetId: string): Promise<void>;
}

export function createAssetCapability(
  repo: ProjectRepository,
  storage: AssetStorageProvider,
  thumbnails: ThumbnailGenerator,
): AssetCapability {
  return {
    async listAssets(designId) {
      return repo.listAssets(designId);
    },

    async registerAsset(designId, input) {
      return repo.createAsset(designId, input);
    },

    async uploadConceptImage(designId, input) {
      const uploadedOriginal = await storage.upload({
        projectId: designId,
        conceptId: input.conceptId,
        fileName: `original${extensionForContentType(input.contentType)}`,
        bytes: input.bytes,
        contentType: input.contentType,
      });

      let primary: AssetRecord;
      try {
        primary = await repo.createAsset(designId, {
          kind: "generated_artwork",
          storageKey: uploadedOriginal.objectKey,
          contentType: input.contentType,
          isThumbnail: false,
          widthPx: input.widthPx,
          heightPx: input.heightPx,
          hasTransparency: input.hasTransparency,
          providerKey: input.providerKey,
          generationJobId: input.generationJobId,
          metadata: input.metadata,
          vectorAssetId: null,
          printAssetId: null,
        });
      } catch (error) {
        // Asset Cleanup: bytes landed in storage but the record that would
        // reference them never did — never leave that orphaned.
        await safeDelete(storage, uploadedOriginal.objectKey);
        throw error;
      }

      const thumbnail = await tryCreateThumbnail(
        repo,
        storage,
        thumbnails,
        designId,
        input,
      );

      return { primary, thumbnail };
    },

    async getSignedUrl(assetId, expiresInSeconds) {
      const asset = await repo.getAssetById(assetId);
      if (!asset || !asset.storageKey) return null;
      return storage.getSignedUrl(
        asset.storageKey,
        clampSignedUrlExpirySeconds(expiresInSeconds),
      );
    },

    async deleteAsset(assetId) {
      const asset = await repo.getAssetById(assetId);
      if (!asset) return;
      if (asset.storageKey) {
        await safeDelete(storage, asset.storageKey);
      }
      await repo.deleteAsset(assetId);
    },
  };
}

/**
 * Thumbnail generation and its own upload/persist are never allowed to
 * fail the whole concept — "Thumbnail failure" is explicitly a recoverable
 * failure mode (Sprint 2H Part 2A). Any error along this path is logged
 * internally (never surfaced to the customer) and swallowed; the caller
 * just gets `null` back.
 */
async function tryCreateThumbnail(
  repo: ProjectRepository,
  storage: AssetStorageProvider,
  thumbnails: ThumbnailGenerator,
  designId: string,
  input: UploadConceptAssetInput,
): Promise<AssetRecord | null> {
  try {
    const generated = await thumbnails.generate({
      bytes: input.bytes,
      contentType: input.contentType,
    });
    if (!generated) return null;

    const uploadedThumb = await storage.upload({
      projectId: designId,
      conceptId: input.conceptId,
      fileName: `thumb${extensionForContentType(generated.contentType)}`,
      bytes: generated.bytes,
      contentType: generated.contentType,
    });

    try {
      return await repo.createAsset(designId, {
        kind: "generated_artwork",
        storageKey: uploadedThumb.objectKey,
        contentType: generated.contentType,
        isThumbnail: true,
        widthPx: generated.widthPx,
        heightPx: generated.heightPx,
        hasTransparency: input.hasTransparency,
        providerKey: input.providerKey,
        generationJobId: input.generationJobId,
        metadata: {},
        vectorAssetId: null,
        printAssetId: null,
      });
    } catch (error) {
      await safeDelete(storage, uploadedThumb.objectKey);
      logThumbnailFailure(error);
      return null;
    }
  } catch (error) {
    logThumbnailFailure(error);
    return null;
  }
}

function logThumbnailFailure(error: unknown): void {
  console.error("[assets] thumbnail generation failed (non-fatal)", {
    message: error instanceof Error ? error.message : String(error),
  });
}

async function safeDelete(
  storage: AssetStorageProvider,
  objectKey: string,
): Promise<void> {
  try {
    await storage.delete(objectKey);
  } catch (error) {
    // Asset Cleanup: "If cleanup fails: Log internally. Do not expose to
    // customers." — never let a cleanup failure surface further.
    console.error("[assets] failed to clean up an orphaned upload", {
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function extensionForContentType(contentType: string): string {
  if (contentType === "image/png") return ".png";
  if (contentType === "image/webp") return ".webp";
  if (contentType === "image/jpeg") return ".jpg";
  return "";
}

export type { AssetKind, AssetRecord };
