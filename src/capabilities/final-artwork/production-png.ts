/**
 * Print-Ready Normalization Phase 1: PNG physical-resolution (`pHYs`)
 * metadata for the production deliverable.
 *
 * `pngjs` — the repository's only PNG codec — decodes and encodes IHDR /
 * IDAT / PLTE / tRNS / gAMA and skips every other ancillary chunk; it has no
 * `pHYs` support in either direction. Rather than swap the codec (a
 * genuinely fragile change to the one library the whole raster pipeline
 * depends on), this module appends the chunk itself to bytes `pngjs` already
 * produced. That is safe and non-fragile precisely because it is additive and
 * spec-literal:
 *
 *   - `pHYs` is a 9-byte ancillary chunk (x/y pixels-per-unit as uint32BE +
 *     a unit byte) that must appear before the first IDAT; it is inserted
 *     immediately after IHDR, which always satisfies that.
 *   - Ancillary chunks are skipped by any conformant decoder that does not
 *     understand them — including `pngjs` itself, so every existing decode
 *     path (thumbnails, tests, production verification) keeps working on
 *     these bytes unchanged.
 *   - Nothing about the image data is touched: same IHDR, same IDAT, same
 *     pixels, byte for byte.
 *
 * IMPORTANT: this metadata is a HINT to graphics software, never the
 * authoritative readiness calculation. Effective print resolution remains
 * `actual production pixels ÷ intended physical inches` (see
 * `print-validation/effective-resolution.ts`). Rewriting a density tag adds
 * no image information, so Print Validation records it and cross-checks it,
 * but never substitutes it for real pixel geometry.
 */

/** PNG's `pHYs` unit specifier for "pixels per metre" (the only unit the format defines). */
const PHYS_UNIT_METRE = 1;
const INCHES_PER_METRE = 39.3700787402;

const PNG_SIGNATURE_LENGTH = 8;
const CHUNK_LENGTH_BYTES = 4;
const CHUNK_TYPE_BYTES = 4;
const CHUNK_CRC_BYTES = 4;

/** 300 PPI ≈ 11811 pixels per metre — the standard apparel-raster production density. */
export function pixelsPerMetreForPpi(ppi: number): number {
  return Math.round(ppi * INCHES_PER_METRE);
}

export function ppiFromPixelsPerMetre(pixelsPerMetre: number): number {
  return pixelsPerMetre / INCHES_PER_METRE;
}

/**
 * Returns `pngBytes` with a `pHYs` chunk declaring `pixelsPerMetre` on both
 * axes, replacing any `pHYs` the input already carried. Throws only for
 * input that is not a PNG at all — never silently returns un-tagged bytes,
 * so a caller can rely on the tag being present.
 */
export function withPhysicalPixelDensity(
  pngBytes: Buffer,
  pixelsPerMetre: number,
): Buffer {
  if (!Number.isFinite(pixelsPerMetre) || pixelsPerMetre <= 0) {
    throw new Error("Physical pixel density must be a positive number of pixels per metre.");
  }
  assertLooksLikePng(pngBytes);

  const stripped = removeExistingPhysChunks(pngBytes);
  // IHDR is required by the spec to be the first chunk, so the insertion
  // point is a fixed offset: signature + IHDR (length + type + 13 data + CRC).
  const ihdrLength = stripped.readUInt32BE(PNG_SIGNATURE_LENGTH);
  const insertAt =
    PNG_SIGNATURE_LENGTH +
    CHUNK_LENGTH_BYTES +
    CHUNK_TYPE_BYTES +
    ihdrLength +
    CHUNK_CRC_BYTES;

  return Buffer.concat([
    stripped.subarray(0, insertAt),
    buildPhysChunk(pixelsPerMetre),
    stripped.subarray(insertAt),
  ]);
}

export interface PhysicalPixelDensity {
  pixelsPerMetreX: number;
  pixelsPerMetreY: number;
  /** `1` = pixels per metre; `0` = unit-less aspect ratio only (no physical meaning). */
  unitSpecifier: number;
  ppiX: number;
  ppiY: number;
}

