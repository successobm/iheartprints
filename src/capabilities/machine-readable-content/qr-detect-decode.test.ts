import assert from "node:assert/strict";
import { test } from "node:test";

import QRCode from "qrcode";

import { decodeQrCodes, scanForQrFinderPatterns, type RgbaImage } from "./qr-detect-decode";

/** A blank RGBA canvas of a given color (default white), for compositing synthetic fixtures. */
function blankCanvas(width: number, height: number, color: [number, number, number] = [255, 255, 255]): RgbaImage {
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = color[0];
    data[i * 4 + 1] = color[1];
    data[i * 4 + 2] = color[2];
    data[i * 4 + 3] = 255;
  }
  return { width, height, data };
}

async function synthesizeQr(payload: string, sizePx = 300): Promise<RgbaImage> {
  const buf = await QRCode.toBuffer(payload, { errorCorrectionLevel: "H", margin: 4, width: sizePx });
  // toBuffer returns PNG bytes; decode with pngjs to get raw RGBA — reuse the same idiom the rest of this codebase uses.
  const { PNG } = await import("pngjs");
  const png = PNG.sync.read(buf);
  return { width: png.width, height: png.height, data: Buffer.from(png.data) };
}

function paste(canvas: RgbaImage, source: RgbaImage, atX: number, atY: number): void {
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
      canvas.data[di + 3] = 255;
    }
  }
}

test("decodeQrCodes: decodes a clean synthetic QR and reports its bounds", async () => {
  const qr = await synthesizeQr("https://example.com/booking");
  const results = decodeQrCodes(qr);
  assert.equal(results.length, 1);
  assert.equal(results[0].payload, "https://example.com/booking");
  assert.equal(results[0].kind, "qr");
  assert.ok(results[0].bounds.widthPx > 0 && results[0].bounds.heightPx > 0);
});

test("decodeQrCodes: returns empty for an image with no QR at all", () => {
  const blank = blankCanvas(400, 300);
  assert.deepEqual(decodeQrCodes(blank), []);
});

test("decodeQrCodes: finds multiple independent QR instances embedded in one larger canvas", async () => {
  const canvas = blankCanvas(900, 400);
  const qrA = await synthesizeQr("https://a.example.com", 200);
  const qrB = await synthesizeQr("https://b.example.com", 200);
  paste(canvas, qrA, 20, 20);
  paste(canvas, qrB, 600, 150);

  const results = decodeQrCodes(canvas, 4);
  const payloads = results.map((r) => r.payload).sort();
  assert.deepEqual(payloads, ["https://a.example.com", "https://b.example.com"]);
});

test("scanForQrFinderPatterns: detects a QR-shaped region even when the payload cannot be decoded (simulated damage)", async () => {
  const qr = await synthesizeQr("https://example.com/damaged-target", 300);
  // Simulate reconstruction damage: scramble the interior data modules
  // (leave the finder-pattern corners intact) so the symbol no longer
  // decodes but its finder-pattern signature survives — the exact
  // shape of damage a botched upscale can plausibly produce.
  const damaged: RgbaImage = { ...qr, data: Buffer.from(qr.data) };
  for (let y = 75; y < 225; y++) {
    for (let x = 75; x < 225; x++) {
      const i = (y * damaged.width + x) * 4;
      const v = (x + y) % 2 === 0 ? 0 : 255;
      damaged.data[i] = v;
      damaged.data[i + 1] = v;
      damaged.data[i + 2] = v;
    }
  }
  assert.deepEqual(decodeQrCodes(damaged), []);
  const detected = scanForQrFinderPatterns(damaged);
  assert.equal(detected.length, 1, "a QR-shaped region must still be detected even though it no longer decodes");
});

test("scanForQrFinderPatterns: does not false-positive on an image with no QR-like structure at all", () => {
  const blank = blankCanvas(500, 500);
  assert.deepEqual(scanForQrFinderPatterns(blank), []);

  // A single stripe pattern (not a finder pattern) must not trigger a
  // false detection either — this is the exact class of coincidental
  // striped/textured content real illustrated artwork can contain.
  const striped = blankCanvas(500, 500);
  for (let y = 0; y < 500; y++) {
    for (let x = 0; x < 500; x++) {
      if (Math.floor(x / 8) % 2 === 0) {
        const i = (y * 500 + x) * 4;
        striped.data[i] = 0;
        striped.data[i + 1] = 0;
        striped.data[i + 2] = 0;
      }
    }
  }
  assert.deepEqual(scanForQrFinderPatterns(striped), []);
});
