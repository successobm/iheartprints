import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MATTE_RAMP,
  RESIDUAL_BODY_TOP,
  RESIDUAL_INTERIOR_DOT,
  RESIDUAL_SPECK_POINTS,
  RESIDUAL_SPIKE_BOTTOM,
  RESIDUAL_SPIKE_TOP,
  RESIDUAL_SPIKE_X,
  ambiguousDarkEdgeArtwork,
  darkOutlinedTaglineArtwork,
  fingerHoleArtwork,
  getPixel,
  haloArtwork,
  intentionalShadowArtwork,
  lightBackgroundEdgeArtwork,
  matteContaminatedEdgeArtwork,
  residualEdgeSpeckArtwork,
  thickDarkOutlineArtwork,
} from "./artwork-fixtures";
import {
  BASE_BACKGROUND_TOLERANCE,
  decontaminateEdgeRgb,
  decontaminateResidualEdgeIslands,
  isolateBackground,
} from "./background-isolation";
import { analyzeArtwork } from "./image-analysis";
import { normalizeProductionRaster } from "@/capabilities/final-artwork/production-normalization";
import { PRINT_PLACEMENT_SIZING_POLICY } from "@/capabilities/shared/print-placement-dimensions";
import {
  hasAnyTransparentPixel,
  type RgbaImage,
} from "@/capabilities/final-artwork/raster-transform";

/**
 * Phase 1.6 — RGB-ONLY EDGE DECONTAMINATION.
 *
 * The whole pass is one bet: that the difference between a dark pixel worth
 * fixing and a dark pixel worth protecting is TOPOLOGY (how thick is it, what
 * is behind it, what is in front of it) and never COLOUR. Every case below
 * exists to hold that bet to account — most of them by presenting a pixel that
 * is exactly as dark and exactly as close to the removed background as the one
 * the pass is meant to fix, and demanding it come through untouched.
 *
 * The alpha invariant is first because it is the one that cannot be traded
 * away: this pass may be wrong about a colour, but it must never be able to
 * change the shape of the artwork.
 */

/** The audited background model, stated explicitly so the fixtures pin the real arithmetic. */
const AUDITED_MODEL = {
  backgroundColor: { r: 1, g: 1, b: 1 },
  tolerance: BASE_BACKGROUND_TOLERANCE,
};

function alphaPlane(image: RgbaImage): Buffer {
  const plane = Buffer.alloc(image.width * image.height);
  for (let pixel = 0; pixel < image.width * image.height; pixel += 1) {
    plane[pixel] = image.data[pixel * 4 + 3]!;
  }
  return plane;
}

function luminance(pixel: { r: number; g: number; b: number }): number {
  return 0.2126 * pixel.r + 0.7152 * pixel.g + 0.0722 * pixel.b;
}

/** Row 60 is in the middle of every vertical-edge fixture's body. */
const ROW = 60;

describe("C: the alpha invariant", () => {
  it("writes not one byte of alpha, compared plane-to-plane", () => {
    const image = matteContaminatedEdgeArtwork();
    const { width, height } = image;
    const total = width * height;

    // A target that has already been through erase + composite feathering is
    // not needed to prove this: what matters is that WHATEVER alpha this pass
    // is handed comes back identical. So hand it a deliberately varied plane.
    const target: RgbaImage = { width, height, data: Buffer.from(image.data) };
    const mask = new Uint8Array(total);
    const distance = new Uint8Array(total).fill(1);
    const declined = new Uint8Array(total).fill(1);
    for (let pixel = 0; pixel < total; pixel += 1) {
      const x = pixel % width;
      if (x < 39) {
        mask[pixel] = 1;
        distance[pixel] = 0;
        target.data[pixel * 4 + 3] = 0;
      } else if (x === 40) {
        target.data[pixel * 4 + 3] = 137; // a partially feathered rim
      }
    }

    const before = alphaPlane(target);
    const result = decontaminateEdgeRgb(image, target, mask, distance, declined);
    const after = alphaPlane(target);

    assert.ok(result.recoloured > 0, "the fixture must actually exercise the pass");
    assert.ok(before.equals(after), "the alpha plane must be byte-for-byte identical");
  });

  it("leaves alpha untouched on the contaminated pixel it recolours", () => {
    const image = matteContaminatedEdgeArtwork();
    const { image: prepared } = isolateBackground(image, AUDITED_MODEL);

    assert.equal(getPixel(image, 39, ROW).a, 255);
    assert.equal(getPixel(prepared, 39, ROW).a, 255);
  });
});

