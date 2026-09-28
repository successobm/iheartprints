/**
 * Pre-Durability PNG Decode Removal (live incident: Pedro Back job
 * `5ccc9d2f-…`, three whole-container deaths at DigitalOcean exit code 128).
 *
 * WHY THIS EXISTS. `downloadCompletedBounded` used to call
 * `PNG.sync.read(bytes)` on the downloaded provider result for ONE reason —
 * to hand `validateReconstructedGeometry` a width and a height — and then
 * `PNG.sync.write(png)` to re-encode what it had just decoded, all BEFORE
 * anything became durable. Instrumented production evidence plus a local
 * profile of a representative result showed what that costs:
 *
 *   result on the wire     11,264,723 bytes (10.74 MiB)   <- transferred fine
 *   decoded raster         13220x4952 = 65.5 Mpx
 *   PNG.sync.read peak     880.80 MiB RSS, 815.96 MiB external
 *   heapUsed at peak       6.46 MiB      <- all external Buffers, so V8's own
 *                                           heap-limit diagnostics never fire
 *   container limit        512 MiB
 *
 * Topaz returns 4.000x of the SOURCE CANVAS regardless of the
 * `output_width`/`output_height` submitted (documented at
 * `PROVIDER_MAX_RECONSTRUCTION_SCALE`, observed on jobs `36df2fa0-…`,
 * `01a049d2-…`, and now Pedro Back), so this cost scales with source area x
 * 16 — it is not a Pedro-specific accident.
 *
 * A PNG's dimensions live in the IHDR at a fixed offset. Reading them costs
 * 8 bytes. Decoding 65.5 Mpx to learn the same two numbers costs 813 MiB.
 *
 * WHAT THIS MODULE IS NOT. It is not a PNG decoder and must never become
 * one. It reads the header and walks the chunk structure without ever
 * inflating IDAT or allocating a raster — every operation here is O(1) in
 * memory regardless of the image's dimensions.
 *
 * WHAT INTEGRITY GUARANTEE IT MUST CARRY. `PNG.sync.read` was, incidentally,
 * also the corruption check at this boundary: a truncated download, a
 * flipped bit, a half-written body would all throw there and be classified
 * `malformed_response`. Removing it must not trade an OOM for silently
 * persisting a corrupt paid artifact, so this module deliberately verifies
 * MORE structure than a signature check would:
 *
 *   - the 8-byte PNG signature;
 *   - IHDR present, first, and exactly 13 bytes;
 *   - EVERY chunk's CRC-32 (the actual bit-corruption detector);
 *   - that the chunks tile the buffer EXACTLY, with IEND last and no
 *     trailing bytes (this is what catches a truncated or padded body);
 *   - at least one IDAT;
 *   - legal bit depth / colour type / compression / filter / interlace
 *     combinations, and non-zero dimensions within a sane ceiling.
 *
 * WHAT IT DELIBERATELY DOES NOT COVER, stated plainly: it does not inflate
 * the IDAT stream, so it cannot prove the compressed pixel data decodes to a
 * semantically valid raster. That guarantee is not lost, only deferred — the
 * downstream normalization step (`finalizeDownloadedResultBounded`) still
 * fully decodes the intermediate, and by then it is reading a DURABLE asset
 * rather than bytes that exist only in this process's memory. A failure
 * there is a recoverable read-back failure, not a lost paid result.
 */

/** PNG signature: \x89 P N G \r \n \x1a \n (PNG spec 5.2). */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const SIGNATURE_LENGTH = 8;
/** length(4) + type(4) + crc(4) — a chunk's fixed overhead (PNG spec 5.3). */
const CHUNK_OVERHEAD = 12;
const IHDR_DATA_LENGTH = 13;
/** PNG spec 5.3: a chunk's length field must not exceed 2^31 - 1. */
const MAX_CHUNK_DATA_LENGTH = 0x7fffffff;

/**
 * A per-axis sanity ceiling. NOT a geometry policy — `validateReconstructedGeometry`
 * remains the sole authority on whether a result's dimensions are acceptable
 * for production, and this module never second-guesses it. This exists only
 * because we no longer decode here: without it, an IHDR could CLAIM an
 * enormous raster in a few kilobytes (a decompression bomb) and the claim
 * would not be tested until a downstream decode tried to allocate it.
 */
