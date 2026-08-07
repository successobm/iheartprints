import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PNG } from "pngjs";

import { LocalRasterInterpolationProvider } from "./local-raster-provider";

/** A real PNG: opaque colored square centered on a fully transparent canvas. */
function buildFixturePng(size: number): Buffer {
  const png = new PNG({ width: size, height: size });
  const margin = Math.floor(size * 0.1);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const idx = (size * y + x) << 2;
      const inside = x >= margin && x < size - margin && y >= margin && y < size - margin;
      png.data[idx] = 20;
      png.data[idx + 1] = 40;
      png.data[idx + 2] = 60;
      png.data[idx + 3] = inside ? 255 : 0;
    }
  }
  return PNG.sync.write(png);
}

describe("LocalRasterInterpolationProvider (Sprint 2M Phase 2C)", () => {
  it("resizing down to a placement the source already exceeds reports native provenance", async () => {
    const provider = new LocalRasterInterpolationProvider();
    const source = buildFixturePng(1024);

    const output = await provider.produce({
      sourceBytes: source,
      sourceContentType: "image/png",
      targetWidthPx: 900,
      targetHeightPx: 900,
      marginFraction: 0.05,
    });

    assert.equal(output.resolutionProvenance, "native");
    assert.equal(output.nativeWidthPx, 1024);
    assert.equal(output.nativeHeightPx, 1024);
    assert.equal(output.widthPx, 900);
    assert.equal(output.heightPx, 900);
  });

  it("resizing up beyond the source's native pixel density honestly reports interpolated_upscale", async () => {
    const provider = new LocalRasterInterpolationProvider();
    const source = buildFixturePng(1024);

    const output = await provider.produce({
      sourceBytes: source,
      sourceContentType: "image/png",
      targetWidthPx: 3600,
      targetHeightPx: 4200,
      marginFraction: 0.05,
    });

    assert.equal(output.resolutionProvenance, "interpolated_upscale");
    assert.equal(output.nativeWidthPx, 1024);
    assert.equal(output.nativeHeightPx, 1024);
    assert.equal(output.widthPx, 3600);
    assert.equal(output.heightPx, 4200);
  });

  it("verifies actual output transparency rather than assuming it", async () => {
    const provider = new LocalRasterInterpolationProvider();
    const source = buildFixturePng(1024);

    const output = await provider.produce({
      sourceBytes: source,
      sourceContentType: "image/png",
      targetWidthPx: 1200,
      targetHeightPx: 1200,
      marginFraction: 0.05,
    });

    assert.equal(output.hasTransparency, true);
    // Sanity: the decoded bytes really are a valid PNG with an alpha channel.
    const decoded = PNG.sync.read(output.bytes);
    assert.equal(decoded.width, 1200);
    assert.equal(decoded.height, 1200);
  });

  it("always declares content preservation — a pure geometric resample never redraws content", async () => {
    const provider = new LocalRasterInterpolationProvider();
    const output = await provider.produce({
      sourceBytes: buildFixturePng(512),
      sourceContentType: "image/png",
      targetWidthPx: 512,
      targetHeightPx: 512,
      marginFraction: 0,
    });
    assert.equal(output.preservesApprovedContent, true);
  });

  it("is deterministic — identical input bytes always produce byte-identical output", async () => {
    const provider = new LocalRasterInterpolationProvider();
    const source = buildFixturePng(600);

    const first = await provider.produce({
      sourceBytes: source,
      sourceContentType: "image/png",
      targetWidthPx: 1200,
      targetHeightPx: 1200,
      marginFraction: 0.05,
    });
    const second = await provider.produce({
      sourceBytes: source,
      sourceContentType: "image/png",
      targetWidthPx: 1200,
      targetHeightPx: 1200,
      marginFraction: 0.05,
    });

    assert.deepEqual(first.bytes, second.bytes);
  });

  it("rejects a non-PNG source content type", async () => {
    const provider = new LocalRasterInterpolationProvider();
    await assert.rejects(
      () =>
        provider.produce({
          sourceBytes: Buffer.from("not a png"),
          sourceContentType: "image/jpeg",
          targetWidthPx: 900,
          targetHeightPx: 900,
          marginFraction: 0.05,
        }),
      /only supports image\/png/i,
    );
  });

  it("rejects bytes that don't actually decode as a PNG", async () => {
    const provider = new LocalRasterInterpolationProvider();
    await assert.rejects(
      () =>
        provider.produce({
          sourceBytes: Buffer.from("this is not really a png file"),
          sourceContentType: "image/png",
          targetWidthPx: 900,
          targetHeightPx: 900,
          marginFraction: 0.05,
        }),
      /could not be decoded/i,
    );
  });
});
