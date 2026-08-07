/**
 * Sprint 2H Part 2A: provider port for where asset *bytes* physically live.
 * Separate from `AssetCapability` (which persists `AssetRecord` metadata —
 * a `storageKey`, never bytes) — this is the boundary a real storage
 * backend (Supabase Storage, S3, local filesystem, or a data URI for
 * dev/tests) implements. `AssetCapability` is the only caller; nothing
 * else in the codebase is allowed to know which backend is active.
 */

export interface UploadAssetInput {
  projectId: string;
  /**
   * Groups an original + its thumbnail under the same storage folder.
   * An internal storage-grouping id — not necessarily equal to any
   * database row's id (the `AssetRecord`/`ArtworkVersion` ids don't exist
   * yet at upload time).
   */
  conceptId: string;
  /** e.g. "original.png", "thumb.png". */
  fileName: string;
  bytes: Buffer;
  contentType: string;
}

export interface UploadedAssetRef {
  /**
   * Opaque, provider-neutral reference — the only thing ever persisted as
   * `AssetRecord.storageKey`. Never a signed URL, never a raw filesystem
   * path exposed to a customer.
   */
  objectKey: string;
}

export interface AssetStorageProvider {
  /** Internal only — never surfaced to the customer. */
  readonly storageKey: string;
  upload(input: UploadAssetInput): Promise<UploadedAssetRef>;
  /** A short-lived, expiring URL a browser can fetch directly. Never a raw object key. */
  getSignedUrl(objectKey: string, expiresInSeconds: number): Promise<string>;
  /**
   * Removes stored bytes. Only ever called by `AssetCapability` to clean up
   * an orphaned upload (bytes landed in storage but the database write that
   * would have referenced them failed) — never to remove a customer-visible
   * asset (Constitution §6.11, Version Everything).
   */
  delete(objectKey: string): Promise<void>;
  /**
   * Sprint 2M Phase 2C: fetches raw bytes server-side. Distinct from
   * `getSignedUrl` — a vision provider only ever needed a URL it fetches
   * itself; a local raster transformation (`FinalArtworkProvider`) needs
   * the actual bytes in-process to decode and resample. Only
   * `AssetCapability` (via `downloadAssetBytes`) ever calls this — no other
   * caller is allowed to know a storage backend exists.
   */
  download(objectKey: string): Promise<Buffer>;
}

/** `AssetStorageProvider.upload`'s bucket/path convention, shared by every implementation. */
export function buildObjectKey(input: {
  projectId: string;
  conceptId: string;
  fileName: string;
}): string {
  return `projects/${input.projectId}/concepts/${input.conceptId}/${input.fileName}`;
}
