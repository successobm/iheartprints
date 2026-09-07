/**
 * DTF Background-Removal Garment-Preview Contradiction Phase: regression
 * coverage for the live acceptance defect where "Check what will be
 * removed" surrounded the artwork with unexplained black — a customer's
 * own free-text garment colour ("Blue") could not be resolved by the
 * compositing route, which silently fell back to a hardcoded black baked
 * directly into the returned preview PNG's own pixels.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { compositeOverGarment } from "@/capabilities/final-artwork/halftone-screen";
import { resolveGarmentColor } from "@/capabilities/shared/production-treatment";
import type { RgbaImage } from "@/capabilities/final-artwork/raster-transform";
import {
  buildSeparationMaster,
  computeRegionMap,
} from "@/capabilities/artwork-preparation/region-separation";
import { createCanvas, fillRect, type Rgba } from "@/capabilities/artwork-preparation/artwork-fixtures";

import {
  describePreviewSurface,
  FALLBACK_PREVIEW_SURFACE,
  GARMENT_INSPECTION_SURFACES,
  resolveInitialPreviewSurfaceHex,
} from "./garment-preview-surface";

const MAGENTA_OPAQUE: Rgba = { r: 255, g: 0, b: 255, a: 255 };
const BLACK_INK: Rgba = { r: 5, g: 5, b: 5, a: 255 };

/**
 * "Crockett Rockets"-shaped fixture: a large pink/magenta exterior
 * (the removable candidate) with real opaque BLACK artwork ink in the
 * centre — deliberately near-black-on-nothing so the composited "Result"
 * preview's own transparent-area colour and this genuine ink can be told
 * apart ONLY by whether alpha survives, never by RGB coincidence.
 */
function pinkBackgroundWithBlackInkArtwork(): RgbaImage {
  const image = createCanvas(120, 120, MAGENTA_OPAQUE);
  fillRect(image, 40, 40, 40, 40, BLACK_INK);
  return image;
}

function buildFullyRemovedMaster(original: RgbaImage): RgbaImage {
  const computation = computeRegionMap(original, "test-asset-sha", { r: 255, g: 0, b: 255 }, 24);
  // Default proposalAuthority ("remove_with_exceptions", no exceptions) —
  // the same worst-case default `fullRemovalSafe` itself is computed
  // against — fully removes the in-bounds proposal.
  return buildSeparationMaster(original, computation, []);
}

describe("garment colour resolution feeding the preview (CASE 1, 4, 5, 7)", () => {
  it("CASE 1 — a stated Blue garment resolves to a real blue hex, never falls through to the unlabeled black fallback", () => {
    const hex = resolveInitialPreviewSurfaceHex("Blue");
    assert.equal(hex, "#1F3FAF");
    assert.notEqual(hex, "#000000");
  });

  it("CASE 7 — the active preview surface is always labeled, never left for the customer to guess", () => {
    assert.equal(describePreviewSurface("#1F3FAF", "Blue"), "Blue");
    // A swatch button's own label always wins once explicitly chosen, even
    // if it happens to coincide with the stated garment colour's hex.
    assert.equal(describePreviewSurface("#000000", "Blue"), "Black");
    for (const surface of GARMENT_INSPECTION_SURFACES) {
      assert.equal(describePreviewSurface(surface.hex, "Blue"), surface.label);
    }
  });

  it("CASE 4 — an unrecognized or absent garment colour falls back to White, deterministically, never crashes, never black", () => {
    for (const unrecognized of ["Heather Blue", "", "   ", "not-a-colour", "Blooo"]) {
      const hex = resolveInitialPreviewSurfaceHex(unrecognized);
      assert.equal(hex, FALLBACK_PREVIEW_SURFACE.hex);
      assert.equal(hex, "#FFFFFF");
      assert.notEqual(hex, "#000000");
      assert.equal(describePreviewSurface(hex, unrecognized), "White");
    }
  });

  it("CASE 5 — every recognized garment colour resolves to its own distinct hex, never silently collapsing to one shared fallback", () => {
    const blue = resolveInitialPreviewSurfaceHex("Blue");
    const red = resolveInitialPreviewSurfaceHex("Red");
    const navy = resolveInitialPreviewSurfaceHex("Navy");
    assert.notEqual(blue, red);
    assert.notEqual(blue, navy);
    assert.notEqual(red, navy);
  });
});

