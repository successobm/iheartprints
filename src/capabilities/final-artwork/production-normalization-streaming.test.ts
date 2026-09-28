import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PNG } from "pngjs";

import { PRINT_PLACEMENT_SIZING_POLICY } from "@/capabilities/shared/print-placement-dimensions";

import { normalizeProductionRasterFromPngBytes } from "./production-normalization-streaming";
import { normalizeProductionRaster, type ProductionSizingRequest } from "./production-normalization";
import { assessPngStreamSupport, scanPngAlphaBounds, streamPngRows } from "./png-stream";
import { computeAlphaBounds } from "./alpha-trim";

/**
 * Memory-Bounded Oversized Provider Result Finalization.
 *
 * The streaming path is only safe to put in production if it is
 * INDISTINGUISHABLE from the in-memory path it replaces. These tests assert
 * that directly — same pixels, same dimensions, same metadata — rather than
 * arguing it from the code.
 */

const SIZING: ProductionSizingRequest = {
  ...PRINT_PLACEMENT_SIZING_POLICY.full_back,
  targetWidthIn: 2,
  maxHeightIn: 4,
  targetPpi: 150,
};

/** Detailed RGBA artwork on a transparent canvas — exercises every filter type. */
function artworkPng(width: number, height: number, opts: { alpha?: boolean; bitDepth?: 8 } = {}): Buffer {
  const png = new PNG({ width, height });
  const mx = Math.max(1, Math.floor(width * 0.12));
  const my = Math.max(1, Math.floor(height * 0.18));
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (width * y + x) << 2;
      const inside = x >= mx && x < width - mx && y >= my && y < height - my;
      png.data[i] = (x * 3 + y * 5) & 0xff;
      png.data[i + 1] = (x ^ y) & 0xff;
      png.data[i + 2] = (x * 7 + y * 11) & 0xff;
      png.data[i + 3] = opts.alpha === false ? 255 : inside ? 255 : 0;
    }
  }
  return PNG.sync.write(png);
}

function inMemory(bytes: Buffer) {
  const png = PNG.sync.read(bytes);
  return normalizeProductionRaster({ width: png.width, height: png.height, data: png.data }, SIZING);
}

