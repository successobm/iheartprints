import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  advanceGesture,
  beginGesture,
  isPanModifierKey,
  isPanModifierTarget,
  resolveArtworkCursorClassName,
  resolveGestureMode,
  shouldSelectOnRelease,
  type GestureSession,
} from "./guided-cleanup-interaction";
import {
  GUIDED_CLEANUP_PAN_THRESHOLD_PX,
  GUIDED_CLEANUP_ZOOM_MIN,
} from "./guided-cleanup-zoom";

/**
 * Phase 1.6B: SELECTION-PRIMARY interaction.
 *
 * These drive whole gestures — down, move, up — rather than asserting on class
 * strings, because the defect being fixed was precisely that the class string
 * and the behaviour disagreed. Every case below states what the CUSTOMER did
 * and asserts what the workspace does about it.
 */

const VIEWPORT = { scrollLeft: 40, scrollTop: 25 };
const ZOOMED = 2;

/** Plays a complete gesture and reports what it panned to and whether it selected. */
function performGesture({
  pointerType = "mouse",
  button = 0,
  spaceHeld = false,
  busy = false,
  zoomFactor = ZOOMED,
  path = [] as Array<[number, number]>,
}) {
  const session = beginGesture(
    { pointerType, button, spaceHeld, busy },
    { pointerId: 7, clientX: 100, clientY: 100 },
    VIEWPORT,
  );
  if (!session) return { started: false, scrolls: [], selected: false, moved: false };

  const scrolls: Array<{ scrollLeft: number; scrollTop: number }> = [];
  for (const [x, y] of path) {
    const scroll = advanceGesture(session, { clientX: x, clientY: y }, zoomFactor);
    if (scroll) scrolls.push(scroll);
  }

  return {
    started: true,
    scrolls,
    moved: session.moved,
    selected: shouldSelectOnRelease(session, busy),
  };
}

describe("1 + 2: the cursor is a crosshair at every zoom level", () => {
  it("says SELECT at Fit and at maximum zoom alike", () => {
    // Zoom is not an input to the cursor at all — that it used to be is the bug.
    assert.equal(
      resolveArtworkCursorClassName({ busy: false, spaceHeld: false }),
      "cursor-crosshair",
    );
  });

  it("says PAN only while the modifier is actually held", () => {
    assert.equal(
      resolveArtworkCursorClassName({ busy: false, spaceHeld: true }),
      "cursor-grab active:cursor-grabbing",
    );
  });

  it("says WAIT while the workspace is busy, whatever is held", () => {
    assert.equal(resolveArtworkCursorClassName({ busy: true, spaceHeld: false }), "cursor-wait");
    assert.equal(resolveArtworkCursorClassName({ busy: true, spaceHeld: true }), "cursor-wait");
  });
});

describe("3 + 4: an ordinary click at zoom", () => {
  it("previews a cleanup candidate and pans nothing", () => {
    const result = performGesture({ path: [] });

    assert.equal(result.selected, true);
    assert.deepEqual(result.scrolls, [], "a stationary click must not scroll the viewport");
  });

  it("still selects when the hand drifts, and still pans nothing", () => {
    // A left drag is not a pan. The release point is where the customer pointed.
    const result = performGesture({ path: [[160, 140]] });

    assert.equal(result.selected, true);
    assert.deepEqual(result.scrolls, []);
    assert.equal(result.moved, false, "a select gesture never records pan travel");
  });

  it("is refused entirely while the workspace is busy", () => {
    const result = performGesture({ busy: true });
    assert.equal(result.started, false);
    assert.equal(result.selected, false);
  });

  it("ignores the buttons that belong to the browser", () => {
    assert.equal(resolveGestureMode({ pointerType: "mouse", button: 2, spaceHeld: false, busy: false }), "ignore");
    assert.equal(resolveGestureMode({ pointerType: "mouse", button: 3, spaceHeld: false, busy: false }), "ignore");
  });
});

