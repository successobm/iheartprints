import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { mapClickToImagePoint, mapImageBoundsToCssPercent } from "./artwork-click-mapping";

/**
 * Phase 1.2: click → source pixel.
 * Phase 1.3: source bounds → CSS percent overlay placement.
 *
 * A wrong answer here removes a region the customer did not point at, which is
 * the one outcome guided cleanup exists to avoid. There is no DOM in this test
 * runner, so the arithmetic lives in a pure function precisely so it can be
 * pinned rather than clicked at.
 */
describe("Artwork click mapping — object-contain letterboxing", () => {
  /** A 1000x500 image drawn into a 200x200 box: scale 0.2, 50px bars top and bottom. */
  const wide = { width: 200, height: 200, naturalWidth: 1000, naturalHeight: 500 };

  it("maps the centre of the drawn area to the centre of the image", () => {
    assert.deepEqual(mapClickToImagePoint(wide, 100, 100), { x: 500, y: 250 });
  });

  it("removes the letterbox offset before scaling", () => {
    // The drawn image starts 50px down; a click there is the image's top row,
    // not row 250. Getting this wrong is the classic off-by-a-letterbox bug.
    assert.deepEqual(mapClickToImagePoint(wide, 0, 50), { x: 0, y: 0 });
    assert.deepEqual(mapClickToImagePoint(wide, 0, 150 - 1), { x: 0, y: 495 });
  });

  it("returns null for a click on the letterbox rather than guessing", () => {
    // These pixels are panel background, not artwork. Clamping them to (0,0)
    // would let a click in the margin remove whatever sits in the corner.
    assert.equal(mapClickToImagePoint(wide, 100, 10), null);
    assert.equal(mapClickToImagePoint(wide, 100, 190), null);
    assert.equal(mapClickToImagePoint(wide, 100, 49), null);
    assert.equal(mapClickToImagePoint(wide, 100, 150), null);
  });

  it("returns null outside the element box entirely", () => {
    assert.equal(mapClickToImagePoint(wide, -1, 100), null);
    assert.equal(mapClickToImagePoint(wide, 200, 100), null);
  });

  it("never returns a coordinate outside the image", () => {
    const tall = { width: 200, height: 200, naturalWidth: 500, naturalHeight: 1000 };
    // The very last drawn pixel on each axis must stay in range: rounding it
    // up would produce a point one past the edge, which the server would then
    // reject as off-canvas and the customer would read as "nothing happened".
    const point = mapClickToImagePoint(tall, 149.99, 199.99);
    assert.ok(point);
    assert.ok(point.x <= 499 && point.x >= 0);
    assert.ok(point.y <= 999 && point.y >= 0);
  });

  it("handles a 1:1 render with no letterboxing", () => {
    const square = { width: 300, height: 300, naturalWidth: 300, naturalHeight: 300 };
    assert.deepEqual(mapClickToImagePoint(square, 42, 17), { x: 42, y: 17 });
  });

  it("returns null before the image has measurable dimensions", () => {
    // An <img> that has not loaded reports 0 for its natural size. Dividing by
    // it would yield Infinity and then NaN.
    assert.equal(
      mapClickToImagePoint(
        { width: 200, height: 200, naturalWidth: 0, naturalHeight: 0 },
        10,
        10,
      ),
      null,
    );
    assert.equal(
      mapClickToImagePoint(
        { width: 0, height: 0, naturalWidth: 100, naturalHeight: 100 },
        0,
        0,
      ),
      null,
    );
  });

  it("maps source bounds to CSS percentages for the highlight overlay", () => {
    assert.deepEqual(
      mapImageBoundsToCssPercent(
        { left: 100, top: 50, width: 200, height: 100 },
        1000,
        500,
      ),
      { left: "10%", top: "10%", width: "20%", height: "20%" },
    );
    assert.equal(
      mapImageBoundsToCssPercent({ left: 0, top: 0, width: 0, height: 10 }, 100, 100),
      null,
    );
  });

  it("maps touch/modal-scale layout boxes the same way as desktop clicks", () => {
    // A phone-width modal still letterboxes a wide prepared image; clientX/Y
    // from a finger tap are already relative to the image element's CSS box
    // (getBoundingClientRect), so the pure mapper must not assume a desktop
    // pixel density or a second coordinate system.
    const mobileModal = {
      width: 320,
      height: 480,
      naturalWidth: 979,
      naturalHeight: 1024,
    };
    const centre = mapClickToImagePoint(mobileModal, 160, 240);
    assert.ok(centre);
    assert.ok(centre.x > 400 && centre.x < 580);
    assert.ok(centre.y > 400 && centre.y < 620);
    assert.equal(mapClickToImagePoint(mobileModal, 8, 8), null);
    assert.equal(mapClickToImagePoint(mobileModal, 310, 470), null);
  });
});

/**
 * Phase 1.6B: the SAME mapper, under zoom and pan.
 *
 * The workspace grows the rendered content box inside a scrollable viewport
 * rather than applying `transform: scale`, and reads the <img>'s own
 * `getBoundingClientRect` at click time. That is why there is exactly one
 * coordinate mapper and why panning needs no term of its own: scrolling moves
 * the element's rect, so `clientX - rect.left` has already absorbed it.
 *
 * These cases pin that. Each one recreates the rect the browser would report
 * and asserts that the customer's finger still lands on the same source pixel.
 */
