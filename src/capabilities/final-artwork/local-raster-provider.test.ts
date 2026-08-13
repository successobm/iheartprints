import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PNG } from "pngjs";

import { PRINT_PLACEMENT_SIZING_POLICY } from "@/capabilities/shared/print-placement-dimensions";

import { LocalRasterInterpolationProvider } from "./local-raster-provider";
import { readPhysicalPixelDensity } from "./production-png";

/** A real PNG: opaque colored square centered on a fully transparent canvas. */
function buildFixturePng(size: number, marginFraction = 0.1): Buffer {
  const png = new PNG({ width: size, height: size });
  const margin = Math.floor(size * marginFraction);
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

/** A real PNG whose visible artwork is deliberately non-square. */
function buildWideFixturePng(size: number): Buffer {
  const png = new PNG({ width: size, height: size });
  const left = Math.floor(size * 0.1);
  const right = size - left;
  const top = Math.floor(size * 0.3);
  const bottom = size - top;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const idx = (size * y + x) << 2;
      const inside = x >= left && x < right && y >= top && y < bottom;
      png.data[idx] = 20;
      png.data[idx + 1] = 40;
      png.data[idx + 2] = 60;
      png.data[idx + 3] = inside ? 255 : 0;
    }
  }
  return PNG.sync.write(png);
}

const SLEEVE = PRINT_PLACEMENT_SIZING_POLICY.sleeve;
const FULL_BACK = PRINT_PLACEMENT_SIZING_POLICY.full_back;

describe("LocalRasterInterpolationProvider (Print-Ready Normalization Phase 1)", () => {
  it("sizes the plate from the placement's physical width, with height from the artwork", async () => {
    const provider = new LocalRasterInterpolationProvider();

    const output = await provider.produce({
      sourceBytes: buildWideFixturePng(1024),
      sourceContentType: "image/png",
      sizing: FULL_BACK,
    });

    assert.equal(output.widthPx, 3150, "10.5in at 300 PPI");
    // The artwork is roughly 2:1, so the plate is roughly half as tall as it
    // is wide — never the old fixed 4200px canvas height.
    assert.notEqual(output.heightPx, 4200);
    // The plate's proportions are the trimmed artwork's proportions — roughly
    // 2:1 here — not the placement envelope's.
    const artworkAspect =
      output.normalization.trimmedWidthPx / output.normalization.trimmedHeightPx;
    assert.ok(artworkAspect > 1.9 && artworkAspect < 2.0, `artwork aspect ${artworkAspect}`);
    assert.ok(
      Math.abs(output.widthPx / output.heightPx - artworkAspect) / artworkAspect < 0.001,
      `plate aspect ${output.widthPx}x${output.heightPx} should match the artwork's ${artworkAspect}`,
    );
    assert.equal(output.normalization.intendedWidthIn, 10.5);
    assert.equal(output.normalization.targetPpi, 300);
    assert.equal(output.normalization.constrainedBy, "width");
  });

  it("resizing down to a placement the trimmed artwork already exceeds reports native provenance", async () => {
    const provider = new LocalRasterInterpolationProvider();
    const source = buildFixturePng(1600);

    const output = await provider.produce({
      sourceBytes: source,
      sourceContentType: "image/png",
      sizing: SLEEVE,
    });

    assert.equal(output.resolutionProvenance, "native");
    assert.equal(output.nativeWidthPx, 1600);
    assert.equal(output.nativeHeightPx, 1600);
    assert.equal(output.widthPx, 900, "3in at 300 PPI");
    assert.equal(output.heightPx, 900);
  });

  it("resizing up beyond the TRIMMED artwork's density honestly reports interpolated_upscale", async () => {
    const provider = new LocalRasterInterpolationProvider();

    const output = await provider.produce({
      sourceBytes: buildFixturePng(1024),
      sourceContentType: "image/png",
      sizing: FULL_BACK,
    });

    assert.equal(output.resolutionProvenance, "interpolated_upscale");
    assert.equal(output.nativeWidthPx, 1024);
    assert.equal(output.nativeHeightPx, 1024);
    assert.equal(output.widthPx, 3150);
  });

  it("trims the source's transparent padding instead of carrying it into the plate", async () => {
    const provider = new LocalRasterInterpolationProvider();

    const output = await provider.produce({
      sourceBytes: buildFixturePng(1000, 0.25), // artwork is only 500x500 of 1000x1000
      sourceContentType: "image/png",
      sizing: SLEEVE,
    });

    assert.equal(output.normalization.alphaBBoxWidthPx, 500);
    assert.equal(output.normalization.alphaBBoxHeightPx, 500);
    assert.equal(output.normalization.trimmedWidthPx, 516, "500 + 8px margin per edge");
    assert.ok(
      output.normalization.artworkOccupancy > 0.93,
      `expected the plate to be nearly all artwork, got ${output.normalization.artworkOccupancy}`,
    );
  });

  it("verifies actual output transparency rather than assuming it, and tags 300 PPI density", async () => {
    const provider = new LocalRasterInterpolationProvider();

    const output = await provider.produce({
      sourceBytes: buildFixturePng(1024),
      sourceContentType: "image/png",
      sizing: SLEEVE,
    });

    assert.equal(output.hasTransparency, true);
    // Sanity: the decoded bytes really are a valid PNG with an alpha channel.
    const decoded = PNG.sync.read(output.bytes);
    assert.equal(decoded.width, 900);
    assert.equal(decoded.height, 900);

    const density = readPhysicalPixelDensity(output.bytes);
    assert.equal(density?.pixelsPerMetreX, 11811);
  });

  it("always declares content preservation — a pure geometric transform never redraws content", async () => {
    const provider = new LocalRasterInterpolationProvider();
    const output = await provider.produce({
      sourceBytes: buildFixturePng(512),
      sourceContentType: "image/png",
      sizing: SLEEVE,
    });
    assert.equal(output.preservesApprovedContent, true);
  });

  it("is deterministic — identical input bytes always produce byte-identical output", async () => {
    const provider = new LocalRasterInterpolationProvider();
    const source = buildFixturePng(600);

    const first = await provider.produce({
      sourceBytes: source,
      sourceContentType: "image/png",
      sizing: SLEEVE,
    });
    const second = await provider.produce({
      sourceBytes: source,
      sourceContentType: "image/png",
      sizing: SLEEVE,
    });

    assert.deepEqual(first.bytes, second.bytes);
  });

  it("fails safely for artwork with nothing visible in it", async () => {
    const provider = new LocalRasterInterpolationProvider();
    const blank = PNG.sync.write(new PNG({ width: 256, height: 256 }));

    await assert.rejects(
      () =>
        provider.produce({
          sourceBytes: blank,
          sourceContentType: "image/png",
          sizing: SLEEVE,
        }),
      /no visible artwork/i,
    );
  });

  it("rejects a non-PNG source content type", async () => {
    const provider = new LocalRasterInterpolationProvider();
    await assert.rejects(
      () =>
        provider.produce({
          sourceBytes: Buffer.from("not a png"),
          sourceContentType: "image/jpeg",
          sizing: SLEEVE,
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
          sizing: SLEEVE,
        }),
      /could not be decoded/i,
    );
  });
});