describe("D: high-confidence dark matte edge", () => {
  it("recolours the opaque remnant of the removed background from the artwork behind it", () => {
    const image = matteContaminatedEdgeArtwork();
    const { image: prepared, record } = isolateBackground(image, AUDITED_MODEL);

    // x=38 reads as background and goes; x=39 is outside the tolerance, is
    // kept, and is the pixel the composite model cannot explain.
    assert.equal(getPixel(prepared, 38, ROW).a, 0);

    const original = getPixel(image, 39, ROW);
    const cleaned = getPixel(prepared, 39, ROW);
    assert.deepEqual(
      { r: original.r, g: original.g, b: original.b },
      { r: MATTE_RAMP[1]!.r, g: MATTE_RAMP[1]!.g, b: MATTE_RAMP[1]!.b },
    );
    assert.ok(
      luminance(cleaned) > luminance(original) + 24,
      `expected the matte to lift materially, got ${luminance(original)} → ${luminance(cleaned)}`,
    );
    assert.ok(record.fringeRgbFallbackPixels > 0);
    assert.equal(record.fringeRgbFallbackCandidates >= record.fringeRgbFallbackPixels, true);
  });

  it("takes the replacement colour from the artwork's own inward reference", () => {
    const image = matteContaminatedEdgeArtwork();
    const { image: prepared } = isolateBackground(image, AUDITED_MODEL);

    // The first non-dark pixel along the inward normal, two steps in.
    const reference = getPixel(prepared, 41, ROW);
    const cleaned = getPixel(prepared, 39, ROW);
    assert.deepEqual(
      { r: cleaned.r, g: cleaned.g, b: cleaned.b },
      { r: reference.r, g: reference.g, b: reference.b },
    );
  });
});

describe("E: a genuine thick dark outline", () => {
  it("preserves a 3px stroke that is exactly as dark and exactly as adjacent to transparency", () => {
    const image = thickDarkOutlineArtwork();
    const { image: prepared, record } = isolateBackground(image, AUDITED_MODEL);

    assert.equal(
      record.fringeRgbFallbackPixels,
      0,
      "no pixel of a 3px stroke may be recoloured",
    );

    // The outermost stroke column is where the composite model declines (there
    // is no solid reference within reach), so it is reachable ONLY by this
    // pass — which makes it the pixel that proves the pass declined.
    const original = getPixel(image, 39, ROW);
    const after = getPixel(prepared, 39, ROW);
    assert.deepEqual(after, original, "the outer stroke column must be byte-identical");
  });
});

describe("F: interior dark artwork, far from any exterior", () => {
  it("never touches a dark region that is not adjacent to confirmed transparency", () => {
    const image = intentionalShadowArtwork();
    const analysis = analyzeArtwork({
      image,
      format: "image/png",
      byteSize: 1234,
      declaresAlphaChannel: true,
      printPlacement: null,
      intendedPrintWidthIn: null,
    });
    const { image: prepared } = isolateBackground(image, {
      backgroundColor: analysis.estimatedBackgroundColor,
      tolerance: analysis.backgroundTolerance,
    });

    // The drop shadow sits deep inside the light plate.
    const before = getPixel(image, 120, 160);
    const after = getPixel(prepared, 120, 160);
    assert.deepEqual(after, before);
    assert.ok(luminance(after) < 64, "the shadow must still be dark");
  });
});