describe("Artwork click mapping — zoom and pan in the cleanup workspace", () => {
  const NATURAL = { naturalWidth: 979, naturalHeight: 1024 };
  /** The bowling asset fitted into the real workspace viewport: ~0.53x. */
  const FIT_SCALE = 0.53;

  /**
   * The <img> rect at a zoom factor, after the viewport has been scrolled.
   * The element box IS the drawn image here — the workspace sizes it exactly —
   * so there is no letterbox, and scrolling simply shifts `left`/`top`.
   */
  interface RenderedRect {
    left: number;
    top: number;
    width: number;
    height: number;
    naturalWidth: number;
    naturalHeight: number;
  }

  function renderedRect(zoomFactor: number, panX = 0, panY = 0): RenderedRect {
    const width = NATURAL.naturalWidth * FIT_SCALE * zoomFactor;
    const height = NATURAL.naturalHeight * FIT_SCALE * zoomFactor;
    return { left: 100 - panX, top: 80 - panY, width, height, ...NATURAL };
  }

  /** What the component does: client coords minus the live rect origin. */
  function clickAt(rect: RenderedRect, clientX: number, clientY: number) {
    return mapClickToImagePoint(rect, clientX - rect.left, clientY - rect.top);
  }

  /** Where the customer must put the pointer to hit a given source pixel. */
  function clientForSourcePixel(rect: RenderedRect, x: number, y: number) {
    const scale = rect.width / rect.naturalWidth;
    return {
      clientX: rect.left + (x + 0.5) * scale,
      clientY: rect.top + (y + 0.5) * scale,
    };
  }

  const TARGET = { x: 545, y: 680 }; // a real guided-removal point

  for (const zoomFactor of [1, 1.25, 1.5, 2, 4]) {
    it(`resolves the same source pixel at ${Math.round(zoomFactor * 100)}%`, () => {
      const rect = renderedRect(zoomFactor);
      const { clientX, clientY } = clientForSourcePixel(rect, TARGET.x, TARGET.y);
      assert.deepEqual(clickAt(rect, clientX, clientY), TARGET);
    });
  }

  for (const [label, panX, panY] of [
    ["horizontal", 240, 0],
    ["vertical", 0, 310],
    ["diagonal", 240, 310],
  ] as Array<[string, number, number]>) {
    it(`resolves the same source pixel after a ${label} pan`, () => {
      const rect = renderedRect(2, panX, panY);
      const { clientX, clientY } = clientForSourcePixel(rect, TARGET.x, TARGET.y);
      assert.deepEqual(clickAt(rect, clientX, clientY), TARGET);
    });
  }

  it("is unaffected by a revision remount, which changes neither box nor natural size", () => {
    // Confirm/undo swaps the <img> via its key but keeps the zoom factor, so
    // the rect the next click reads is identical.
    const before = renderedRect(2, 120, 90);
    const after = renderedRect(2, 120, 90);
    const { clientX, clientY } = clientForSourcePixel(before, TARGET.x, TARGET.y);

    assert.deepEqual(clickAt(before, clientX, clientY), clickAt(after, clientX, clientY));
    assert.deepEqual(clickAt(after, clientX, clientY), TARGET);
  });

  it("is unaffected by the QA background, which is CSS underneath the artwork", () => {
    // Preview Background paints the viewport, never the image box. Same rect,
    // same answer — there is no code path by which it could differ.
    const rect = renderedRect(1.5, 60, 60);
    const { clientX, clientY } = clientForSourcePixel(rect, TARGET.x, TARGET.y);
    assert.deepEqual(clickAt(rect, clientX, clientY), TARGET);
  });

  it("keeps the highlight on the region that was selected, at every zoom", () => {
    // The overlay is positioned in PERCENTAGES of the natural image, so it is
    // scale-free by construction: one expression, valid at Fit and at 400%.
    const bounds = { left: 490, top: 640, width: 80, height: 60 };
    const percent = mapImageBoundsToCssPercent(
      bounds,
      NATURAL.naturalWidth,
      NATURAL.naturalHeight,
    );
    assert.ok(percent);

    for (const zoomFactor of [1, 2, 4]) {
      const rect = renderedRect(zoomFactor, 50, 50);
      const sourcePixel = rect.width / rect.naturalWidth;
      // The highlight's top-left in client space, per those percentages...
      const highlightLeft: number =
        rect.left + (Number.parseFloat(percent.left) / 100) * rect.width;
      const highlightTop: number =
        rect.top + (Number.parseFloat(percent.top) / 100) * rect.height;
      // ...sampled half a source pixel inside, because the edge itself is the
      // boundary BETWEEN two pixels and which one it rounds to is a float
      // detail, not an alignment fact.
      assert.deepEqual(
        clickAt(rect, highlightLeft + sourcePixel / 2, highlightTop + sourcePixel / 2),
        { x: bounds.left, y: bounds.top },
        `highlight top-left drifts at ${zoomFactor}x`,
      );

      // And the opposite corner, which is what would drift if the overlay were
      // being positioned in anything but natural-image percentages.
      assert.deepEqual(
        clickAt(
          rect,
          highlightLeft + (bounds.width - 0.5) * sourcePixel,
          highlightTop + (bounds.height - 0.5) * sourcePixel,
        ),
        { x: bounds.left + bounds.width - 1, y: bounds.top + bounds.height - 1 },
        `highlight bottom-right drifts at ${zoomFactor}x`,
      );
    }
  });
});
