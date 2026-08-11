import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  clampZoomFactor,
  fitDisplaySize,
  GUIDED_CLEANUP_ZOOM_MAX,
  GUIDED_CLEANUP_ZOOM_MIN,
  GUIDED_CLEANUP_ZOOM_STEP,
  isPanGesture,
  nextZoomIn,
  nextZoomOut,
  zoomedDisplaySize,
  zoomPercentLabel,
} from "./guided-cleanup-zoom";
import { mapClickToImagePoint, mapImageBoundsToCssPercent } from "./artwork-click-mapping";

describe("guided-cleanup-zoom", () => {
  it("A/D: Fit is zoom factor 1 and clamps below Fit up to Fit", () => {
    assert.equal(GUIDED_CLEANUP_ZOOM_MIN, 1);
    assert.equal(clampZoomFactor(0.5), 1);
    assert.equal(nextZoomOut(1), 1);
  });

  it("B/C: Zoom In increases and Zoom Out decreases by the step", () => {
    assert.equal(nextZoomIn(1), 1 + GUIDED_CLEANUP_ZOOM_STEP);
    assert.equal(nextZoomOut(1.5), 1.25);
  });

  it("E/F: min and max zoom are enforced", () => {
    assert.equal(nextZoomOut(GUIDED_CLEANUP_ZOOM_MIN), GUIDED_CLEANUP_ZOOM_MIN);
    assert.equal(nextZoomIn(GUIDED_CLEANUP_ZOOM_MAX), GUIDED_CLEANUP_ZOOM_MAX);
    assert.equal(clampZoomFactor(99), GUIDED_CLEANUP_ZOOM_MAX);
  });

  it("computes Fit display size without cropping", () => {
    const fit = fitDisplaySize(1000, 500, 400, 400);
    assert.ok(fit);
    assert.equal(fit.width, 400);
    assert.equal(fit.height, 200);
    assert.equal(fit.fitScale, 0.4);
  });

  it("B: zoomed display size scales Fit by the factor", () => {
    const fit = fitDisplaySize(1000, 500, 400, 400)!;
    const at125 = zoomedDisplaySize(fit, 1.25);
    assert.equal(at125.width, 500);
    assert.equal(at125.height, 250);
    const at200 = zoomedDisplaySize(fit, 2);
    assert.equal(at200.width, 800);
    assert.equal(at200.height, 400);
  });

  it("labels zoom as a percent", () => {
    assert.equal(zoomPercentLabel(1), "100%");
    assert.equal(zoomPercentLabel(1.25), "125%");
    assert.equal(zoomPercentLabel(2), "200%");
  });

  it("V: pan gesture threshold separates drag from click", () => {
    assert.equal(isPanGesture(0, 0), false);
    assert.equal(isPanGesture(3, 3), false);
    assert.equal(isPanGesture(10, 0), true);
    assert.equal(isPanGesture(0, 10), true);
  });
});

describe("Artwork click mapping — zoomed content boxes", () => {
  /**
   * When the workspace sizes the <img> to an exact aspect-matched content
   * box (Fit × zoom), letterboxing inside that box is zero. Pan only changes
   * scroll offsets; getBoundingClientRect already accounts for them when the
   * caller passes offsets relative to the image element.
   */

  it("G: mapping accurate at Fit (1× content box)", () => {
    const fit = { width: 400, height: 200, naturalWidth: 1000, naturalHeight: 500 };
    assert.deepEqual(mapClickToImagePoint(fit, 200, 100), { x: 500, y: 250 });
    assert.deepEqual(mapClickToImagePoint(fit, 0, 0), { x: 0, y: 0 });
  });

  it("H: mapping accurate at 125%", () => {
    const box = { width: 500, height: 250, naturalWidth: 1000, naturalHeight: 500 };
    assert.deepEqual(mapClickToImagePoint(box, 250, 125), { x: 500, y: 250 });
    assert.deepEqual(mapClickToImagePoint(box, 125, 62), { x: 250, y: 124 });
  });

  it("I: mapping accurate at 150% and 200%", () => {
    const at150 = { width: 600, height: 300, naturalWidth: 1000, naturalHeight: 500 };
    const at200 = { width: 800, height: 400, naturalWidth: 1000, naturalHeight: 500 };
    assert.deepEqual(mapClickToImagePoint(at150, 300, 150), { x: 500, y: 250 });
    assert.deepEqual(mapClickToImagePoint(at200, 400, 200), { x: 500, y: 250 });
    assert.deepEqual(mapClickToImagePoint(at200, 160, 80), { x: 200, y: 100 });
  });

  it("J/K/L: mapping uses image-local offsets (pan is scroll, not a second transform)", () => {
    // After horizontal/vertical/combined pan, the caller still measures
    // clientX/Y against the image's getBoundingClientRect. Offsets of 40,30
    // on a 200% box map the same regardless of scrollLeft/scrollTop.
    const zoomed = { width: 800, height: 400, naturalWidth: 1000, naturalHeight: 500 };
    assert.deepEqual(mapClickToImagePoint(zoomed, 40, 200), { x: 50, y: 250 });
    assert.deepEqual(mapClickToImagePoint(zoomed, 400, 40), { x: 500, y: 50 });
    assert.deepEqual(mapClickToImagePoint(zoomed, 80, 60), { x: 100, y: 75 });
  });

  it("M: outside-image / letterbox click still returns null", () => {
    // Legacy object-contain letterbox still nulls; zoomed exact boxes have no
    // inset, so outside means outside the element.
    const letterboxed = {
      width: 200,
      height: 200,
      naturalWidth: 1000,
      naturalHeight: 500,
    };
    assert.equal(mapClickToImagePoint(letterboxed, 100, 10), null);
    const exact = { width: 400, height: 200, naturalWidth: 1000, naturalHeight: 500 };
    assert.equal(mapClickToImagePoint(exact, -1, 100), null);
    assert.equal(mapClickToImagePoint(exact, 400, 100), null);
  });

  it("N/O: highlight percents stay relative to the natural image (zoom-invariant)", () => {
    // Overlay is positioned with % of the same content box that scales with
    // the artwork, so Fit vs 200% share identical percentage styles.
    const style = mapImageBoundsToCssPercent(
      { left: 100, top: 50, width: 200, height: 100 },
      1000,
      500,
    );
    assert.deepEqual(style, {
      left: "10%",
      top: "10%",
      width: "20%",
      height: "20%",
    });
  });

  it("W: mobile/touch modal sizes still map correctly when zoomed", () => {
    const mobileFit = {
      width: 320,
      height: 334.6,
      naturalWidth: 979,
      naturalHeight: 1024,
    };
    const centre = mapClickToImagePoint(mobileFit, 160, 167);
    assert.ok(centre);
    assert.ok(centre.x > 400 && centre.x < 580);
    const mobile200 = {
      width: mobileFit.width * 2,
      height: mobileFit.height * 2,
      naturalWidth: 979,
      naturalHeight: 1024,
    };
    const centreZoomed = mapClickToImagePoint(
      mobile200,
      mobile200.width / 2,
      mobile200.height / 2,
    );
    assert.ok(centreZoomed);
    // Flooring at different display scales can differ by 1px at the midpoint.
    assert.ok(Math.abs(centreZoomed.x - centre!.x) <= 1);
    assert.ok(Math.abs(centreZoomed.y - centre!.y) <= 1);
  });
});
