import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  classifyArtworkOrientation,
  NEAR_SQUARE_ASPECT_TOLERANCE,
  orientedProductionBox,
  PRODUCTION_BOX_RECOMMENDATIONS,
  recommendProductionBox,
  sizingPolicyForProductionBox,
} from "./garment-production-sizing";
import {
  PRINT_PLACEMENT_SIZING_POLICY,
  resolveWidthConstrainedSizing,
  safetyMarginPxFor,
} from "./print-placement-dimensions";
import { sizingPolicyForConfirmedSize } from "./confirmed-production-size";
import { describePrintReadySize } from "./print-ready-size";
import { resolveReconstructionRequest } from "@/capabilities/final-artwork/topaz-transparency-upscale-provider";

/**
 * Phase 28S — orientation-aware production sizing.
 *
 * The historical audit (see the Phase 28S final report) found NO prior
 * orientation-classification code anywhere in this repository —
 * `recommendProductionBox` never took artwork dimensions as an input at
 * all, so a "portrait/landscape/square" distinction never existed to
 * regress. What DID exist, and what this phase generalizes, is Phase 28I's
 * one-off partial fix for `adult_plus` (`{maxWidthIn: 10.5, maxHeightIn:
 * 12}`, deliberately taller than a square) — proof the underlying problem
 * (a flat recommendation box strangling portrait artwork) was recognized
 * once before, for one class, and never generalized into a real mechanism.
 * This file is that mechanism's test coverage.
 */
describe("Phase 28S — classifyArtworkOrientation (matrix A-F)", () => {
  it("A: clear portrait", () => {
    assert.equal(classifyArtworkOrientation(1000, 1500), "portrait");
  });

  it("B: clear landscape", () => {
    assert.equal(classifyArtworkOrientation(1500, 1000), "landscape");
  });

  it("C: exact square", () => {
    assert.equal(classifyArtworkOrientation(1000, 1000), "square");
  });

  it("D: near-square portrait, within the intended tolerance, classifies as square", () => {
    // ratio = 0.92, inside [1 - 0.1, 1 + 0.1].
    const ratio = 920 / 1000;
    assert.ok(ratio > 1 - NEAR_SQUARE_ASPECT_TOLERANCE);
    assert.equal(classifyArtworkOrientation(920, 1000), "square");
  });

  it("E: near-square landscape, within the intended tolerance, classifies as square", () => {
    const ratio = 1000 / 920;
    assert.ok(ratio < 1 + NEAR_SQUARE_ASPECT_TOLERANCE);
    assert.equal(classifyArtworkOrientation(1000, 920), "square");
  });

  it("F: the transparent CANVAS never controls orientation — only visible bounds do", () => {
    // A 2000x2000 canvas (which would classify as "square") whose visible
    // alpha bounds are 1000x1500 (portrait). This function only ever sees
    // what its caller passes it (it is pure — see the module doc comment
    // in garment-production-sizing.ts) — passing the CANVAS here would be
    // the caller's bug, not this function's; this test proves the correct
    // call (visible bounds) gives the correct answer.
    const canvasOrientation = classifyArtworkOrientation(2000, 2000);
    const visibleOrientation = classifyArtworkOrientation(1000, 1500);
    assert.equal(canvasOrientation, "square");
    assert.equal(visibleOrientation, "portrait");
  });
});

