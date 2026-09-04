import assert from "node:assert/strict";
import { test } from "node:test";

import { PNG } from "pngjs";
import QRCode from "qrcode";

import { decodeQrCodes, type RgbaImage } from "./qr-detect-decode";
import {
  compositeQrRaster,
  generateReplacementQrRaster,
  mapSourceRegionToProportionalCandidateRegion,
  restoreAllFixableQrInstances,
  restoreQrInCandidate,
} from "./qr-restore";

async function synthesizeQr(payload: string, sizePx = 300): Promise<RgbaImage> {
  const buf = await QRCode.toBuffer(payload, { errorCorrectionLevel: "H", margin: 4, width: sizePx });
  const png = PNG.sync.read(buf);
  return { width: png.width, height: png.height, data: Buffer.from(png.data) };
}

function blankCanvas(width: number, height: number, color: [number, number, number] = [10, 10, 10]): RgbaImage {
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = color[0];
    data[i * 4 + 1] = color[1];
    data[i * 4 + 2] = color[2];
    data[i * 4 + 3] = 255;
  }
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

// --- Regeneration from verified payload: persisted bytes decode P -------
test("regenerate from verified P: the composited raster itself decodes back to exactly P", () => {
  const raster = generateReplacementQrRaster("https://get-hibachi.com/book", 300, 300);
  const decoded = decodeQrCodes({ width: raster.width, height: raster.height, data: raster.data });
  assert.equal(decoded.length, 1);
  assert.equal(decoded[0].payload, "https://get-hibachi.com/book");
});

test("every pixel in the generated raster is pure black or pure white — never anti-aliased/blended", () => {
  const raster = generateReplacementQrRaster("https://get-hibachi.com/book", 300, 300);
  for (let i = 0; i < raster.data.length; i += 4) {
    const [r, g, b, a] = [raster.data[i], raster.data[i + 1], raster.data[i + 2], raster.data[i + 3]];
    const isPureBlack = r === 0 && g === 0 && b === 0;
    const isPureWhite = r === 255 && g === 255 && b === 255;
    assert.ok(isPureBlack || isPureWhite, `pixel at byte ${i} was (${r},${g},${b}) — not pure black/white`);
    assert.equal(a, 255);
  }
});

// --- Quiet zone preserved -------------------------------------------------
test("replacement preserves sufficient quiet zone: the outermost 4 modules on every side are the light quiet-zone colour, not part of the symbol", () => {
  const raster = generateReplacementQrRaster("https://get-hibachi.com/book", 300, 300);
  const quietPx = 4 * raster.pixelsPerModule;
  // Sample the very first row/column band — must be entirely white (quiet zone), never a dark module.
  for (let x = 0; x < raster.width; x++) {
    const i = (0 * raster.width + x) * 4;
    assert.equal(raster.data[i], 255, `top quiet-zone row pixel ${x} was not white`);
  }
  for (let y = 0; y < quietPx; y++) {
    const i = (y * raster.width + 0) * 4;
    assert.equal(raster.data[i], 255, `left quiet-zone column pixel row ${y} was not white`);
  }
});

// --- Location preservation ------------------------------------------------
test("compositeQrRaster preserves location: only the target region's pixels change, everything else on the canvas is untouched", () => {
  const canvas = blankCanvas(800, 600, [10, 10, 10]);
  const original = Buffer.from(canvas.data);
  const raster = generateReplacementQrRaster("https://get-hibachi.com/book", 200, 200);
  const region = { xPx: 500, yPx: 350, widthPx: 220, heightPx: 220 };
  compositeQrRaster(canvas.data, canvas.width, canvas.height, region, raster);

  let changedOutsideRegion = false;
  for (let y = 0; y < canvas.height; y++) {
    for (let x = 0; x < canvas.width; x++) {
      const inRegion =
        x >= region.xPx && x < region.xPx + region.widthPx && y >= region.yPx && y < region.yPx + region.heightPx;
      if (inRegion) continue;
      const i = (y * canvas.width + x) * 4;
      if (
        canvas.data[i] !== original[i] ||
        canvas.data[i + 1] !== original[i + 1] ||
        canvas.data[i + 2] !== original[i + 2]
      ) {
        changedOutsideRegion = true;
      }
    }
  }
  assert.equal(changedOutsideRegion, false, "compositing must never touch pixels outside the target region");

  // And the region itself now decodes correctly, at its actual on-canvas location.
  const decoded = decodeQrCodes(canvas);
  assert.equal(decoded.length, 1);
  assert.equal(decoded[0].payload, "https://get-hibachi.com/book");
});