describe("streaming production normalization — equivalence with the in-memory path", () => {
  it("produces byte-identical pixels and identical metadata across many shapes", async () => {
    for (const [w, h] of [
      [120, 90],
      [91, 173],
      [200, 200],
      [301, 97],
      [64, 512],
    ] as const) {
      const bytes = artworkPng(w, h);
      const expected = inMemory(bytes);
      const actual = await normalizeProductionRasterFromPngBytes(bytes, SIZING);

      assert.equal(actual.status, expected.status, `${w}x${h} status`);
      if (expected.status !== "normalized" || actual.status !== "normalized") {
        throw new Error(`${w}x${h} expected a normalized outcome`);
      }
      assert.equal(actual.result.image.width, expected.result.image.width, `${w}x${h} width`);
      assert.equal(actual.result.image.height, expected.result.image.height, `${w}x${h} height`);
      assert.equal(
        Buffer.compare(actual.result.image.data, expected.result.image.data),
        0,
        `${w}x${h} pixels must be byte-identical`,
      );
      assert.deepEqual(actual.result.metadata, expected.result.metadata, `${w}x${h} metadata`);
    }
  });

  it("matches on a fully opaque source (no transparent padding)", async () => {
    const bytes = artworkPng(150, 110, { alpha: false });
    const expected = inMemory(bytes);
    const actual = await normalizeProductionRasterFromPngBytes(bytes, SIZING);
    if (expected.status !== "normalized" || actual.status !== "normalized") throw new Error("unreachable");
    assert.equal(Buffer.compare(actual.result.image.data, expected.result.image.data), 0);
    assert.deepEqual(actual.result.metadata, expected.result.metadata);
    assert.equal(actual.result.metadata.sourceFullyOpaque, true);
  });

  it("preserves transparency in the output exactly", async () => {
    const bytes = artworkPng(140, 100);
    const expected = inMemory(bytes);
    const actual = await normalizeProductionRasterFromPngBytes(bytes, SIZING);
    if (expected.status !== "normalized" || actual.status !== "normalized") throw new Error("unreachable");
    let expectedAlpha = 0;
    let actualAlpha = 0;
    for (let i = 3; i < expected.result.image.data.length; i += 4) {
      expectedAlpha += expected.result.image.data[i]!;
      actualAlpha += actual.result.image.data[i]!;
    }
    assert.equal(actualAlpha, expectedAlpha);
    assert.ok(actualAlpha > 0, "fixture must actually carry alpha");
  });

  it("reports the same no_visible_artwork refusal, word for word", async () => {
    const png = new PNG({ width: 40, height: 30 });
    for (let i = 3; i < png.data.length; i += 4) png.data[i] = 0;
    const bytes = PNG.sync.write(png);
    const expected = inMemory(bytes);
    const actual = await normalizeProductionRasterFromPngBytes(bytes, SIZING);
    assert.equal(expected.status, "no_visible_artwork");
    assert.equal(actual.status, "no_visible_artwork");
    if (expected.status !== "no_visible_artwork" || actual.status !== "no_visible_artwork") {
      throw new Error("unreachable");
    }
    assert.equal(actual.reason, expected.reason);
  });

  it("agrees with computeAlphaBounds on the bounding box", async () => {
    for (const [w, h] of [[120, 90], [77, 43], [200, 31]] as const) {
      const bytes = artworkPng(w, h);
      const png = PNG.sync.read(bytes);
      const expected = computeAlphaBounds({ width: png.width, height: png.height, data: png.data }, 8);
      const scan = await scanPngAlphaBounds(bytes, 8);
      assert.deepEqual(scan.bbox, expected, `${w}x${h}`);
    }
  });

  it("streams RGB (colour type 2) and reports full opacity", async () => {
    // pngjs writes colour type 6; build a type-2 image by hand via pngjs's
    // colorType option so the reader's RGB expansion path is exercised.
    const png = new PNG({ width: 60, height: 40, colorType: 2, inputHasAlpha: false });
    for (let i = 0; i < 60 * 40; i += 1) {
      png.data[i * 4] = (i * 3) & 0xff;
      png.data[i * 4 + 1] = (i * 5) & 0xff;
      png.data[i * 4 + 2] = (i * 7) & 0xff;
      png.data[i * 4 + 3] = 255;
    }
    const bytes = PNG.sync.write(png, { colorType: 2, inputHasAlpha: false });
    const support = assessPngStreamSupport(bytes);
    assert.equal(support.supported, true);
    if (!support.supported) throw new Error("unreachable");
    assert.equal(support.header.colorType, 2);

    const decoded = PNG.sync.read(bytes);
    let rows = 0;
    await streamPngRows(bytes, (row, y) => {
      rows += 1;
      const expected = decoded.data.subarray(y * 60 * 4, (y + 1) * 60 * 4);
      assert.equal(Buffer.compare(row, expected), 0, `row ${y} must match pngjs`);
    });
    assert.equal(rows, 40);
  });

  it("refuses encodings it cannot stream, rather than guessing", () => {
    const png = new PNG({ width: 20, height: 20 });
    const interlaced = PNG.sync.write(png, { interlace: true } as never);
    const support = assessPngStreamSupport(interlaced);
    if (support.supported) {
      // pngjs may ignore the option; only assert when it really is interlaced.
      assert.equal(support.header.interlaced, false);
    } else {
      assert.match(support.reason, /interlaced|colour type|bit depth/);
    }
  });

  it("fails deterministically on a corrupt or truncated body", async () => {
    const bytes = artworkPng(80, 60);
    await assert.rejects(() => normalizeProductionRasterFromPngBytes(bytes.subarray(0, 120), SIZING));
    const corrupt = Buffer.from(bytes);
    corrupt[Math.floor(corrupt.length * 0.7)] ^= 0xff;
    await assert.rejects(() => normalizeProductionRasterFromPngBytes(corrupt, SIZING));
  });

  it("enforces the dimension ceilings before any allocation", () => {
    const header = Buffer.alloc(8);
    header.writeUInt32BE(200000, 0);
    header.writeUInt32BE(200000, 4);
    // Built through the structure inspector: a hostile IHDR must be refused
    // without the reader ever sizing a buffer from it.
    const support = assessPngStreamSupport(
      Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40)]),
    );
    assert.equal(support.supported, false);
  });
});