describe("Phase 28S — Standard Adult / Full Front orientation policy (matrix G-N)", () => {
  const placement = "full_front" as const;
  const placementPolicy = PRINT_PLACEMENT_SIZING_POLICY[placement];
  const box = PRODUCTION_BOX_RECOMMENDATIONS.adult_standard[placement]!;

  it("G: portrait artwork uses the portrait sizing policy — the box's height ceiling is raised to the placement's own technical limit", () => {
    const oriented = orientedProductionBox(box, "portrait", placementPolicy.maxHeightIn);
    assert.equal(oriented.maxWidthIn, box.maxWidthIn);
    assert.equal(oriented.maxHeightIn, placementPolicy.maxHeightIn);
    assert.ok(oriented.maxHeightIn > box.maxHeightIn, "portrait must get MORE height than the flat square box offered");
  });

  it("H: landscape artwork uses the landscape sizing policy — the box is returned completely unchanged", () => {
    const oriented = orientedProductionBox(box, "landscape", placementPolicy.maxHeightIn);
    assert.deepEqual(oriented, box);
  });

  it("I: square artwork uses the square sizing policy — the box is returned completely unchanged", () => {
    const oriented = orientedProductionBox(box, "square", placementPolicy.maxHeightIn);
    assert.deepEqual(oriented, box);
  });

  it("J: all three orientations preserve the artwork's own aspect ratio in the resolved plate", () => {
    const cases: Array<{ orientation: "portrait" | "landscape" | "square"; widthPx: number; heightPx: number }> = [
      { orientation: "portrait", widthPx: 1011, heightPx: 1525 },
      { orientation: "landscape", widthPx: 562, heightPx: 486 },
      { orientation: "square", widthPx: 1000, heightPx: 1000 },
    ];
    for (const { orientation, widthPx, heightPx } of cases) {
      const oriented = orientedProductionBox(box, orientation, placementPolicy.maxHeightIn);
      const policy = sizingPolicyForProductionBox(placementPolicy, oriented.maxWidthIn, oriented.maxHeightIn);
      const resolved = resolveWidthConstrainedSizing(policy, widthPx, heightPx);
      const sourceAspect = widthPx / heightPx;
      const resolvedAspect = resolved.widthPx / resolved.heightPx;
      assert.ok(
        Math.abs(sourceAspect - resolvedAspect) / sourceAspect < 0.01,
        `${orientation}: source aspect ${sourceAspect} vs resolved ${resolvedAspect}`,
      );
    }
  });

  it("K: all three orientations stay within the placement's technical band", () => {
    for (const orientation of ["portrait", "landscape", "square"] as const) {
      const oriented = orientedProductionBox(box, orientation, placementPolicy.maxHeightIn);
      assert.ok(oriented.maxWidthIn <= placementPolicy.maxWidthIn);
      assert.ok(oriented.maxHeightIn <= placementPolicy.maxHeightIn);
    }
  });

  it("L: portrait is NOT artificially capped at 10.5in tall solely because a square recommendation object exists", () => {
    const oriented = orientedProductionBox(box, "portrait", placementPolicy.maxHeightIn);
    assert.notEqual(oriented.maxHeightIn, 10.5);
    assert.equal(oriented.maxHeightIn, 14);
  });

  it("M: landscape is not made excessively tall — a real landscape shape stays well under any square/portrait ceiling", () => {
    // The real INCREDI-BOWLS visible bounds (Phase 28M/28N), landscape.
    const oriented = orientedProductionBox(box, "landscape", placementPolicy.maxHeightIn);
    const policy = sizingPolicyForProductionBox(placementPolicy, oriented.maxWidthIn, oriented.maxHeightIn);
    const resolved = resolveWidthConstrainedSizing(policy, 562, 486);
    assert.equal(resolved.constrainedBy, "width", "a landscape design must be width-bound, never forced tall");
    assert.ok(resolved.heightIn < resolved.widthIn);
  });

  it("N: the restored portrait policy respects the ~1 sq ft guardrail as a sanity check, not a forced target", () => {
    // The real car-show visible bounds (Phase 28Q/28R/28S).
    const oriented = orientedProductionBox(box, "portrait", placementPolicy.maxHeightIn);
    const policy = sizingPolicyForProductionBox(placementPolicy, oriented.maxWidthIn, oriented.maxHeightIn);
    const resolved = resolveWidthConstrainedSizing(policy, 1011, 1525);
    const areaSqIn = resolved.widthIn * resolved.heightIn;
    // Comfortably in the neighborhood of 144 sq in (1 sq ft) -- a sanity
    // guardrail, never an exact target (Section 7 of the Phase 28S
    // mission explicitly forbids forcing exactly 144).
    assert.ok(areaSqIn > 100 && areaSqIn < 145, `area ${areaSqIn} sq in should be near, not far from, ~1 sq ft`);
  });
});

