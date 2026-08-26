/**
 * Phase 27C/27D — EXPERIMENTAL / LOCAL-ONLY. Read-only: given a raw LIST
 * of click points (Phase 27D additive selection), a mode, a tolerance
 * level, and an optional `removeAt` point (Phase 27D subtractive
 * selection), recomputes the AUTHORITATIVE union selection server-side and
 * returns its stats plus a rendered overlay — never persists anything.
 *
 * The client sends only raw points; it never sends or is trusted for a
 * mask. When `removeAt` is present, the server decides which clicks
 * survive (by recomputing each one's own flood fill) and returns
 * `effectiveClicks` so the client's local state stays exactly in sync with
 * what the server actually used — the client never manufactures that
 * decision itself.
 *
 * Preview and Apply use this exact same selection algorithm
 * (`computeSelectionPreview` / `floodFillSelect` / `unionMasks`), so what
 * the operator sees here is guaranteed to match what Apply would persist.
 */
import { NextResponse } from "next/server";
import { computeSelectionPreview, encodePngResponse } from "@/experimental/magic-wand/lab-state";
import { isToleranceLevel, type CorrectionAction, type Point } from "@/experimental/magic-wand/magic-wand";

function isPoint(value: unknown): value is Point {
  return !!value && typeof value === "object" && typeof (value as Point).x === "number" && typeof (value as Point).y === "number";
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as
    | { clicks?: unknown; mode?: unknown; toleranceLevel?: unknown; removeAt?: unknown }
    | null;
  if (
    !body ||
    !Array.isArray(body.clicks) ||
    body.clicks.length === 0 ||
    !body.clicks.every(isPoint) ||
    (body.mode !== "restore" && body.mode !== "remove") ||
    !isToleranceLevel(body.toleranceLevel) ||
    (body.removeAt !== undefined && !isPoint(body.removeAt))
  ) {
    return NextResponse.json(
      { error: "clicks (non-empty array of {x,y}), mode (restore|remove), toleranceLevel (less|default|more), optional removeAt ({x,y}) are required" },
      { status: 400 },
    );
  }
  const mode = body.mode as CorrectionAction;
  const clicks = body.clicks as Point[];
  const removeAt = body.removeAt as Point | undefined;

  let result;
  try {
    result = computeSelectionPreview(clicks, mode, body.toleranceLevel, removeAt);
  } catch (error) {
    // Fails closed: an out-of-bounds click (or any other computation
    // failure) never produces a guessed selection.
    return NextResponse.json({ error: error instanceof Error ? error.message : "selection failed" }, { status: 400 });
  }
  const { selection, overlay, effectiveClicks } = result;
  const overlayDataUrl = `data:image/png;base64,${encodePngResponse(overlay).toString("base64")}`;
  return NextResponse.json({
    pixelCount: selection.pixelCount,
    bounds: selection.bounds,
    touchesEdge: selection.touchesEdge,
    broad: selection.broad,
    overlayDataUrl,
    effectiveClicks,
  });
}