const MAX_PROVIDER_RESULT_DIMENSION_PX = 65_535;
/**
 * A total-pixel ceiling, chosen against real evidence rather than a round
 * number: the largest legitimate provider result this codebase has on record
 * is Pedro Front's 13260x10800 intermediate at 143.2 Mpx. 256 Mpx sits
 * comfortably above that while still refusing a header describing a raster
 * no proportional reconstruction of a customer upload could produce.
 */
const MAX_PROVIDER_RESULT_PIXELS = 256_000_000;

/** PNG spec 11.2.2 — the legal (colour type -> bit depth) combinations. */
const LEGAL_BIT_DEPTHS: Record<number, readonly number[]> = {
  0: [1, 2, 4, 8, 16], // greyscale
  2: [8, 16], // truecolour
  3: [1, 2, 4, 8], // indexed
  4: [8, 16], // greyscale + alpha
  6: [8, 16], // truecolour + alpha
};

/** Precomputed CRC-32 table (PNG spec 15, the standard IEEE polynomial). */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

/**
 * CRC-32 over `bytes[start, end)`. Iterates in place — no slice, no copy, no
 * allocation proportional to the range, so this stays O(1) in memory even
 * across a multi-megabyte IDAT.
 */
function crc32(bytes: Buffer, start: number, end: number): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i += 1) {
    c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

export interface PngStructureOk {
  status: "ok";
  widthPx: number;
  heightPx: number;
  bitDepth: number;
  colorType: number;
  interlaced: boolean;
  /** How many chunks were walked and CRC-verified — diagnostic only. */
  chunkCount: number;
}

export interface PngStructureInvalid {
  status: "invalid";
  /** Internal diagnostic text. Never customer-facing, never contains bytes or a URL. */
  reason: string;
}

export type PngStructureInspection = PngStructureOk | PngStructureInvalid;

/**
 * Header-and-chunk inspection of a PNG, with NO pixel decode.
 *
 * Returns the IHDR dimensions on success. Never throws — every failure is a
 * `status: "invalid"` with an internal reason, so the caller keeps full
 * control of provider-error classification (preserving the existing
 * `malformed_response` semantics exactly).
 */
export function inspectPngStructure(bytes: Buffer): PngStructureInspection {
  if (bytes.length < SIGNATURE_LENGTH + CHUNK_OVERHEAD + IHDR_DATA_LENGTH) {
    return { status: "invalid", reason: `too short to contain a PNG header (${bytes.length} bytes)` };
  }
  if (!bytes.subarray(0, SIGNATURE_LENGTH).equals(PNG_SIGNATURE)) {
    return { status: "invalid", reason: "missing the PNG signature" };
  }

  let offset = SIGNATURE_LENGTH;
  let chunkCount = 0;
  let sawIhdr = false;
  let sawIdat = false;
  let sawIend = false;
  let widthPx = 0;
  let heightPx = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlaced = false;

  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) {
      return { status: "invalid", reason: "truncated: incomplete chunk header" };
    }
    const dataLength = bytes.readUInt32BE(offset);
    if (dataLength > MAX_CHUNK_DATA_LENGTH) {
      return { status: "invalid", reason: `chunk length ${dataLength} exceeds the PNG maximum` };
    }
    const type = bytes.toString("latin1", offset + 4, offset + 8);
    if (!/^[A-Za-z]{4}$/.test(type)) {
      return { status: "invalid", reason: "chunk type is not four alphabetic bytes" };
    }
    const chunkEnd = offset + CHUNK_OVERHEAD + dataLength;
    if (chunkEnd > bytes.length) {
      // THE TRUNCATION DETECTOR. A body cut short mid-IDAT lands here.
      return {
        status: "invalid",
        reason: `truncated: chunk "${type}" needs ${chunkEnd} bytes but the body is ${bytes.length}`,
      };
    }

    // CRC covers the type field AND the data, never the length (PNG spec 5.3).
    const declaredCrc = bytes.readUInt32BE(offset + 8 + dataLength);
    const actualCrc = crc32(bytes, offset + 4, offset + 8 + dataLength);
    if (declaredCrc !== actualCrc) {
      return { status: "invalid", reason: `chunk "${type}" failed its CRC check` };
    }

    if (chunkCount === 0) {
      if (type !== "IHDR") {
        return { status: "invalid", reason: `first chunk is "${type}", not IHDR` };
      }
      if (dataLength !== IHDR_DATA_LENGTH) {
        return { status: "invalid", reason: `IHDR is ${dataLength} bytes, expected ${IHDR_DATA_LENGTH}` };
      }
      const d = offset + 8;
      widthPx = bytes.readUInt32BE(d);
      heightPx = bytes.readUInt32BE(d + 4);
      bitDepth = bytes[d + 8]!;
      colorType = bytes[d + 9]!;
      const compression = bytes[d + 10]!;
      const filter = bytes[d + 11]!;
      const interlace = bytes[d + 12]!;

      if (widthPx === 0 || heightPx === 0) {
        return { status: "invalid", reason: `IHDR declares a zero dimension (${widthPx}x${heightPx})` };
      }
      if (widthPx > MAX_PROVIDER_RESULT_DIMENSION_PX || heightPx > MAX_PROVIDER_RESULT_DIMENSION_PX) {
        return {
          status: "invalid",
          reason: `IHDR declares ${widthPx}x${heightPx}, beyond the ${MAX_PROVIDER_RESULT_DIMENSION_PX}px per-axis ceiling`,
        };
      }
      if (widthPx * heightPx > MAX_PROVIDER_RESULT_PIXELS) {
        return {
          status: "invalid",
          reason: `IHDR declares ${widthPx}x${heightPx} (${widthPx * heightPx} px), beyond the ${MAX_PROVIDER_RESULT_PIXELS}px ceiling`,
        };
      }
      const legalDepths = LEGAL_BIT_DEPTHS[colorType];
      if (!legalDepths) {
        return { status: "invalid", reason: `IHDR declares an unknown colour type (${colorType})` };
      }
      if (!legalDepths.includes(bitDepth)) {
        return {
          status: "invalid",
          reason: `IHDR declares bit depth ${bitDepth}, illegal for colour type ${colorType}`,
        };
      }
      if (compression !== 0) {
        return { status: "invalid", reason: `IHDR declares an unknown compression method (${compression})` };
      }
      if (filter !== 0) {
        return { status: "invalid", reason: `IHDR declares an unknown filter method (${filter})` };
      }
      if (interlace !== 0 && interlace !== 1) {
        return { status: "invalid", reason: `IHDR declares an unknown interlace method (${interlace})` };
      }
      interlaced = interlace === 1;
      sawIhdr = true;
    } else if (type === "IHDR") {
      return { status: "invalid", reason: "more than one IHDR chunk" };
    }

    if (type === "IDAT") sawIdat = true;
    if (type === "IEND") {
      if (dataLength !== 0) {
        return { status: "invalid", reason: `IEND carries ${dataLength} bytes of data` };
      }
      sawIend = true;
      offset = chunkEnd;
      break;
    }

    chunkCount += 1;
    offset = chunkEnd;
  }

  if (!sawIhdr) return { status: "invalid", reason: "no IHDR chunk" };
  if (!sawIdat) return { status: "invalid", reason: "no IDAT chunk" };
  if (!sawIend) return { status: "invalid", reason: "truncated: no IEND chunk" };
  if (offset !== bytes.length) {
    // Trailing bytes after IEND. A well-formed PNG ends exactly at IEND.
    return { status: "invalid", reason: `${bytes.length - offset} trailing bytes after IEND` };
  }

  return {
    status: "ok",
    widthPx,
    heightPx,
    bitDepth,
    colorType,
    interlaced,
    chunkCount: chunkCount + 1,
  };
}

export {
  MAX_PROVIDER_RESULT_DIMENSION_PX,
  MAX_PROVIDER_RESULT_PIXELS,
};
