/**
 * Structural Layout Reflow Phase 2C (Frame-Interior-Aware Segmentation).
 * Kept separate from `sign-layout-segmentation.test.ts` (Phase 1, kept
 * completely untouched by this phase — every unwindowed call there still
 * behaves byte-for-byte identically) — every test here exercises the new,
 * OPT-IN `analysisWindow` parameter and `resolveFrameAnalysisWindow`.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { measureFrameStructuralModel } from "./frame-structure-model";
import {
  ambiguousAdjacentFillArtwork,
  framedBannerSignArtwork,
  framedSignArtwork,
  makeImage,
} from "./sign-fixtures";
import {
  resolveFrameAnalysisWindow,
  segmentStructuralLayout,
  type SignStructuralAnalysisWindow,
} from "./sign-layout-segmentation";

describe("resolveFrameAnalysisWindow", () => {
  it("A/measured frame: returns the frame's own interior, unchanged", () => {
    const image = framedBannerSignArtwork({ rounded: false, withHoles: false });
    const frame = measureFrameStructuralModel(image);
    assert.equal(frame.status, "measured");
    if (frame.status !== "measured") return;
    const window = resolveFrameAnalysisWindow(frame, image.width, image.height);
    assert.deepEqual(window, frame.model.interior);
  });

  it("E: frame status not_present -> null, never guesses a window", () => {
    // A plain rectangle with no frame structure at all.
    const image = makeImage(400, 600, { r: 10, g: 10, b: 10 });
    const frame = measureFrameStructuralModel(image);
    assert.equal(frame.status, "not_present");
    if (frame.status !== "not_present") return;
    const window = resolveFrameAnalysisWindow(frame, image.width, image.height);
    assert.equal(window, null);
  });

  it("E: frame status ambiguous -> null, never guesses a window", () => {
    // framedSignArtwork with an inconsistent corner radius is a known
    // ambiguous-frame shape from the Parametric Frame Reconstruction Phase.
    const image = framedSignArtwork({ width: 4000, height: 5333, rounded: true, withHoles: false, breakCorner: "radius" });
    const frame = measureFrameStructuralModel(image);
    assert.equal(frame.status, "ambiguous");
    if (frame.status !== "ambiguous") return;
    const window = resolveFrameAnalysisWindow(frame, image.width, image.height);
    assert.equal(window, null);
  });

  it("E: a source-dimension mismatch (stale/wrong image) -> null, never a window measured against a different image", () => {
    const image = framedBannerSignArtwork({ rounded: false, withHoles: false });
    const frame = measureFrameStructuralModel(image);
    assert.equal(frame.status, "measured");
    if (frame.status !== "measured") return;
    // Same model, but claiming a DIFFERENT source size than it was actually measured against.
    const window = resolveFrameAnalysisWindow(frame, image.width + 1, image.height);
    assert.equal(window, null);
  });
});

describe("segmentStructuralLayout — analysis window validation (fail-closed)", () => {
  const image = framedBannerSignArtwork({ rounded: false, withHoles: false });

  it("E: an out-of-bounds window (extends past the image) falls back to full-image analysis rather than erroring or refusing", () => {
    const badWindow: SignStructuralAnalysisWindow = { x: 0, y: 0, width: image.width + 100, height: image.height };
    const windowed = segmentStructuralLayout(image, badWindow);
    const unwindowed = segmentStructuralLayout(image);
    assert.deepEqual(windowed, unwindowed);
  });

  it("E: a negative-origin window falls back to full-image analysis", () => {
    const badWindow: SignStructuralAnalysisWindow = { x: -5, y: 0, width: 100, height: 100 };
    const windowed = segmentStructuralLayout(image, badWindow);
    const unwindowed = segmentStructuralLayout(image);
    assert.deepEqual(windowed, unwindowed);
  });

  it("E: a non-finite/non-integer window falls back to full-image analysis", () => {
    const nonFinite: SignStructuralAnalysisWindow = { x: 0, y: 0, width: Number.NaN, height: 100 };
    assert.deepEqual(segmentStructuralLayout(image, nonFinite), segmentStructuralLayout(image));
    const nonInteger: SignStructuralAnalysisWindow = { x: 0.5, y: 0, width: 100, height: 100 };
    assert.deepEqual(segmentStructuralLayout(image, nonInteger), segmentStructuralLayout(image));
  });

  it("E: a too-small window (below the minimum analyzable size) falls back to full-image analysis", () => {
    const tiny: SignStructuralAnalysisWindow = { x: 40, y: 40, width: 3, height: 3 };
    assert.deepEqual(segmentStructuralLayout(image, tiny), segmentStructuralLayout(image));
  });

  it("a genuinely valid, smaller-than-interior window is honoured (not silently expanded or ignored)", () => {
    const frame = measureFrameStructuralModel(image);
    assert.equal(frame.status, "measured");
    if (frame.status !== "measured") return;
    const full = resolveFrameAnalysisWindow(frame, image.width, image.height)!;
    // A window half the interior's own height, starting at the same origin.
    const half: SignStructuralAnalysisWindow = { x: full.x, y: full.y, width: full.width, height: Math.floor(full.height / 2) };
    const result = segmentStructuralLayout(image, half);
    // Must not equal the full-window result (a genuinely different domain was analyzed).
    const fullResult = segmentStructuralLayout(image, full);
    assert.notDeepEqual(result, fullResult);
  });
});

describe("segmentStructuralLayout — frame-interior-windowed structural results", () => {
  function windowedResultFor(image: ReturnType<typeof framedBannerSignArtwork>) {
    const frame = measureFrameStructuralModel(image);
    assert.equal(frame.status, "measured");
    if (frame.status !== "measured") throw new Error("expected a measured frame for this fixture");
    const window = resolveFrameAnalysisWindow(frame, image.width, image.height);
    assert.ok(window, "expected a valid analysis window");
    return { window: window!, result: segmentStructuralLayout(image, window ?? undefined) };
  }

  it("A: a framed multi-region banner is measured with top/middle/middle/bottom regions and 3 gaps, once windowed", () => {
    const { result } = windowedResultFor(framedBannerSignArtwork({ rounded: false, withHoles: false }));
    assert.equal(result.status, "measured");
    if (result.status !== "measured") return;
    assert.equal(result.regions.length, 4);
    assert.deepEqual(
      result.regions.map((r) => r.role),
      ["top_anchor", "middle", "middle", "bottom_anchor"],
    );
    assert.equal(result.gaps.length, 3);
  });

  it("B: the SAME layout without a frame (acceptanceBannerSignArtwork-style, unwindowed) is semantically equivalent apart from the coordinate offset the frame's own band depth introduces", async () => {
    const { acceptanceBannerSignArtwork } = await import("./sign-fixtures");
    const unframed = segmentStructuralLayout(acceptanceBannerSignArtwork());
    const { result: framed } = windowedResultFor(framedBannerSignArtwork({ rounded: false, withHoles: false }));
    assert.equal(unframed.status, "measured");
    assert.equal(framed.status, "measured");
    if (unframed.status !== "measured" || framed.status !== "measured") return;
    assert.deepEqual(
      unframed.regions.map((r) => r.role),
      framed.regions.map((r) => r.role),
    );
    assert.equal(unframed.gaps.length, framed.gaps.length);
  });

  it("C: a rounded decorative frame produces the SAME structural interpretation as the square one", () => {
    const { result: square } = windowedResultFor(framedBannerSignArtwork({ rounded: false, withHoles: false }));
    const { result: rounded } = windowedResultFor(framedBannerSignArtwork({ rounded: true, withHoles: false }));
    assert.deepEqual(square, rounded);
  });

  it("D: framed ambiguous interior fills fail closed", () => {
    const image = framedBannerSignArtwork({ ambiguousInterior: true });
    const frame = measureFrameStructuralModel(image);
    assert.equal(frame.status, "measured");
    if (frame.status !== "measured") return;
    const window = resolveFrameAnalysisWindow(frame, image.width, image.height);
    const result = segmentStructuralLayout(image, window ?? undefined);
    assert.equal(result.status, "ambiguous");
  });

  it("F: a one-region (flat-interior) framed artwork is 'not_present', once windowed — never a manufactured top/bottom pair", () => {
    const image = framedSignArtwork({ rounded: false, withHoles: false });
    const frame = measureFrameStructuralModel(image);
    assert.equal(frame.status, "measured");
    if (frame.status !== "measured") return;
    const window = resolveFrameAnalysisWindow(frame, image.width, image.height);
    const result = segmentStructuralLayout(image, window ?? undefined);
    assert.equal(result.status, "not_present");
  });

  it("G: hole indicators do not affect interior segmentation — identical result with or without them", () => {
    const { result: withoutHoles } = windowedResultFor(framedBannerSignArtwork({ rounded: false, withHoles: false }));
    const { result: withHoles } = windowedResultFor(framedBannerSignArtwork({ rounded: false, withHoles: true }));
    assert.deepEqual(withoutHoles, withHoles);
  });

  it("all emitted coordinates are SOURCE-image-absolute, not window-relative — every region/gap bound lies within the source image and starts after the window's own origin", () => {
    const { window, result } = windowedResultFor(framedBannerSignArtwork({ rounded: false, withHoles: false }));
    assert.equal(result.status, "measured");
    if (result.status !== "measured") return;
    for (const region of result.regions) {
      assert.ok(region.sourceBounds.startYPx >= window.y);
      assert.ok(region.sourceBounds.startYPx + region.sourceBounds.heightPx <= window.y + window.height);
    }
    // The FIRST region's own source-absolute start must equal the window's
    // own top (31 for this fixture) — NEVER 0 (which would mean the window
    // was silently ignored) and never window-relative (which would read 0
    // here too, by coincidence — the stronger, unambiguous proof is the
    // `analysisWindow` field itself, checked next).
    assert.equal(result.regions[0]!.sourceBounds.startYPx, window.y);
    assert.deepEqual(result.analysisWindow, window);
  });

  it("determinism: repeated identical analysis of identical bytes and an identical window produces a byte-identical (deepEqual) result", () => {
    const image = framedBannerSignArtwork({ rounded: false, withHoles: false });
    const frame = measureFrameStructuralModel(image);
    assert.equal(frame.status, "measured");
    if (frame.status !== "measured") return;
    const window = resolveFrameAnalysisWindow(frame, image.width, image.height);
    const a = segmentStructuralLayout(image, window ?? undefined);
    const b = segmentStructuralLayout(image, window ?? undefined);
    assert.deepEqual(a, b);
  });

  it("no window supplied at all -> unaffected, existing Phase 1 behaviour (analysisWindow: null, identical to before this phase)", () => {
    const image = ambiguousAdjacentFillArtwork();
    const result = segmentStructuralLayout(image);
    assert.equal(result.status, "ambiguous"); // Phase 1's own established result for this fixture, unchanged.
  });
});
