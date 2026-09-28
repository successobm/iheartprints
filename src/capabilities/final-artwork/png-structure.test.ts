import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deflateSync } from "node:zlib";
import { PNG } from "pngjs";

import {
  inspectPngStructure,
  MAX_PROVIDER_RESULT_DIMENSION_PX,
  MAX_PROVIDER_RESULT_PIXELS,
} from "./png-structure";

/**
 * Pre-Durability PNG Decode Removal: the header-and-chunk inspector that
 * replaced `PNG.sync.read` at the download boundary. These tests exist to
 * prove the trade was safe — that removing the full decode did NOT remove
 * the corruption detection it incidentally provided.
 */

function realPng(width: number, height: number): Buffer {
  const png = new PNG({ width, height });
  for (let i = 0; i < width * height; i += 1) {
    png.data[i * 4] = (i * 7) & 0xff;
    png.data[i * 4 + 1] = (i * 13) & 0xff;
    png.data[i * 4 + 2] = (i * 29) & 0xff;
    png.data[i * 4 + 3] = 255;
  }
  return PNG.sync.write(png);
}

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([len, typeAndData, crc]);
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Hand-builds a structurally valid PNG with an ARBITRARY declared IHDR. */
function syntheticPng(opts: {
  width: number;
  height: number;
  bitDepth?: number;
  colorType?: number;
  compression?: number;
  filter?: number;
  interlace?: number;
  omitIdat?: boolean;
  omitIend?: boolean;
}): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(opts.width, 0);
  ihdr.writeUInt32BE(opts.height, 4);
  ihdr[8] = opts.bitDepth ?? 8;
  ihdr[9] = opts.colorType ?? 6;
  ihdr[10] = opts.compression ?? 0;
  ihdr[11] = opts.filter ?? 0;
  ihdr[12] = opts.interlace ?? 0;
  const parts = [SIGNATURE, chunk("IHDR", ihdr)];
  if (!opts.omitIdat) parts.push(chunk("IDAT", deflateSync(Buffer.from([0, 0, 0, 0, 0]))));
  if (!opts.omitIend) parts.push(chunk("IEND", Buffer.alloc(0)));
  return Buffer.concat(parts);
}

