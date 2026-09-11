import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PNG } from "pngjs";

import { downscaleForProposal, MAX_PROPOSAL_DIMENSION_PX } from "./downscale-for-proposal";

function pngBytes(width: number, height: number): Buffer {
  const png = new PNG({ width, height });
  return PNG.sync.write(png);
}

describe("downscaleForProposal", () => {
  it("never upscales a source already at or below the target dimension", () => {
    const result = downscaleForProposal(pngBytes(400, 300));
    assert.ok(result);
    assert.equal(result!.widthPx, 400);
    assert.equal(result!.heightPx, 300);
  });

  it("downscales a larger source, preserving aspect ratio and never exceeding the max dimension", () => {
    const result = downscaleForProposal(pngBytes(4000, 2000));
    assert.ok(result);
    assert.ok(Math.max(result!.widthPx, result!.heightPx) <= MAX_PROPOSAL_DIMENSION_PX);
    // 2:1 aspect ratio preserved.
    assert.equal(result!.widthPx, MAX_PROPOSAL_DIMENSION_PX);
    assert.equal(result!.heightPx, MAX_PROPOSAL_DIMENSION_PX / 2);
  });

  it("returns null for bytes that do not decode as a PNG, never throws", () => {
    assert.equal(downscaleForProposal(Buffer.from("not a png")), null);
  });
});