describe("A/B: intentional dark holes", () => {
  const HOLES: Array<[string, number, number]> = [
    ["hole 1", 130, 120],
    ["hole 2", 190, 120],
    ["hole 3", 160, 175],
  ];

  it("survive automatic preparation with their colour intact", () => {
    const image = fingerHoleArtwork();
    const { image: prepared, record } = isolateBackground(image, AUDITED_MODEL);

    for (const [name, x, y] of HOLES) {
      const after = getPixel(prepared, x, y);
      assert.equal(after.a, 255, `${name} must stay opaque`);
      assert.ok(luminance(after) < 64, `${name} must stay dark, got ${luminance(after)}`);
      assert.deepEqual(after, getPixel(image, x, y), `${name} must be byte-identical`);
    }
    assert.equal(record.fringeRgbFallbackPixels, 0);
  });

  it("survive an unrelated guided removal elsewhere in the image", () => {
    const image = fingerHoleArtwork();
    // A click on the exterior resolves to nothing removable; what matters is
    // that the guided path runs at all and the holes are indifferent to it.
    const { image: prepared } = isolateBackground(image, {
      ...AUDITED_MODEL,
      guidedRemovalPoints: [{ x: 5, y: 5 }],
    });

    for (const [name, x, y] of HOLES) {
      const after = getPixel(prepared, x, y);
      assert.equal(after.a, 255, `${name} must stay opaque`);
      assert.deepEqual(after, getPixel(image, x, y), `${name} must be byte-identical`);
    }
  });
});

describe("H: an ambiguous edge", () => {
  it("preserves a dark edge whose luminance does not climb", () => {
    const image = ambiguousDarkEdgeArtwork();
    const { image: prepared, record } = isolateBackground(image, AUDITED_MODEL);

    assert.equal(
      record.fringeRgbFallbackPixels,
      0,
      "without a rising ramp there is no evidence, and no evidence means no change",
    );
    assert.ok(
      record.fringeRgbFallbackPreservedAmbiguous > 0,
      "the undecided pixels must be reported, not silently dropped",
    );
    assert.deepEqual(getPixel(prepared, 39, ROW), getPixel(image, 39, ROW));
  });
});

describe("G: small tagline line work", () => {
  it("keeps every visible pixel and every dark stroke of a tagline-scale glyph", () => {
    const image = darkOutlinedTaglineArtwork();
    const analysis = analyzeArtwork({
      image,
      format: "image/png",
      byteSize: 1234,
      declaresAlphaChannel: true,
      printPlacement: null,
      intendedPrintWidthIn: null,
    });
    const { image: prepared } = isolateBackground(image, {
      backgroundColor: analysis.estimatedBackgroundColor,
      tolerance: analysis.backgroundTolerance,
    });

    // The glyph's bright fill, well clear of every removed region, is untouched...
    assert.deepEqual(getPixel(prepared, 36, 60), getPixel(image, 36, 60));
    // ...and the inner dark stroke that borders the REMOVED counter is still
    // dark rather than flooded with the bright fill two pixels behind it.
    const innerStroke = getPixel(prepared, 40, 60);
    assert.equal(innerStroke.a, 255);
    assert.ok(
      luminance(innerStroke) < 64,
      `the inner stroke must stay dark, got ${luminance(innerStroke)}`,
    );
  });
});

describe("I: a light background", () => {
  it("declines entirely — the forensics that justify this pass measured dark contamination only", () => {
    const image = lightBackgroundEdgeArtwork();
    const analysis = analyzeArtwork({
      image,
      format: "image/png",
      byteSize: 1234,
      declaresAlphaChannel: true,
      printPlacement: null,
      intendedPrintWidthIn: null,
    });
    const { image: prepared, record } = isolateBackground(image, {
      backgroundColor: analysis.estimatedBackgroundColor,
      tolerance: analysis.backgroundTolerance,
    });

    assert.ok(analysis.estimatedBackgroundColor.r > 240);
    assert.equal(record.fringeRgbFallbackPixels, 0);
    // The dark body itself is untouched.
    assert.deepEqual(getPixel(prepared, 60, ROW), getPixel(image, 60, ROW));
  });
});