describe("inspectPngStructure — header-level validation without pixel decode", () => {
  it("accepts a normal PNG and reports its true dimensions", () => {
    const bytes = realPng(64, 40);
    const result = inspectPngStructure(bytes);
    assert.equal(result.status, "ok");
    if (result.status !== "ok") throw new Error("unreachable");
    assert.equal(result.widthPx, 64);
    assert.equal(result.heightPx, 40);
    assert.equal(result.colorType, 6);
    assert.equal(result.bitDepth, 8);
    assert.equal(result.interlaced, false);
    assert.ok(result.chunkCount >= 3);
  });

  it("agrees with a full pngjs decode on dimensions, across shapes", () => {
    for (const [w, h] of [[1, 1], [64, 40], [300, 7], [7, 300], [513, 129]] as const) {
      const bytes = realPng(w, h);
      const decoded = PNG.sync.read(bytes);
      const inspected = inspectPngStructure(bytes);
      assert.equal(inspected.status, "ok", `${w}x${h}`);
      if (inspected.status !== "ok") throw new Error("unreachable");
      assert.equal(inspected.widthPx, decoded.width, `${w}x${h} width`);
      assert.equal(inspected.heightPx, decoded.height, `${w}x${h} height`);
    }
  });

  it("reads Pedro-scale oversized dimensions without allocating the raster", () => {
    // 13220x4952 = 65.5 Mpx: the real Topaz response shape. A full decode of
    // this needs ~813 MiB; the header read must be constant-memory and fast.
    const bytes = syntheticPng({ width: 13220, height: 4952 });
    const before = process.memoryUsage().rss;
    const started = Date.now();
    const result = inspectPngStructure(bytes);
    const elapsedMs = Date.now() - started;
    const growthMiB = (process.memoryUsage().rss - before) / 1048576;

    assert.equal(result.status, "ok");
    if (result.status !== "ok") throw new Error("unreachable");
    assert.equal(result.widthPx, 13220);
    assert.equal(result.heightPx, 4952);
    assert.ok(bytes.length < 1000, `header-only fixture stayed small (${bytes.length} B)`);
    assert.ok(growthMiB < 32, `RSS growth must stay trivial, saw ${growthMiB.toFixed(1)} MiB`);
    assert.ok(elapsedMs < 1000, `must be fast, took ${elapsedMs}ms`);
  });

  it("rejects a bad signature", () => {
    const bytes = realPng(32, 32);
    bytes[1] = 0x00;
    const result = inspectPngStructure(bytes);
    assert.equal(result.status, "invalid");
    if (result.status !== "invalid") throw new Error("unreachable");
    assert.match(result.reason, /signature/i);
  });

  it("rejects a truncated body — THE check the removed decode used to provide", () => {
    const full = realPng(128, 128);
    for (const fraction of [0.25, 0.5, 0.9, 0.999]) {
      const cut = full.subarray(0, Math.floor(full.length * fraction));
      const result = inspectPngStructure(cut);
      assert.equal(result.status, "invalid", `truncated to ${fraction}`);
      if (result.status !== "invalid") throw new Error("unreachable");
      assert.match(result.reason, /truncated|too short/i);
    }
  });

  it("rejects a single flipped bit inside IDAT via CRC", () => {
    const bytes = realPng(64, 64);
    // Land well past the header, inside compressed pixel data.
    const target = Math.floor(bytes.length * 0.6);
    bytes[target] = bytes[target]! ^ 0x01;
    const result = inspectPngStructure(bytes);
    assert.equal(result.status, "invalid");
    if (result.status !== "invalid") throw new Error("unreachable");
    assert.match(result.reason, /CRC/i);
  });

  it("rejects a malformed / missing IHDR", () => {
    const noIhdrFirst = Buffer.concat([
      SIGNATURE,
      chunk("IDAT", deflateSync(Buffer.from([0]))),
      chunk("IEND", Buffer.alloc(0)),
    ]);
    const a = inspectPngStructure(noIhdrFirst);
    assert.equal(a.status, "invalid");
    if (a.status !== "invalid") throw new Error("unreachable");
    assert.match(a.reason, /first chunk is "IDAT", not IHDR/);

    const shortIhdr = Buffer.concat([
      SIGNATURE,
      chunk("IHDR", Buffer.alloc(9)),
      chunk("IDAT", deflateSync(Buffer.from([0]))),
      chunk("IEND", Buffer.alloc(0)),
    ]);
    const b = inspectPngStructure(shortIhdr);
    assert.equal(b.status, "invalid");
    if (b.status !== "invalid") throw new Error("unreachable");
    assert.match(b.reason, /IHDR is 9 bytes/);
  });

  it("rejects zero width and zero height", () => {
    for (const [w, h] of [[0, 10], [10, 0], [0, 0]] as const) {
      const result = inspectPngStructure(syntheticPng({ width: w, height: h }));
      assert.equal(result.status, "invalid", `${w}x${h}`);
      if (result.status !== "invalid") throw new Error("unreachable");
      assert.match(result.reason, /zero dimension/);
    }
  });

  it("rejects absurd/unsafe dimensions (decompression-bomb headers)", () => {
    const perAxis = inspectPngStructure(
      syntheticPng({ width: MAX_PROVIDER_RESULT_DIMENSION_PX + 1, height: 10 }),
    );
    assert.equal(perAxis.status, "invalid");
    if (perAxis.status !== "invalid") throw new Error("unreachable");
    assert.match(perAxis.reason, /per-axis ceiling/);

    // Within the per-axis ceiling but an impossible total pixel count.
    const totalPixels = inspectPngStructure(syntheticPng({ width: 60000, height: 60000 }));
    assert.equal(totalPixels.status, "invalid");
    if (totalPixels.status !== "invalid") throw new Error("unreachable");
    assert.match(totalPixels.reason, /px ceiling/);
    assert.ok(60000 * 60000 > MAX_PROVIDER_RESULT_PIXELS);
  });

  it("accepts Pedro Front's real 143.2 Mpx shape — the ceiling must not reject legitimate results", () => {
    const result = inspectPngStructure(syntheticPng({ width: 13260, height: 10800 }));
    assert.equal(result.status, "ok");
  });

  it("rejects illegal IHDR field combinations", () => {
    const badDepth = inspectPngStructure(syntheticPng({ width: 8, height: 8, colorType: 6, bitDepth: 4 }));
    assert.equal(badDepth.status, "invalid");
    if (badDepth.status !== "invalid") throw new Error("unreachable");
    assert.match(badDepth.reason, /bit depth 4, illegal for colour type 6/);

    const badColor = inspectPngStructure(syntheticPng({ width: 8, height: 8, colorType: 7 }));
    assert.equal(badColor.status, "invalid");

    const badCompression = inspectPngStructure(syntheticPng({ width: 8, height: 8, compression: 3 }));
    assert.equal(badCompression.status, "invalid");

    const badInterlace = inspectPngStructure(syntheticPng({ width: 8, height: 8, interlace: 9 }));
    assert.equal(badInterlace.status, "invalid");
  });

  it("rejects a PNG with no IDAT and one with no IEND", () => {
    const noIdat = inspectPngStructure(syntheticPng({ width: 8, height: 8, omitIdat: true }));
    assert.equal(noIdat.status, "invalid");
    if (noIdat.status !== "invalid") throw new Error("unreachable");
    assert.match(noIdat.reason, /no IDAT/);

    const noIend = inspectPngStructure(syntheticPng({ width: 8, height: 8, omitIend: true }));
    assert.equal(noIend.status, "invalid");
    if (noIend.status !== "invalid") throw new Error("unreachable");
    assert.match(noIend.reason, /no IEND/);
  });

  it("rejects trailing bytes appended after IEND", () => {
    const bytes = Buffer.concat([realPng(16, 16), Buffer.from("EXTRA")]);
    const result = inspectPngStructure(bytes);
    assert.equal(result.status, "invalid");
    if (result.status !== "invalid") throw new Error("unreachable");
    assert.match(result.reason, /trailing bytes after IEND/);
  });

  it("never throws, whatever it is handed", () => {
    for (const bytes of [
      Buffer.alloc(0),
      Buffer.from("not a png"),
      Buffer.from([0x89, 0x50]),
      Buffer.alloc(40),
      SIGNATURE,
      Buffer.concat([SIGNATURE, Buffer.from([0xff, 0xff, 0xff, 0xff, 0x41, 0x41, 0x41, 0x41])]),
    ]) {
      const result = inspectPngStructure(bytes);
      assert.equal(result.status, "invalid");
    }
  });
});
