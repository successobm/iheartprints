/**
 * Sprint 2H Part 2A: a small, provider-neutral port so a future generation
 * provider can produce thumbnails in a different format without
 * `AssetCapability` (the only caller) changing at all.
 */

export interface ThumbnailInput {
  bytes: Buffer;
  contentType: string;
}

export interface ThumbnailOutput {
  bytes: Buffer;
  contentType: string;
  widthPx: number;
  heightPx: number;
}

export interface ThumbnailGenerator {
  /**
   * Returns `null` when this content type/payload can't be thumbnailed —
   * the caller treats that as "no thumbnail available", never as a fatal
   * generation failure (see the "Thumbnail failure" case in
   * `AssetCapability.uploadConceptImage`).
   */
  generate(input: ThumbnailInput): Promise<ThumbnailOutput | null>;
}
