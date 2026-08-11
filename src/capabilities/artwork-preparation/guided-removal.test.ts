import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { RgbaImage } from "@/capabilities/final-artwork/raster-transform";

import {
  BOWLING_FINGER_HOLES,
  bowlingLetterformArtwork,
  darkOutlinedDisplayArtwork,
  fingerHoleArtwork,
  getPixel,
  intentionalShadowArtwork,
} from "./artwork-fixtures";
import { isolateBackground, resolveGuidedRemovalAt } from "./background-isolation";
import { analyzeArtwork } from "./image-analysis";
import type { GuidedRemovalPoint } from "./guided-removal";

/**
 * Phase 1.2, Part C: user-guided background removal, as pure logic.
 *
 * The real-file audit established that the counters inside large display
 * lettering (wall/inradius 2.11–5.29) and a bowling ball's finger holes
 * (2.89–4.69) are NESTED populations — no threshold separates them, so the
 * automatic pass must preserve both and the customer resolves the ambiguity.
 *
 * What these tests pin is therefore NOT "the system knows a counter from a
 * finger hole" — it provably cannot. It is the narrower, checkable guarantee
 * that makes asking safe: a click can only ever reach a region the automatic
 * pass already classified as enclosed background, the customer is told exactly
 * what would go before it goes, and everything else in the image is inert.
 */
