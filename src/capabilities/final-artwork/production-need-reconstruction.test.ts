import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PNG } from "pngjs";

import {
  assembleUploadedPreserveProductionPrintValidationInput,
  createPrintValidationCapability,
} from "@/capabilities/print-validation";
import {
  PRINT_PLACEMENT_SIZING_POLICY,
  type PlacementSizingPolicy,
} from "@/capabilities/shared/print-placement-dimensions";

import { decideEnhancement } from "./enhancement-decision";
import {
  encodeProductionPng,
  normalizeProductionRaster,
} from "./production-normalization";
import { trimToAlphaBounds } from "./alpha-trim";
import type { RgbaImage } from "./raster-transform";
import {
  resolveReconstructionRequest,
  TopazTransparencyUpscaleProvider,
} from "./topaz-transparency-upscale-provider";
import type { FinalArtworkProviderInput } from "./provider";

/**
 * PRINT'EM ALL PHASE 0 — production-need-driven reconstruction.
 *
 * THE FAILURE THIS FILE EXISTS TO PREVENT, from the live order:
 *
 *   prepared artwork   584x640 canvas, 562x486 visible
 *   production         10.5in wide, 300 PPI  ->  3150px plate
 *   needed             3150 / 562 = 5.60x
 *   asked for          4x, because RECONSTRUCTION_SCALE said so
 *   got                2275px of trimmed reconstruction
 *   verdict            reconstruction_sufficiency FAIL at contentScale 1.3846
 *   cost               one Topaz credit, spent on a plate production rejected
 *
 * The fix is NOT to loosen the validator. `reconstruction_sufficiency` was
 * right, and every assertion below leaves it exactly as strict as it was —
 * the D case passes it on the merits, by asking the provider for enough
 * pixels in ONE pass instead of a constant that knew nothing about the plate.
 *
 * ZERO REAL PROVIDER CALLS. Every reconstruction here is a local `pngjs`
 * nearest-neighbour blow-up standing in for Topaz at the exact dimensions the
 * adapter requested. That double is deliberately WORSE than Topaz — it invents
 * no detail whatsoever — which is the honest way to test the arithmetic: if
 * the geometry works with a dumb resampler, the requested size was genuinely
 * sufficient rather than rescued by the provider.
 */

const ALPHA_THRESHOLD = 8;

/** Opaque artwork block centered on a transparent canvas, at an exact visible size. */
function artworkPng(
  canvasWidth: number,
  canvasHeight: number,
  visibleWidth: number,
  visibleHeight: number,
): Buffer {
  const png = new PNG({ width: canvasWidth, height: canvasHeight });
  const left = Math.floor((canvasWidth - visibleWidth) / 2);
  const top = Math.floor((canvasHeight - visibleHeight) / 2);
  for (let y = 0; y < canvasHeight; y += 1) {
    for (let x = 0; x < canvasWidth; x += 1) {
      const i = (canvasWidth * y + x) << 2;
      const inside =
        x >= left && x < left + visibleWidth && y >= top && y < top + visibleHeight;
      // Deliberately near-black artwork on a transparent ground: the live file
      // is dark artwork whose BLACK BACKGROUND was already removed, and this
      // keeps that shape represented.
      png.data[i] = 12;
      png.data[i + 1] = 12;
      png.data[i + 2] = 12;
      png.data[i + 3] = inside ? 255 : 0;
    }
  }
  return PNG.sync.write(png);
}

function decode(bytes: Buffer): RgbaImage {
  const png = PNG.sync.read(bytes);
  return { width: png.width, height: png.height, data: png.data };
}

/** Stand-in for a provider reconstruction: exact requested dimensions, no invented detail. */
function fakeReconstruction(source: RgbaImage, widthPx: number, heightPx: number): RgbaImage {
  const out = new PNG({ width: widthPx, height: heightPx });
  for (let y = 0; y < heightPx; y += 1) {
    const sy = Math.min(source.height - 1, Math.floor((y * source.height) / heightPx));
    for (let x = 0; x < widthPx; x += 1) {
      const sx = Math.min(source.width - 1, Math.floor((x * source.width) / widthPx));
      const si = (source.width * sy + sx) << 2;
      const di = (widthPx * y + x) << 2;
      out.data[di] = source.data[si]!;
      out.data[di + 1] = source.data[si + 1]!;
      out.data[di + 2] = source.data[si + 2]!;
      out.data[di + 3] = source.data[si + 3]!;
    }
  }
  return { width: out.width, height: out.height, data: out.data };
}

function visibleWidthOf(image: RgbaImage): number {
  const trim = trimToAlphaBounds(image, { alphaThreshold: ALPHA_THRESHOLD });
  if (trim.status !== "trimmed") throw new Error("fixture has no visible artwork");
  return trim.metadata.alphaBBox.width;
}

