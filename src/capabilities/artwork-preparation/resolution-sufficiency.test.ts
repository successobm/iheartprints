import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { RgbaImage } from "@/capabilities/final-artwork/raster-transform";
import { PROVIDER_MAX_RECONSTRUCTION_SCALE } from "@/capabilities/final-artwork/topaz-transparency-upscale-provider";

import {
  alreadyTransparentArtwork,
  bowlingStyleArtwork,
  createCanvas,
  fillRect,
  NEAR_BLACK,
  setPixel,
  whiteBackgroundArtwork,
  WHITE,
  type Rgba,
} from "./artwork-fixtures";
import { analyzeArtwork } from "./image-analysis";
import {
  classifyResolutionSufficiency,
  RECONSTRUCTION_SCALE_CEILING,
} from "./resolution-sufficiency";

/**
 * Resolution Sufficiency / Reconstruction Scale Eligibility Phase
 * (advisory) — regression coverage. Mirrors `image-analysis.test.ts`'s own
 * `analyze()` helper exactly, so nothing here diverges from how the rest
 * of this capability already builds an `AnalyzeArtworkInput`.
 *
 * Renamed from `source-recoverability.test.ts` (terminology/contract
 * correction only — see ARCHITECTURE.md §13h2): the classification values
 * and reason codes changed name, but every fixture, pixel count, and
 * expected branch below is byte-for-byte the same math as before the
 * rename. No behavior changed.
 */
function analyze(
  image: RgbaImage,
  overrides: Partial<Parameters<typeof analyzeArtwork>[0]> = {},
) {
  return analyzeArtwork({
    image,
    format: "image/png",
    byteSize: 4096,
    declaresAlphaChannel: true,
    printPlacement: null,
    intendedPrintWidthIn: null,
    ...overrides,
  });
}

/**
 * A hard-edged, near-black, edge-connected exterior (the same proven
 * technique `edgeTouchingSubjectArtwork`/`haloArtwork` already use in
 * `artwork-fixtures.ts`) with an opaque foreground rectangle at an EXACT,
 * chosen pixel size — so `artworkBounds`/`pixelSufficiency.availableWidthPx`
 * land on a precisely known number, never an approximation.
 */
function uniformExteriorWithForegroundRect(
  canvasWidthPx: number,
  canvasHeightPx: number,
  rectXPx: number,
  rectYPx: number,
  rectWidthPx: number,
  rectHeightPx: number,
  fill: Rgba | ((localX: number, localY: number) => Rgba),
): RgbaImage {
  const image = createCanvas(canvasWidthPx, canvasHeightPx, NEAR_BLACK);
  if (typeof fill === "function") {
    for (let y = rectYPx; y < rectYPx + rectHeightPx; y += 1) {
      for (let x = rectXPx; x < rectXPx + rectWidthPx; x += 1) {
        setPixel(image, x, y, fill(x - rectXPx, y - rectYPx));
      }
    }
  } else {
    fillRect(image, rectXPx, rectYPx, rectWidthPx, rectHeightPx, fill);
  }
  return image;
}

/**
 * "Cochrane-class" — the REAL, already-audited evidence from the False
 * Print-Ready Guard regression (`print-validation/false-print-ready-guard
 * .test.ts`'s `cochraneInput`/`cochraneNormalization`): a visible source
 * bbox of 1050x354px against a 14in @ 300PPI (4200px) requested width —
 * "near Topaz's 4x ceiling" per that file's own comment. Reproduced here at
 * the EXACT real pixel counts (not scaled down — `full_front`'s own
 * `minWidthIn` floor clamps an arbitrarily-shrunk request, so only the
 * real width honestly reaches the real ratio) so this module's verdict for
 * the real incident's own shape is proven, not assumed.
 *
 * This is the exact counterexample that drove the rename: the real Topaz
 * reconstruction of this source was visually poor despite landing exactly
 * at the governed ceiling — proof that "within the scale ceiling" and
 * "will reconstruct cleanly" are different facts. See the dedicated test
 * below that asserts this explicitly.
 */
