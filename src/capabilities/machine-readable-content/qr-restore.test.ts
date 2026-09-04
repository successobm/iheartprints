import assert from "node:assert/strict";
import { test } from "node:test";

import { PNG } from "pngjs";
import QRCode from "qrcode";

import { decodeQrCodes, type RgbaImage } from "./qr-detect-decode";
import {
  compositeQrRaster,
  generateReplacementQrRaster,
  localizeConfirmedDestinationReplacementRegion,
  mapSourceRegionToProportionalCandidateRegion,
  restoreAllFixableQrInstances,
  restoreFromConfirmedDestinations,
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

/**
 * QR REPAIR V2: a synchronous, real (not synthetic-noise) damaged-but-
 * localizable QR — generated via the SAME deterministic generator
 * production repair itself uses, then damaged in its central 25%-75% band
 * (the same proven-reliable parameters used throughout this whole
 * engagement's QR fixtures) so the 3 corner finder patterns remain fully
 * intact: `scanForQrFinderPatterns` confidently localizes it ("high"),
 * but `decodeQrCodes` cannot read it — exactly the real Get Hibachi shape
 * of "a genuinely undecodable, but locatable, QR-shaped candidate region."
 */
function damagedQrLike(sizePx: number, payload = "https://example.com/damaged-fixture"): RgbaImage {
  const raster = generateReplacementQrRaster(payload, sizePx, sizePx);
  const image: RgbaImage = { width: raster.width, height: raster.height, data: Buffer.from(raster.data) };
  const y0 = Math.floor(image.height * 0.25);
  const y1 = y0 + Math.floor(image.height * 0.5);
  const x0 = Math.floor(image.width * 0.25);
  const x1 = x0 + Math.floor(image.width * 0.5);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * image.width + x) * 4;
      const v = (x + y) % 2 === 0 ? 0 : 255;
      image.data[i] = v;
      image.data[i + 1] = v;
      image.data[i + 2] = v;
    }
  }
  return image;
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

// --- restoreFromConfirmedDestinations (SIGNS QR DESTINATION RESOLUTION) ---
//
// QR REPAIR V2: a `confirmed_destination` correction now requires the
// CANDIDATE to itself already carry corroborating QR-shaped evidence at
// (approximately) the mapped location — exactly the real Get Hibachi
// shape of the problem (a damaged-but-present QR block sitting in the
// candidate, not a blank canvas) — before automatic placement proceeds.
test("restoreFromConfirmedDestinations: composites an explicit confirmed payload into a candidate that already has a damaged/undecodable QR at the corroborating location", () => {
  const confirmedPayload = "https://get-hibachi.com/book-now";
  const candidateCanvas = blankCanvas(6144, 4096);
  const damagedQr = damagedQrLike(1200);
  // Same 4x proportional mapping used throughout this file (1198*4, 700*4).
  paste(candidateCanvas, damagedQr, 1198 * 4, 700 * 4);
  assert.deepEqual(decodeQrCodes(candidateCanvas), [], "sanity: the damaged QR must not already decode");

  const result = restoreFromConfirmedDestinations({
    candidate: candidateCanvas,
    sourceImageWidthPx: 1536,
    sourceImageHeightPx: 1024,
    corrections: [
      {
        sourceBounds: { xPx: 1198, yPx: 700, widthPx: 300, heightPx: 300 },
        sourceLocalizationConfidence: "high",
        payload: confirmedPayload,
      },
    ],
  });
  assert.equal(result.changed, true, `expected a change; unresolved=${JSON.stringify(result.unresolved)}`);
  assert.equal(result.restoredCount, 1);
  const decoded = decodeQrCodes({ width: candidateCanvas.width, height: candidateCanvas.height, data: result.data });
  assert.equal(decoded.length, 1);
  assert.equal(decoded[0].payload, confirmedPayload);
});

// --- QR REPAIR V2: the replacement safety gate ----------------------------

test("restoreFromConfirmedDestinations: low source localization confidence refuses replacement outright — nothing is composited", () => {
  const candidateCanvas = blankCanvas(6144, 4096);
  const damagedQr = damagedQrLike(1200);
  paste(candidateCanvas, damagedQr, 1198 * 4, 700 * 4);
  const before = Buffer.from(candidateCanvas.data);

  const result = restoreFromConfirmedDestinations({
    candidate: candidateCanvas,
    sourceImageWidthPx: 1536,
    sourceImageHeightPx: 1024,
    corrections: [
      {
        sourceBounds: { xPx: 1198, yPx: 700, widthPx: 300, heightPx: 300 },
        sourceLocalizationConfidence: "low",
        payload: "https://get-hibachi.com",
      },
    ],
  });
  assert.equal(result.changed, false);
  assert.equal(result.restoredCount, 0);
  assert.equal(result.unresolved.length, 1);
  assert.equal(result.unresolved[0].reason, "source_localization_low_confidence");
  assert.deepEqual(result.data, before, "a low-confidence region must never be composited into — zero pixels touched");
});

