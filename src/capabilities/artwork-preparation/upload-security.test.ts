import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PNG } from "pngjs";

import { solidBlackExteriorArtwork, toPngBytes } from "./artwork-fixtures";
import { decodePngUpload, readPngHeader } from "./image-decode";
import {
  ArtworkUploadRejectedError,
  MAX_IMAGE_DIMENSION_PX,
  MAX_TOTAL_PIXELS,
  MAX_UPLOAD_BYTES,
  assertDecodableDimensions,
  detectImageFormat,
  sanitizeUploadFilename,
  validateUploadBytes,
} from "./upload-limits";

/**
 * The ingress security suite. Every case here is a rejection the pipeline
 * must make BEFORE any uncontrolled allocation, and every rejection must
 * carry a customer-safe sentence rather than an internal error.
 */

function expectRejection(fn: () => unknown, code: string): ArtworkUploadRejectedError {
  try {
    fn();
  } catch (error) {
    assert.ok(
      error instanceof ArtworkUploadRejectedError,
      `expected an ArtworkUploadRejectedError, got ${String(error)}`,
    );
    assert.equal(error.code, code);
    assert.ok(error.message.length > 0);
    return error;
  }
  throw new Error(`expected a rejection with code "${code}"`);
}

/** A structurally valid PNG header with arbitrary declared dimensions. */
function pngHeaderBytes(width: number, height: number): Buffer {
  const real = toPngBytes({ width: 16, height: 16, data: Buffer.alloc(16 * 16 * 4) });
  const forged = Buffer.from(real);
  forged.writeUInt32BE(width, 16);
  forged.writeUInt32BE(height, 20);
  return forged;
}

describe("format detection (bytes, never the filename or declared type)", () => {
  it("recognizes PNG by signature", () => {
    assert.equal(detectImageFormat(toPngBytes(solidBlackExteriorArtwork())), "png");
  });

  it("recognizes the formats it cannot decode yet, so it can say so honestly", () => {
    assert.equal(detectImageFormat(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), "jpeg");
    assert.equal(
      detectImageFormat(Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP")])),
      "webp",
    );
    assert.equal(detectImageFormat(Buffer.from("GIF89a")), "gif");
  });

  it("recognizes SVG despite it having no magic number", () => {
    assert.equal(detectImageFormat(Buffer.from('<svg xmlns="x"></svg>')), "svg");
    assert.equal(
      detectImageFormat(Buffer.from('<?xml version="1.0"?>\n<svg><rect/></svg>')),
      "svg",
    );
  });
});

describe("validateUploadBytes", () => {
  it("rejects an empty file", () => {
    expectRejection(() => validateUploadBytes(Buffer.alloc(0), "image/png"), "empty_file");
  });

  it("rejects an encoded upload past the size limit", () => {
    const oversized = Buffer.alloc(MAX_UPLOAD_BYTES + 1);
    toPngBytes(solidBlackExteriorArtwork()).copy(oversized);
    expectRejection(
      () => validateUploadBytes(oversized, "image/png"),
      "file_too_large",
    );
  });

  it("rejects an unsupported format even when the declared type says PNG", () => {
    // A JPEG renamed and re-labelled as a PNG: the bytes decide.
    expectRejection(
      () => validateUploadBytes(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0]), "image/png"),
      "unsupported_format",
    );
  });

  it("rejects SVG explicitly rather than as a generic unsupported format", () => {
    const error = expectRejection(
      () => validateUploadBytes(Buffer.from('<svg xmlns="x"><script/></svg>'), "image/svg+xml"),
      "svg_not_supported",
    );
    assert.match(error.message, /SVG/);
  });

  it("rejects a real PNG whose declared content type disagrees with it", () => {
    expectRejection(
      () => validateUploadBytes(toPngBytes(solidBlackExteriorArtwork()), "image/jpeg"),
      "format_mismatch",
    );
  });

  it("accepts a real PNG, with or without a declared type", () => {
    const bytes = toPngBytes(solidBlackExteriorArtwork());
    assert.equal(validateUploadBytes(bytes, "image/png").format, "image/png");
    assert.equal(validateUploadBytes(bytes, null).format, "image/png");
    // Browsers frequently send this for a drag-and-drop; the signature is
    // authoritative, so it must not be treated as a mismatch.
    assert.equal(
      validateUploadBytes(bytes, "application/octet-stream").format,
      "image/png",
    );
  });
});