function cochraneClassArtwork(): RgbaImage {
  const marginX = 300;
  const marginY = 190;
  const rectWidth = 1050;
  const rectHeight = 354;
  return uniformExteriorWithForegroundRect(
    rectWidth + marginX * 2,
    rectHeight + marginY * 2,
    marginX,
    marginY,
    rectWidth,
    rectHeight,
    WHITE,
  );
}

/** A continuous-tone, smoothly-varying "photo-like" rectangle — no hard edges, no flat fill, deliberately far from `NEAR_BLACK` at every pixel so it survives exterior removal cleanly. */
function continuousToneArtwork(rectWidthPx: number, rectHeightPx: number): RgbaImage {
  const margin = 50;
  return uniformExteriorWithForegroundRect(
    rectWidthPx + margin * 2,
    rectHeightPx + margin * 2,
    margin,
    margin,
    rectWidthPx,
    rectHeightPx,
    (localX, localY) => ({
      r: 80 + Math.round((localX / rectWidthPx) * 140),
      g: 100 + Math.round((localY / rectHeightPx) * 100),
      b: 120 + Math.round(((localX + localY) / (rectWidthPx + rectHeightPx)) * 120),
      a: 255,
    }),
  );
}

describe("classifyResolutionSufficiency — contract shape", () => {
  it("null when no print-size context exists yet — never guesses a default placement", () => {
    const analysis = analyze(bowlingStyleArtwork());
    assert.equal(analysis.pixelSufficiency, null);
    assert.equal(classifyResolutionSufficiency(analysis), null);
  });

  it("RECONSTRUCTION_SCALE_CEILING never silently disagrees with the real provider's own ceiling", () => {
    assert.equal(RECONSTRUCTION_SCALE_CEILING, PROVIDER_MAX_RECONSTRUCTION_SCALE);
    assert.equal(RECONSTRUCTION_SCALE_CEILING, 4);
  });

  it("evidence.coverageRatio is the EXACT SAME field/value as analysis.pixelSufficiency.coverageRatio — never a second computation", () => {
    const analysis = analyze(bowlingStyleArtwork(), { printPlacement: "full_front" });
    const assessment = classifyResolutionSufficiency(analysis)!;
    assert.equal(assessment.evidence.coverageRatio, analysis.pixelSufficiency!.coverageRatio);
    assert.equal(assessment.evidence.visibleWidthPx, analysis.pixelSufficiency!.availableWidthPx);
    assert.equal(assessment.evidence.requiredWidthPx, analysis.pixelSufficiency!.requiredWidthPx);
  });

  it("is deterministic — the same analysis always produces the same assessment", () => {
    const analysis = analyze(bowlingStyleArtwork(), { printPlacement: "full_front" });
    const first = classifyResolutionSufficiency(analysis);
    const second = classifyResolutionSufficiency(analysis);
    assert.deepEqual(first, second);
  });
});

