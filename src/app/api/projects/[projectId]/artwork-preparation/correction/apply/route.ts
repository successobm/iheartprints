import { NextResponse } from "next/server";

import { ArtworkPreparationStateError } from "@/capabilities/artwork-preparation";
import { isAuthorizedForArtworkCorrection } from "@/capabilities/artwork-preparation/artwork-correction-authorization";
import { getCapabilityGraph } from "@/capabilities/composition";
import { getProjectRepository } from "@/lib/db";

type RouteContext = { params: Promise<{ projectId: string }> };

/**
 * Phase 27E — accepts one correction operation into the IN-MEMORY session
 * (never the database — see Phase 27E §10, no hidden auto-save). Persists
 * only raw clicks + mode + tolerance, never a mask. Phase 28K: internal staff OR this project's own owner (see `isAuthorizedForArtworkCorrection`).
 */
export async function POST(request: Request, context: RouteContext) {
  const { projectId } = await context.params;
  const graph = getCapabilityGraph();

  if (!(await isAuthorizedForArtworkCorrection(graph.acquisition, getProjectRepository(), projectId))) {
    return new Response("Not found", { status: 404 });
  }

  try {
    const body = (await request.json().catch(() => null)) as
      | { tool?: unknown; clicks?: unknown; mode?: unknown; toleranceLevel?: unknown; click?: unknown; points?: unknown; radius?: unknown }
      | null;
    if (!body) {
      return NextResponse.json({ error: "A request body is required" }, { status: 400 });
    }

    if (body.tool === "restore_fill") {
      if (!body.click || typeof body.click !== "object") {
        return NextResponse.json({ error: "click is required" }, { status: 400 });
      }
      const result = await graph.artworkPreparation.acceptCorrectionOperation(projectId, {
        tool: "restore_fill",
        click: body.click as { x: number; y: number },
      });
      return NextResponse.json(result);
    }

    if (body.tool === "restore_brush" || body.tool === "erase_brush") {
      if (!Array.isArray(body.points) || typeof body.radius !== "number") {
        return NextResponse.json({ error: "points and radius are required" }, { status: 400 });
      }
      const result = await graph.artworkPreparation.acceptCorrectionOperation(projectId, {
        tool: body.tool,
        points: body.points as { x: number; y: number }[],
        radius: body.radius,
      });
      return NextResponse.json(result);
    }

    if (!Array.isArray(body.clicks)) {
      return NextResponse.json({ error: "clicks, mode, toleranceLevel are required" }, { status: 400 });
    }
    const result = await graph.artworkPreparation.acceptCorrectionOperation(projectId, {
      clicks: body.clicks as { x: number; y: number }[],
      mode: body.mode as "restore" | "remove",
      toleranceLevel: body.toleranceLevel as "less" | "default" | "more",
    });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof ArtworkPreparationStateError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    console.error("Failed to accept correction operation", error);
    return NextResponse.json({ error: "Failed to accept correction operation" }, { status: 500 });
  }
}