describe("K/L: the existing composite path", () => {
  it("still decontaminates a white-on-dark anti-aliased rim exactly as before", () => {
    const image = haloArtwork();
    const analysis = analyzeArtwork({
      image,
      format: "image/png",
      byteSize: 1234,
      declaresAlphaChannel: true,
      printPlacement: null,
      intendedPrintWidthIn: null,
    });
    const { image: prepared, record } = isolateBackground(image, {
      backgroundColor: analysis.estimatedBackgroundColor,
      tolerance: analysis.backgroundTolerance,
    });

    // The composite model succeeds here, so the fallback must never see these
    // pixels — it only ever runs on what that model declined.
    assert.ok(record.decontaminatedPixels > 0);

    let fringeX = -1;
    for (let x = 0; x < prepared.width; x += 1) {
      const alpha = getPixel(prepared, x, 70).a;
      if (alpha > 0 && alpha < 255) {
        fringeX = x;
        break;
      }
    }
    assert.ok(fringeX >= 0);
    assert.ok(getPixel(prepared, fringeX, 70).r > getPixel(image, fringeX, 70).r);
  });
});

describe("M: local production normalization", () => {
  /**
   * Share of VISIBLE pixels that are dark. On this fixture the only dark
   * pixels are the matte, so this is a direct read of how much of it is left
   * once the plate has been resampled to production size.
   */
  function darkShare(image: RgbaImage): number {
    const { width, height, data } = image;
    let visible = 0;
    let dark = 0;
    for (let pixel = 0; pixel < width * height; pixel += 1) {
      const idx = pixel * 4;
      if (data[idx + 3]! < 16) continue;
      visible += 1;
      if (luminance({ r: data[idx]!, g: data[idx + 1]!, b: data[idx + 2]! }) < 64) dark += 1;
    }
    return dark / Math.max(1, visible);
  }

  function normalized(image: RgbaImage): RgbaImage {
    const outcome = normalizeProductionRaster(image, PRINT_PLACEMENT_SIZING_POLICY.full_front);
    assert.equal(outcome.status, "normalized");
    assert.ok(outcome.status === "normalized");
    return outcome.result.image;
  }

  it("does not resample the matte back in", () => {
    // Every resample in this codebase interpolates RGB independently of alpha.
    // If the decontaminated colour did not survive that, the fix would be
    // cosmetic on the prepared asset and absent from the plate that prints.
    const image = matteContaminatedEdgeArtwork();
    const { image: prepared } = isolateBackground(image, AUDITED_MODEL);

    // The same prepared asset with the matte put back — the counterfactual.
    const contaminated: RgbaImage = {
      width: prepared.width,
      height: prepared.height,
      data: Buffer.from(prepared.data),
    };
    for (let y = 30; y < 90; y += 1) {
      const idx = (y * prepared.width + 39) * 4;
      contaminated.data[idx] = MATTE_RAMP[1]!.r;
      contaminated.data[idx + 1] = MATTE_RAMP[1]!.g;
      contaminated.data[idx + 2] = MATTE_RAMP[1]!.b;
    }

    const cleanShare = darkShare(normalized(prepared));
    const dirtyShare = darkShare(normalized(contaminated));

    assert.ok(
      cleanShare < dirtyShare,
      `normalization must carry the fix through, got ${cleanShare} vs ${dirtyShare}`,
    );
  });

  it("preserves alpha topology, aspect ratio and dimensions", () => {
    const image = matteContaminatedEdgeArtwork();
    const { image: prepared } = isolateBackground(image, AUDITED_MODEL);
    const outcome = normalizeProductionRaster(
      prepared,
      PRINT_PLACEMENT_SIZING_POLICY.full_front,
    );
    assert.ok(outcome.status === "normalized");

    const { metadata } = outcome.result;
    assert.ok(
      Math.abs(metadata.outputAspectRatio - metadata.trimmedAspectRatio) < 0.01,
      "aspect ratio must survive normalization",
    );
    assert.equal(outcome.result.image.width, metadata.outputWidthPx);
    assert.equal(outcome.result.image.height, metadata.outputHeightPx);
    // Still a cut-out, not a flattened plate.
    assert.ok(hasAnyTransparentPixel(outcome.result.image));
  });
});

