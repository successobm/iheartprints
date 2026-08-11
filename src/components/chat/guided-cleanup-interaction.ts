/**
 * Existing Artwork → Print Ready Phase 1.6B: SELECTION-PRIMARY pointer
 * interaction for the guided-cleanup workspace.
 *
 * The workspace exists so a customer can point at leftover background and say
 * "remove that". Zoom and pan are there to make that pointing accurate — they
 * are not the purpose of the surface. Phase 1.4 nonetheless swapped the cursor
 * to `grab` at any zoom above Fit, which told the customer that dragging was
 * the primary gesture while a stationary click was still, in fact, the only
 * thing that did anything. The affordance and the behaviour disagreed.
 *
 * So the contract here is: SELECTION IS ALWAYS THE DEFAULT, at every zoom
 * level, and panning is something the customer must explicitly ask for.
 *
 *   Desktop  crosshair everywhere; left click previews a removal.
 *            Hold SPACE (or press the middle button) to pan — while that is
 *            held the cursor is `grab`/`grabbing` and NO cleanup can fire,
 *            however still the pointer is.
 *   Touch    there is no cursor and no Space key, so the gesture itself has to
 *            carry the meaning: a tap selects, a drag pans, and a drag can
 *            never select. No pinch zoom — the toolbar owns zoom.
 *
 * Pure functions, for the reason `artwork-click-mapping.ts` states: this
 * repo's test tooling is `node:test` + `renderToString`, with no DOM and no
 * layout engine. A gesture rule living inside an event handler could only ever
 * be verified by clicking around, so the rules live here and the component
 * stays a thin adapter over them.
 */

import { GUIDED_CLEANUP_ZOOM_MIN, isPanGesture } from "./guided-cleanup-zoom";

/**
 * What a pointerdown started.
 *
 * `pan-or-tap` and `pan-only` differ on exactly one point, and it is the point
 * the touch and desktop contracts disagree about: whether a gesture that never
 * moved should select. On touch a stationary press IS the select gesture; with
 * Space held it must not be, because the customer has explicitly said they are
 * panning right now.
 */
export type PointerGestureMode = "select" | "pan-or-tap" | "pan-only" | "ignore";

export interface PointerGestureStart {
  /** `PointerEvent.pointerType` — "mouse", "touch" or "pen". */
  pointerType: string;
  /** `PointerEvent.button` — 0 left, 1 middle, 2 right. */
  button: number;
  /** Whether the Space pan modifier is currently held. */
  spaceHeld: boolean;
  /** A busy workspace accepts no gesture at all. */
  busy: boolean;
}

export function resolveGestureMode({
  pointerType,
  button,
  spaceHeld,
  busy,
}: PointerGestureStart): PointerGestureMode {
  if (busy) return "ignore";

  // Touch and pen have no modifier key to hold, so the gesture carries the
  // meaning by itself and is resolved on release.
  if (pointerType === "touch" || pointerType === "pen") {
    return button <= 0 ? "pan-or-tap" : "ignore";
  }

  if (button === 1) return "pan-only"; // middle drag, the conventional pan
  if (button !== 0) return "ignore"; // right/back/forward belong to the browser
  return spaceHeld ? "pan-only" : "select";
}

export interface GestureSession {
  mode: PointerGestureMode;
  pointerId: number;
  startX: number;
  startY: number;
  /** Viewport scroll at the moment the gesture began. */
  scrollLeft: number;
  scrollTop: number;
  /** Set once the pointer has travelled past the pan threshold. */
  moved: boolean;
}

export function beginGesture(
  start: PointerGestureStart,
  pointer: { pointerId: number; clientX: number; clientY: number },
  scroll: { scrollLeft: number; scrollTop: number },
): GestureSession | null {
  const mode = resolveGestureMode(start);
  if (mode === "ignore") return null;
  return {
    mode,
    pointerId: pointer.pointerId,
    startX: pointer.clientX,
    startY: pointer.clientY,
    scrollLeft: scroll.scrollLeft,
    scrollTop: scroll.scrollTop,
    moved: false,
  };
}

/**
 * Advances a live gesture and returns the scroll position the viewport should
 * take, or `null` when this movement pans nothing.
 *
 * MUTATES `session.moved`, which is what a later `shouldSelectOnRelease` reads
 * to refuse a selection. A `select` gesture deliberately does NOT set it: a
 * left click that drifts a few pixels on the way down is still the customer
 * pointing at something, and the release position is where they pointed.
 */
export function advanceGesture(
  session: GestureSession,
  pointer: { clientX: number; clientY: number },
  zoomFactor: number,
): { scrollLeft: number; scrollTop: number } | null {
  if (session.mode !== "pan-or-tap" && session.mode !== "pan-only") return null;

  const deltaX = pointer.clientX - session.startX;
  const deltaY = pointer.clientY - session.startY;
  if (!isPanGesture(deltaX, deltaY)) return null;

  session.moved = true;

  // At Fit the artwork already fits the viewport, so there is nothing to pan
  // to — but the gesture still counts as movement, and still suppresses the
  // selection it would otherwise have made.
  if (zoomFactor <= GUIDED_CLEANUP_ZOOM_MIN) return null;

  return {
    scrollLeft: session.scrollLeft - deltaX,
    scrollTop: session.scrollTop - deltaY,
  };
}

/** Whether releasing this gesture should preview a cleanup candidate. */
export function shouldSelectOnRelease(session: GestureSession, busy: boolean): boolean {
  if (busy) return false;
  if (session.mode === "select") return true;
  if (session.mode === "pan-or-tap") return !session.moved;
  return false; // pan-only never selects, moved or not
}

/**
 * The cursor for the artwork surface.
 *
 * Zoom is deliberately NOT an input. That it used to be is the whole defect:
 * the pointer's meaning is the same at 400% as it is at Fit, so its picture
 * must be too.
 */
export function resolveArtworkCursorClassName({
  busy,
  spaceHeld,
}: {
  busy: boolean;
  spaceHeld: boolean;
}): string {
  if (busy) return "cursor-wait";
  if (spaceHeld) return "cursor-grab active:cursor-grabbing";
  return "cursor-crosshair";
}

/** The Space key, under both the modern and legacy `KeyboardEvent.key` values. */
export function isPanModifierKey(key: string): boolean {
  return key === " " || key === "Spacebar";
}

/**
 * Whether a Space press aimed at `target` is the pan modifier, or that
 * element's own business.
 *
 * The toolbar carries real buttons and the Preview Background radio group, for
 * which Space is activation. Swallowing it there would break keyboard operation
 * of controls that have nothing to do with panning.
 */
export function isPanModifierTarget(target: unknown): boolean {
  if (target === null || typeof target !== "object") return true;
  const element = target as {
    tagName?: unknown;
    isContentEditable?: unknown;
  };
  if (element.isContentEditable === true) return false;
  const tagName = typeof element.tagName === "string" ? element.tagName.toUpperCase() : "";
  return !INTERACTIVE_TAG_NAMES.has(tagName);
}

const INTERACTIVE_TAG_NAMES = new Set(["INPUT", "TEXTAREA", "SELECT", "BUTTON", "A", "OPTION"]);
