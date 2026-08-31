import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PNG } from "pngjs";

import { fillRect, makeImage } from "@/capabilities/sign-preparation/sign-fixtures";

import {
  SIGN_PRESERVATION_DETAIL_CROP_LINEAR_SCALE,
  SIGN_PRESERVATION_IMAGE_DERIVATION_VERSION,
  SIGN_PRESERVATION_MAX_IMAGE_COUNT,
} from "./contracts";
import {
  deriveSemanticComparisonImages,
  encodeImageAsDataUri,
} from "./sign-preservation-image-derivation";

/** Decodes a `data:image/png;base64,...` URI back to raw RGBA pixels for assertions — pngjs's parser always normalizes its `.data` output to RGBA regardless of the encoded colour type, filling alpha=255 for any colour-type-2 (no-alpha) source. */
function decodeDataUri(dataUri: string): { width: number; height: number; data: Buffer } {
  const base64 = dataUri.split(",")[1];
  return PNG.sync.read(Buffer.from(base64, "base64"));
}

/** Reads one pixel's [r, g, b, a] from a decoded PNG buffer. */
function pixelAt(png: { width: number; data: Buffer }, x: number, y: number): [number, number, number, number] {
  const i = (y * png.width + x) * 4;
  return [png.data[i], png.data[i + 1], png.data[i + 2], png.data[i + 3]];
}

