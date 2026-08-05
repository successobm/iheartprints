import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PNG } from "pngjs";

import { PngThumbnailGenerator } from "./png-thumbnail-generator";

function solidPng(width: number, height: number): Buffer {
  const png = new PNG({ width, height });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = 200; // R
    png.data[i + 1] = 100; // G
    png.data[i + 2] = 50; // B
    png.data[i + 3] = 255; // A
  }
  return PNG.sync.write(png);
}

describe("PngThumbnailGenerator", () => {
  it("downscales a large image to the configured max dimension, preserving aspect ratio", async () => {
    const generator = new PngThumbnailGenerator(256);
    const result = await generator.generate({
      bytes: solidPng(1024, 512),
      contentType: "image/png",
    });

    assert.ok(result);
    assert.equal(result.contentType, "image/png");
    assert.equal(result.widthPx, 256);
    assert.equal(result.heightPx, 128); // 512/1024 * 256, aspect preserved

    // The result is itself a real, decodable PNG.
    const decoded = PNG.sync.read(result.bytes);
    assert.equal(decoded.width, 256);
    assert.equal(decoded.height, 128);
  });

  it("leaves an already-small image at its original size rather than upscaling", async () => {
    const generator = new PngThumbnailGenerator(256);
    const result = await generator.generate({
      bytes: solidPng(64, 32),
      contentType: "image/png",
    });

    assert.ok(result);
    assert.equal(result.widthPx, 64);
    assert.equal(result.heightPx, 32);
  });

  it("produces a genuinely smaller byte payload for a large image (fast preview)", async () => {
    const generator = new PngThumbnailGenerator(64);
    const original = solidPng(800, 800);
    const result = await generator.generate({ bytes: original, contentType: "image/png" });

    assert.ok(result);
    assert.ok(result.bytes.length < original.length);
  });

  it("returns null for a non-PNG content type — never a fatal failure", async () => {
    const generator = new PngThumbnailGenerator();
    const result = await generator.generate({
      bytes: Buffer.from("not an image"),
      contentType: "image/webp",
    });
    assert.equal(result, null);
  });

  it("returns null for bytes that don't actually decode as PNG, instead of throwing", async () => {
    const generator = new PngThumbnailGenerator();
    const result = await generator.generate({
      bytes: Buffer.from("this is definitely not a png"),
      contentType: "image/png",
    });
    assert.equal(result, null);
  });
});