describe("J: garment neutrality", () => {
  it("produces identical bytes regardless of anything about presentation", () => {
    // The pass has no parameter through which a garment or preview colour
    // could reach it; this pins that the prepared bytes are a pure function of
    // (original, background model, clicks) and nothing else. Phase 1.5's QA
    // backgrounds are a rendering of this asset, never an input to it.
    const image = matteContaminatedEdgeArtwork();
    const first = isolateBackground(image, AUDITED_MODEL);
    const second = isolateBackground(image, AUDITED_MODEL);

    assert.ok(first.image.data.equals(second.image.data));
    assert.equal(first.record.fringeRgbFallbackPixels, second.record.fringeRgbFallbackPixels);
  });

  it("never mutates the customer's original", () => {
    const image = matteContaminatedEdgeArtwork();
    const pristine = Buffer.from(image.data);
    isolateBackground(image, AUDITED_MODEL);
    assert.ok(image.data.equals(pristine));
  });
});

/**
 * PHASE 1.6B — RESIDUAL EDGE ISLANDS.
 *
 * Phase 1.6 asks a question about a pixel and ONE direction. Where the
 * silhouette turns a corner that direction points along the edge instead of
 * across it, and the ramp test then has nothing to read. This pass asks about
 * the whole dark COMPONENT instead.
 *
 * `residualEdgeSpeckArtwork` puts a fleck, an interior mark and a hairline
 * spike on the same edge of the same body in the same colour, so nothing below
 * can pass by reading darkness, distance from the background, or adjacency to
 * transparency. Only component shape separates them.
 */
describe("N: residual edge islands the directional pass cannot see", () => {
  it("recolours a fleck whose inward normal points into transparency", () => {
    const image = residualEdgeSpeckArtwork();
    const { image: prepared, record } = isolateBackground(image, AUDITED_MODEL);

    assert.equal(
      record.fringeRgbFallbackPixels,
      0,
      "the directional pass must genuinely be blind here, or this proves nothing",
    );
    assert.equal(record.fringeRgbResidualPixels, RESIDUAL_SPECK_POINTS.length);
    assert.ok(record.fringeRgbResidualCandidates >= record.fringeRgbResidualPixels);

    const body = getPixel(prepared, RESIDUAL_SPECK_POINTS[0]![0], RESIDUAL_BODY_TOP);
    for (const [x, y] of RESIDUAL_SPECK_POINTS) {
      const before = getPixel(image, x, y);
      const after = getPixel(prepared, x, y);
      assert.ok(luminance(before) < 64, `the fleck at ${x},${y} must start dark`);
      assert.ok(
        luminance(after) > luminance(before) + 24,
        `the fleck at ${x},${y} must lift materially, got ${luminance(before)} → ${luminance(after)}`,
      );
      assert.deepEqual(
        { r: after.r, g: after.g, b: after.b },
        { r: body.r, g: body.g, b: body.b },
        "the replacement colour must come from the artwork the fleck sits on",
      );
      assert.equal(after.a, before.a, "and its alpha must be untouched");
    }
  });

  it("preserves the identical mark one pixel deeper, where it is artwork", () => {
    const image = residualEdgeSpeckArtwork();
    const { image: prepared } = isolateBackground(image, AUDITED_MODEL);

    const [x, y] = RESIDUAL_INTERIOR_DOT;
    assert.deepEqual(
      getPixel(prepared, x, y),
      getPixel(image, x, y),
      "a dark mark that does not touch the exterior is the artwork, whatever its size",
    );
  });

  it("preserves a hairline spike that is thin but too long to be a fleck", () => {
    const image = residualEdgeSpeckArtwork();
    const { image: prepared } = isolateBackground(image, AUDITED_MODEL);

    for (let y = RESIDUAL_SPIKE_TOP; y < RESIDUAL_SPIKE_BOTTOM; y += 1) {
      assert.deepEqual(
        getPixel(prepared, RESIDUAL_SPIKE_X, y),
        getPixel(image, RESIDUAL_SPIKE_X, y),
        `the spike pixel at row ${y} must be byte-identical`,
      );
    }
  });
});

