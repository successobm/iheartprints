import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { LocalRasterInterpolationProvider } from "./local-raster-provider";
import { TopazTransparencyUpscaleProvider } from "./topaz-transparency-upscale-provider";
import { UnavailableFinalArtworkProvider } from "./unavailable-final-artwork-provider";
import { resolveFinalArtworkProvider } from "./resolve-final-artwork-provider";

describe("resolveFinalArtworkProvider (Sprint 2M Phase 2E)", () => {
  it("resolves LocalRasterInterpolationProvider for mode: local", () => {
    const provider = resolveFinalArtworkProvider({ mode: "local" });
    assert.ok(provider instanceof LocalRasterInterpolationProvider);
    assert.equal(provider.providerKey, "local_raster_interpolation");
  });

  it("resolves TopazTransparencyUpscaleProvider for mode: topaz", () => {
    const provider = resolveFinalArtworkProvider({ mode: "topaz", apiKey: "test-key" });
    assert.ok(provider instanceof TopazTransparencyUpscaleProvider);
    assert.equal(provider.providerKey, "topaz_transparency_upscale");
  });

  it("B: resolves UnavailableFinalArtworkProvider (never local, never a working Topaz instance) when topaz is misconfigured", async () => {
    const provider = resolveFinalArtworkProvider({
      mode: "unavailable",
      safeErrorCode: "FINAL_ARTWORK_PROVIDER_NOT_CONFIGURED",
      internalReason: "TOPAZ_API_KEY is not set.",
    });
    assert.ok(provider instanceof UnavailableFinalArtworkProvider);
    await assert.rejects(
      () =>
        provider.produce({
          sourceBytes: Buffer.from(""),
          sourceContentType: "image/png",
          targetWidthPx: 100,
          targetHeightPx: 100,
          marginFraction: 0.05,
        }),
      /TOPAZ_API_KEY/i,
    );
  });
});
