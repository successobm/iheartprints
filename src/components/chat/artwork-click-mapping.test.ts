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