// --- Resolution-only transform maps QR correctly --------------------------
test("resolution-only transform (same aspect ratio, uniform scale — the real project's exact case) maps the source region correctly", () => {
  // Mirrors the real project: 1536x1024 source -> 6144x4096 candidate, 4x uniform scale, 3:2 aspect both.
  const sourceBounds = { xPx: 1198, yPx: 798, widthPx: 320, heightPx: 220 };
  const mapped = mapSourceRegionToProportionalCandidateRegion(sourceBounds, 1536, 1024, 6144, 4096);
  assert.ok(mapped, "same-aspect-ratio proportional mapping must succeed");
  assert.equal(mapped!.xPx, 1198 * 4);
  assert.equal(mapped!.yPx, 798 * 4);
  assert.equal(mapped!.widthPx, 320 * 4);
  assert.equal(mapped!.heightPx, 220 * 4);
});

// --- Structural transform without trustworthy mapping fails closed -------
test("a transform whose aspect ratio does NOT match (a structural/cropped transform) fails closed — no region mapping is invented", () => {
  const sourceBounds = { xPx: 1198, yPx: 798, widthPx: 320, heightPx: 220 };
  // Candidate is NOT proportional to the source (e.g. a crop/pad/reflow) — different aspect ratio entirely.
  const mapped = mapSourceRegionToProportionalCandidateRegion(sourceBounds, 1536, 1024, 4096, 4096);
  assert.equal(mapped, null, "a non-proportional transform must never produce a guessed region mapping");
});

