import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { GarmentSizeClass } from "@/lib/domain/types";

import {
  confirmableSizeFromBox,
  normalizeConfirmableWidth,
  PRODUCTION_SIZE_CONFIRMATION_REQUIRED_MESSAGE,
  resolveProductionSizeConfirmation,
  sizingPolicyForConfirmedSize,
} from "./confirmed-production-size";
import {
  ASSUMED_GARMENT_SIZE_CLASS,
  PRODUCTION_BOX_RECOMMENDATIONS,
  recommendProductionBox,
  sizingPolicyForProductionBox,
} from "./garment-production-sizing";
import {
  PRINT_PLACEMENT_SIZING_POLICY,
  resolveWidthConstrainedSizing,
  technicalLimitForPlacement,
} from "./print-placement-dimensions";
import { describePrintReadySize } from "./print-ready-size";

/**
 * Print'em All Phase 1 — the garment-aware production size authority.
 *
 * Pure arithmetic and policy throughout: no repository, no provider, no
 * network, no paid call, no clock.
 *
 * The live fixture these numbers come from is a real prepared upload whose
 * VISIBLE artwork measures 562 x 486 px on a full back. Every containment
 * assertion below is checked against that, so the file proves behavior on the
 * shape that actually went through production rather than on a convenient
 * square.
 */

/** The live Print'em All prepared-upload fixture's visible (alpha-bound) artwork. */
const LIVE_FIXTURE = { widthPx: 562, heightPx: 486 };