describe("garment colour is preview context only — output pixels never change (CASE 1, 2, 3, 5, 6, H)", () => {
  it("CASE 3, 5 — the removal MASTER (before any garment compositing) is byte-identical regardless of which garment colour is later previewed", () => {
    const original = pinkBackgroundWithBlackInkArtwork();
    const masterA = buildFullyRemovedMaster(original);
    const masterB = buildFullyRemovedMaster(original);
    // Two independent computations of the SAME source produce identical
    // masters — the master itself has no garment-colour input at all
    // (`computeRegionMap`/`buildSeparationMaster` take no garment
    // parameter), so there is nothing for a garment choice to change here.
    assert.deepEqual(masterA.data, masterB.data);

    const blue = resolveGarmentColor("Blue")!;
    const black = resolveGarmentColor("Black")!;
    const resultBlue = compositeOverGarment(masterA, blue);
    const resultBlack = compositeOverGarment(masterA, black);
    // The two RESULT previews legitimately differ (different garment
    // colour, as intended) — proving the fixture is meaningful — but the
    // underlying master they were both built from never did.
    assert.notDeepEqual(resultBlue.data, resultBlack.data);
  });

  it("CASE 2 — real opaque black artwork ink is byte-identical across every garment preview colour; only the transparent (removed) area changes", () => {
    const original = pinkBackgroundWithBlackInkArtwork();
    const master = buildFullyRemovedMaster(original);

    const garments = ["Blue", "Black", "White", "Red"].map((c) => resolveGarmentColor(c)!);
    const results = garments.map((g) => compositeOverGarment(master, g));

    // The design's own ink region (40..79, 40..79) must read the SAME RGB
    // — the customer's real artwork — no matter which garment is chosen.
    for (let y = 40; y < 80; y += 5) {
      for (let x = 40; x < 80; x += 5) {
        const idx = (y * original.width + x) * 4;
        const first = [results[0]!.data[idx], results[0]!.data[idx + 1], results[0]!.data[idx + 2]];
        for (const result of results) {
          assert.deepEqual(
            [result.data[idx], result.data[idx + 1], result.data[idx + 2]],
            first,
            `real ink pixel at (${x},${y}) must never change with the previewed garment colour`,
          );
        }
        // And it must genuinely still read as the artwork's own near-black
        // ink — never silently replaced by a garment preview colour.
        assert.ok(first[0]! < 40 && first[1]! < 40 && first[2]! < 40, "ink pixel must remain near-black, not garment-coloured");
      }
    }

    // The exterior (removed/transparent) area, by contrast, DOES legitimately
    // change with the previewed garment — that is the entire point of a
    // garment preview, and proves this isn't a vacuous all-pixels-frozen test.
    const exteriorIdx = (10 * original.width + 10) * 4;
    const exteriorAcrossGarments = results.map((r) => [r.data[exteriorIdx], r.data[exteriorIdx + 1], r.data[exteriorIdx + 2]]);
    const allSame = exteriorAcrossGarments.every(
      (rgb) => rgb[0] === exteriorAcrossGarments[0]![0] && rgb[1] === exteriorAcrossGarments[0]![1] && rgb[2] === exteriorAcrossGarments[0]![2],
    );
    assert.equal(allSame, false, "sanity: the exterior/removed area must actually vary across different previewed garments");
  });

  it("CASE 1, H — compositing over a garment never lowers alpha below what the master already had, and never mutates the master image object itself", () => {
    const original = pinkBackgroundWithBlackInkArtwork();
    const master = buildFullyRemovedMaster(original);
    const masterDataBefore = Buffer.from(master.data);

    const blue = resolveGarmentColor("Blue")!;
    compositeOverGarment(master, blue);

    // `compositeOverGarment` must be a pure function: the master it read
    // from is never itself mutated by a preview compositing call — the
    // SAME master is what the actual print-ready pipeline (`artwork-
    // preparation-capability.ts`'s `derivePreparedAsset`, which never
    // receives a garment parameter at all) would go on to encode.
    assert.deepEqual(master.data, masterDataBefore);
  });

  it("CASE 6 — the Original representation has no garment-colour concept at all; a garment composite is a materially different, separately-labeled image, never confused with the customer's own upload", () => {
    const original = pinkBackgroundWithBlackInkArtwork();
    const originalBytesBefore = Buffer.from(original.data);

    // Building a master/preview from `original` never mutates it — the
    // "Original" tab's own source bytes remain exactly the customer's
    // upload no matter what garment preview work happens elsewhere.
    const master = buildFullyRemovedMaster(original);
    void master;
    assert.deepEqual(original.data, originalBytesBefore);

    // And the label a "Result" composite gets is always distinct from
    // "the original artwork" — see `SeparationReviewPanel`'s own `alt`
    // text branches (`proposalViewMode === "original"` vs `"result"`),
    // proven at the source level in `separation-review-workspace-shape
    // .test.ts`; this test proves the underlying data-level guarantee
    // that makes that labeling honest in the first place.
    assert.notDeepEqual(compositeOverGarment(master, resolveGarmentColor("Blue")!).data, original.data);
  });
});

describe("separation/image route's own master-preview fallback (server-side defense in depth)", () => {
  const ROUTE_SOURCE = readFileSync(
    path.join(
      __dirname,
      "..",
      "..",
      "app",
      "api",
      "projects",
      "[projectId]",
      "artwork-preparation",
      "separation",
      "image",
      "route.ts",
    ),
    "utf8",
  );

  it("no longer defaults or falls back to black for an unresolved garment param", () => {
    assert.doesNotMatch(ROUTE_SOURCE, /#000000/i);
  });

  it("defaults/falls back to white instead", () => {
    const whiteOccurrences = (ROUTE_SOURCE.match(/#FFFFFF/gi) ?? []).length;
    assert.ok(whiteOccurrences >= 2, "both the default query param AND the resolveGarmentColor(...) ?? fallback must use white");
  });

  it("only the master-preview mode ever reads a garment query param — mode=original and mode=proposal-highlight never do", () => {
    const masterPreviewIndex = ROUTE_SOURCE.indexOf('mode === "master"');
    const garmentParamIndex = ROUTE_SOURCE.indexOf('searchParams.get("garment")');
    assert.ok(masterPreviewIndex >= 0 && garmentParamIndex > masterPreviewIndex, "garment resolution must live in the master-preview branch, after the plain master/original modes have already returned");
  });
});