describe("decode limits (enforced against the header, before any allocation)", () => {
  it("rejects dimensions beyond the per-axis bound", () => {
    expectRejection(
      () => assertDecodableDimensions(MAX_IMAGE_DIMENSION_PX + 1, 100),
      "image_too_large",
    );
  });

  it("rejects a pixel count beyond the total bound even when each axis is legal", () => {
    // 12000 x 11000 satisfies both axes and is ~528 MB of RGBA.
    expectRejection(
      () => assertDecodableDimensions(12_000, 11_000),
      "too_many_pixels",
    );
    assert.ok(12_000 <= MAX_IMAGE_DIMENSION_PX);
    assert.ok(12_000 * 11_000 > MAX_TOTAL_PIXELS);
  });

  it("rejects an image too small to print from", () => {
    expectRejection(() => assertDecodableDimensions(4, 4), "image_too_small");
  });

  it("stops a decompression bomb at the header, not at the bitmap", () => {
    // Tiny files that DECLARE enormous dimensions. Both rejections come from
    // the header check, so neither ever allocates a bitmap — the whole point
    // of checking before decoding.
    const oversizedAxis = pngHeaderBytes(30_000, 30_000);
    assert.ok(oversizedAxis.length < 1000);
    expectRejection(() => decodePngUpload(oversizedAxis), "image_too_large");

    // Within both per-axis bounds, but ~528 MB of RGBA once decoded.
    const oversizedArea = pngHeaderBytes(12_000, 11_000);
    assert.ok(oversizedArea.length < 1000);
    expectRejection(() => decodePngUpload(oversizedArea), "too_many_pixels");
  });
});

describe("malformed and truncated input", () => {
  it("rejects a truncated PNG cleanly", () => {
    const full = toPngBytes(solidBlackExteriorArtwork());
    const truncated = full.subarray(0, Math.floor(full.length / 2));
    expectRejection(() => decodePngUpload(truncated), "malformed_image");
  });

  it("rejects a PNG signature followed by garbage", () => {
    const corrupt = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(64, 0x41),
    ]);
    expectRejection(() => readPngHeader(corrupt), "malformed_image");
  });

  it("rejects a header declaring an impossible colour type", () => {
    const forged = pngHeaderBytes(64, 64);
    forged[25] = 9;
    expectRejection(() => readPngHeader(forged), "malformed_image");
  });

  it("decodes a real PNG to straight RGBA matching its header", () => {
    const image = solidBlackExteriorArtwork();
    const decoded = decodePngUpload(toPngBytes(image));

    assert.equal(decoded.image.width, image.width);
    assert.equal(decoded.image.height, image.height);
    assert.equal(decoded.image.data.length, image.width * image.height * 4);
    assert.ok(decoded.image.data.equals(image.data));
    assert.equal(decoded.header.declaresAlphaChannel, true);
  });

  it("reports a PNG with no alpha channel as declaring none", () => {
    const png = new PNG({ width: 32, height: 32, colorType: 2, inputColorType: 2 });
    png.data.fill(120);
    const header = readPngHeader(PNG.sync.write(png, { colorType: 2 }));
    assert.equal(header.declaresAlphaChannel, false);
  });
});

describe("sanitizeUploadFilename", () => {
  it("keeps an ordinary filename readable", () => {
    assert.equal(sanitizeUploadFilename("bowling-logo.png"), "bowling-logo.png");
    assert.equal(sanitizeUploadFilename("Team Logo 2026.PNG"), "Team Logo 2026.PNG");
  });

  it("strips POSIX and Windows path traversal", () => {
    assert.equal(sanitizeUploadFilename("../../etc/passwd"), "passwd");
    assert.equal(
      sanitizeUploadFilename("..\\..\\windows\\system32\\win.ini"),
      "win.ini",
    );
    assert.equal(sanitizeUploadFilename("/etc/shadow"), "shadow");
    assert.equal(sanitizeUploadFilename("C:\\Users\\eric\\secret.png"), "secret.png");
  });

  it("removes control characters and markup", () => {
    assert.equal(sanitizeUploadFilename("logo\u0000.png"), "logo.png");
    // Markup collapses to hyphens, and the resulting leading punctuation is
    // trimmed — a name may never start with a character that reads as a
    // path, a flag, or a hidden file.
    assert.equal(
      sanitizeUploadFilename('<img src=x onerror="alert(1)">.png'),
      "img src-x onerror-alert-1-.png",
    );
  });

  it("returns null rather than inventing a name when nothing safe survives", () => {
    assert.equal(sanitizeUploadFilename(".."), null);
    assert.equal(sanitizeUploadFilename("   "), null);
    assert.equal(sanitizeUploadFilename(null), null);
    assert.equal(sanitizeUploadFilename(undefined), null);
  });

  it("bounds the length", () => {
    const long = `${"a".repeat(500)}.png`;
    assert.ok(sanitizeUploadFilename(long)!.length <= 80);
  });
});