/** Contains artwork within a box using the SAME geometry production uses. */
function containWithinBox(
  placement: "full_front" | "full_back" | "left_chest" | "sleeve",
  boxWidthIn: number,
  boxHeightIn: number | null,
  artworkWidthPx: number,
  artworkHeightPx: number,
) {
  return resolveWidthConstrainedSizing(
    sizingPolicyForProductionBox(
      PRINT_PLACEMENT_SIZING_POLICY[placement],
      boxWidthIn,
      boxHeightIn,
    ),
    artworkWidthPx,
    artworkHeightPx,
  );
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

describe("Print'em All Phase 1 — recommendation is not authority", () => {
  it("A: the standard adult full-front recommendation is a 10.5 x 10.5 box", () => {
    const recommendation = recommendProductionBox({
      placement: "full_front",
      garmentSizeClass: "adult_standard",
    });
    assert.deepEqual(recommendation!.box, { maxWidthIn: 10.5, maxHeightIn: 10.5 });
    assert.equal(recommendation!.recommendationKey, "adult_standard:full_front");
  });

  it("A: the standard adult full-BACK recommendation is the same 10.5 x 10.5 box", () => {
    const recommendation = recommendProductionBox({
      placement: "full_back",
      garmentSizeClass: "adult_standard",
    });
    assert.deepEqual(recommendation!.box, { maxWidthIn: 10.5, maxHeightIn: 10.5 });
  });

  it("a recommendation ALWAYS requires explicit confirmation, however good it is", () => {
    for (const placement of ["full_front", "full_back", "left_chest", "sleeve"] as const) {
      const recommendation = recommendProductionBox({
        placement,
        garmentSizeClass: "adult_standard",
      });
      assert.equal(recommendation!.requiresExplicitConfirmation, true);
    }
  });

  it("an unstated garment class is ASSUMED standard adult, and says so", () => {
    const recommendation = recommendProductionBox({
      placement: "full_back",
      garmentSizeClass: null,
    });
    assert.equal(recommendation!.garmentSizeClass, ASSUMED_GARMENT_SIZE_CLASS);
    assert.equal(recommendation!.assumedGarmentSizeClass, true);
    assert.match(recommendation!.rationale, /assumed/i);
  });

  it("no placement means no recommendation — never a guess", () => {
    assert.equal(
      recommendProductionBox({ placement: null, garmentSizeClass: "adult_standard" }),
      null,
    );
  });

  // --- A-G: the exact operator-authorized recommendation table --------------

  it("A/B/C/D: each garment class recommends its own front/back box", () => {
    // The operator's initial Print'em All production recommendations, pinned
    // exactly. These are expected to evolve from real production evidence;
    // this test is what makes an unintended drift visible rather than silent.
    // youth/womens_small/adult_standard remain SQUARE recommendations — a
    // recommendation is an AREA, and the artwork's own proportions decide
    // how much of it gets used.
    const squareExpected = {
      youth: 8.5,
      womens_small: 9,
      adult_standard: 10.5,
    } as const;

    for (const [garmentSizeClass, widthIn] of Object.entries(squareExpected)) {
      for (const placement of ["full_front", "full_back"] as const) {
        assert.deepEqual(
          recommendProductionBox({
            placement,
            garmentSizeClass: garmentSizeClass as keyof typeof squareExpected,
          })!.box,
          { maxWidthIn: widthIn, maxHeightIn: widthIn },
          `${garmentSizeClass} @ ${placement}`,
        );
      }
    }

    // Phase 28I: adult_plus is no longer square. It shares adult_standard's
    // 10.5in WIDTH ceiling (a larger garment does not by itself justify MORE
    // width than the standard, economical DTF envelope) while keeping a
    // taller 12in HEIGHT ceiling a larger garment can still make good use of
    // for a portrait design.
    for (const placement of ["full_front", "full_back"] as const) {
      assert.deepEqual(
        recommendProductionBox({ placement, garmentSizeClass: "adult_plus" })!.box,
        { maxWidthIn: 10.5, maxHeightIn: 12 },
        `adult_plus @ ${placement}`,
      );
    }
  });

  it("the 'standard adult' reassurance never appears for a non-adult garment", () => {
    // It read "This is a standard adult full front print size." for EVERY
    // front/back project before this pass, because 10.5in was the only
    // possibility. Once a youth or 2XL box can be recommended that sentence
    // is simply false, and it sits directly under a chip the customer just
    // pressed saying otherwise.
    const noteFor = (garmentSizeClass: GarmentSizeClass | null) =>
      describePrintReadySize({
        printPlacement: "full_front",
        intendedPrintWidthIn: null,
        garmentSizeClass,
        productionSizeConfirmedAt: null,
        productionSizeConfirmedWidthIn: null,
        productionSizeConfirmedMaxHeightIn: null,
        artworkWidthPx: 1000,
        artworkHeightPx: 1000,
      })!.note;

    assert.match(noteFor("adult_standard")!, /standard adult full front/i);
    // An unstated class resolves to standard adult, so the note is true.
    assert.match(noteFor(null)!, /standard adult full front/i);

    for (const garmentSizeClass of [
      "youth",
      "womens_small",
      "adult_plus",
      "custom",
    ] as const) {
      assert.equal(noteFor(garmentSizeClass), null, garmentSizeClass);
    }
  });

  it("E: custom carries NO recommendation, at any placement, permanently", () => {
    for (const placement of ["full_front", "full_back", "left_chest", "sleeve"] as const) {
      const recommendation = recommendProductionBox({
        placement,
        garmentSizeClass: "custom",
      });
      assert.equal(recommendation!.box, null, placement);
      assert.match(recommendation!.rationale, /must be stated explicitly/i);
    }
  });

  it("F/G: left chest stays 4in and sleeve stays 3in for EVERY named class", () => {
    // A left-chest logo is a left-chest logo regardless of garment size.
    // Scaling it with the class would put a 12in "left chest" print on a 2XL,
    // which is a full front, not a left chest.
    for (const garmentSizeClass of [
      "youth",
      "womens_small",
      "adult_standard",
      "adult_plus",
    ] as const) {
      assert.deepEqual(
        recommendProductionBox({ placement: "left_chest", garmentSizeClass })!.box,
        { maxWidthIn: 4, maxHeightIn: 4 },
        `${garmentSizeClass} left chest`,
      );
      assert.deepEqual(
        recommendProductionBox({ placement: "sleeve", garmentSizeClass })!.box,
        { maxWidthIn: 3, maxHeightIn: 3 },
        `${garmentSizeClass} sleeve`,
      );
    }
  });

  it("every configured recommendation sits INSIDE its placement's technical band", () => {
    // A recommendation that could not be confirmed would be worse than no
    // recommendation at all — the surface would offer a button that refuses.
    for (const [garmentSizeClass, byPlacement] of Object.entries(
      PRODUCTION_BOX_RECOMMENDATIONS,
    )) {
      for (const [placement, box] of Object.entries(byPlacement)) {
        if (!box) continue;
        const limit = technicalLimitForPlacement(
          placement as "full_front" | "full_back" | "left_chest" | "sleeve",
        )!;
        assert.ok(
          box.maxWidthIn >= limit.minWidthIn && box.maxWidthIn <= limit.maxWidthIn,
          `${garmentSizeClass}:${placement} recommends ${box.maxWidthIn}in, outside ${limit.minWidthIn}-${limit.maxWidthIn}in`,
        );
        assert.ok(
          confirmableSizeFromBox(
            placement as "full_front" | "full_back" | "left_chest" | "sleeve",
            box,
          ),
          `${garmentSizeClass}:${placement} must be confirmable`,
        );
      }
    }
  });

  it("the adult_standard row agrees exactly with the placement policy it came from", () => {
    for (const placement of ["full_front", "full_back", "left_chest", "sleeve"] as const) {
      assert.equal(
        PRODUCTION_BOX_RECOMMENDATIONS.adult_standard[placement]!.maxWidthIn,
        PRINT_PLACEMENT_SIZING_POLICY[placement].defaultWidthIn,
        `${placement}: the recommendation and the historical default must not drift`,
      );
    }
  });
});

describe("Print'em All Phase 1 — contain, never distort", () => {
  it("A: a square design fills the standard adult box exactly", () => {
    const contained = containWithinBox("full_back", 10.5, 10.5, 1000, 1000);
    assert.equal(round2(contained.widthIn), 10.5);
    assert.equal(round2(contained.heightIn), 10.5);
  });

  it("B: a 3:2 landscape contains to 10.5 x 7.0 — never stretched to fill", () => {
    const contained = containWithinBox("full_back", 10.5, 10.5, 3000, 2000);
    assert.equal(round2(contained.widthIn), 10.5);
    assert.equal(round2(contained.heightIn), 7);
  });

  it("C: a 2:3 portrait contains to 7.0 x 10.5 — never forced to 10.5 wide", () => {
    const contained = containWithinBox("full_back", 10.5, 10.5, 2000, 3000);
    assert.equal(round2(contained.widthIn), 7);
    assert.equal(round2(contained.heightIn), 10.5);
    assert.equal(contained.constrainedBy, "max_height");
  });

  it("H/I: aspect ratio survives every box, with no crop and no padding", () => {
    const cases = [
      { w: 3000, h: 2000 },
      { w: 2000, h: 3000 },
      { w: 562, h: 486 },
      { w: 1, h: 7 },
      { w: 9, h: 1 },
    ];
    for (const { w, h } of cases) {
      const contained = containWithinBox("full_back", 10.5, 10.5, w, h);
      const sourceAspect = h / w;
      const producedAspect = contained.heightPx / contained.widthPx;
      // Within a pixel of rounding on the smaller axis — the only tolerance
      // integer pixel geometry permits.
      assert.ok(
        Math.abs(sourceAspect - producedAspect) < 1 / Math.min(contained.widthPx, contained.heightPx),
        `${w}x${h}: aspect ${producedAspect} drifted from ${sourceAspect}`,
      );
      // Contained, so neither axis can exceed the box.
      assert.ok(contained.widthIn <= 10.5 + 1e-9);
      assert.ok(contained.heightIn <= 10.5 + 1e-9);
    }
  });
});

describe("Print'em All Phase 1 — the live 562x486 full-back fixture", () => {
  it("Goal 18: the standard adult 10.5 box produces ~10.5 x 9.1", () => {
    const contained = containWithinBox(
      "full_back",
      10.5,
      10.5,
      LIVE_FIXTURE.widthPx,
      LIVE_FIXTURE.heightPx,
    );
    assert.equal(round2(contained.widthIn), 10.5);
    assert.equal(round2(contained.heightIn), 9.08);
    assert.equal(contained.constrainedBy, "width");
    assert.equal(contained.widthPx, 3150);
  });

  it("Goal 18: an explicit 12in confirmation produces ~12 x 10.38", () => {
    const contained = containWithinBox(
      "full_back",
      12,
      // A stated WIDTH carries no box height — the placement's technical
      // limit is the only bound, which is what makes an oversize request
      // honored rather than clipped back to the recommendation.
      null,
      LIVE_FIXTURE.widthPx,
      LIVE_FIXTURE.heightPx,
    );
    assert.equal(round2(contained.widthIn), 12);
    assert.equal(round2(contained.heightIn), 10.38);
    assert.equal(contained.widthPx, 3600);
  });

  it("L/M: each garment class contains the live fixture proportionally in its own box", () => {
    const sourceAspect = LIVE_FIXTURE.heightPx / LIVE_FIXTURE.widthPx;
    const expected = [
      { garmentSizeClass: "youth", widthIn: 8.5, heightIn: 7.35 },
      { garmentSizeClass: "womens_small", widthIn: 9, heightIn: 7.78 },
      { garmentSizeClass: "adult_standard", widthIn: 10.5, heightIn: 9.08 },
      // Phase 28I: this LANDSCAPE fixture is width-constrained in every box
      // (it never reaches the height ceiling), so adult_plus -- which now
      // shares adult_standard's 10.5in width ceiling instead of an
      // independent 12in one -- produces the IDENTICAL result to
      // adult_standard here. That is the intended effect: a larger garment
      // no longer gets more WIDTH just for being larger; see the
      // TALL/portrait test below for where adult_plus's still-taller 12in
      // height ceiling continues to matter.
      { garmentSizeClass: "adult_plus", widthIn: 10.5, heightIn: 9.08 },
    ] as const;

    for (const row of expected) {
      const box = recommendProductionBox({
        placement: "full_back",
        garmentSizeClass: row.garmentSizeClass,
      })!.box!;
      const contained = containWithinBox(
        "full_back",
        box.maxWidthIn,
        box.maxHeightIn,
        LIVE_FIXTURE.widthPx,
        LIVE_FIXTURE.heightPx,
      );

      assert.equal(round2(contained.widthIn), row.widthIn, row.garmentSizeClass);
      assert.equal(round2(contained.heightIn), row.heightIn, row.garmentSizeClass);
      // Landscape artwork, so width is the binding axis in every box — the
      // recommended height is never reached and never pads anything out.
      assert.equal(contained.constrainedBy, "width", row.garmentSizeClass);
      assert.ok(
        Math.abs(contained.heightPx / contained.widthPx - sourceAspect) < 1e-3,
        `${row.garmentSizeClass} distorted the artwork`,
      );
    }
  });

  it("Phase 28C, D-G: a TALL/portrait design contains proportionally into EVERY garment class's own box -- height controls in every one, and increasing garment size never lets a tall design exceed that class's OWN height policy merely because more width happens to be available", () => {
    // The reported live order's own proportions: a 2:3 portrait.
    const tallWidthPx = 2000;
    const tallHeightPx = 3000;
    const sourceAspect = tallHeightPx / tallWidthPx;

    const expected = [
      { garmentSizeClass: "youth", widthIn: 5.67, heightIn: 8.5 },
      { garmentSizeClass: "womens_small", widthIn: 6, heightIn: 9 },
      { garmentSizeClass: "adult_standard", widthIn: 7, heightIn: 10.5 },
      { garmentSizeClass: "adult_plus", widthIn: 8, heightIn: 12 },
    ] as const;

    let previousHeightIn = 0;
    for (const row of expected) {
      const box = recommendProductionBox({
        placement: "full_front",
        garmentSizeClass: row.garmentSizeClass,
      })!.box!;
      const contained = containWithinBox(
        "full_front",
        box.maxWidthIn,
        box.maxHeightIn,
        tallWidthPx,
        tallHeightPx,
      );

      assert.equal(round2(contained.widthIn), row.widthIn, row.garmentSizeClass);
      assert.equal(round2(contained.heightIn), row.heightIn, row.garmentSizeClass);
      // The defining assertion: for THIS artwork, height is what controls
      // in every single garment class -- never width, regardless of how
      // much wider the box gets.
      assert.equal(contained.constrainedBy, "max_height", row.garmentSizeClass);
      assert.ok(
        Math.abs(contained.heightPx / contained.widthPx - sourceAspect) < 1e-3,
        `${row.garmentSizeClass} distorted the artwork`,
      );
      // Neither axis may ever exceed this class's own box.
      assert.ok(contained.widthIn <= box.maxWidthIn + 1e-9, `${row.garmentSizeClass} width exceeded its own box`);
      assert.ok(contained.heightIn <= box.maxHeightIn + 1e-9, `${row.garmentSizeClass} height exceeded its own box`);
      // Exactly this class's OWN height policy, never a neighboring class's --
      // e.g. moving from youth to Standard Adult must land on Standard
      // Adult's 10.5in ceiling, never silently stay at youth's 8.5in just
      // because nothing forced a recompute.
      assert.equal(contained.heightIn, box.maxHeightIn, `${row.garmentSizeClass} height must equal its own box's max height, not a neighboring class's`);
      // Monotonically larger with a larger garment class -- moving from
      // Youth to 2XL-4XL must never SHRINK the result.
      assert.ok(contained.heightIn > previousHeightIn, `${row.garmentSizeClass} must be strictly larger than the previous, smaller class`);
      previousHeightIn = contained.heightIn;
    }
  });

  it("L: the view reports the same three figures a customer would read", () => {
    // Phase 28I: heights are ~0.03-0.04in taller than before this phase --
    // the recommendation card now applies the SAME artwork-edge safety
    // margin production actually uses (`withArtworkEdgeSafetyMargin`), so
    // this figure agrees exactly with the plate that gets produced instead
    // of quoting the pre-margin raw bounding box. adult_plus no longer
    // recommends more WIDTH than adult_standard (Phase 28I's economical
    // envelope) -- for this LANDSCAPE fixture (width-constrained in every
    // box), that makes it identical to adult_standard's own figures.
    const expected = [
      { garmentSizeClass: "youth", widthIn: 8.5, heightIn: 7.38 },
      { garmentSizeClass: "adult_standard", widthIn: 10.5, heightIn: 9.12 },
      { garmentSizeClass: "adult_plus", widthIn: 10.5, heightIn: 9.12 },
    ] as const;

    for (const row of expected) {
      const view = describePrintReadySize({
        printPlacement: "full_back",
        intendedPrintWidthIn: null,
        garmentSizeClass: row.garmentSizeClass,
        productionSizeConfirmedAt: null,
        productionSizeConfirmedWidthIn: null,
        productionSizeConfirmedMaxHeightIn: null,
        artworkWidthPx: LIVE_FIXTURE.widthPx,
        artworkHeightPx: LIVE_FIXTURE.heightPx,
      })!;

      assert.equal(view.recommendation!.boxWidthIn, row.widthIn);
      assert.equal(view.recommendation!.artworkWidthIn, row.widthIn);
      assert.equal(view.recommendation!.artworkHeightIn, row.heightIn);
      // I: showing a recommendation never confirms it.
      assert.equal(view.confirmed, false);
      assert.equal(view.recommendation!.isConfirmed, false);
    }
  });

  it("Goal 18: both sizes preserve the fixture's own aspect ratio", () => {
    const sourceAspect = LIVE_FIXTURE.heightPx / LIVE_FIXTURE.widthPx;
    for (const [boxW, boxH] of [
      [10.5, 10.5],
      [12, null],
    ] as const) {
      const contained = containWithinBox(
        "full_back",
        boxW,
        boxH,
        LIVE_FIXTURE.widthPx,
        LIVE_FIXTURE.heightPx,
      );
      assert.ok(
        Math.abs(contained.heightPx / contained.widthPx - sourceAspect) < 1e-3,
        `${boxW}in box distorted the artwork`,
      );
    }
  });
});

describe("Print'em All Phase 1 — recommendation vs technical limit", () => {
  it("F: an explicit 12in is above the recommendation and well inside the limit", () => {
    const limit = technicalLimitForPlacement("full_back")!;
    assert.ok(12 > PRODUCTION_BOX_RECOMMENDATIONS.adult_standard.full_back!.maxWidthIn);
    assert.ok(12 <= limit.maxWidthIn);
    assert.equal(normalizeConfirmableWidth("full_back", 12), 12);
  });

  it("Goal 11: an explicit oversize is NEVER silently pulled back to the recommendation", () => {
    for (const widthIn of [11, 12, 13, 14]) {
      assert.equal(
        normalizeConfirmableWidth("full_back", widthIn),
        widthIn,
        `${widthIn}in must be honored, not clamped to 10.5`,
      );
    }
  });

  it("G: an explicit width BELOW the recommendation is honored too", () => {
    assert.equal(normalizeConfirmableWidth("full_back", 8), 8);
    assert.equal(normalizeConfirmableWidth("full_back", 4), 4);
  });

  it("a width outside the technical limit is REFUSED, never quietly clamped", () => {
    // Refused rather than clamped precisely because this feeds a
    // CONFIRMATION, and a confirmation must mean exactly what it says. A
    // clamp would record consent for a size the operator never chose.
    assert.equal(normalizeConfirmableWidth("full_back", 20), null);
    assert.equal(normalizeConfirmableWidth("full_back", 1), null);
    assert.equal(normalizeConfirmableWidth("left_chest", 10.5), null);
  });

  it("widths round to the quarter inch, the same way the pipeline does", () => {
    assert.equal(normalizeConfirmableWidth("full_back", 10.4999999), 10.5);
    assert.equal(normalizeConfirmableWidth("full_back", 11.3), 11.25);
  });
});

describe("Print'em All Phase 1 — confirmation is the production authority", () => {
  const CONFIRMED_AT = "2026-08-21T00:00:00.000Z";

  it("J: a numeric default with no confirmation is UNCONFIRMED", () => {
    // The exact live incident: a width existed (or was defaulted into
    // existence) and a paid provider ran against it. A number cannot carry
    // consent, so having one proves nothing.
    const confirmation = resolveProductionSizeConfirmation({
      printPlacement: "full_back",
      productionSizeConfirmedAt: null,
      productionSizeConfirmedWidthIn: null,
      productionSizeConfirmedMaxHeightIn: null,
    });
    assert.equal(confirmation.confirmed, false);
    assert.equal(
      confirmation.confirmed === false ? confirmation.reason : null,
      "never_confirmed",
    );
  });

  it("a HALF-written confirmation is not a confirmation, in either direction", () => {
    const timestampOnly = resolveProductionSizeConfirmation({
      printPlacement: "full_back",
      productionSizeConfirmedAt: CONFIRMED_AT,
      productionSizeConfirmedWidthIn: null,
      productionSizeConfirmedMaxHeightIn: null,
    });
    assert.equal(timestampOnly.confirmed, false);

    const widthOnly = resolveProductionSizeConfirmation({
      printPlacement: "full_back",
      productionSizeConfirmedAt: null,
      productionSizeConfirmedWidthIn: 10.5,
      productionSizeConfirmedMaxHeightIn: null,
    });
    assert.equal(widthOnly.confirmed, false);
  });

  it("no placement means nothing to confirm against", () => {
    const confirmation = resolveProductionSizeConfirmation({
      printPlacement: null,
      productionSizeConfirmedAt: CONFIRMED_AT,
      productionSizeConfirmedWidthIn: 10.5,
      productionSizeConfirmedMaxHeightIn: 10.5,
    });
    assert.equal(confirmation.confirmed, false);
    assert.equal(
      confirmation.confirmed === false ? confirmation.reason : null,
      "placement_unknown",
    );
  });

  it("a confirmation that no longer fits the placement fails CLOSED", () => {
    // 10.5in was confirmed for a full back; the placement then became a left
    // chest, which tops out at 5in. Unconfirmed — never silently clamped to
    // 5in, which would spend money on a size nobody approved.
    const confirmation = resolveProductionSizeConfirmation({
      printPlacement: "left_chest",
      productionSizeConfirmedAt: CONFIRMED_AT,
      productionSizeConfirmedWidthIn: 10.5,
      productionSizeConfirmedMaxHeightIn: 10.5,
    });
    assert.equal(confirmation.confirmed, false);
    assert.equal(
      confirmation.confirmed === false ? confirmation.reason : null,
      "outside_technical_limit",
    );
  });

  it("a confirmed BOX bounds both axes; a confirmed WIDTH bounds only one", () => {
    const box = confirmableSizeFromBox(
      "full_back",
      PRODUCTION_BOX_RECOMMENDATIONS.adult_standard.full_back,
    )!;
    const boxPolicy = sizingPolicyForConfirmedSize("full_back", {
      widthIn: box.widthIn,
      boxMaxHeightIn: box.boxMaxHeightIn,
      confirmedAt: CONFIRMED_AT,
    });
    assert.equal(boxPolicy.maxHeightIn, 10.5);

    const widthPolicy = sizingPolicyForConfirmedSize("full_back", {
      widthIn: 12,
      boxMaxHeightIn: null,
      confirmedAt: CONFIRMED_AT,
    });
    // Falls back to the placement's technical height limit, not the box.
    assert.equal(widthPolicy.maxHeightIn, technicalLimitForPlacement("full_back")!.maxHeightIn);
  });

  it("a class with no recommendation cannot be confirmed from one", () => {
    // `custom` is the permanent case: there is no box, so there is nothing
    // for a "use the recommendation" action to confirm, and the surface has
    // to ask for a width instead.
    assert.equal(
      confirmableSizeFromBox(
        "full_back",
        PRODUCTION_BOX_RECOMMENDATIONS.custom.full_back,
      ),
      null,
    );
  });
});

describe("Print'em All Phase 1 — the size view says all three things", () => {
  const CONFIRMED_AT = "2026-08-21T00:00:00.000Z";

  it("Goal 9: an unconfirmed project reports the recommendation and what blocks it", () => {
    const view = describePrintReadySize({
      printPlacement: "full_back",
      intendedPrintWidthIn: null,
      garmentSizeClass: null,
      productionSizeConfirmedAt: null,
      productionSizeConfirmedWidthIn: null,
      productionSizeConfirmedMaxHeightIn: null,
      artworkWidthPx: LIVE_FIXTURE.widthPx,
      artworkHeightPx: LIVE_FIXTURE.heightPx,
    })!;

    assert.equal(view.confirmed, false);
    assert.equal(view.confirmedAt, null);
    assert.equal(view.blockingMessage, PRODUCTION_SIZE_CONFIRMATION_REQUIRED_MESSAGE);
    assert.equal(view.recommendation!.recommendedFor, "Standard Adult · Full Back");
    assert.equal(view.recommendation!.boxWidthIn, 10.5);
    assert.equal(view.recommendation!.boxHeightIn, 10.5);
    assert.equal(view.recommendation!.artworkWidthIn, 10.5);
    // Phase 28I: +0.04in vs. before this phase -- the artwork-edge safety
    // margin production actually applies is now included in this figure.
    assert.equal(view.recommendation!.artworkHeightIn, 9.12);
    assert.equal(view.recommendation!.isConfirmed, false);
  });

  it("Goal 9: a confirmed project reports the confirmation and stops blocking", () => {
    const view = describePrintReadySize({
      printPlacement: "full_back",
      intendedPrintWidthIn: 10.5,
      garmentSizeClass: "adult_standard",
      productionSizeConfirmedAt: CONFIRMED_AT,
      productionSizeConfirmedWidthIn: 10.5,
      productionSizeConfirmedMaxHeightIn: 10.5,
      artworkWidthPx: LIVE_FIXTURE.widthPx,
      artworkHeightPx: LIVE_FIXTURE.heightPx,
    })!;

    assert.equal(view.confirmed, true);
    assert.equal(view.confirmedAt, CONFIRMED_AT);
    assert.equal(view.blockingMessage, null);
    assert.equal(view.recommendation!.isConfirmed, true);
    assert.equal(view.widthIn, 10.5);
    // Phase 28I: +0.04in vs. before this phase -- see the margin note above.
    assert.equal(view.heightIn, 9.12);
  });

  it("F: a confirmed 12in oversize is REPORTED as 12in, beside the 10.5 recommendation", () => {
    const view = describePrintReadySize({
      printPlacement: "full_back",
      intendedPrintWidthIn: 12,
      garmentSizeClass: "adult_standard",
      productionSizeConfirmedAt: CONFIRMED_AT,
      productionSizeConfirmedWidthIn: 12,
      productionSizeConfirmedMaxHeightIn: null,
      artworkWidthPx: LIVE_FIXTURE.widthPx,
      artworkHeightPx: LIVE_FIXTURE.heightPx,
    })!;

    assert.equal(view.widthIn, 12);
    // Phase 28I: +0.04in vs. before this phase -- see the margin note above.
    assert.equal(view.heightIn, 10.42);
    // The recommendation is still stated — and is still 10.5. Recommendation
    // and confirmed size are allowed to differ; that is the whole point.
    assert.equal(view.recommendation!.boxWidthIn, 10.5);
    assert.equal(view.recommendation!.isConfirmed, false);
    assert.equal(view.confirmed, true);
  });

  it("a confirmed WIDTH of 10.5 is not the same decision as the confirmed 10.5 BOX", () => {
    // The two produce different plates for anything that is not landscape, so
    // the view must not report the recommendation as taken when only its
    // width was confirmed — that would hide "Use recommended size" from
    // somebody who has not actually taken it.
    const widthOnly = describePrintReadySize({
      printPlacement: "full_back",
      intendedPrintWidthIn: 10.5,
      garmentSizeClass: "adult_standard",
      productionSizeConfirmedAt: CONFIRMED_AT,
      productionSizeConfirmedWidthIn: 10.5,
      productionSizeConfirmedMaxHeightIn: null,
      artworkWidthPx: 2000,
      artworkHeightPx: 3000,
    })!;
    assert.equal(widthOnly.confirmed, true);
    assert.equal(widthOnly.recommendation!.isConfirmed, false);
    // Phase 28C (Bug B correction): a width alone lets the portrait run past
    // the recommended area, bounded only by the 14in technical height limit
    // — but width and height must still describe the SAME aspect-preserving
    // plate. Before this fix, `widthIn` and `heightIn` were sourced from two
    // different computations: `heightIn` was correctly clipped to the 14in
    // ceiling, but `widthIn` was left at the bare confirmed 10.5in — an
    // internally inconsistent "10.5 x 14" pair that does not describe this
    // artwork's own 2:3 aspect ratio at all (10.5:14 is 3:4). The correct,
    // aspect-preserving pair for a 2:3 portrait clipped to 14in tall is
    // ~9.33 x 14 — the same `resolveWidthConstrainedSizing` call that
    // clipped the height ALSO narrows the width to match. Phase 28I: +0.05in
    // vs. before this phase -- the artwork-edge safety margin production
    // actually applies is now included in this figure too.
    assert.equal(widthOnly.heightIn, 14);
    assert.equal(widthOnly.widthIn, 9.38);

    const asBox = describePrintReadySize({
      printPlacement: "full_back",
      intendedPrintWidthIn: 10.5,
      garmentSizeClass: "adult_standard",
      productionSizeConfirmedAt: CONFIRMED_AT,
      productionSizeConfirmedWidthIn: 10.5,
      productionSizeConfirmedMaxHeightIn: 10.5,
      artworkWidthPx: 2000,
      artworkHeightPx: 3000,
    })!;
    assert.equal(asBox.recommendation!.isConfirmed, true);
    // Contained within the recommended area: 7.0 x 10.5, aspect preserved.
    assert.equal(asBox.heightIn, 10.5);
    // Phase 28C (Bug B correction): the PRIMARY "Your artwork will print
    // at" statement (`widthIn`/`heightIn`) must agree with the
    // recommendation's own already-correct contained figures — before this
    // fix, `asBox.widthIn` was silently left at the raw confirmed 10.5in
    // box width (never asserted here, which is exactly how this
    // inconsistency went unnoticed) while only `heightIn` was genuinely
    // contained. Phase 28I: +0.03in vs. before this phase -- see the margin
    // note above.
    assert.equal(asBox.widthIn, 7.03);
    assert.equal(asBox.recommendation!.artworkWidthIn, 7.03);
    assert.equal(asBox.recommendation!.artworkHeightIn, 10.5);
  });

  it("E/Goal 7: a custom-size project has no recommendation and must be sized explicitly", () => {
    const view = describePrintReadySize({
      printPlacement: "full_back",
      intendedPrintWidthIn: null,
      garmentSizeClass: "custom",
      productionSizeConfirmedAt: null,
      productionSizeConfirmedWidthIn: null,
      productionSizeConfirmedMaxHeightIn: null,
      artworkWidthPx: LIVE_FIXTURE.widthPx,
      artworkHeightPx: LIVE_FIXTURE.heightPx,
    })!;

    assert.equal(view.recommendation, null);
    assert.equal(view.confirmed, false);
    assert.equal(view.blockingMessage, PRODUCTION_SIZE_CONFIRMATION_REQUIRED_MESSAGE);

    // The architecture is complete regardless: an explicit width confirms
    // exactly as it does for any recommended class.
    const confirmed = describePrintReadySize({
      printPlacement: "full_back",
      intendedPrintWidthIn: 8,
      garmentSizeClass: "custom",
      productionSizeConfirmedAt: CONFIRMED_AT,
      productionSizeConfirmedWidthIn: 8,
      productionSizeConfirmedMaxHeightIn: null,
      artworkWidthPx: LIVE_FIXTURE.widthPx,
      artworkHeightPx: LIVE_FIXTURE.heightPx,
    })!;
    assert.equal(confirmed.confirmed, true);
    assert.equal(confirmed.widthIn, 8);
    assert.equal(confirmed.recommendation, null);
  });

  it("H: an adult-plus operator who explicitly wants 13in gets 13in, not the 12in recommendation", () => {
    const confirmed = describePrintReadySize({
      printPlacement: "full_back",
      intendedPrintWidthIn: 13,
      garmentSizeClass: "adult_plus",
      productionSizeConfirmedAt: CONFIRMED_AT,
      productionSizeConfirmedWidthIn: 13,
      productionSizeConfirmedMaxHeightIn: null,
      artworkWidthPx: LIVE_FIXTURE.widthPx,
      artworkHeightPx: LIVE_FIXTURE.heightPx,
    })!;

    assert.equal(confirmed.widthIn, 13);
    assert.equal(confirmed.confirmed, true);
    // The recommendation is still stated, and is still 10.5 (Phase 28I:
    // adult_plus no longer recommends 12in of width) — recommendation
    // and confirmed size are allowed to disagree. That is the whole point.
    assert.equal(confirmed.recommendation!.boxWidthIn, 10.5);
    assert.equal(confirmed.recommendation!.isConfirmed, false);
  });

  it("G: a womens_small operator who explicitly wants 8.5in gets 8.5in, below the 9in recommendation", () => {
    const confirmed = describePrintReadySize({
      printPlacement: "full_front",
      intendedPrintWidthIn: 8.5,
      garmentSizeClass: "womens_small",
      productionSizeConfirmedAt: CONFIRMED_AT,
      productionSizeConfirmedWidthIn: 8.5,
      productionSizeConfirmedMaxHeightIn: null,
      artworkWidthPx: LIVE_FIXTURE.widthPx,
      artworkHeightPx: LIVE_FIXTURE.heightPx,
    })!;

    assert.equal(confirmed.widthIn, 8.5);
    assert.equal(confirmed.recommendation!.boxWidthIn, 9);
    assert.equal(confirmed.recommendation!.isConfirmed, false);
  });
});