describe("classifyResolutionSufficiency — real/audited fixtures", () => {
  it("A/J: clean, large-enough logo (real bowling fixture) at 'sleeve' (900px required): resolution_adequate", () => {
    // Audited bbox ~923px wide; sleeve requires 3in @ 300PPI = 900px.
    // 923/900 > 1 -- native resolution already covers this placement.
    const analysis = analyze(bowlingStyleArtwork(), { printPlacement: "sleeve" });
    const assessment = classifyResolutionSufficiency(analysis)!;
    assert.equal(assessment.classification, "resolution_adequate");
    assert.deepEqual(assessment.reasons, ["native_resolution_sufficient"]);
    assert.ok(assessment.evidence.coverageRatio >= 1);
    assert.equal(assessment.evidence.enlargementFactor, 1);
  });

  it("B: the SAME clean bowling source at 'full_front' (3150px required): reconstruction_scale_eligible, never resolution_adequate", () => {
    // Same real bbox (~923px), now short of a much larger target --
    // undersized but clean, exactly the product-principle example.
    const analysis = analyze(bowlingStyleArtwork(), { printPlacement: "full_front" });
    const assessment = classifyResolutionSufficiency(analysis)!;
    assert.equal(assessment.classification, "reconstruction_scale_eligible");
    assert.deepEqual(assessment.reasons, ["within_governed_reconstruction_ceiling"]);
    assert.ok(assessment.evidence.enlargementFactor > 1);
    assert.ok(assessment.evidence.enlargementFactor <= RECONSTRUCTION_SCALE_CEILING);
  });

  it("test #2: the IDENTICAL source classifies differently once the requested production size is materially larger — contextual, not permanent", () => {
    const image = bowlingStyleArtwork();
    const small = classifyResolutionSufficiency(analyze(image, { printPlacement: "sleeve" }))!;
    const large = classifyResolutionSufficiency(analyze(image, { printPlacement: "full_front" }))!;
    assert.equal(small.classification, "resolution_adequate");
    assert.equal(large.classification, "reconstruction_scale_eligible");
    assert.notEqual(small.classification, large.classification);
    // Never a permanent, size-independent verdict baked into the source alone.
    assert.equal(small.evidence.visibleWidthPx, large.evidence.visibleWidthPx);
    assert.notEqual(small.evidence.requiredWidthPx, large.evidence.requiredWidthPx);
  });

  it("H (Cochrane regression): real False Print-Ready Guard evidence — 1050 visible px, 4200 required px, exactly 4x enlargement — classifies reconstruction_scale_eligible, NEVER resolution_adequate, and makes NO claim the reconstruction will look good", () => {
    const analysis = analyze(cochraneClassArtwork(), {
      printPlacement: "full_front",
      intendedPrintWidthIn: 14, // the real Cochrane order's own chosen width
    });
    const assessment = classifyResolutionSufficiency(analysis)!;
    assert.equal(analysis.pixelSufficiency!.availableWidthPx, 1050);
    assert.equal(analysis.pixelSufficiency!.requiredWidthPx, 4200);

    assert.notEqual(assessment.classification, "resolution_adequate");
    // At exactly the governed ceiling (this module's own `<=` boundary,
    // matching the real provider's own — a request AT 4x is not refused,
    // only a request ABOVE it), this lands reconstruction_scale_eligible —
    // proven, not assumed. The REAL Topaz reconstruction of this exact
    // source was visually poor despite this classification: eligibility
    // (fits the governed scale ceiling) is not the same fact as
    // recoverability (will reconstruct cleanly). This assessment's
    // classification, reasons, and evidence make no visual-quality claim
    // whatsoever — see the module doc header and ARCHITECTURE.md §13h2.
    assert.equal(assessment.classification, "reconstruction_scale_eligible");
    assert.deepEqual(assessment.reasons, ["within_governed_reconstruction_ceiling"]);
    assert.ok(
      Math.abs(assessment.evidence.enlargementFactor - RECONSTRUCTION_SCALE_CEILING) < 0.05,
      `expected the enlargement factor to land essentially at the governed ceiling, got ${assessment.evidence.enlargementFactor}`,
    );
  });

  it("K: a genuinely tiny/ambiguous source needing far more than the governed ceiling: resolution_insufficient", () => {
    const tiny = uniformExteriorWithForegroundRect(180, 180, 20, 20, 140, 140, WHITE);
    const analysis = analyze(tiny, { printPlacement: "full_front" }); // 3150px required; 140px visible -> ~22.5x
    const assessment = classifyResolutionSufficiency(analysis)!;
    assert.equal(assessment.classification, "resolution_insufficient");
    assert.deepEqual(assessment.reasons, ["exceeds_governed_reconstruction_ceiling"]);
    assert.ok(assessment.evidence.enlargementFactor > RECONSTRUCTION_SCALE_CEILING);
  });

  it("no visible artwork at all: resolution_insufficient, reason no_visible_artwork — mirrors classifyRepairability's own NOT_REPAIRABLE trigger", () => {
    const blank = createCanvas(200, 200, { r: 0, g: 0, b: 0, a: 0 });
    const analysis = analyze(blank, { printPlacement: "full_front" });
    assert.equal(analysis.artworkBounds, null);
    const assessment = classifyResolutionSufficiency(analysis)!;
    assert.equal(assessment.classification, "resolution_insufficient");
    assert.deepEqual(assessment.reasons, ["no_visible_artwork"]);
  });
});