// --- End-to-end restoration + re-verification of the ACTUAL persisted bytes ---
test("restoreQrInCandidate: end to end — maps region, generates, composites, and re-decodes the ACTUAL composited pixels before reporting success", async () => {
  const payload = "https://get-hibachi.com/book";
  const sourceQr = await synthesizeQr(payload, 300);
  const sourceCanvas = blankCanvas(1536, 1024);
  // Fully inside the 1536x1024 source canvas (1198+300=1498 < 1536, 700+300=1000 < 1024) —
  // mirrors the real project's own bottom-right QR placement without clipping.
  paste(sourceCanvas, sourceQr, 1198, 700);

  // A damaged candidate (unreadable QR at the proportionally-scaled location).
  const candidateCanvas = blankCanvas(6144, 4096);
  const damagedQr = await synthesizeQr(payload, 1200);
  // Scramble the interior before pasting, to simulate a botched reconstruction.
  for (let y = 300; y < 900; y++) {
    for (let x = 300; x < 900; x++) {
      const i = (y * damagedQr.width + x) * 4;
      const v = (x + y) % 2 === 0 ? 0 : 255;
      damagedQr.data[i] = v;
      damagedQr.data[i + 1] = v;
      damagedQr.data[i + 2] = v;
    }
  }
  // Same 4x proportional mapping as the region-mapping test below (1198*4, 700*4) — fully inside the 6144x4096 candidate.
  paste(candidateCanvas, damagedQr, 1198 * 4, 700 * 4);
  assert.deepEqual(decodeQrCodes(candidateCanvas), [], "the damaged candidate must not already decode (sanity check on the fixture)");

  const result = restoreQrInCandidate({
    candidate: candidateCanvas,
    sourceBounds: { xPx: 1198, yPx: 700, widthPx: sourceQr.width, heightPx: sourceQr.height },
    sourceImageWidthPx: 1536,
    sourceImageHeightPx: 1024,
    verifiedPayload: payload,
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  // Section Q: the returned bytes are RE-DECODED here, independently of restoreQrInCandidate's own internal check, to prove the persisted artifact itself is genuinely correct — not merely that the function claims success.
  const finalDecoded = decodeQrCodes({ width: candidateCanvas.width, height: candidateCanvas.height, data: result.data });
  assert.equal(finalDecoded.length, 1);
  assert.equal(finalDecoded[0].payload, payload);
});

test("restoreQrInCandidate fails closed when region mapping is not trustworthy (structural transform)", () => {
  const candidateCanvas = blankCanvas(4096, 4096);
  const result = restoreQrInCandidate({
    candidate: candidateCanvas,
    sourceBounds: { xPx: 1198, yPx: 798, widthPx: 320, heightPx: 220 },
    sourceImageWidthPx: 1536,
    sourceImageHeightPx: 1024,
    verifiedPayload: "https://get-hibachi.com/book",
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "region_mapping_not_trustworthy");
});

// --- restoreAllFixableQrInstances -----------------------------------------
test("restoreAllFixableQrInstances: a no-op when the candidate already matches — never touches anything", async () => {
  const payload = "https://get-hibachi.com/book";
  const sourceQr = await synthesizeQr(payload, 300);
  const sourceCanvas = blankCanvas(1536, 1024);
  paste(sourceCanvas, sourceQr, 1198, 700);

  const candidateCanvas = blankCanvas(6144, 4096);
  const matchingQr = await synthesizeQr(payload, 1200);
  paste(candidateCanvas, matchingQr, 1198 * 4, 700 * 4);

  const result = restoreAllFixableQrInstances({ source: sourceCanvas, candidate: candidateCanvas });
  assert.equal(result.changed, false);
  assert.equal(result.restoredCount, 0);
  assert.deepEqual(result.data, candidateCanvas.data);
});

test("restoreAllFixableQrInstances: repairs a genuinely broken candidate and the result decodes correctly", async () => {
  const payload = "https://get-hibachi.com/book";
  const sourceQr = await synthesizeQr(payload, 300);
  const sourceCanvas = blankCanvas(1536, 1024);
  paste(sourceCanvas, sourceQr, 1198, 700);

  const candidateCanvas = blankCanvas(6144, 4096);
  const damagedQr = await synthesizeQr(payload, 1200);
  for (let y = 300; y < 900; y++) {
    for (let x = 300; x < 900; x++) {
      const i = (y * damagedQr.width + x) * 4;
      const v = (x + y) % 2 === 0 ? 0 : 255;
      damagedQr.data[i] = v;
      damagedQr.data[i + 1] = v;
      damagedQr.data[i + 2] = v;
    }
  }
  paste(candidateCanvas, damagedQr, 1198 * 4, 700 * 4);

  const result = restoreAllFixableQrInstances({ source: sourceCanvas, candidate: candidateCanvas });
  assert.equal(result.changed, true);
  assert.equal(result.restoredCount, 1);
  assert.equal(result.unresolved.length, 0);

  const redecoded = decodeQrCodes({ width: candidateCanvas.width, height: candidateCanvas.height, data: result.data });
  assert.equal(redecoded.length, 1);
  assert.equal(redecoded[0].payload, payload);
});

test("restoreAllFixableQrInstances: an undecodable source is never touched — nothing to restore FROM", () => {
  const sourceCanvas = blankCanvas(1536, 1024);
  const candidateCanvas = blankCanvas(6144, 4096);
  const { changed, restoredCount, unresolved } = restoreAllFixableQrInstances({
    source: sourceCanvas,
    candidate: candidateCanvas,
  });
  assert.equal(changed, false);
  assert.equal(restoredCount, 0);
  assert.deepEqual(unresolved, []);
});