describe("Phase 28T correction — adult_plus's already-deliberate asymmetric box is NOT further widened", () => {
  it("adult_plus (10.5x12, not square) is returned completely unchanged for portrait artwork", () => {
    const placement = "full_front" as const;
    const placementPolicy = PRINT_PLACEMENT_SIZING_POLICY[placement];
    const adultPlusBox = PRODUCTION_BOX_RECOMMENDATIONS.adult_plus[placement]!;
    assert.notEqual(adultPlusBox.maxWidthIn, adultPlusBox.maxHeightIn, "precondition: adult_plus's box is not square");

    const oriented = orientedProductionBox(adultPlusBox, "portrait", placementPolicy.maxHeightIn);
    assert.deepEqual(
      oriented,
      adultPlusBox,
      "a real Phase 28T bug: the original Phase 28S implementation widened EVERY box unconditionally, silently overriding adult_plus's own already-deliberate 12in ceiling to the placement's full 14in",
    );
  });

  it("youth and womens_small (square boxes) DO still receive the portrait widening — only adult_plus's asymmetric choice is exempt", () => {
    const placement = "full_front" as const;
    const placementPolicy = PRINT_PLACEMENT_SIZING_POLICY[placement];
    for (const garmentClass of ["youth", "womens_small"] as const) {
      const box = PRODUCTION_BOX_RECOMMENDATIONS[garmentClass][placement]!;
      assert.equal(box.maxWidthIn, box.maxHeightIn, `precondition: ${garmentClass}'s box is square`);
      const oriented = orientedProductionBox(box, "portrait", placementPolicy.maxHeightIn);
      assert.equal(oriented.maxHeightIn, placementPolicy.maxHeightIn, garmentClass);
    }
  });
});

describe("Phase 28S — real car-show regression (visible bounds 1011x1525, Standard Adult, Full Front)", () => {
  const placement = "full_front" as const;
  const placementPolicy = PRINT_PLACEMENT_SIZING_POLICY[placement];
  const VISIBLE_WIDTH_PX = 1011;
  const VISIBLE_HEIGHT_PX = 1525;

  it("classifies as portrait", () => {
    assert.equal(classifyArtworkOrientation(VISIBLE_WIDTH_PX, VISIBLE_HEIGHT_PX), "portrait");
  });

  it("resolves the canonical portrait size, derived from the aspect ratio + Standard Adult + Full Front policy — never a hardcoded 9.28x14", () => {
    const recommendation = recommendProductionBox({ placement, garmentSizeClass: "adult_standard" });
    assert.ok(recommendation?.box);
    const orientation = classifyArtworkOrientation(VISIBLE_WIDTH_PX, VISIBLE_HEIGHT_PX);
    const oriented = orientedProductionBox(recommendation.box, orientation, placementPolicy.maxHeightIn);
    const policy = sizingPolicyForProductionBox(placementPolicy, oriented.maxWidthIn, oriented.maxHeightIn);
    const resolved = resolveWidthConstrainedSizing(policy, VISIBLE_WIDTH_PX, VISIBLE_HEIGHT_PX);

    // Height is bound at the placement's own technical ceiling (14in) --
    // deterministic given portrait + adult_standard + full_front.
    assert.equal(resolved.constrainedBy, "max_height");
    assert.equal(resolved.heightIn, 14);
    // Width is DERIVED from the same aspect ratio `resolveWidthConstrainedSizing`
    // itself uses -- computed here independently, not copied from any
    // prior phase's report, and asserted equal to what the real function
    // produces.
    const expectedWidthIn = Math.round((14 * placementPolicy.targetPpi) / (VISIBLE_HEIGHT_PX / VISIBLE_WIDTH_PX)) / placementPolicy.targetPpi;
    assert.equal(resolved.widthIn, expectedWidthIn);
    // Documents WHY this is ~9.28x14, not asserting the literal figure as
    // ground truth: it falls straight out of the real 1011x1525 ratio.
    assert.ok(Math.abs(resolved.widthIn - 9.28) < 0.05, `expected close to 9.28in, got ${resolved.widthIn}`);
  });
});

