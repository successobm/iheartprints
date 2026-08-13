/**
 * True Source-Image Targeted Revision: the selected source artwork could
 * not be turned into real image bytes, so this revision cannot be performed
 * as an EDIT.
 *
 * This is deliberately fatal to the job. Falling back to text-to-image here
 * would silently recreate the exact defect this work exists to fix: the
 * customer asked to change one thing about a specific concept, and would
 * instead receive an unrelated reinterpretation of the brief that looks
 * like a successful revision. A failed job is honest and recoverable; a
 * fake success is neither.
 *
 * `reason` is a stable, non-secret machine code for `GenerationJob.lastError`
 * — internal only, never surfaced to the customer (the worker's existing
 * regeneration failure message is what they see, and it correctly tells
 * them their selected concept is unchanged).
 */
export type TargetedRevisionSourceFailure =
  | "source_artwork_missing"
  | "source_asset_missing"
  | "source_bytes_unavailable"
  | "source_content_type_unsupported";

export class TargetedRevisionSourceError extends Error {
  readonly reason: TargetedRevisionSourceFailure;
  readonly targetArtworkVersionId: string;

  constructor(
    reason: TargetedRevisionSourceFailure,
    targetArtworkVersionId: string,
    message: string,
  ) {
    super(message);
    this.name = "TargetedRevisionSourceError";
    this.reason = reason;
    this.targetArtworkVersionId = targetArtworkVersionId;
  }
}

/**
 * Image types an edit provider can accept as input. A concept asset is
 * always PNG today; anything else is rejected rather than uploaded blindly,
 * so an unexpected type fails loudly at our boundary instead of becoming an
 * opaque provider rejection (or worse, a silently ignored input image).
 */
const SUPPORTED_SOURCE_CONTENT_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
]);

export function isSupportedSourceContentType(contentType: string): boolean {
  return SUPPORTED_SOURCE_CONTENT_TYPES.has(contentType.trim().toLowerCase());
}
