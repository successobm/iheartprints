/**
 * Constitution amendment 3.2 (§16A.2): QR detection/decoding must be
 * alpha-safe now that a Signs candidate can legitimately carry
 * transparency (the "remove" background treatment). Proves:
 *
 *   N. hidden RGB bytes beneath fully-transparent (alpha 0) pixels can
 *      never influence detection — an unpremultiplied PNG's "hidden"
 *      colour data is never meaningful for production, so it must never
 *      be meaningful for QR analysis either.
 *   O. a QR whose own pixels are fully opaque still decodes correctly
 *      when everything AROUND it is transparent (a governed "remove"
 *      result) — exactly as it would surrounded by any other colour.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import QRCode from "qrcode";

import { decodeQrCodes, type RgbaImage } from "./qr-detect-decode";

function transparentCanvas(width: number, height: number): RgbaImage {
  // alpha 0 everywhere; RGB left at 0 (Buffer.alloc zero-fills).
  return { width, height, data: Buffer.alloc(width * height * 4) };
}

async function synthesizeQr(payload: string, sizePx = 300): Promise<RgbaImage> {
  const buf = await QRCode.toBuffer(payload, { errorCorrectionLevel: "H", margin: 4, width: sizePx });
  const { PNG } = await import("pngjs");
  const png = PNG.sync.read(buf);
  return { width: png.width, height: png.height, data: Buffer.from(png.data) };
}

/** Pastes `source`'s RGB bytes, forcing every pasted pixel's alpha to `alpha` (never `source`'s own alpha). */
function pasteWithForcedAlpha(canvas: RgbaImage, source: RgbaImage, atX: number, atY: number, alpha: number): void {
  for (let y = 0; y < source.height; y++) {
    for (let x = 0; x < source.width; x++) {
      const si = (y * source.width + x) * 4;
      const dx = atX + x;
      const dy = atY + y;
      if (dx < 0 || dx >= canvas.width || dy < 0 || dy >= canvas.height) continue;
      const di = (dy * canvas.width + dx) * 4;
      canvas.data[di] = source.data[si];
      canvas.data[di + 1] = source.data[si + 1];
      canvas.data[di + 2] = source.data[si + 2];
      canvas.data[di + 3] = alpha;
    }
  }
}

test("N: a valid QR's own RGB bytes, pasted but forced fully transparent, decodes to NOTHING — hidden RGB under alpha=0 never influences detection", async () => {
  const qr = await synthesizeQr("https://example.com/hidden-under-alpha-zero");
  const canvas = transparentCanvas(400, 400);
  // The QR's real black/white module RGB bytes are present in the buffer
  // — exactly the "unpremultiplied PNG hides real colour under alpha=0"
  // shape the amendment's QR-safety requirement is written against — but
  // every one of those pixels is forced fully transparent.
  pasteWithForcedAlpha(canvas, qr, 50, 50, 0);

  const results = decodeQrCodes(canvas);
  assert.equal(results.length, 0);
});

test("N: a partially-transparent (alpha 128) QR does not decode as confidently/differently than its own alpha-blended appearance would predict — no special-cased raw-RGB path exists", async () => {
  const qr = await synthesizeQr("https://example.com/half-alpha");
  const opaqueCanvas = transparentCanvas(400, 400);
  pasteWithForcedAlpha(opaqueCanvas, qr, 50, 50, 255);
  const opaqueResults = decodeQrCodes(opaqueCanvas);
  assert.equal(opaqueResults.length, 1);
  assert.equal(opaqueResults[0]!.payload, "https://example.com/half-alpha");

  // At alpha 128 the modules are blended roughly halfway to neutral grey —
  // contrast is real but reduced. This is not asserted to always decode
  // (jsQR's own tolerance is not this module's contract); the point is
  // narrower and structural: it must never decode to a DIFFERENT payload
  // than the fully-opaque source encodes.
  const blendedCanvas = transparentCanvas(400, 400);
  pasteWithForcedAlpha(blendedCanvas, qr, 50, 50, 128);
  const blendedResults = decodeQrCodes(blendedCanvas);
  for (const result of blendedResults) {
    if (result.kind === "qr") {
      assert.equal(result.payload, "https://example.com/half-alpha");
    }
  }
});

test("O: a fully-opaque QR decodes correctly when everything around it is transparent (a governed REMOVE result)", async () => {
  const qr = await synthesizeQr("https://example.com/on-transparent-background");
  const canvas = transparentCanvas(500, 500);
  pasteWithForcedAlpha(canvas, qr, 100, 100, 255);

  const results = decodeQrCodes(canvas);
  assert.equal(results.length, 1);
  assert.equal(results[0]!.payload, "https://example.com/on-transparent-background");
  assert.equal(results[0]!.kind, "qr");
});

test("O: the SAME opaque QR decodes identically on a transparent background as on a white one — surrounding transparency changes nothing about the QR's own region", async () => {
  const qr = await synthesizeQr("https://example.com/consistency-check");

  const onTransparent = transparentCanvas(400, 400);
  pasteWithForcedAlpha(onTransparent, qr, 40, 40, 255);
  const transparentResults = decodeQrCodes(onTransparent);

  const onWhite: RgbaImage = { width: 400, height: 400, data: Buffer.alloc(400 * 400 * 4) };
  for (let i = 0; i < onWhite.width * onWhite.height; i++) {
    onWhite.data[i * 4] = 255;
    onWhite.data[i * 4 + 1] = 255;
    onWhite.data[i * 4 + 2] = 255;
    onWhite.data[i * 4 + 3] = 255;
  }
  pasteWithForcedAlpha(onWhite, qr, 40, 40, 255);
  const whiteResults = decodeQrCodes(onWhite);

  assert.equal(transparentResults.length, 1);
  assert.equal(whiteResults.length, 1);
  assert.equal(transparentResults[0]!.payload, whiteResults[0]!.payload);
});
