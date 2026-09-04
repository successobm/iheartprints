import assert from "node:assert/strict";
import { test } from "node:test";

import { PNG } from "pngjs";
import QRCode from "qrcode";

import { compareMachineReadableContent } from "./qr-preservation";
import type { RgbaImage } from "./qr-detect-decode";

async function synthesizeQr(payload: string, sizePx = 300): Promise<RgbaImage> {
  const buf = await QRCode.toBuffer(payload, { errorCorrectionLevel: "H", margin: 4, width: sizePx });
  const png = PNG.sync.read(buf);
  return { width: png.width, height: png.height, data: Buffer.from(png.data) };
}

function blankCanvas(width: number, height: number): RgbaImage {
  const data = Buffer.alloc(width * height * 4, 255);
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  return { width, height, data };
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

function damageInterior(image: RgbaImage): RgbaImage {
  const damaged: RgbaImage = { ...image, data: Buffer.from(image.data) };
  const midY = Math.floor(image.height * 0.25);
  const midX = Math.floor(image.width * 0.25);
  for (let y = midY; y < midY + Math.floor(image.height * 0.5); y++) {
    for (let x = midX; x < midX + Math.floor(image.width * 0.5); x++) {
      const i = (y * damaged.width + x) * 4;
      const v = (x + y) % 2 === 0 ? 0 : 255;
      damaged.data[i] = v;
      damaged.data[i + 1] = v;
      damaged.data[i + 2] = v;
    }
  }
  return damaged;
}

// --- 1: pass -----------------------------------------------------------
test("pass: source decodes P, candidate decodes the SAME P", async () => {
  const source = await synthesizeQr("https://get-hibachi.com/book");
  const candidate = await synthesizeQr("https://get-hibachi.com/book", 600); // resized, same payload
  const report = compareMachineReadableContent(source, candidate);
  assert.equal(report.overall, "pass");
  assert.equal(report.instances.length, 1);
  assert.equal(report.instances[0].result, "pass");
  assert.equal(report.instances[0].sourceDecodable, true);
  assert.equal(report.instances[0].candidateDecodable, true);
});

// --- 2: fail (source decodable, candidate unreadable) -------------------
test("fail: source decodes P, candidate is unreadable (damaged reconstruction)", async () => {
  const source = await synthesizeQr("https://get-hibachi.com/book");
  const candidate = damageInterior(await synthesizeQr("https://get-hibachi.com/book"));
  const report = compareMachineReadableContent(source, candidate);
  assert.equal(report.overall, "fail");
  assert.equal(report.instances[0].result, "fail");
  assert.equal(report.instances[0].sourceDecodable, true);
  assert.equal(report.instances[0].candidateDecodable, false);
});

// --- 3: hard_fail (candidate decodes a DIFFERENT payload) ---------------
test("hard_fail: source decodes P, candidate decodes a DIFFERENT payload Q", async () => {
  const source = await synthesizeQr("https://get-hibachi.com/book");
  const candidate = await synthesizeQr("https://not-the-same-destination.example.com");
  const report = compareMachineReadableContent(source, candidate);
  assert.equal(report.overall, "hard_fail");
  assert.equal(report.instances[0].result, "hard_fail");
  assert.ok(report.instances[0].candidatePayloadSha256 !== report.instances[0].sourcePayloadSha256);
});

// --- 4: review_required (source itself is not reliably decodable) -------
test("review_required: source is not reliably decodable at all — candidate's state is irrelevant", async () => {
  const source = damageInterior(await synthesizeQr("https://get-hibachi.com/book"));
  const candidateAlsoUnreadable = damageInterior(await synthesizeQr("https://get-hibachi.com/book"));
  const report = compareMachineReadableContent(source, candidateAlsoUnreadable);
  assert.equal(report.overall, "review_required");
  assert.equal(report.instances[0].sourceDecodable, false);
  assert.equal(report.instances[0].sourcePayloadSha256, null);
});

test("review_required is never silently treated as pass or upgraded to fail — it is its own case", async () => {
  const source = damageInterior(await synthesizeQr("https://get-hibachi.com/book"));
  // Candidate happens to decode fine (a real functioning QR) — still
  // review_required, because nothing proves the SOURCE ever worked, so
  // nothing can be claimed about what "preserved" even means here.
  const candidateDecodable = await synthesizeQr("https://get-hibachi.com/book");
  const report = compareMachineReadableContent(source, candidateDecodable);
  assert.equal(report.overall, "review_required");
});

// --- 5: not_applicable (no QR at all) ------------------------------------
test("not_applicable: no QR-shaped region anywhere in the source", () => {
  const source = blankCanvas(1200, 800);
  const candidate = blankCanvas(2400, 1600);
  const report = compareMachineReadableContent(source, candidate);
  assert.equal(report.overall, "not_applicable");
  assert.deepEqual(report.instances, []);
});

// --- Multiple QR codes: independent identities ---------------------------
test("multiple QR codes retain independent identities and independent results", async () => {
  const sourceCanvas = blankCanvas(900, 400);
  const qrA = await synthesizeQr("https://a.example.com", 200);
  const qrB = await synthesizeQr("https://b.example.com", 200);
  paste(sourceCanvas, qrA, 20, 20);
  paste(sourceCanvas, qrB, 600, 150);

  const candidateCanvas = blankCanvas(900, 400);
  // A survives intact; B decodes to a DIFFERENT payload (hard_fail) in the candidate.
  const qrBReplaced = await synthesizeQr("https://hijacked.example.com", 200);
  paste(candidateCanvas, qrA, 20, 20);
  paste(candidateCanvas, qrBReplaced, 600, 150);

  const report = compareMachineReadableContent(sourceCanvas, candidateCanvas);
  assert.equal(report.instances.length, 2);
  const results = report.instances.map((i) => i.result).sort();
  assert.deepEqual(results, ["hard_fail", "pass"]);
  // Overall reflects the WORST instance.
  assert.equal(report.overall, "hard_fail");
});

// --- Security: payload is compared/hashed only, never fetched -----------
test("a payload containing a URL is never fetched, opened, or resolved — only compared", async () => {
  let networkCallMade = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((...args: unknown[]) => {
    networkCallMade = true;
    throw new Error(`fetch must never be called by preservation comparison; called with ${JSON.stringify(args)}`);
  }) as typeof fetch;
  try {
    const source = await synthesizeQr("https://get-hibachi.com/book-a-real-network-endpoint");
    const candidate = await synthesizeQr("https://get-hibachi.com/book-a-real-network-endpoint", 500);
    const report = compareMachineReadableContent(source, candidate);
    assert.equal(report.overall, "pass");
    assert.equal(networkCallMade, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("evidence never carries the raw payload — only a SHA-256 hash", async () => {
  const source = await synthesizeQr("https://get-hibachi.com/super-secret-looking-path");
  const candidate = await synthesizeQr("https://get-hibachi.com/super-secret-looking-path", 500);
  const report = compareMachineReadableContent(source, candidate);
  const serialized = JSON.stringify(report);
  assert.doesNotMatch(serialized, /super-secret-looking-path/);
  assert.match(report.instances[0].sourcePayloadSha256 ?? "", /^[0-9a-f]{64}$/);
});
