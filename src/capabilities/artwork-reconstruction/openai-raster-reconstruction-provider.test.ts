import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DEFAULT_TIMEOUT_MS } from "./openai-raster-reconstruction-provider";

describe("OpenAIRasterReconstructionProvider default timeout", () => {
  it("defaults the OpenAI raster reconstruction request timeout to 120 seconds", () => {
    assert.equal(DEFAULT_TIMEOUT_MS, 120_000);
  });
});
