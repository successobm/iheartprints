/**
 * Existing Artwork → Print Ready Phase 1: the ingress safety boundary for
 * customer-uploaded artwork. Pure and dependency-free — no repository, no
 * storage, no image codec — so every rejection rule is directly testable
 * without touching a byte of I/O.
 *
 * Everything here runs BEFORE any uncontrolled allocation. The decode limits
 * in particular are enforced against the PNG header, not against a decoded
 * bitmap: a 32000x32000 PNG is ~700 bytes on the wire and ~4GB decoded, so
 * "check the file size, then decode, then check the dimensions" is exactly
 * the wrong order.
 */

/**
 * Maximum encoded (compressed, on-the-wire) upload size.
 *
 * Large Raster Upload Limit Audit: the original 25 MB figure was never
 * derived from a decode-memory or dimension budget — those are governed
 * independently and unconditionally by `MAX_IMAGE_DIMENSION_PX`/
 * `MAX_TOTAL_PIXELS` below, checked against the PNG HEADER before any
 * bitmap is allocated (`image-decode.ts`). Compressed byte size and decoded
 * memory are only loosely correlated for PNG: a highly complex/photographic
 * or AI-generated raster can be large on the wire while well within the
 * pixel budget (PNG has no lossy mode to shrink such content the way JPEG
 * would), so a real customer's honest, moderate-resolution artwork can
 * legitimately exceed a byte cap chosen for "typical" content. A real
 * production precedent for a similarly-large legitimate raster already
 * exists in this codebase: `MAX_PROVIDER_RESULT_DOWNLOAD_BYTES` = 64 MiB
 * (`topaz-transparency-upscale-provider.ts`), raised from this same 25 MB
 * figure after a genuine 36,324,544-byte Topaz result was wrongly rejected.
 *
 * 50 MB keeps real headroom below that 64 MiB precedent (a provider RESULT
 * may legitimately be larger than a customer UPLOAD) while comfortably
 * covering a realistic complex/AI-generated PNG at the full pixel ceiling
 * below. It is a bounded, authoritative cap, not a cosmetic one:
 * `capped-request-body.ts` enforces it WHILE the request body streams in
 * (never trusting a missing/lying/chunked `Content-Length`), so the actual
 * worst-case raw-byte buffering for one request is this constant, not the
 * previously-unbounded body-buffering-bypass gap documented in
 * `ARCHITECTURE.md` §23 item 2.
 */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

/**
 * Hard per-axis bound. UNCHANGED by the Large Raster Upload Limit Audit —
 * comfortably above any real apparel plate (a 14" @ 300 PPI print is
 * 4200px) and above the real Signs/banner case that motivated this audit
 * (an 84"-wide banner reaches this bound only above ~143 PPI, well past
 * any resolution a banner viewed at distance needs). Deliberately NOT
 * raised: see `MAX_TOTAL_PIXELS`'s own doc for why the decode-time memory
 * budget this bounds is already close to this runtime's safe ceiling.
 */
export const MAX_IMAGE_DIMENSION_PX = 12000;

/**
 * Total decoded pixel bound — the decompression-bomb guard. 40 MP at 4 bytes
 * per pixel is ~160 MB of RGBA, the largest single allocation this pipeline
 * is willing to make. A file can satisfy both per-axis bounds and still blow
 * past this (e.g. 12000x11000), which is why it is checked independently.
 *
 * Large Raster Upload Limit Audit: audited, deliberately UNCHANGED. The
 * production runtime (~512 MB RAM, 1 shared vCPU) already runs the upload
 * decode/analysis pipeline synchronously inline in the request handler
 * (`ARCHITECTURE.md` §23 item 5) with, at this EXISTING 40 MP ceiling: two
 * full RGBA buffers during decode (`image-decode.ts` — one before this
 * audit's redundant-copy fix, still momentarily two during the fix's own
 * brief overlap) plus several full-resolution 1-4-byte-per-pixel mask/label
 * buffers during apparel's upload-time region-separation analysis
 * (`region-separation.ts`'s `computeRegionMap`, called from
 * `analyzeArtwork` — an `Int32Array` region-label buffer alone is another
 * ~160 MB at this ceiling). Realistic peak resident memory for a single
 * request already reaches several hundred MB at the EXISTING cap — a real,
 * pre-existing, load-bearing constraint this audit did not introduce.
 * Raising this bound further, without also reworking that synchronous
 * decode/analysis pipeline (batching/streaming the mask computation, or
 * moving it off the request thread), would risk real out-of-memory
 * failures under concurrent uploads. That rework is architectural and
 * explicitly out of this task's scope — see the final report's §G/§P.
 */