describe("deriveSemanticComparisonImages (Signs Phase S4.2A / S4.2B.2)", () => {
  it("exact integer scale (the real Ruth 4x relationship) -> exactly 14 images, none data-dependent in count", () => {
    const source = makeImage(1024, 1536, { r: 1, g: 2, b: 3 });
    const reconstruction = makeImage(4096, 6144, { r: 4, g: 5, b: 6 });
    const set = deriveSemanticComparisonImages(source, reconstruction);
    assert.ok(set);
    const totalImages = 2 + set!.sourceCrops.length + set!.reconstructionCrops.length;
    assert.equal(totalImages, SIGN_PRESERVATION_MAX_IMAGE_COUNT);
    assert.equal(set!.sourceCrops.length, 6);
    assert.equal(set!.reconstructionCrops.length, 6);
  });

  it("overview pair is same-dimensioned (source native, reconstruction normalized down to match)", () => {
    const source = makeImage(200, 300, { r: 1, g: 2, b: 3 });
    const reconstruction = makeImage(800, 1200, { r: 4, g: 5, b: 6 }); // exact 4x
    const set = deriveSemanticComparisonImages(source, reconstruction)!;
    assert.ok(set.sourceOverview.dataUri.startsWith("data:image/png;base64,"));
    assert.ok(set.reconstructionOverview.dataUri.startsWith("data:image/png;base64,"));
    const decodedSourceOverview = decodeDataUri(set.sourceOverview.dataUri);
    const decodedReconOverview = decodeDataUri(set.reconstructionOverview.dataUri);
    assert.equal(decodedSourceOverview.width, source.width);
    assert.equal(decodedSourceOverview.height, source.height);
    assert.equal(decodedReconOverview.width, source.width);
    assert.equal(decodedReconOverview.height, source.height);
  });

  it("source crops stay at native source resolution — 512x512 for the real Ruth 1024x1536 source (2x3 grid)", () => {
    const source = makeImage(1024, 1536, { r: 1, g: 2, b: 3 });
    const reconstruction = makeImage(4096, 6144, { r: 4, g: 5, b: 6 }); // exact 4x
    const set = deriveSemanticComparisonImages(source, reconstruction)!;
    for (const crop of set.sourceCrops) {
      const decoded = decodeDataUri(crop.dataUri);
      assert.equal(decoded.width, 512);
      assert.equal(decoded.height, 512);
    }
  });

  it("Signs Phase S4.2B.2: reconstruction detail crops are capped at SIGN_PRESERVATION_DETAIL_CROP_LINEAR_SCALE x the source crop's own dimensions — 1024x1024 for the real Ruth case (512x512 source crop, 4x native reconstruction), never the full 2048x2048 native size", () => {
    const source = makeImage(1024, 1536, { r: 1, g: 2, b: 3 });
    const reconstruction = makeImage(4096, 6144, { r: 4, g: 5, b: 6 }); // exact 4x native
    const set = deriveSemanticComparisonImages(source, reconstruction)!;
    assert.equal(SIGN_PRESERVATION_DETAIL_CROP_LINEAR_SCALE, 2);
    for (const crop of set.reconstructionCrops) {
      const decoded = decodeDataUri(crop.dataUri);
      assert.equal(decoded.width, 1024, "expected 512 (source crop) x 2 (linear scale) = 1024, not native 2048");
      assert.equal(decoded.height, 1024);
    }
  });

  it("when the upstream reconstruction's own native scale is already <= the target linear scale, the native crop is used unresampled (never upscaled beyond what the reconstruction actually contains)", () => {
    const source = makeImage(1024, 1536, { r: 1, g: 2, b: 3 });
    const reconstruction = makeImage(2048, 3072, { r: 4, g: 5, b: 6 }); // exact 2x native == the target linear scale
    const set = deriveSemanticComparisonImages(source, reconstruction)!;
    for (const crop of set.reconstructionCrops) {
      const decoded = decodeDataUri(crop.dataUri);
      // 2x native === 2x target -> crop stays exactly 1024x1024, not upscaled further.
      assert.equal(decoded.width, 1024);
      assert.equal(decoded.height, 1024);
    }
  });

  it("non-integer scale relationship -> unavailable (null), never guessed", () => {
    const source = makeImage(101, 151, { r: 1, g: 2, b: 3 });
    const reconstruction = makeImage(400, 600, { r: 4, g: 5, b: 6 }); // not an exact integer multiple of 101x151
    const set = deriveSemanticComparisonImages(source, reconstruction);
    assert.equal(set, null);
  });

  it("grid derivation is fully deterministic — re-deriving with identical inputs produces byte-identical output", () => {
    const source = makeImage(120, 180, { r: 1, g: 2, b: 3 });
    const reconstruction = makeImage(240, 360, { r: 4, g: 5, b: 6 }); // exact 2x
    const set = deriveSemanticComparisonImages(source, reconstruction)!;
    const again = deriveSemanticComparisonImages(source, reconstruction)!;
    assert.deepEqual(
      set.sourceCrops.map((c) => c.dataUri),
      again.sourceCrops.map((c) => c.dataUri),
    );
    assert.deepEqual(
      set.reconstructionCrops.map((c) => c.dataUri),
      again.reconstructionCrops.map((c) => c.dataUri),
    );
  });

  it("geometric fidelity: each reconstruction detail crop corresponds EXACTLY to the same customer-content region as its source crop counterpart — no shift, no gap, no cross-contamination, no padding", () => {
    // Real Ruth dimensions: 1024x1536 source, exact 2x3 grid -> six 512x512
    // cells with NO rounding remainder (1024/2=512, 1536/3=512), so cell
    // boundaries are exact and unambiguous.
    const source = makeImage(1024, 1536, { r: 0, g: 0, b: 0 });
    const reconstruction = makeImage(4096, 6144, { r: 0, g: 0, b: 0 }); // exact 4x native

    // Paint each of the 6 grid cells a distinct, uniform, easily-identified
    // colour in BOTH images (at each image's own native resolution) — a
    // reconstruction crop that leaked pixels from a neighbouring cell, was
    // shifted, or included padding would no longer be a uniform single
    // colour once decoded.
    const cellColors = [
      { r: 10, g: 20, b: 30 },
      { r: 40, g: 50, b: 60 },
      { r: 70, g: 80, b: 90 },
      { r: 100, g: 110, b: 120 },
      { r: 130, g: 140, b: 150 },
      { r: 160, g: 170, b: 180 },
    ];
    const cols = 2;
    const rows = 3;
    let cellIndex = 0;
    const cellBoundaries: { col: number; row: number; x0: number; y0: number; x1: number; y1: number }[] = [];
    for (let row = 0; row < rows; row += 1) {
      for (let col = 0; col < cols; col += 1) {
        const x0 = Math.round((col / cols) * source.width);
        const x1 = Math.round(((col + 1) / cols) * source.width);
        const y0 = Math.round((row / rows) * source.height);
        const y1 = Math.round(((row + 1) / rows) * source.height);
        cellBoundaries.push({ col, row, x0, y0, x1, y1 });
        const color = cellColors[cellIndex];
        fillRect(source, x0, y0, x1, y1, color);
        fillRect(reconstruction, x0 * 4, y0 * 4, x1 * 4, y1 * 4, color);
        cellIndex += 1;
      }
    }

    const set = deriveSemanticComparisonImages(source, reconstruction)!;
    assert.equal(set.sourceCrops.length, 6);
    assert.equal(set.reconstructionCrops.length, 6);

    for (let i = 0; i < cellBoundaries.length; i += 1) {
      const { col, row } = cellBoundaries[i];
      const expected = cellColors[i];

      const decodedSourceCrop = decodeDataUri(set.sourceCrops[i].dataUri);
      const decodedReconCrop = decodeDataUri(set.reconstructionCrops[i].dataUri);

      // Sample all four corners and the centre of BOTH crops — a uniform
      // colour across every sampled point proves no shift/gap/cross-
      // contamination/padding leaked in anywhere in the crop.
      const sourceSamplePoints: [number, number][] = [
        [0, 0],
        [decodedSourceCrop.width - 1, 0],
        [0, decodedSourceCrop.height - 1],
        [decodedSourceCrop.width - 1, decodedSourceCrop.height - 1],
        [Math.floor(decodedSourceCrop.width / 2), Math.floor(decodedSourceCrop.height / 2)],
      ];
      for (const [x, y] of sourceSamplePoints) {
        const [r, g, b] = pixelAt(decodedSourceCrop, x, y);
        assert.deepEqual(
          [r, g, b],
          [expected.r, expected.g, expected.b],
          `source crop (col ${col}, row ${row}) at (${x},${y}) should be uniformly the cell's own colour`,
        );
      }

      const reconSamplePoints: [number, number][] = [
        [0, 0],
        [decodedReconCrop.width - 1, 0],
        [0, decodedReconCrop.height - 1],
        [decodedReconCrop.width - 1, decodedReconCrop.height - 1],
        [Math.floor(decodedReconCrop.width / 2), Math.floor(decodedReconCrop.height / 2)],
      ];
      for (const [x, y] of reconSamplePoints) {
        const [r, g, b] = pixelAt(decodedReconCrop, x, y);
        assert.deepEqual(
          [r, g, b],
          [expected.r, expected.g, expected.b],
          `reconstruction crop (col ${col}, row ${row}) at (${x},${y}) should be uniformly the SAME cell colour as its source counterpart — proves exact geometric correspondence`,
        );
      }
    }
  });

  it("still contains genuine 2x linear sampling relative to the original source (not merely resized down to match the source crop) — a reconstruction crop carries strictly more independently-sampled pixels than its source counterpart", () => {
    const source = makeImage(1024, 1536, { r: 1, g: 2, b: 3 });
    const reconstruction = makeImage(4096, 6144, { r: 4, g: 5, b: 6 });
    const set = deriveSemanticComparisonImages(source, reconstruction)!;
    const decodedSourceCrop = decodeDataUri(set.sourceCrops[0].dataUri);
    const decodedReconCrop = decodeDataUri(set.reconstructionCrops[0].dataUri);
    // 512x512 source crop vs 1024x1024 reconstruction crop: exactly 2x
    // linear (4x area) — genuinely finer sampling than the source, unlike
    // a same-size crop pair which would discard the extra reconstruction
    // detail entirely.
    assert.equal(decodedReconCrop.width, decodedSourceCrop.width * 2);
    assert.equal(decodedReconCrop.height, decodedSourceCrop.height * 2);
  });

  it("payload reduction: total serialized request size for the real Ruth geometry is substantially smaller than the previous native-resolution (v1) behaviour's ~52.35 MB", () => {
    const source = makeImage(1024, 1536, { r: 12, g: 34, b: 56 });
    const reconstruction = makeImage(4096, 6144, { r: 78, g: 90, b: 123 });
    const set = deriveSemanticComparisonImages(source, reconstruction)!;
    const allDataUris = [
      set.sourceOverview.dataUri,
      set.reconstructionOverview.dataUri,
      ...set.sourceCrops.map((c) => c.dataUri),
      ...set.reconstructionCrops.map((c) => c.dataUri),
    ];
    const serializedBytes = Buffer.byteLength(JSON.stringify(allDataUris), "utf8");
    // Flat-fill fixtures compress far better than real photographic
    // content, so this is a loose sanity ceiling, not the real Ruth
    // measurement (see the phase report for the actual measured bytes) —
    // it only proves the new crop sizing produces a materially smaller
    // payload shape, not a regression back toward native-resolution sizes.
    assert.ok(
      serializedBytes < 20_000_000,
      `expected a flat-fill fixture's serialized payload to stay well under 20MB with 1024x1024 crops, got ${serializedBytes}`,
    );
  });

  it("image derivation version was bumped for this phase's behavior change", () => {
    assert.equal(SIGN_PRESERVATION_IMAGE_DERIVATION_VERSION, "sign-preservation-image-derivation:v2");
    const source = makeImage(1024, 1536, { r: 1, g: 2, b: 3 });
    const reconstruction = makeImage(4096, 6144, { r: 4, g: 5, b: 6 });
    const set = deriveSemanticComparisonImages(source, reconstruction)!;
    assert.equal(set.imageDerivationVersion, "sign-preservation-image-derivation:v2");
  });

  it("deriving comparison images never touches the network — covers both the OpenAI semantic provider and the Topaz reconstruction provider paths, since both dispatch exclusively via global fetch", () => {
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      throw new Error("fetch must never be called by deriveSemanticComparisonImages/encodeImageAsDataUri");
    }) as typeof fetch;
    try {
      const source = makeImage(1024, 1536, { r: 1, g: 2, b: 3 });
      const reconstruction = makeImage(4096, 6144, { r: 4, g: 5, b: 6 });
      const set = deriveSemanticComparisonImages(source, reconstruction);
      assert.ok(set);
      assert.equal(fetchCalls, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("encodeImageAsDataUri opaque RGB encoding (Signs Phase S4.2B.2)", () => {
  it("a fully opaque image round-trips every R/G/B byte exactly, with alpha removed from the encoding", () => {
    const image = makeImage(4, 4, { r: 0, g: 0, b: 0, a: 255 });
    // Vary each pixel's colour so a channel-swap or off-by-one bug would be
    // caught, not just a flat-fill coincidence.
    for (let y = 0; y < image.height; y += 1) {
      for (let x = 0; x < image.width; x += 1) {
        const i = (y * image.width + x) * 4;
        image.data[i] = (x * 17 + y * 3) % 256;
        image.data[i + 1] = (x * 5 + y * 41) % 256;
        image.data[i + 2] = (x * 91 + y * 13) % 256;
        image.data[i + 3] = 255;
      }
    }
    const dataUri = encodeImageAsDataUri(image);
    const decoded = decodeDataUri(dataUri);
    assert.equal(decoded.width, image.width);
    assert.equal(decoded.height, image.height);
    for (let y = 0; y < image.height; y += 1) {
      for (let x = 0; x < image.width; x += 1) {
        const i = (y * image.width + x) * 4;
        const [r, g, b, a] = pixelAt(decoded, x, y);
        assert.equal(r, image.data[i], `R mismatch at (${x},${y})`);
        assert.equal(g, image.data[i + 1], `G mismatch at (${x},${y})`);
        assert.equal(b, image.data[i + 2], `B mismatch at (${x},${y})`);
        // pngjs's parser always normalizes decoded output to RGBA, filling
        // 255 for a source PNG that had no alpha channel at all (colour
        // type 2) — this is the expected, correct read-back for a fully
        // opaque encode, not evidence alpha was "kept".
        assert.equal(a, 255);
      }
    }
    // Byte-level proof the alpha channel was actually dropped from the
    // OUTPUT PNG, not merely read back as opaque by coincidence: the PNG
    // spec fixes the colour-type byte at a constant offset in the IHDR
    // chunk (8-byte signature + 4-byte length + 4-byte "IHDR" tag + 4-byte
    // width + 4-byte height + 1-byte bit depth = offset 25). Colour type 2
    // is truecolour-without-alpha; 6 is truecolour-with-alpha. A
    // compressed-size comparison is NOT used here — deflate overhead on a
    // tiny fixture can make a 1-byte-per-pixel saving disappear into
    // rounding, which is a property of zlib, not of whether alpha was
    // dropped.
    const encodedBytes = Buffer.from(dataUri.split(",")[1], "base64");
    assert.equal(encodedBytes[25], 2, "expected PNG IHDR colour type 2 (truecolour, no alpha) for a proven-opaque image");

    // Corroborating evidence at a larger, more realistic size: with more
    // pixels, the alpha channel's contribution to raw (pre-deflate) size is
    // large enough that dropping it produces a smaller encoded PNG even
    // after compression — varied per-pixel colour again, so deflate cannot
    // trivially collapse the whole buffer to a handful of runs.
    const bigImage = makeImage(64, 64, { r: 0, g: 0, b: 0, a: 255 });
    for (let y = 0; y < bigImage.height; y += 1) {
      for (let x = 0; x < bigImage.width; x += 1) {
        const i = (y * bigImage.width + x) * 4;
        bigImage.data[i] = (x * 17 + y * 3) % 256;
        bigImage.data[i + 1] = (x * 5 + y * 41) % 256;
        bigImage.data[i + 2] = (x * 91 + y * 13) % 256;
        bigImage.data[i + 3] = 255;
      }
    }
    const bigOpaqueBytes = Buffer.from(encodeImageAsDataUri(bigImage).split(",")[1], "base64");
    const bigForcedRgbaPng = new PNG({ width: bigImage.width, height: bigImage.height });
    bigImage.data.copy(bigForcedRgbaPng.data);
    const bigForcedRgbaBytes = PNG.sync.write(bigForcedRgbaPng);
    assert.equal(bigOpaqueBytes[25], 2);
    assert.equal(bigForcedRgbaBytes[25], 6);
    assert.ok(
      bigOpaqueBytes.length < bigForcedRgbaBytes.length,
      `expected the opaque-encoded PNG (${bigOpaqueBytes.length} bytes) to be smaller than an equivalent RGBA encoding (${bigForcedRgbaBytes.length} bytes) at a realistic size`,
    );
  });

  it("an image with ANY non-opaque pixel retains its real alpha channel and exact values — never forced to 255, never dropped", () => {
    const image = makeImage(4, 4, { r: 200, g: 100, b: 50, a: 255 });
    // A single non-opaque pixel is enough to prove the whole image keeps
    // its alpha channel — evidence-based, not assumed from a summary stat.
    const nonOpaqueIndex = (2 * image.width + 1) * 4;
    image.data[nonOpaqueIndex + 3] = 128;

    const dataUri = encodeImageAsDataUri(image);
    const decoded = decodeDataUri(dataUri);
    const [, , , alphaAtNonOpaquePixel] = pixelAt(decoded, 1, 2);
    assert.equal(alphaAtNonOpaquePixel, 128, "the real, exact alpha value must survive — never rounded/forced to 255");

    // Every other (opaque) pixel must still read back as 255 and its RGB
    // must survive exactly, proving RGBA encoding preserved the whole
    // image faithfully, not just the one transparent pixel.
    const [r, g, b, a] = pixelAt(decoded, 0, 0);
    assert.deepEqual([r, g, b, a], [200, 100, 50, 255]);
  });
});
