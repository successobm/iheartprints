/**
 * Existing Artwork → Print Ready Phase 1: the ONLY place customer-uploaded
 * bytes are turned into pixels.
 *
 * Two properties matter here and nowhere else in the pipeline:
 *
 *   1. Dimensions are read from the PNG HEADER and bounds-checked BEFORE
 *      `pngjs` is asked to decode anything. A decompression bomb is small on
 *      the wire and enormous in memory, so checking the decoded image is
 *      already too late.
 *   2. Every `pngjs` failure — malformed, truncated, unsupported chunk
 *      layout — becomes an `ArtworkUploadRejectedError`, never an unhandled
 *      throw and never a partially-decoded image. A truncated file is a
 *      customer problem to explain, not a server error to leak.
 */

import { PNG } from "pngjs";

import type { RgbaImage } from "@/capabilities/final-artwork/raster-transform";
import {
  ArtworkUploadRejectedError,
  assertDecodableDimensions,
} from "./upload-limits";

const PNG_SIGNATURE_LENGTH = 8;
const IHDR_MINIMUM_LENGTH = PNG_SIGNATURE_LENGTH + 4 + 4 + 13 + 4;

export interface PngHeader {
  width: number;
  height: number;
  bitDepth: number;
  /** 0 greyscale, 2 truecolour, 3 indexed, 4 greyscale+alpha, 6 truecolour+alpha. */
  colorType: number;
  interlaceMethod: number;
  /** True when the PNG's own colour type carries an alpha channel. */
  declaresAlphaChannel: boolean;
}

/**
 * Parses IHDR without decoding image data. Throws
 * `ArtworkUploadRejectedError("malformed_image")` for anything that is not a
 * structurally valid PNG header.
 */
export function readPngHeader(bytes: Buffer): PngHeader {
  if (bytes.length < IHDR_MINIMUM_LENGTH) {
    throw malformed();
  }
  if (bytes.toString("ascii", 12, 16) !== "IHDR") {
    throw malformed();
  }
  if (bytes.readUInt32BE(PNG_SIGNATURE_LENGTH) !== 13) {
    throw malformed();
  }

  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  const bitDepth = bytes[24]!;
  const colorType = bytes[25]!;
  const interlaceMethod = bytes[28]!;

  if (![0, 2, 3, 4, 6].includes(colorType)) throw malformed();
  if (![1, 2, 4, 8, 16].includes(bitDepth)) throw malformed();
  if (interlaceMethod !== 0 && interlaceMethod !== 1) throw malformed();

  return {
    width,
    height,
    bitDepth,
    colorType,
    interlaceMethod,
    // Colour types 4 and 6 carry a real alpha channel. Indexed PNGs (3) may
    // still carry transparency via a tRNS chunk, which is why this flag is
    // only a hint — actual transparency is always MEASURED from the decoded
    // pixels (`image-analysis.ts`), never inferred from here.
    declaresAlphaChannel: colorType === 4 || colorType === 6,
  };
}

export interface DecodedUpload {
  image: RgbaImage;
  header: PngHeader;
}

/**
 * Bounds-checks the header, then decodes to straight (non-premultiplied)
 * RGBA — the same layout `raster-transform.ts` and `alpha-trim.ts` already
 * operate on, so every downstream pixel module is reused rather than
 * duplicated for uploads.
 */
export function decodePngUpload(bytes: Buffer): DecodedUpload {
  const header = readPngHeader(bytes);
  assertDecodableDimensions(header.width, header.height);

  let decoded: PNG;
  try {
    decoded = PNG.sync.read(bytes);
  } catch {
    throw malformed();
  }

  // `pngjs` is trusted to be self-consistent, but a decoded buffer that
  // disagrees with its own header would silently produce out-of-bounds reads
  // in every pixel loop downstream. Cheap to verify, catastrophic to assume.
  const expectedLength = decoded.width * decoded.height * 4;
  if (
    decoded.width !== header.width ||
    decoded.height !== header.height ||
    decoded.data.length !== expectedLength
  ) {
    throw malformed();
  }

  return {
    image: {
      width: decoded.width,
      height: decoded.height,
      data: Buffer.from(decoded.data),
    },
    header,
  };
}

/** Encodes an RGBA image back to PNG bytes. The single encode path for derived assets. */
export function encodeRgbaToPng(image: RgbaImage): Buffer {
  const png = new PNG({ width: image.width, height: image.height });
  image.data.copy(png.data);
  return PNG.sync.write(png);
}

function malformed(): ArtworkUploadRejectedError {
  return new ArtworkUploadRejectedError(
    "malformed_image",
    "We couldn't read that image. It may be damaged — please try exporting it again.",
  );
}