describe("O: the finger holes, against the island pass", () => {
  it("leaves all three untouched and never even counts them as candidates", () => {
    const image = fingerHoleArtwork();
    const { image: prepared, record } = isolateBackground(image, AUDITED_MODEL);

    assert.equal(record.fringeRgbResidualPixels, 0);
    for (const [name, x, y] of [
      ["hole 1", 130, 120],
      ["hole 2", 190, 120],
      ["hole 3", 160, 175],
    ] as Array<[string, number, number]>) {
      assert.deepEqual(getPixel(prepared, x, y), getPixel(image, x, y), `${name} must be byte-identical`);
      assert.ok(luminance(getPixel(prepared, x, y)) < 64, `${name} must stay dark`);
    }
  });
});

describe("P: a genuine thick dark outline, against the island pass", () => {
  it("recolours nothing — the component is neither small nor thin", () => {
    const image = thickDarkOutlineArtwork();
    const { image: prepared, record } = isolateBackground(image, AUDITED_MODEL);

    assert.equal(record.fringeRgbResidualPixels, 0);
    assert.deepEqual(getPixel(prepared, 39, ROW), getPixel(image, 39, ROW));
    assert.deepEqual(getPixel(prepared, 40, ROW), getPixel(image, 40, ROW));
    assert.deepEqual(getPixel(prepared, 41, ROW), getPixel(image, 41, ROW));
  });
});

describe("Q: an intentional shadow, against the island pass", () => {
  it("recolours nothing deep inside the plate", () => {
    const image = intentionalShadowArtwork();
    const analysis = analyzeArtwork({
      image,
      format: "image/png",
      byteSize: 1234,
      declaresAlphaChannel: true,
      printPlacement: null,
      intendedPrintWidthIn: null,
    });
    const { image: prepared, record } = isolateBackground(image, {
      backgroundColor: analysis.estimatedBackgroundColor,
      tolerance: analysis.backgroundTolerance,
    });

    assert.equal(record.fringeRgbResidualPixels, 0);
    assert.deepEqual(getPixel(prepared, 120, 160), getPixel(image, 120, 160));
  });
});

describe("R: small tagline line work, against the island pass", () => {
  it("keeps the inner dark stroke that borders a removed counter", () => {
    const image = darkOutlinedTaglineArtwork();
    const analysis = analyzeArtwork({
      image,
      format: "image/png",
      byteSize: 1234,
      declaresAlphaChannel: true,
      printPlacement: null,
      intendedPrintWidthIn: null,
    });
    const { image: prepared } = isolateBackground(image, {
      backgroundColor: analysis.estimatedBackgroundColor,
      tolerance: analysis.backgroundTolerance,
    });

    const innerStroke = getPixel(prepared, 40, 60);
    assert.equal(innerStroke.a, 255);
    assert.ok(
      luminance(innerStroke) < 64,
      `the inner stroke must stay dark, got ${luminance(innerStroke)}`,
    );
    assert.deepEqual(getPixel(prepared, 36, 60), getPixel(image, 36, 60));
  });
});