describe("Guided removal — a click is evidence, not authority", () => {
  function modelFor(image: RgbaImage) {
    const analysis = analyzeArtwork({
      image,
      format: "image/png",
      byteSize: 4096,
      declaresAlphaChannel: false,
      printPlacement: null,
      intendedPrintWidthIn: null,
    });
    return {
      backgroundColor: analysis.estimatedBackgroundColor,
      tolerance: analysis.backgroundTolerance,
    };
  }

  function resolve(image: RgbaImage, point: GuidedRemovalPoint) {
    return resolveGuidedRemovalAt(image, point, modelFor(image));
  }

  it("resolves a click inside an ambiguous counter to that whole region", () => {
    const image = darkOutlinedDisplayArtwork();
    const model = modelFor(image);

    // The automatic pass refuses this one on geometry — that is the premise.
    const automatic = isolateBackground(image, model);
    assert.equal(automatic.record.enclosedCavityRegionsRemoved, 0);
    assert.equal(getPixel(automatic.image, 70, 80).a, 255);

    const resolution = resolve(image, { x: 70, y: 80 });
    assert.equal(resolution.outcome, "eligible");
    assert.ok(resolution.region);
    assert.ok(resolution.region.pixelCount > 100);
    // The customer is shown WHAT would go, before it goes.
    assert.ok(resolution.region.bounds.width > 0);
    assert.ok(resolution.region.bounds.height > 0);
  });

  it("removes exactly that region and nothing else when applied", () => {
    const image = darkOutlinedDisplayArtwork();
    const model = modelFor(image);
    const before = isolateBackground(image, model);
    const after = isolateBackground(image, {
      ...model,
      guidedRemovalPoints: [{ x: 70, y: 80 }],
    });

    assert.equal(after.record.guidedRegionsRemoved, 1);
    assert.equal(getPixel(after.image, 70, 80).a, 0, "the counter is gone");

    // Nothing outside the counter's own bounds lost its opacity.
    const region = resolve(image, { x: 70, y: 80 }).region!;
    let unexpected = 0;
    for (let y = 0; y < image.height; y += 1) {
      for (let x = 0; x < image.width; x += 1) {
        const wasVisible = getPixel(before.image, x, y).a > 0;
        const isVisible = getPixel(after.image, x, y).a > 0;
        if (!wasVisible || isVisible) continue;
        const inside =
          x >= region.bounds.left &&
          x < region.bounds.right &&
          y >= region.bounds.top &&
          y < region.bounds.bottom;
        if (!inside) unexpected += 1;
      }
    }
    assert.equal(unexpected, 0, "no pixel outside the clicked region was taken");
  });

  it("is idempotent: the same region clicked twice is the same image", () => {
    const image = darkOutlinedDisplayArtwork();
    const model = modelFor(image);

    const once = isolateBackground(image, {
      ...model,
      guidedRemovalPoints: [{ x: 70, y: 80 }],
    });
    // A different pixel of the SAME region, which is what a real second click
    // looks like — the customer does not hit the same coordinate twice.
    const twice = isolateBackground(image, {
      ...model,
      guidedRemovalPoints: [
        { x: 70, y: 80 },
        { x: 72, y: 84 },
      ],
    });

    assert.equal(twice.record.guidedRegionsRemoved, 1, "the repeat added nothing");
    assert.deepEqual(
      twice.image.data,
      once.image.data,
      "and produced byte-identical artwork",
    );
    assert.equal(twice.guided.rejected.length, 1);
    assert.equal(twice.guided.rejected[0]!.outcome, "already_removed");
  });

  it("refuses a click on intentional dark line work", () => {
    // The customer's dark outline measures (16,8,0) against a (1,1,1)
    // background — Chebyshev 15 against a tolerance of 12, so it is
    // unambiguously FOREGROUND and was never a cavity candidate at all. It is
    // inert: no click, however deliberate, can reach it.
    const image = darkOutlinedDisplayArtwork();
    const resolution = resolve(image, { x: 32, y: 80 });

    assert.equal(resolution.outcome, "not_background");
    assert.equal(resolution.region, null);

    // And it stays put even when the pipeline is handed that exact point.
    const model = modelFor(image);
    const forced = isolateBackground(image, {
      ...model,
      guidedRemovalPoints: [{ x: 32, y: 80 }],
    });
    assert.equal(getPixel(forced.image, 32, 80).a, 255);
    assert.equal(forced.record.guidedRegionsRemoved, 0);
  });

  it("refuses a click on ordinary coloured artwork", () => {
    const image = darkOutlinedDisplayArtwork();
    // The white letter body: opaque, obvious artwork, nowhere near background.
    const resolution = resolve(image, { x: 42, y: 80 });

    assert.equal(resolution.outcome, "not_background");
    assert.equal(resolution.region, null);
  });

  it("reports a click on already-transparent background as already removed", () => {
    const image = darkOutlinedDisplayArtwork();
    // The exterior, which the flood fill took before any of this ran.
    const resolution = resolve(image, { x: 2, y: 2 });

    assert.equal(resolution.outcome, "already_removed");
    assert.equal(resolution.region, null);
  });

  it("refuses a forged or out-of-range coordinate safely", () => {
    const image = darkOutlinedDisplayArtwork();

    for (const point of [
      { x: -1, y: 10 },
      { x: 10, y: -1 },
      { x: image.width, y: 10 },
      { x: 10, y: image.height },
      { x: 10_000_000, y: 10_000_000 },
      { x: Number.NaN, y: 4 },
      { x: 4, y: Number.POSITIVE_INFINITY },
    ]) {
      const resolution = resolve(image, point);
      assert.equal(
        resolution.outcome,
        "outside_image",
        `${point.x},${point.y} must not resolve`,
      );
      assert.equal(resolution.region, null);
    }

    // And a forged point changes nothing when it reaches the pipeline.
    const model = modelFor(image);
    const untouched = isolateBackground(image, model);
    const forged = isolateBackground(image, {
      ...model,
      guidedRemovalPoints: [{ x: -5, y: 99_999 }],
    });
    assert.deepEqual(forged.image.data, untouched.image.data);
    assert.equal(forged.record.guidedRegionsRemoved, 0);
  });

  it("multiple guided removals are order-independent and deterministic", () => {
    const image = bowlingLetterformArtwork();
    const model = modelFor(image);

    // Two of the display counters the automatic pass would also have taken —
    // used here purely because they are two distinct, well-separated regions.
    const a = { x: 170, y: 825 };
    const b = { x: 490, y: 825 };

    const forward = isolateBackground(image, {
      ...model,
      guidedRemovalPoints: [a, b],
    });
    const reverse = isolateBackground(image, {
      ...model,
      guidedRemovalPoints: [b, a],
    });
    const repeat = isolateBackground(image, {
      ...model,
      guidedRemovalPoints: [a, b],
    });

    assert.deepEqual(forward.image.data, reverse.image.data, "order-independent");
    assert.deepEqual(forward.image.data, repeat.image.data, "deterministic");
  });

  it("a finger hole resolves like any other ambiguous region — and the customer decides", () => {
    // THE HONEST NEGATIVE CONTROL. A finger hole IS an enclosed
    // background-coloured region the automatic pass preserved on ambiguous
    // geometry, exactly like a letter counter, so it necessarily resolves as
    // eligible. The audit proved no measurement separates them.
    //
    // What must hold is that the SYSTEM never takes one on its own, and that
    // the customer is shown a bounded region before anything happens. Both are
    // asserted here.
    const image = fingerHoleArtwork();
    const model = modelFor(image);

    const automatic = isolateBackground(image, model);
    for (const [x, y] of [
      [130, 120],
      [190, 120],
      [160, 175],
    ] as const) {
      assert.equal(
        getPixel(automatic.image, x, y).a,
        255,
        "no finger hole is ever removed automatically",
      );
    }

    const resolution = resolveGuidedRemovalAt(image, { x: 130, y: 120 }, model);
    assert.equal(resolution.outcome, "eligible");
    // Bounded and previewable: the customer sees a ~24px hole highlighted, not
    // the whole ball, so a mis-click is obvious and undoable.
    assert.ok(resolution.region!.bounds.width <= 30);
    assert.ok(resolution.region!.bounds.height <= 30);
  });

  it("an enclosed intentional shadow behaves the same way, for the same reason", () => {
    // CHARACTERIZATION, recorded so nobody later reads the finger-hole test as
    // a special case. A drop shadow drawn in the background colour and sealed
    // inside a light plate is, to every measurement available, indistinguishable
    // from a counter: enclosed, background-coloured, preserved on ambiguity.
    //
    // It is therefore clickable — and it is never taken automatically, which is
    // the property that matters.
    const image = intentionalShadowArtwork();
    const model = modelFor(image);

    const automatic = isolateBackground(image, model);
    assert.equal(
      getPixel(automatic.image, 120, 160).a,
      255,
      "the shadow survives automatic preparation",
    );
    assert.equal(automatic.record.enclosedCavityRegionsRemoved, 0);

    assert.equal(
      resolveGuidedRemovalAt(image, { x: 120, y: 160 }, model).outcome,
      "eligible",
    );
  });

  it("leaves the bowling acceptance fixture's finger holes untouched automatically", () => {
    const image = bowlingLetterformArtwork();
    const automatic = isolateBackground(image, modelFor(image));

    for (const hole of BOWLING_FINGER_HOLES) {
      assert.deepEqual(
        getPixel(automatic.image, hole.x, hole.y),
        getPixel(image, hole.x, hole.y),
        `finger hole at ${hole.x},${hole.y} is byte-identical`,
      );
    }
    assert.equal(automatic.record.guidedRegionsRemoved, 0);
  });
});