/**
 * Reads the `pHYs` chunk back out of PNG bytes, or `null` when the file
 * carries none. Used by tests and by the worker to record the density it
 * actually wrote (never to derive readiness).
 */
export function readPhysicalPixelDensity(
  pngBytes: Buffer,
): PhysicalPixelDensity | null {
  assertLooksLikePng(pngBytes);

  for (const chunk of iterateChunks(pngBytes)) {
    if (chunk.type !== "pHYs" || chunk.dataLength !== 9) continue;
    const pixelsPerMetreX = pngBytes.readUInt32BE(chunk.dataStart);
    const pixelsPerMetreY = pngBytes.readUInt32BE(chunk.dataStart + 4);
    const unitSpecifier = pngBytes[chunk.dataStart + 8];
    return {
      pixelsPerMetreX,
      pixelsPerMetreY,
      unitSpecifier,
      ppiX: ppiFromPixelsPerMetre(pixelsPerMetreX),
      ppiY: ppiFromPixelsPerMetre(pixelsPerMetreY),
    };
  }
  return null;
}

function buildPhysChunk(pixelsPerMetre: number): Buffer {
  const chunk = Buffer.alloc(CHUNK_LENGTH_BYTES + CHUNK_TYPE_BYTES + 9 + CHUNK_CRC_BYTES);
  chunk.writeUInt32BE(9, 0);
  chunk.write("pHYs", 4, "ascii");
  chunk.writeUInt32BE(Math.round(pixelsPerMetre), 8);
  chunk.writeUInt32BE(Math.round(pixelsPerMetre), 12);
  chunk[16] = PHYS_UNIT_METRE;
  // CRC covers the chunk type and data, never the length field.
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 17)), 17);
  return chunk;
}

function removeExistingPhysChunks(pngBytes: Buffer): Buffer {
  const segments: Buffer[] = [];
  let copiedTo = 0;
  let removedAny = false;

  for (const chunk of iterateChunks(pngBytes)) {
    if (chunk.type !== "pHYs") continue;
    segments.push(pngBytes.subarray(copiedTo, chunk.start));
    copiedTo = chunk.end;
    removedAny = true;
  }
  if (!removedAny) return pngBytes;

  segments.push(pngBytes.subarray(copiedTo));
  return Buffer.concat(segments);
}

interface PngChunkPosition {
  type: string;
  /** Offset of the chunk's length field. */
  start: number;
  /** Offset just past the chunk's CRC. */
  end: number;
  dataStart: number;
  dataLength: number;
}

function* iterateChunks(pngBytes: Buffer): Generator<PngChunkPosition> {
  let offset = PNG_SIGNATURE_LENGTH;
  while (offset + CHUNK_LENGTH_BYTES + CHUNK_TYPE_BYTES <= pngBytes.length) {
    const dataLength = pngBytes.readUInt32BE(offset);
    const type = pngBytes.toString("ascii", offset + 4, offset + 8);
    const dataStart = offset + CHUNK_LENGTH_BYTES + CHUNK_TYPE_BYTES;
    const end = dataStart + dataLength + CHUNK_CRC_BYTES;
    if (end > pngBytes.length) return;
    yield { type, start: offset, end, dataStart, dataLength };
    if (type === "IEND") return;
    offset = end;
  }
}

function assertLooksLikePng(pngBytes: Buffer): void {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (
    pngBytes.length < PNG_SIGNATURE_LENGTH + 12 ||
    !pngBytes.subarray(0, PNG_SIGNATURE_LENGTH).equals(signature)
  ) {
    throw new Error("Buffer is not a PNG file.");
  }
}

const CRC_TABLE = buildCrcTable();

function buildCrcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
}

/** Standard PNG (ISO 3309 / ITU-T V.42) CRC-32 over a chunk's type+data bytes. */
function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
