import { NextResponse } from "next/server";

import { ArtworkPreparationStateError } from "@/capabilities/artwork-preparation";
import { getCapabilityGraph } from "@/capabilities/composition";

type RouteContext = { params: Promise<{ projectId: string }> };

/**
 * Phase 27E — GRADUATED Magic Wand correction workspace, read-only
 * selection preview. INTERNAL ONLY, ENFORCED SERVER-SIDE, same pattern as
 * every `separation/*` route: bare 404 as the first statement, before any
 * body parsing.
 *
 * The client sends only raw click points + mode + tolerance (+ optional
 * `removeAt` for subtractive selection) — never a mask. The server
 * recomputes the authoritative selection from scratch every time.
 */
export async function POST(request: Request, context: RouteContext) {
  const { projectId } = await context.params;
  const graph = getCapabilityGraph();

  if (!(await graph.acquisition.isInternalProject(projectId))) {
    return new Response("Not found", { status: 404 });
  }

  try {
    const body = (await request.json().catch(() => null)) as
      | { tool?: unknown; clicks?: unknown; mode?: unknown; toleranceLevel?: unknown; removeAt?: unknown; click?: unknown }
      | null;
    if (!body) {
      return NextResponse.json({ error: "A request body is required" }, { status: 400 });
    }

    // Phase 27I §C: Restore Fill's preview takes a single click, not a
    // clicks[]/mode/toleranceLevel triple -- a distinct request shape,
    // dispatched on `tool` before falling back to the Magic Wand shape
    // every existing caller already sends.
    if (body.tool === "restore_fill") {
      if (!body.click || typeof body.click !== "object") {
        return NextResponse.json({ error: "click is required" }, { status: 400 });
      }
      const result = await graph.artworkPreparation.previewCorrectionSelection(projectId, {
        tool: "restore_fill",
        click: body.click as { x: number; y: number },
      });
      return NextResponse.json({
        pixelCount: result.pixelCount,
        bounds: result.bounds,
        touchesEdge: result.touchesEdge,
        broad: result.broad,
        overlayDataUrl: `data:image/png;base64,${result.overlayPng.toString("base64")}`,
        effectiveClicks: result.effectiveClicks,
        refused: result.refused ?? false,
        refusalReason: result.refusalReason ?? null,
      });
    }

    if (!Array.isArray(body.clicks)) {
      return NextResponse.json({ error: "clicks, mode, toleranceLevel are required" }, { status: 400 });
    }
    const result = await graph.artworkPreparation.previewCorrectionSelection(projectId, {
      clicks: body.clicks as { x: number; y: number }[],
      mode: body.mode as "restore" | "remove",
      toleranceLevel: body.toleranceLevel as "less" | "default" | "more",
      removeAt: body.removeAt as { x: number; y: number } | undefined,
    });
    return NextResponse.json({
      pixelCount: result.pixelCount,
      bounds: result.bounds,
      touchesEdge: result.touchesEdge,
      broad: result.broad,
      overlayDataUrl: `data:image/png;base64,${result.overlayPng.toString("base64")}`,
      effectiveClicks: result.effectiveClicks,
    });
  } catch (error) {
    if (error instanceof ArtworkPreparationStateError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    console.error("Failed to compute correction selection", error);
    return NextResponse.json({ error: "Failed to compute correction selection" }, { status: 500 });
  }
}