export const MAX_TOTAL_PIXELS = 40_000_000;

/** Smallest artwork worth preparing — below this there is nothing printable. */
export const MIN_IMAGE_DIMENSION_PX = 16;

/**
 * Phase 1 supports PNG only, and says so honestly rather than advertising
 * formats it cannot decode. The repository's one image codec is `pngjs`
 * (`png-thumbnail-generator.ts`, `raster-transform.ts`, `production-png.ts`),
 * which is PNG-only; JPEG/WebP support would mean adding a new decoder
 * dependency and its whole security surface, which Phase 1 deliberately does
 * not do. See ARCHITECTURE.md §13h.
 */
export const SUPPORTED_UPLOAD_CONTENT_TYPES = ["image/png"] as const;

export type SupportedUploadContentType =
  (typeof SUPPORTED_UPLOAD_CONTENT_TYPES)[number];

/**
 * What the BYTES actually are — never what the filename or the browser's
 * `Content-Type` claims. `"svg"` and the other recognized-but-unsupported
 * formats are detected explicitly so the customer gets an honest "we can't
 * take that yet" instead of a generic "corrupt file".
 */
export type DetectedImageFormat =
  | "png"
  | "jpeg"
  | "webp"
  | "gif"
  | "bmp"
  | "tiff"
  | "svg"
  | "unknown";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Content sniffing by magic signature. SVG has no magic number (it is XML),
 * so it is detected by inspecting the leading non-whitespace bytes for an
 * XML/SVG opening — deliberately conservative and only used to REJECT.
 */
export function detectImageFormat(bytes: Buffer): DetectedImageFormat {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return "png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "jpeg";
  }
  if (
    bytes.length >= 12 &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "webp";
  }
  if (bytes.length >= 6 && bytes.toString("ascii", 0, 3) === "GIF") {
    return "gif";
  }
  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) {
    return "bmp";
  }
  if (
    bytes.length >= 4 &&
    ((bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2a && bytes[3] === 0x00) ||
      (bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0x00 && bytes[3] === 0x2a))
  ) {
    return "tiff";
  }
  if (looksLikeSvg(bytes)) return "svg";
  return "unknown";
}

function looksLikeSvg(bytes: Buffer): boolean {
  // Only the first kilobyte, decoded leniently: an SVG's root element is at
  // the top of the document, and scanning further would just be scanning
  // arbitrary binary for a string.
  const head = bytes.subarray(0, 1024).toString("utf8").trimStart().toLowerCase();
  if (head.startsWith("<svg")) return true;
  if (!head.startsWith("<?xml") && !head.startsWith("<!doctype")) return false;
  return head.includes("<svg");
}

/** Stable, non-secret rejection reasons. Each maps to one customer-safe sentence. */
export type UploadRejectionCode =
  | "empty_file"
  | "file_too_large"
  | "unsupported_format"
  | "svg_not_supported"
  | "format_mismatch"
  | "malformed_image"
  | "image_too_small"
  | "image_too_large"
  | "too_many_pixels";

export class ArtworkUploadRejectedError extends Error {
  constructor(
    readonly code: UploadRejectionCode,
    message: string,
  ) {
    super(message);
    this.name = "ArtworkUploadRejectedError";
  }
}

export interface ValidatedUploadBytes {
  bytes: Buffer;
  format: SupportedUploadContentType;
  byteSize: number;
}

/**
 * Validates the ENCODED upload: size, real format, and (when the browser
 * supplied one) that the declared content type agrees with the bytes.
 *
 * A declared type that disagrees with the signature is rejected rather than
 * silently corrected. The bytes are authoritative for what we DO, but a
 * mismatch means the request is not what it claims to be, and accepting it
 * would let a caller probe which of the two we actually trust.
 */