test("restoreFromConfirmedDestinations: candidate has no corroborating QR-shaped content at the mapped location — refused, fails closed (a blank/erased candidate region is never guessed)", () => {
  const candidateCanvas = blankCanvas(6144, 4096); // no QR-shaped content anywhere
  const before = Buffer.from(candidateCanvas.data);

  const result = restoreFromConfirmedDestinations({
    candidate: candidateCanvas,
    sourceImageWidthPx: 1536,
    sourceImageHeightPx: 1024,
    corrections: [
      {
        sourceBounds: { xPx: 1198, yPx: 700, widthPx: 300, heightPx: 300 },
        sourceLocalizationConfidence: "high",
        payload: "https://get-hibachi.com",
      },
    ],
  });
  assert.equal(result.changed, false);
  assert.equal(result.unresolved[0].reason, "candidate_localization_missing");
  assert.deepEqual(result.data, before);
});

test("restoreFromConfirmedDestinations: candidate localization disagrees materially with the mapped source region — refused, fails closed", () => {
  const candidateCanvas = blankCanvas(6144, 4096);
  const damagedQr = damagedQrLike(1200);
  // Paste the corroborating QR-shaped content FAR from where the source
  // mapping says it should be (source bounds below map to ~(4792,2800),
  // but the actual candidate evidence sits near the opposite corner).
  paste(candidateCanvas, damagedQr, 200, 200);
  const before = Buffer.from(candidateCanvas.data);

  const result = restoreFromConfirmedDestinations({
    candidate: candidateCanvas,
    sourceImageWidthPx: 1536,
    sourceImageHeightPx: 1024,
    corrections: [
      {
        sourceBounds: { xPx: 1198, yPx: 700, widthPx: 300, heightPx: 300 },
        sourceLocalizationConfidence: "high",
        payload: "https://get-hibachi.com",
      },
    ],
  });
  assert.equal(result.changed, false);
  assert.equal(result.unresolved[0].reason, "candidate_localization_missing");
  assert.deepEqual(result.data, before, "the far-away QR-shaped content must never be treated as corroboration for an unrelated mapped region");
});

test("restoreFromConfirmedDestinations: a malformed 2:1 source region (the real Get Hibachi defect shape) can never itself reach replacement — localizeConfirmedDestinationReplacementRegion refuses on confidence alone before any candidate scan", () => {
  // The exact real defect geometry: width = 2x height.
  const malformedBounds = { xPx: 982, yPx: 808, widthPx: 406, heightPx: 203 };
  const localized = localizeConfirmedDestinationReplacementRegion({
    sourceBounds: malformedBounds,
    sourceLocalizationConfidence: "low", // this is what the real detector actually reports for such a box
    sourceImageWidthPx: 1536,
    sourceImageHeightPx: 1024,
    candidate: blankCanvas(6144, 4096),
  });
  assert.equal(localized.ok, false);
  if (localized.ok) return;
  assert.equal(localized.reason, "source_localization_low_confidence");
});

test("localizeConfirmedDestinationReplacementRegion: a high-confidence, square source region with corroborating candidate evidence succeeds and returns the CANDIDATE's own detected bounds (not the naive mapped estimate)", () => {
  const candidateCanvas = blankCanvas(6144, 4096);
  const damagedQr = damagedQrLike(1200);
  paste(candidateCanvas, damagedQr, 1198 * 4, 700 * 4);

  const localized = localizeConfirmedDestinationReplacementRegion({
    sourceBounds: { xPx: 1198, yPx: 700, widthPx: 300, heightPx: 300 },
    sourceLocalizationConfidence: "high",
    sourceImageWidthPx: 1536,
    sourceImageHeightPx: 1024,
    candidate: candidateCanvas,
  });
  assert.equal(localized.ok, true);
  if (!localized.ok) return;
  // The mapped (naive) region would be exactly (4792, 2800, 1200, 1200) —
  // the candidate's own independently-detected region should be close to
  // that (same real QR), but is not required to be pixel-identical to it.
  assert.ok(Math.abs(localized.region.xPx - 4792) < 400);
  assert.ok(Math.abs(localized.region.yPx - 2800) < 400);
});

test("two QR codes, well-separated: each corrects independently — corroboration for one never absorbs or is confused by the other", () => {
  const candidateCanvas = blankCanvas(6144, 4096);
  const qrA = damagedQrLike(900);
  const qrB = damagedQrLike(900);
  paste(candidateCanvas, qrA, 300, 300); // top-left
  paste(candidateCanvas, qrB, 4800, 2900); // bottom-right, well separated

  const result = restoreFromConfirmedDestinations({
    candidate: candidateCanvas,
    sourceImageWidthPx: 1536,
    sourceImageHeightPx: 1024,
    corrections: [
      {
        sourceBounds: { xPx: 75, yPx: 75, widthPx: 225, heightPx: 225 }, // maps to ~(300,300) at x4
        sourceLocalizationConfidence: "high",
        payload: "https://example.com/a",
      },
      {
        sourceBounds: { xPx: 1200, yPx: 725, widthPx: 225, heightPx: 225 }, // maps to ~(4800,2900) at x4
        sourceLocalizationConfidence: "high",
        payload: "https://example.com/b",
      },
    ],
  });
  assert.equal(result.restoredCount, 2, `expected both to resolve independently; unresolved=${JSON.stringify(result.unresolved)}`);
  const decoded = decodeQrCodes({ width: candidateCanvas.width, height: candidateCanvas.height, data: result.data }, 4);
  const payloads = decoded.map((d) => d.payload).sort();
  assert.deepEqual(payloads, ["https://example.com/a", "https://example.com/b"]);
});