describe("classifyResolutionSufficiency — content-type neutrality", () => {
  it("E: photo-like continuous-tone content is classified by the SAME resolution arithmetic as a hard-edge logo — no hard-edge penalty exists to apply", () => {
    const photo = continuousToneArtwork(400, 400);
    const analysis = analyze(photo, { printPlacement: "left_chest" }); // 1200px required; 400px visible -> 3x
    const assessment = classifyResolutionSufficiency(analysis)!;
    assert.equal(assessment.classification, "reconstruction_scale_eligible");
    assert.equal(assessment.evidence.coverageRatio, analysis.pixelSufficiency!.coverageRatio);
    // The identical ratio on a hard-edge fixture produces the identical verdict.
    const logo = uniformExteriorWithForegroundRect(500, 500, 50, 50, 400, 400, WHITE);
    const logoAssessment = classifyResolutionSufficiency(analyze(logo, { printPlacement: "left_chest" }))!;
    assert.equal(logoAssessment.classification, assessment.classification);
    assert.equal(logoAssessment.evidence.enlargementFactor, assessment.evidence.enlargementFactor);
  });

  it("F: background presence alone does not make an otherwise-adequate source insufficient", () => {
    // whiteBackgroundArtwork: 120x120 canvas, a 60x60 foreground square --
    // a real, removable background sits around it, unrelated to this
    // classification.
    const analysis = analyze(whiteBackgroundArtwork(), { printPlacement: "sleeve" }); // 900px required
    // The visible artwork here is small (60px) -- deliberately proving the
    // CLASSIFICATION reads visible-content evidence, never whether a
    // background happens to be present, by cross-checking against a
    // transparent-background fixture at the identical visible size below.
    const assessment = classifyResolutionSufficiency(analysis)!;
    assert.ok(
      assessment.classification === "resolution_insufficient" ||
        assessment.classification === "reconstruction_scale_eligible",
    );
    // Background presence is never itself a reason.
    assert.doesNotMatch(assessment.reasons.join(","), /background|transparen/i);
  });

  it("G: transparency alone does not make a source resolution_adequate — an already-transparent but undersized source still reads its true visible size", () => {
    const analysis = analyze(alreadyTransparentArtwork(), { printPlacement: "full_front" }); // 3150px required, ~34px visible gold ellipse
    assert.equal(analysis.hasTransparency, true);
    const assessment = classifyResolutionSufficiency(analysis)!;
    assert.notEqual(assessment.classification, "resolution_adequate");
  });

  it("background presence/absence never changes the classification for the SAME visible content size", () => {
    // A same-size hard-edge subject, once against a removable near-black
    // exterior and once already isolated on transparency -- identical
    // visible bbox, identical verdict.
    const withBackground = uniformExteriorWithForegroundRect(300, 300, 50, 50, 200, 200, WHITE);
    const withoutBackground = createCanvas(200, 200, { r: 0, g: 0, b: 0, a: 0 });
    fillRect(withoutBackground, 0, 0, 200, 200, WHITE);

    const a = classifyResolutionSufficiency(analyze(withBackground, { printPlacement: "left_chest" }))!;
    const b = classifyResolutionSufficiency(analyze(withoutBackground, { printPlacement: "left_chest" }))!;
    assert.equal(a.evidence.visibleWidthPx, b.evidence.visibleWidthPx);
    assert.equal(a.classification, b.classification);
  });
});

describe("classifyResolutionSufficiency — no provider calls, ever", () => {
  it("performs no network/provider I/O — pure function of already-computed analysis", () => {
    const originalFetch = globalThis.fetch;
    let called = false;
    // @ts-expect-error -- test-only trap, restored immediately after
    globalThis.fetch = () => {
      called = true;
      throw new Error("classifyResolutionSufficiency must never call fetch");
    };
    try {
      const analysis = analyze(bowlingStyleArtwork(), { printPlacement: "full_front" });
      classifyResolutionSufficiency(analysis);
      assert.equal(called, false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