/** The real order's prepared artwork. */
const LIVE_CANVAS = { width: 584, height: 640 };
const LIVE_VISIBLE = { width: 562, height: 486 };

describe("Print'em All Phase 0 — production-need-driven reconstruction", () => {
  /* ================================================================== */
  /* GOAL 5 — the real file, end to end                                  */
  /* ================================================================== */

  it("D: the live 562x486 file requests ~5.6x in ONE pass and reaches a certifiable plate", () => {
    const sourceBytes = artworkPng(
      LIVE_CANVAS.width,
      LIVE_CANVAS.height,
      LIVE_VISIBLE.width,
      LIVE_VISIBLE.height,
    );
    const source = decode(sourceBytes);
    const sizing = PRINT_PLACEMENT_SIZING_POLICY.full_back;

    // --- the paid/not-paid decision is unchanged and still says "reconstruct"
    const enhancement = decideEnhancement({
      sourceVisibleWidthPx: visibleWidthOf(source),
      targetWidthIn: sizing.targetWidthIn,
      targetPpi: sizing.targetPpi,
    });
    assert.equal(enhancement.requiresReconstruction, true);
    assert.equal(enhancement.requiredWidthPx, 3150, "10.5in x 300 PPI");

    // --- the request itself: derived, not constant
    const outcome = resolveReconstructionRequest(source, sizing);
    assert.equal(outcome.status, "resolved");
    if (outcome.status !== "resolved") return;
    const request = outcome.request;

    const impliedFactor = request.projectedVisibleWidthPx / LIVE_VISIBLE.width;
    assert.ok(
      impliedFactor > 5.6 && impliedFactor < 6.0,
      `expected ~5.6x-5.7x (5.60x need + 2% headroom), got ${impliedFactor.toFixed(3)}x`,
    );
    assert.ok(
      impliedFactor > 4,
      "the removed fixed 4x is exactly what produced the live failure",
    );
    assert.equal(request.targetWidthPx, 3150);
    assert.ok(
      request.projectedVisibleWidthPx >= 3150,
      "the reconstruction must carry at least the plate it will be resampled to",
    );
    assert.equal(request.clampedByMaxDimension, false);
    assert.ok(
      Math.abs(request.widthPx / request.heightPx - source.width / source.height) < 0.01,
      "the request preserves the source canvas aspect ratio",
    );

    // --- one reconstruction, then the SAME shared normalization
    const reconstructed = fakeReconstruction(source, request.widthPx, request.heightPx);
    const normalized = normalizeProductionRaster(reconstructed, sizing);
    assert.equal(normalized.status, "normalized");
    if (normalized.status !== "normalized") return;
    const meta = normalized.result.metadata;

    assert.equal(meta.outputWidthPx, 3150);
    assert.ok(
      meta.contentScale <= 1.005,
      `contentScale must clear reconstruction_sufficiency; got ${meta.contentScale.toFixed(4)} (the live failure was 1.3846)`,
    );
    assert.ok(meta.trimmedWidthPx >= 3150);

    // --- authoritative validation, uploaded-preserve profile, unchanged rules
    const encoded = encodeProductionPng(normalized.result);
    assert.equal(encoded.hasTransparency, true, "GOAL 7: transparency survives");

    // The SAME assembler and the SAME capability the worker uses — never a
    // hand-built input that could quietly disagree with production.
    const report = createPrintValidationCapability().validateArtwork(
      assembleUploadedPreserveProductionPrintValidationInput({
        artworkVersionId: "prepared-artwork-version",
        printPlacement: "full_back",
        productSummary: "tshirts",
        intendedPrintWidthIn: 10.5,
        requestedProductionOutput: null,
        asset: {
          contentType: "image/png",
          widthPx: normalized.result.image.width,
          heightPx: normalized.result.image.height,
          hasTransparency: encoded.hasTransparency,
          resolutionProvenance: "reconstructed",
          nativeWidthPx: source.width,
          nativeHeightPx: source.height,
        },
        // Same mapping the worker performs: Print Validation consumes a
        // provider-neutral SUMMARY, and `widthToleranceIn` is a placement
        // policy decision rather than anything a provider declares.
        normalization: {
          strategy: meta.strategy,
          alphaBBoxWidthPx: meta.alphaBBoxWidthPx,
          alphaBBoxHeightPx: meta.alphaBBoxHeightPx,
          trimmedWidthPx: meta.trimmedWidthPx,
          trimmedHeightPx: meta.trimmedHeightPx,
          artworkOccupancy: meta.artworkOccupancy,
          targetWidthIn: meta.targetWidthIn,
          widthToleranceIn: sizing.widthToleranceIn,
          targetPpi: meta.targetPpi,
          intendedWidthIn: meta.intendedWidthIn,
          intendedHeightIn: meta.intendedHeightIn,
          constrainedBy: meta.constrainedBy,
          densityPixelsPerMetre: meta.densityPixelsPerMetre,
        },
        uploadedPreserve: {
          preparedArtworkVersionId: "prepared-artwork-version",
          preparedAssetId: "prepared-asset",
          originalAssetId: "original-opaque-upload",
          sourceBytesSha256: "a".repeat(64),
          sourceAlphaBBoxWidthPx: LIVE_VISIBLE.width,
          sourceAlphaBBoxHeightPx: LIVE_VISIBLE.height,
          enhancement: "reconstructed",
        },
      }),
    );

    const byName = new Map(report.checks.map((c) => [c.check, c]));
    for (const name of [
      "reconstruction_sufficiency",
      "effective_resolution",
      "minimum_raster_dimensions",
      "aspect_ratio_preserved",
      "source_lineage",
      "preserved_source_geometry",
      "transparency",
    ] as const) {
      assert.equal(
        byName.get(name)?.status,
        "pass",
        `${name} must pass: ${byName.get(name)?.reason ?? "check not emitted"}`,
      );
    }
    assert.deepEqual(report.blockingIssues, [], "no blocking issue may remain");
    assert.equal(report.status, "ready", "the plate is certifiable");
  });

  /* ================================================================== */
  /* GOAL 6 — the other scale cases                                      */
  /* ================================================================== */

  it("A: artwork that already carries the target never reaches a paid provider at all", () => {
    const sizing = PRINT_PLACEMENT_SIZING_POLICY.sleeve; // 3in x 300 = 900px
    const source = decode(artworkPng(1200, 1200, 1000, 1000));
    const enhancement = decideEnhancement({
      sourceVisibleWidthPx: visibleWidthOf(source),
      targetWidthIn: sizing.targetWidthIn,
      targetPpi: sizing.targetPpi,
    });
    assert.equal(enhancement.requiresReconstruction, false);
    assert.equal(enhancement.method, "skipped");
    // The worker routes "skipped" to the local normalizer, so no Topaz request
    // is ever built. Proven here at the decision that makes that routing.
  });

  it("B: a source needing under 4x requests only what production needs, never a forced 4x", () => {
    const sizing = PRINT_PLACEMENT_SIZING_POLICY.left_chest; // 4in x 300 = 1200px
    const source = decode(artworkPng(1100, 1100, 1000, 1000));
    const outcome = resolveReconstructionRequest(source, sizing);
    assert.equal(outcome.status, "resolved");
    if (outcome.status !== "resolved") return;

    const factor = outcome.request.projectedVisibleWidthPx / 1000;
    assert.ok(factor < 4, `must not force 4x when production needs ~1.2x; got ${factor.toFixed(3)}x`);
    assert.ok(factor >= 1.2, `must still cover the 1200px plate; got ${factor.toFixed(3)}x`);
    assert.ok(outcome.request.projectedVisibleWidthPx >= outcome.request.targetWidthPx);
  });

  it("C: a source needing about 4x still resolves and still satisfies the validator", () => {
    const sizing = PRINT_PLACEMENT_SIZING_POLICY.full_back; // 3150px
    const source = decode(artworkPng(820, 820, 790, 790));
    const outcome = resolveReconstructionRequest(source, sizing);
    assert.equal(outcome.status, "resolved");
    if (outcome.status !== "resolved") return;

    const factor = outcome.request.projectedVisibleWidthPx / 790;
    assert.ok(factor > 3.9 && factor < 4.2, `expected ~4x, got ${factor.toFixed(3)}x`);

    const normalized = normalizeProductionRaster(
      fakeReconstruction(source, outcome.request.widthPx, outcome.request.heightPx),
      sizing,
    );
    assert.equal(normalized.status, "normalized");
    if (normalized.status !== "normalized") return;
    assert.ok(normalized.result.metadata.contentScale <= 1.005);
  });

  it("E: a non-square source at the maximum is clamped PROPORTIONALLY, never per-axis", () => {
    // 3000x1500 asking for a big upscale: the pre-Phase-0 per-axis clamp turned
    // 12000x6000 into 8192x6000, silently changing a 2.00 aspect ratio to 1.37.
    const source = decode(artworkPng(3000, 1500, 2900, 1400));
    const sizing: PlacementSizingPolicy = {
      ...PRINT_PLACEMENT_SIZING_POLICY.full_back,
      targetWidthIn: 14,
      maxHeightIn: 14,
    };
    const outcome = resolveReconstructionRequest(source, sizing);
    assert.equal(outcome.status, "resolved");
    if (outcome.status !== "resolved") return;

    const sourceAspect = 3000 / 1500;
    const requestAspect = outcome.request.widthPx / outcome.request.heightPx;
    assert.ok(
      Math.abs(requestAspect - sourceAspect) / sourceAspect < 0.001,
      `aspect must survive the clamp: ${sourceAspect} -> ${requestAspect}`,
    );
    assert.ok(outcome.request.widthPx <= 8192);
    assert.ok(outcome.request.heightPx <= 8192);
    assert.notEqual(
      outcome.request.heightPx,
      Math.round(1500 * (outcome.request.widthPx / 3000)) + 1,
      "sanity: height tracked the same scale as width",
    );
  });

  it("F: a request the proportional maximum cannot satisfy fails BEFORE any dispatch", async () => {
    // Tiny visible artwork against a very large plate: even at the 8192 ceiling
    // the reconstruction cannot carry the pixels production requires.
    const sourceBytes = artworkPng(4000, 4000, 40, 40);
    const source = decode(sourceBytes);
    const sizing: PlacementSizingPolicy = {
      ...PRINT_PLACEMENT_SIZING_POLICY.full_back,
      targetWidthIn: 14,
      maxHeightIn: 14,
    };

    const outcome = resolveReconstructionRequest(source, sizing);
    assert.equal(
      outcome.status,
      "insufficient_reconstruction",
      "must be known impossible before a credit is spent",
    );

    // And the adapter must refuse without touching the network.
    let fetched = 0;
    const provider = new TopazTransparencyUpscaleProvider({
      apiKey: "test-key",
      fetchImpl: (async () => {
        fetched += 1;
        throw new Error("no provider call may happen");
      }) as typeof fetch,
      sleepImpl: async () => {},
    });

    let submitted = 0;
    const input: FinalArtworkProviderInput = {
      sourceBytes,
      sourceContentType: "image/png",
      sizing,
      existingProviderRequest: null,
      onProviderRequestSubmitted: async () => {
        submitted += 1;
      },
    };

    await assert.rejects(
      () => provider.produce(input),
      /cannot be reconstructed to the .* this production size requires/i,
    );
    assert.equal(fetched, 0, "GOAL 3: zero provider dispatches");
    assert.equal(submitted, 0, "no paid request identity was ever recorded");
  });

  /* ================================================================== */
  /* GOAL 2 / GOAL 7 — single pass, and the prepared source              */
  /* ================================================================== */

  it("G/H: the reconstruction source is always the PREPARED bytes — never a prior reconstruction", () => {
    const sourceBytes = artworkPng(
      LIVE_CANVAS.width,
      LIVE_CANVAS.height,
      LIVE_VISIBLE.width,
      LIVE_VISIBLE.height,
    );
    const source = decode(sourceBytes);
    const sizing = PRINT_PLACEMENT_SIZING_POLICY.full_back;

    const first = resolveReconstructionRequest(source, sizing);
    assert.equal(first.status, "resolved");
    if (first.status !== "resolved") return;

    // The reconstruction that a first pass would produce.
    const reconstructed = fakeReconstruction(source, first.request.widthPx, first.request.heightPx);

    // GOAL 2: feeding THAT back in is what a second pass would be. The resolver
    // would ask for ~1x — i.e. there is nothing further to gain — which is the
    // arithmetic reason a second pass can only ever launder interpolation as
    // detail rather than add any. The pipeline never does this: the adapter
    // reads `input.sourceBytes` (the prepared asset) exactly once per job.
    const second = resolveReconstructionRequest(reconstructed, sizing);
    assert.equal(second.status, "resolved");
    if (second.status !== "resolved") return;
    assert.ok(
      second.request.scale <= 1.05,
      "a second pass over a reconstruction has nothing left to reconstruct",
    );

    // GOAL 7: the resolved request derives from the transparent prepared
    // artwork, and normalization never reintroduces an opaque ground.
    const normalized = normalizeProductionRaster(
      reconstructed,
      sizing,
    );
    assert.equal(normalized.status, "normalized");
    if (normalized.status !== "normalized") return;
    assert.equal(
      normalized.result.metadata.sourceFullyOpaque,
      false,
      "the prepared (background-removed) artwork is the source, not the opaque original",
    );
    assert.equal(
      encodeProductionPng(normalized.result).hasTransparency,
      true,
      "the black background must never return",
    );
  });

  it("resolves nothing to reconstruct as a truthful verdict, not a crash", () => {
    const empty = new PNG({ width: 64, height: 64 });
    const outcome = resolveReconstructionRequest(
      { width: 64, height: 64, data: empty.data },
      PRINT_PLACEMENT_SIZING_POLICY.full_back,
    );
    assert.equal(outcome.status, "no_visible_artwork");
  });
});