test("a QR-shaped region sitting beside an unrelated graphic (the real Get Hibachi shape: 'FOLLOW US' text/social icons next to the QR card) never has that neighboring content absorbed or overwritten", () => {
  const candidateCanvas = blankCanvas(6144, 4096, [250, 250, 250]);
  // An unrelated solid block standing in for "FOLLOW US" + social icons —
  // placed directly adjacent to (but outside) the QR's own footprint.
  const neighborX0 = 3000, neighborY0 = 2800, neighborX1 = 4700, neighborY1 = 3600;
  for (let y = neighborY0; y < neighborY1; y++) {
    for (let x = neighborX0; x < neighborX1; x++) {
      const i = (y * candidateCanvas.width + x) * 4;
      candidateCanvas.data[i] = 20;
      candidateCanvas.data[i + 1] = 120;
      candidateCanvas.data[i + 2] = 20;
    }
  }
  const damagedQr = damagedQrLike(900);
  paste(candidateCanvas, damagedQr, 4800, 2800); // well clear of the neighbor block
  const before = Buffer.from(candidateCanvas.data);

  const result = restoreFromConfirmedDestinations({
    candidate: candidateCanvas,
    sourceImageWidthPx: 1536,
    sourceImageHeightPx: 1024,
    corrections: [
      {
        sourceBounds: { xPx: 1200, yPx: 700, widthPx: 225, heightPx: 225 }, // maps to ~(4800,2800) at x4
        sourceLocalizationConfidence: "high",
        payload: "https://example.com/beside-neighbor",
      },
    ],
  });
  assert.equal(result.restoredCount, 1, `unresolved=${JSON.stringify(result.unresolved)}`);

  // The neighboring block must be byte-for-byte unchanged.
  for (let y = neighborY0; y < neighborY1; y++) {
    for (let x = neighborX0; x < neighborX1; x++) {
      const i = (y * candidateCanvas.width + x) * 4;
      assert.equal(result.data[i], before[i], `neighbor pixel (${x},${y}) R channel changed`);
      assert.equal(result.data[i + 1], before[i + 1], `neighbor pixel (${x},${y}) G channel changed`);
      assert.equal(result.data[i + 2], before[i + 2], `neighbor pixel (${x},${y}) B channel changed`);
    }
  }
  const decoded = decodeQrCodes({ width: candidateCanvas.width, height: candidateCanvas.height, data: result.data });
  assert.equal(decoded[0]?.payload, "https://example.com/beside-neighbor");
});

test("the changed-pixel bounding box after a validated replacement is entirely contained within the localized region — the compositing area itself was first proven to belong to the QR, not merely bounded", () => {
  const candidateCanvas = blankCanvas(6144, 4096);
  const damagedQr = damagedQrLike(1200);
  paste(candidateCanvas, damagedQr, 1198 * 4, 700 * 4);
  const before = Buffer.from(candidateCanvas.data);

  const localized = localizeConfirmedDestinationReplacementRegion({
    sourceBounds: { xPx: 1198, yPx: 700, widthPx: 300, heightPx: 300 },
    sourceLocalizationConfidence: "high",
    sourceImageWidthPx: 1536,
    sourceImageHeightPx: 1024,
    candidate: candidateCanvas,
  });
  assert.equal(localized.ok, true);
  if (!localized.ok) return;

  const result = restoreQrInCandidate({
    candidate: candidateCanvas,
    sourceBounds: { xPx: 1198, yPx: 700, widthPx: 300, heightPx: 300 },
    sourceImageWidthPx: 1536,
    sourceImageHeightPx: 1024,
    verifiedPayload: "https://example.com/bounded",
    regionOverride: localized.region,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let y = 0; y < candidateCanvas.height; y++) {
    for (let x = 0; x < candidateCanvas.width; x++) {
      const i = (y * candidateCanvas.width + x) * 4;
      if (result.data[i] !== before[i] || result.data[i + 1] !== before[i + 1] || result.data[i + 2] !== before[i + 2]) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  const region = localized.region;
  assert.ok(minX >= region.xPx, `changed pixels extend left of the validated region: minX=${minX}, region.xPx=${region.xPx}`);
  assert.ok(minY >= region.yPx, `changed pixels extend above the validated region: minY=${minY}, region.yPx=${region.yPx}`);
  assert.ok(maxX < region.xPx + region.widthPx, `changed pixels extend right of the validated region`);
  assert.ok(maxY < region.yPx + region.heightPx, `changed pixels extend below the validated region`);
});