export function validateUploadBytes(
  bytes: Buffer,
  declaredContentType: string | null,
): ValidatedUploadBytes {
  if (bytes.length === 0) {
    throw new ArtworkUploadRejectedError(
      "empty_file",
      "That file was empty. Please choose an image file and try again.",
    );
  }
  if (bytes.length > MAX_UPLOAD_BYTES) {
    throw new ArtworkUploadRejectedError(
      "file_too_large",
      `That file is larger than the ${Math.round(
        MAX_UPLOAD_BYTES / (1024 * 1024),
      )} MB we can accept. Please upload a smaller version of your artwork.`,
    );
  }

  const format = detectImageFormat(bytes);

  if (format === "svg") {
    throw new ArtworkUploadRejectedError(
      "svg_not_supported",
      "We can't work with SVG files yet. Please upload a PNG image of your artwork.",
    );
  }
  if (format !== "png") {
    throw new ArtworkUploadRejectedError(
      "unsupported_format",
      "We can only prepare PNG images right now. Please upload your artwork as a PNG.",
    );
  }

  const declared = normalizeDeclaredContentType(declaredContentType);
  if (declared && declared !== "image/png") {
    throw new ArtworkUploadRejectedError(
      "format_mismatch",
      "That file didn't match the type it said it was. Please upload your artwork as a PNG.",
    );
  }

  return { bytes, format: "image/png", byteSize: bytes.length };
}

function normalizeDeclaredContentType(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.split(";")[0]!.trim().toLowerCase();
  if (trimmed === "" || trimmed === "application/octet-stream") return null;
  return trimmed;
}

/**
 * Bounds the DECODED image before any bitmap is allocated. Callers must run
 * this against header-derived dimensions, never against an already-decoded
 * image (see this module's doc comment).
 */
export function assertDecodableDimensions(width: number, height: number): void {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0
  ) {
    throw new ArtworkUploadRejectedError(
      "malformed_image",
      "We couldn't read that image. It may be damaged — please try exporting it again.",
    );
  }
  if (width < MIN_IMAGE_DIMENSION_PX || height < MIN_IMAGE_DIMENSION_PX) {
    throw new ArtworkUploadRejectedError(
      "image_too_small",
      "That image is too small to print from. Please upload a larger version of your artwork.",
    );
  }
  if (width > MAX_IMAGE_DIMENSION_PX || height > MAX_IMAGE_DIMENSION_PX) {
    throw new ArtworkUploadRejectedError(
      "image_too_large",
      "That image is larger than we can work with. Please upload a version under 12,000 pixels on each side.",
    );
  }
  if (width * height > MAX_TOTAL_PIXELS) {
    throw new ArtworkUploadRejectedError(
      "too_many_pixels",
      "That image has more detail than we can process in one go. Please upload a smaller version of your artwork.",
    );
  }
}

/** Longest filename we keep for display. Long enough to stay recognizable, short enough to render. */
export const MAX_DISPLAY_FILENAME_LENGTH = 80;

/**
 * Reduces a customer filename to something safe to STORE AND DISPLAY. It is
 * never used to build a storage path — object keys are always
 * `buildObjectKey({ projectId, conceptId, fileName })` with a fileName this
 * code chooses — so this exists purely so a traversal-shaped or
 * control-character-laden name can never reach the database or the browser.
 *
 * Returns `null` when nothing safe survives, which callers store as "no
 * filename" rather than substituting an invented one.
 */
export function sanitizeUploadFilename(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;

  // Take the last path segment under BOTH separators, so neither a POSIX
  // "../../etc/passwd" nor a Windows "..\..\windows\win.ini" survives as a
  // path.
  const lastSegment = raw.split(/[/\\]/).pop() ?? "";

  // Control characters are dropped by code point rather than by a regex
  // range, so no literal control byte ever appears in this source file.
  const withoutControlChars = [...lastSegment]
    .filter((char) => {
      const code = char.codePointAt(0) ?? 0;
      return code >= 0x20 && code !== 0x7f;
    })
    .join("")
    .trim();

  // Conservative allow-list; everything else collapses to "-" so the name
  // stays readable without carrying markup, quotes, or separators.
  const cleaned = withoutControlChars
    .replace(/[^A-Za-z0-9._ -]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[.\-\s]+/, "")
    .trim();

  if (cleaned === "" || cleaned === "." || cleaned === "..") return null;

  return cleaned.length > MAX_DISPLAY_FILENAME_LENGTH
    ? cleaned.slice(0, MAX_DISPLAY_FILENAME_LENGTH)
    : cleaned;
}