describe("S: the island pass's own invariants", () => {
  /**
   * Alpha identity is asserted around a DIRECT call, so it is a property of
   * this function rather than a coincidence of what the passes around it did.
   *
   * It carries the geometry guarantees with it. Every mask-derived count in the
   * record — cavity regions and pixels, speckle islands, guided removals,
   * feathered edge pixels — and the visible bounding box are all functions of
   * the alpha plane and the mask, both of which are settled before this pass
   * runs. A pass that provably writes no alpha cannot move any of them.
   */
  /** The exterior removed down to the body, with the flecks retained on top of it. */
  function isolatedFleckTarget(image: RgbaImage) {
    const { width, height } = image;
    const total = width * height;
    const target: RgbaImage = { width, height, data: Buffer.from(image.data) };
    const mask = new Uint8Array(total);
    const declined = new Uint8Array(total).fill(1);

    for (let pixel = 0; pixel < total; pixel += 1) {
      if (Math.floor(pixel / width) >= RESIDUAL_BODY_TOP) continue;
      mask[pixel] = 1;
      target.data[pixel * 4 + 3] = 0;
    }
    for (const [x, y] of RESIDUAL_SPECK_POINTS) {
      const pixel = y * width + x;
      mask[pixel] = 0;
      target.data[pixel * 4 + 3] = 255;
    }

    return { target, mask, declined };
  }

  it("writes not one byte of alpha, compared plane-to-plane", () => {
    const image = residualEdgeSpeckArtwork();
    const { target, mask, declined } = isolatedFleckTarget(image);

    const before = alphaPlane(target);
    const result = decontaminateResidualEdgeIslands(image, target, mask, declined);
    const after = alphaPlane(target);

    assert.ok(result.recoloured > 0, "the fixture must actually exercise the pass");
    assert.ok(before.equals(after), "the alpha plane must be byte-for-byte identical");
  });

  it("touches the fleck pixels and no others", () => {
    const image = residualEdgeSpeckArtwork();
    const { target, mask, declined } = isolatedFleckTarget(image);

    const before = Buffer.from(target.data);
    decontaminateResidualEdgeIslands(image, target, mask, declined);

    const changed: Array<[number, number]> = [];
    for (let pixel = 0; pixel < image.width * image.height; pixel += 1) {
      const idx = pixel * 4;
      if (
        before[idx] === target.data[idx] &&
        before[idx + 1] === target.data[idx + 1] &&
        before[idx + 2] === target.data[idx + 2] &&
        before[idx + 3] === target.data[idx + 3]
      ) {
        continue;
      }
      changed.push([pixel % image.width, Math.floor(pixel / image.width)]);
    }

    assert.deepEqual(
      changed.sort((a, b) => a[0] - b[0]),
      [...RESIDUAL_SPECK_POINTS].sort((a, b) => a[0] - b[0]),
      "exactly the flecks, and nothing anywhere else in the image",
    );
  });

  it("is deterministic — no island's output can seed another's reference", () => {
    const image = residualEdgeSpeckArtwork();
    const first = isolateBackground(image, AUDITED_MODEL);
    const second = isolateBackground(image, AUDITED_MODEL);

    assert.ok(first.image.data.equals(second.image.data));
    assert.equal(first.record.fringeRgbResidualPixels, second.record.fringeRgbResidualPixels);
  });

  it("never mutates the customer's original", () => {
    const image = residualEdgeSpeckArtwork();
    const pristine = Buffer.from(image.data);
    isolateBackground(image, AUDITED_MODEL);
    assert.ok(image.data.equals(pristine));
  });
});

describe("T: the island fix survives local production normalization", () => {
  it("does not resample the flecks back in", () => {
    const image = residualEdgeSpeckArtwork();
    const { image: prepared } = isolateBackground(image, AUDITED_MODEL);

    // The same prepared asset with the flecks put back — the counterfactual.
    const contaminated: RgbaImage = {
      width: prepared.width,
      height: prepared.height,
      data: Buffer.from(prepared.data),
    };
    for (const [x, y] of RESIDUAL_SPECK_POINTS) {
      const idx = (y * prepared.width + x) * 4;
      const original = getPixel(image, x, y);
      contaminated.data[idx] = original.r;
      contaminated.data[idx + 1] = original.g;
      contaminated.data[idx + 2] = original.b;
    }

    function darkVisible(source: RgbaImage): number {
      const outcome = normalizeProductionRaster(source, PRINT_PLACEMENT_SIZING_POLICY.full_front);
      assert.ok(outcome.status === "normalized");
      const { data, width, height } = outcome.result.image;
      let dark = 0;
      for (let pixel = 0; pixel < width * height; pixel += 1) {
        const idx = pixel * 4;
        if (data[idx + 3]! < 16) continue;
        if (luminance({ r: data[idx]!, g: data[idx + 1]!, b: data[idx + 2]! }) < 64) dark += 1;
      }
      return dark;
    }

    assert.ok(
      darkVisible(prepared) < darkVisible(contaminated),
      "the fix must carry through to the plate that actually prints",
    );
  });
});