describe("Phase 28S — INCREDI-BOWLS landscape regression (real visible bounds 562x486)", () => {
  // Phase 28M/28N: the real bowling-shirt asset's visible alpha bounds.
  const VISIBLE_WIDTH_PX = 562;
  const VISIBLE_HEIGHT_PX = 486;

  it("classifies as landscape", () => {
    assert.equal(classifyArtworkOrientation(VISIBLE_WIDTH_PX, VISIBLE_HEIGHT_PX), "landscape");
  });

  it("stays width-dominant and unchanged from pre-Phase-28S behavior — fixing portrait must not touch landscape", () => {
    const placement = "full_front" as const;
    const placementPolicy = PRINT_PLACEMENT_SIZING_POLICY[placement];
    const box = PRODUCTION_BOX_RECOMMENDATIONS.adult_standard[placement]!;
    const orientation = classifyArtworkOrientation(VISIBLE_WIDTH_PX, VISIBLE_HEIGHT_PX);
    const oriented = orientedProductionBox(box, orientation, placementPolicy.maxHeightIn);

    // Byte-identical to the unoriented box -- landscape is untouched.
    assert.deepEqual(oriented, box);

    const policy = sizingPolicyForProductionBox(placementPolicy, oriented.maxWidthIn, oriented.maxHeightIn);
    const resolved = resolveWidthConstrainedSizing(policy, VISIBLE_WIDTH_PX, VISIBLE_HEIGHT_PX);
    assert.equal(resolved.constrainedBy, "width");
    assert.equal(resolved.widthIn, 10.5);
    assert.ok(resolved.heightIn < 10.5, "landscape must not be enlarged tall");
  });
});

describe("Phase 28S — square/near-square regression", () => {
  it("a near-square badge (1000x1050) is treated as square, stays proportional, and stays within Standard Adult limits", () => {
    const placement = "full_front" as const;
    const placementPolicy = PRINT_PLACEMENT_SIZING_POLICY[placement];
    const box = PRODUCTION_BOX_RECOMMENDATIONS.adult_standard[placement]!;
    const widthPx = 1000;
    const heightPx = 1050;

    const orientation = classifyArtworkOrientation(widthPx, heightPx);
    assert.equal(orientation, "square");

    const oriented = orientedProductionBox(box, orientation, placementPolicy.maxHeightIn);
    assert.deepEqual(oriented, box, "square must use the box exactly as today -- never treated as extreme portrait or landscape");

    const policy = sizingPolicyForProductionBox(placementPolicy, oriented.maxWidthIn, oriented.maxHeightIn);
    const resolved = resolveWidthConstrainedSizing(policy, widthPx, heightPx);
    assert.ok(resolved.widthIn <= 10.5 && resolved.heightIn <= 10.5, "must stay inside the Standard Adult square-ish envelope");
    const sourceAspect = widthPx / heightPx;
    const resolvedAspect = resolved.widthPx / resolved.heightPx;
    assert.ok(Math.abs(sourceAspect - resolvedAspect) / sourceAspect < 0.01);
  });
});

