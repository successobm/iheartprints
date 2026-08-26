import { NextResponse } from "next/server";

import { ArtworkPreparationStateError } from "@/capabilities/artwork-preparation";
import { getCapabilityGraph } from "@/capabilities/composition";

type RouteContext = { params: Promise<{ projectId: string }> };

/**
 * Phase 27E — accepts one correction operation into the IN-MEMORY session
 * (never the database — see Phase 27E §10, no hidden auto-save). Persists
 * only raw clicks + mode + tolerance, never a mask. INTERNAL ONLY.
 */
export async function POST(request: Request, context: RouteContext) {
  const { projectId } = await context.params;
  const graph = getCapabilityGraph();

  if (!(await graph.acquisition.isInternalProject(projectId))) {
    return new Response("Not found", { status: 404 });
  }

  try {
    const body = (await request.json().catch(() => null)) as
      | { clicks?: unknown; mode?: unknown; toleranceLevel?: unknown }
      | null;
    if (!body || !Array.isArray(body.clicks)) {
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
