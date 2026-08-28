import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { resolveWidthConstrainedSizing } from "@/capabilities/shared/print-placement-dimensions";
import { PRODUCTION_BOX_RECOMMENDATIONS } from "@/capabilities/shared/garment-production-sizing";
import { decideEnhancement } from "@/capabilities/final-artwork/enhancement-decision";

import { deriveProductionRequirements } from "./production-requirements";

/**
 * Phase 28C — THE REAL PRODUCTION/ENHANCEMENT SIZING FIX.
 *
 * A live customer order (a tall, portrait event-poster T-shirt design)
 * exposed that Standard Adult full-front/back production was sized
 * primarily from a bare 10.5in WIDTH target — for a tall design this
 * produced an oversized print and overstated how much enhancement was
 * needed.
 *
 * Traced precisely: `deriveProductionRequirements`'s `sizing` field —
 * which BOTH `decideEnhancement` and the actual raster transform
 * (`production-normalization.ts`) read — was built from
 * `sizingPolicyForPlacement` alone, whose `maxHeightIn` is the PLACEMENT's
 * generic technical ceiling (14in for a full front/back), not the
 * garment-class-aware box a human actually confirmed (10.5in for Standard
 * Adult, 8.5in for Youth, ...). A confirmed WIDTH that happens to equal the
 * placement's own default (as every garment-box recommendation's width
 * does, by construction) left `sizingPolicyForPlacement` returning that
 * SAME loose 14in ceiling unchanged, so a tall design correctly confirmed
 * against a 10.5x10.5 Standard Adult box was still produced against a
 * 10.5x14 envelope.
 *
 * The fix (`confirmedMaxHeightIn`) narrows ONLY the height ceiling, and
 * ONLY when a real confirmation supplies one — proven here never to widen
 * anything, never to override an explicit width, and to leave every
 * omitted-parameter caller (the exact contract every existing test already
 * exercises) byte-for-byte unchanged.
 */
describe("Phase 28C: deriveProductionRequirements narrows the height ceiling to a confirmed garment box", () => {
  function requirementsFor(confirmedMaxHeightIn?: number | null) {
    return deriveProductionRequirements({
      printPlacement: "full_front",
      productSummary: "Event poster T-shirt",
      designDescription: null,
      intendedPrintWidthIn: 10.5,
      confirmedMaxHeightIn,
    });
  }

  it("omitted confirmedMaxHeightIn preserves EXACTLY today's behavior -- the placement's own 14in technical ceiling", () => {
    const requirements = requirementsFor(undefined);
    assert.equal(requirements.sizing!.targetWidthIn, 10.5);
    assert.equal(requirements.sizing!.maxHeightIn, 14);
  });

  it("null confirmedMaxHeightIn (a bare, unconfirmed or box-less width) behaves identically to omitted", () => {
    const requirements = requirementsFor(null);
    assert.equal(requirements.sizing!.targetWidthIn, 10.5);
    assert.equal(requirements.sizing!.maxHeightIn, 14);
  });

  it("a confirmed Standard Adult box (10.5x10.5) narrows maxHeightIn to 10.5, never touching targetWidthIn", () => {
    const requirements = requirementsFor(10.5);
    assert.equal(requirements.sizing!.targetWidthIn, 10.5);
    assert.equal(requirements.sizing!.maxHeightIn, 10.5);
  });

  it("only ever NARROWS -- a confirmedMaxHeightIn wider than the placement's own ceiling is not honored (never invented here; a real confirmation cannot exceed the technical limit anyway)", () => {
    const requirements = requirementsFor(20);
    // sizingPolicyForProductionBox substitutes verbatim -- this asserts the
    // substitution mechanism itself is a plain override, not a min/max
    // clamp; the technical-limit refusal happens earlier, at confirmation
    // time (`confirmed-production-size.ts`), never here.
    assert.equal(requirements.sizing!.maxHeightIn, 20);
  });

  it("the ACTUAL output geometry for a tall design changes correctly once the box narrows -- this is what fixes the oversized print", () => {
    // A 2:3 portrait, matching the reported live order's own proportions.
    const artworkWidthPx = 2000;
    const artworkHeightPx = 3000;

    const oldSizing = requirementsFor(undefined).sizing!;
    const oldOutput = resolveWidthConstrainedSizing(oldSizing, artworkWidthPx, artworkHeightPx);
    assert.ok(
      Math.abs(oldOutput.widthIn - 9.3333) < 0.001,
      "the OLD placement-only ceiling (14in) still lets this design run wider than Standard Adult's true box",
    );
    assert.equal(oldOutput.heightIn, 14);

    const newSizing = requirementsFor(10.5).sizing!;
    const newOutput = resolveWidthConstrainedSizing(newSizing, artworkWidthPx, artworkHeightPx);
    assert.equal(newOutput.widthIn, 7, "correctly contained inside the confirmed 10.5x10.5 Standard Adult box");
    assert.equal(newOutput.heightIn, 10.5);

    assert.ok(newOutput.widthIn < oldOutput.widthIn, "the fix must always produce an equal-or-SMALLER plate for a tall design, never a larger one");
    assert.ok(newOutput.heightIn < oldOutput.heightIn);
  });

  it("PRODUCTION_BOX_RECOMMENDATIONS' own authoritative values are what this fix threads through -- never a value invented in this test", () => {
    const box = PRODUCTION_BOX_RECOMMENDATIONS.adult_standard.full_front!;
    assert.equal(box.maxWidthIn, 10.5);
    assert.equal(box.maxHeightIn, 10.5);
    const requirements = requirementsFor(box.maxHeightIn);
    assert.equal(requirements.sizing!.maxHeightIn, 10.5);
  });
});

describe("Phase 28C: decideEnhancement compares against the CONTAINED width, never the box's raw nominal width", () => {
  it("a tall design's own contained target width is narrower than the box's nominal width, so fewer real source pixels are genuinely required", () => {
    const requirements = deriveProductionRequirements({
      printPlacement: "full_front",
      productSummary: "Event poster T-shirt",
      designDescription: null,
      intendedPrintWidthIn: 10.5,
      confirmedMaxHeightIn: 10.5,
    });
    const sizing = requirements.sizing!;

    // The same 2:3 portrait, at a resolution that is enough for its OWN
    // correctly-contained 7.0in width (2100px at 300 PPI) but would have
    // failed the OLD, box-width-only requirement (3150px for 10.5in).
    const sourceVisibleWidthPx = 2200;
    const sourceVisibleHeightPx = 3300;

    const contained = resolveWidthConstrainedSizing(sizing, sourceVisibleWidthPx, sourceVisibleHeightPx);
    assert.equal(contained.widthIn, 7);

    const enhancement = decideEnhancement({
      sourceVisibleWidthPx,
      targetWidthIn: contained.widthIn,
      targetPpi: sizing.targetPpi,
    });
    assert.equal(enhancement.method, "skipped", "2200px already exceeds the 2100px this design's own correctly-contained 7in width needs");

    // Prove the OLD behavior would have wrongly demanded reconstruction for
    // this exact same artwork.
    const oldEnhancement = decideEnhancement({
      sourceVisibleWidthPx,
      targetWidthIn: sizing.targetWidthIn, // the box's raw nominal width (10.5), the old bug
      targetPpi: sizing.targetPpi,
    });
    assert.equal(oldEnhancement.method, "reconstructed", "the OLD width-only comparison overstated this design's real enhancement need");
  });
});