describe("5 + 6: Space + drag", () => {
  it("pans the viewport by exactly the pointer's travel", () => {
    const result = performGesture({ spaceHeld: true, path: [[70, 60]] });

    assert.deepEqual(result.scrolls, [
      { scrollLeft: VIEWPORT.scrollLeft - (70 - 100), scrollTop: VIEWPORT.scrollTop - (60 - 100) },
    ]);
  });

  it("never previews a cleanup candidate, however still the pointer was", () => {
    const dragged = performGesture({ spaceHeld: true, path: [[70, 60]] });
    assert.equal(dragged.selected, false);

    // The dangerous case: Space held, pointer perfectly stationary. Phase 1.4
    // would have treated this as a click.
    const stationary = performGesture({ spaceHeld: true, path: [] });
    assert.equal(stationary.started, true);
    assert.equal(stationary.selected, false);
  });

  it("suppresses selection even at Fit, where there is nothing to scroll", () => {
    const result = performGesture({
      spaceHeld: true,
      zoomFactor: GUIDED_CLEANUP_ZOOM_MIN,
      path: [[40, 40]],
    });

    assert.deepEqual(result.scrolls, [], "Fit already shows the whole artwork");
    assert.equal(result.moved, true, "but the gesture still counts as a pan");
    assert.equal(result.selected, false);
  });

  it("also accepts a middle-button drag, the conventional pan", () => {
    const result = performGesture({ button: 1, path: [[70, 60]] });
    assert.equal(result.scrolls.length, 1);
    assert.equal(result.selected, false);
  });
});

describe("7: releasing Space restores selection", () => {
  it("resolves each gesture by the modifier state at the moment it began", () => {
    const held = performGesture({ spaceHeld: true, path: [[70, 60]] });
    assert.equal(held.selected, false);

    const released = performGesture({ spaceHeld: false, path: [] });
    assert.equal(released.selected, true, "the very next click selects again");
  });

  it("treats Space as the modifier under both key spellings", () => {
    assert.equal(isPanModifierKey(" "), true);
    assert.equal(isPanModifierKey("Spacebar"), true);
    assert.equal(isPanModifierKey("Enter"), false);
    assert.equal(isPanModifierKey("Escape"), false);
  });

  it("leaves Space alone when a real control has focus", () => {
    // The zoom buttons and the Preview Background radios need Space to work.
    assert.equal(isPanModifierTarget({ tagName: "BUTTON" }), false);
    assert.equal(isPanModifierTarget({ tagName: "INPUT" }), false);
    assert.equal(isPanModifierTarget({ tagName: "A" }), false);
    assert.equal(isPanModifierTarget({ tagName: "DIV", isContentEditable: true }), false);
    assert.equal(isPanModifierTarget({ tagName: "DIV" }), true);
  });
});

describe("8 + 9: touch, which has neither a cursor nor a Space key", () => {
  it("selects on a tap", () => {
    const result = performGesture({ pointerType: "touch", path: [] });
    assert.equal(result.selected, true);
    assert.deepEqual(result.scrolls, []);
  });

  it("pans on a drag and never selects", () => {
    const result = performGesture({ pointerType: "touch", path: [[60, 55]] });
    assert.equal(result.scrolls.length, 1);
    assert.equal(result.selected, false);
  });

  it("tolerates the jitter of a finger that meant to tap", () => {
    const jitter = GUIDED_CLEANUP_PAN_THRESHOLD_PX - 2;
    const result = performGesture({ pointerType: "touch", path: [[100 + jitter, 100]] });

    assert.equal(result.moved, false);
    assert.equal(result.selected, true, "under the threshold this is still a tap");
  });

  it("behaves the same for a stylus", () => {
    assert.equal(
      resolveGestureMode({ pointerType: "pen", button: 0, spaceHeld: false, busy: false }),
      "pan-or-tap",
    );
  });
});

describe("gesture bookkeeping", () => {
  it("only ever pans the pointer that started the gesture", () => {
    const session = beginGesture(
      { pointerType: "touch", button: 0, spaceHeld: false, busy: false },
      { pointerId: 42, clientX: 10, clientY: 10 },
      VIEWPORT,
    );
    assert.ok(session);
    assert.equal(session.pointerId, 42);
  });

  it("reports no scroll for a movement that has not crossed the threshold", () => {
    const session: GestureSession = {
      mode: "pan-only",
      pointerId: 1,
      startX: 0,
      startY: 0,
      scrollLeft: 0,
      scrollTop: 0,
      moved: false,
    };
    assert.equal(advanceGesture(session, { clientX: 1, clientY: 1 }, ZOOMED), null);
    assert.equal(session.moved, false);
  });

  it("refuses to select on release once the workspace has gone busy", () => {
    const session: GestureSession = {
      mode: "select",
      pointerId: 1,
      startX: 0,
      startY: 0,
      scrollLeft: 0,
      scrollTop: 0,
      moved: false,
    };
    assert.equal(shouldSelectOnRelease(session, true), false);
  });
});