describe("Phase 28S — downstream consistency (Section 21): recommendation, confirmation, reconstruction, and normalization all agree", () => {
  it("the SAME resolved dimensions drive the customer preview, the confirmed-size read path, and the reconstruction request", () => {
    const placement = "full_front" as const;
    const placementPolicy = PRINT_PLACEMENT_SIZING_POLICY[placement];
    const VISIBLE_WIDTH_PX = 1011;
    const VISIBLE_HEIGHT_PX = 1525;

    const recommendation = recommendProductionBox({ placement, garmentSizeClass: "adult_standard" });
    assert.ok(recommendation?.box);
    const orientation = classifyArtworkOrientation(VISIBLE_WIDTH_PX, VISIBLE_HEIGHT_PX);
    const oriented = orientedProductionBox(recommendation.box, orientation, placementPolicy.maxHeightIn);

    // 1. The customer-facing PREVIEW (pre-confirmation).
    const preview = describePrintReadySize({
      printPlacement: placement,
      intendedPrintWidthIn: null,
      garmentSizeClass: "adult_standard",
      productionSizeConfirmedAt: null,
      productionSizeConfirmedWidthIn: null,
      productionSizeConfirmedMaxHeightIn: null,
      artworkWidthPx: VISIBLE_WIDTH_PX,
      artworkHeightPx: VISIBLE_HEIGHT_PX,
    })!;
    assert.equal(preview.recommendation!.boxHeightIn, oriented.maxHeightIn);
    assert.equal(preview.recommendation!.artworkHeightIn, 14);

    // 2. The CONFIRMED-size read path (what finalization actually uses),
    // fed the SAME oriented box a real confirmation would have persisted.
    const confirmedPolicy = sizingPolicyForConfirmedSize(placement, {
      widthIn: oriented.maxWidthIn,
      boxMaxHeightIn: oriented.maxHeightIn,
      confirmedAt: new Date(0).toISOString(),
    });
    // Same artwork-edge safety margin `describeRecommendation`/production
    // normalization both apply (Phase 28I) -- comparing against a
    // margin-adjusted preview using UN-adjusted pixels would manufacture a
    // fake ~0.05in "inconsistency" that isn't really there.
    const margin = safetyMarginPxFor({ width: VISIBLE_WIDTH_PX, height: VISIBLE_HEIGHT_PX });
    const confirmedResolved = resolveWidthConstrainedSizing(
      confirmedPolicy,
      VISIBLE_WIDTH_PX + 2 * margin,
      VISIBLE_HEIGHT_PX + 2 * margin,
    );
    assert.equal(confirmedResolved.heightIn, preview.recommendation!.artworkHeightIn);
    assert.equal(confirmedResolved.widthIn, preview.recommendation!.artworkWidthIn);

    // 3. The RECONSTRUCTION request (what would be sent to Topaz), built
    // from the SAME confirmed policy -- must target the SAME physical size.
    // A synthetic RGBA buffer whose opaque region is exactly the real
    // visible bounds, centered on a slightly larger canvas (mirrors the
    // real car-show asset: 1024x1536 canvas, ~1011x1525 visible).
    const canvasWidth = 1024;
    const canvasHeight = 1536;
    const data = Buffer.alloc(canvasWidth * canvasHeight * 4);
    const left = Math.floor((canvasWidth - VISIBLE_WIDTH_PX) / 2);
    const top = Math.floor((canvasHeight - VISIBLE_HEIGHT_PX) / 2);
    for (let y = top; y < top + VISIBLE_HEIGHT_PX; y += 1) {
      for (let x = left; x < left + VISIBLE_WIDTH_PX; x += 1) {
        const idx = (y * canvasWidth + x) * 4;
        data[idx + 3] = 255;
      }
    }
    const reconstruction = resolveReconstructionRequest(
      { width: canvasWidth, height: canvasHeight, data },
      confirmedPolicy,
    );
    assert.equal(reconstruction.status, "resolved");
    if (reconstruction.status === "resolved") {
      assert.equal(reconstruction.request.targetHeightPx, Math.round(14 * placementPolicy.targetPpi));
    }
  });
});
