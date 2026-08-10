import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PNG } from "pngjs";

import {
  pixelsPerMetreForPpi,
  ppiFromPixelsPerMetre,
  readPhysicalPixelDensity,
  withPhysicalPixelDensity,
} from "./production-png";

function solidPng(width: number, height: number): Buffer {
  const png = new PNG({ width, height });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = 10;
    png.data[i + 1] = 120;
    png.data[i + 2] = 200;
    png.data[i + 3] = 255;
  }
  return PNG.sync.write(png);
}

describe("PNG physical-resolution metadata (Print-Ready Normalization Phase 1)", () => {
  it("300 PPI is 11811 pixels per metre", () => {
    assert.equal(pixelsPerMetreForPpi(300), 11811);
    assert.ok(Math.abs(ppiFromPixelsPerMetre(11811) - 300) < 0.01);
  });

  it("writes a readable pHYs chunk without disturbing the image", () => {
    const original = solidPng(32, 24);
    const tagged = withPhysicalPixelDensity(original, pixelsPerMetreForPpi(300));

    const density = readPhysicalPixelDensity(tagged);
    assert.equal(density?.pixelsPerMetreX, 11811);
    assert.equal(density?.pixelsPerMetreY, 11811);
    assert.equal(density?.unitSpecifier, 1);

    const before = PNG.sync.read(original);
    const after = PNG.sync.read(tagged);
    assert.equal(after.width, before.width);
    assert.equal(after.height, before.height);
    assert.deepEqual(after.data, before.data, "pixels are untouched");
  });

  it("reports null for a PNG with no density metadata", () => {
    assert.equal(readPhysicalPixelDensity(solidPng(8, 8)), null);
  });

  it("replaces an existing density rather than appending a second one", () => {
    const once = withPhysicalPixelDensity(solidPng(16, 16), 5000);
    const twice = withPhysicalPixelDensity(once, 11811);

    assert.equal(readPhysicalPixelDensity(twice)?.pixelsPerMetreX, 11811);
    assert.equal(countPhysChunks(twice), 1);
    assert.deepEqual(PNG.sync.read(twice).data, PNG.sync.read(once).data);
  });

  it("inserts the chunk before the first IDAT, as the PNG spec requires", () => {
    const tagged = withPhysicalPixelDensity(solidPng(16, 16), 11811);
    assert.ok(
      tagged.indexOf(Buffer.from("pHYs", "ascii")) <
        tagged.indexOf(Buffer.from("IDAT", "ascii")),
    );
  });

  it("is deterministic", () => {
    const source = solidPng(20, 20);
    assert.deepEqual(
      withPhysicalPixelDensity(source, 11811),
      withPhysicalPixelDensity(source, 11811),
    );
  });

  it("rejects bytes that are not a PNG at all rather than silently returning them untagged", () => {
    assert.throws(
      () => withPhysicalPixelDensity(Buffer.from("definitely not a png file"), 11811),
      /not a PNG/i,
    );
  });

  it("rejects a non-positive density", () => {
    assert.throws(
      () => withPhysicalPixelDensity(solidPng(8, 8), 0),
      /positive number of pixels per metre/i,
    );
  });
});

function countPhysChunks(pngBytes: Buffer): number {
  let count = 0;
  let index = pngBytes.indexOf(Buffer.from("pHYs", "ascii"));
  while (index !== -1) {
    count += 1;
    index = pngBytes.indexOf(Buffer.from("pHYs", "ascii"), index + 1);
  }
  return count;
}
