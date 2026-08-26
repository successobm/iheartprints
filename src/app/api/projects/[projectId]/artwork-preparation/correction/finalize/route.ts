import { NextResponse } from "next/server";

import { ArtworkPreparationStateError } from "@/capabilities/artwork-preparation";
import { getCapabilityGraph } from "@/capabilities/composition";

type RouteContext = { params: Promise<{ projectId: string }> };

/**
 * Phase 27E — "Use This Artwork": THE authoritative handoff. Takes no
 * body — like `separation/approve`, this authorizes exactly the operations
 * already accepted into the session, never a payload the client could
 * substitute at the last moment. INTERNAL ONLY, ENFORCED SERVER-SIDE.
 */
export async function POST(_request: Request, context: RouteContext) {
  const { projectId } = await context.params;
  const graph = getCapabilityGraph();

  if (!(await graph.acquisition.isInternalProject(projectId))) {
    return new Response("Not found", { status: 404 });
  }

  try {
    const view = await graph.artworkPreparation.finalizeCorrection(projectId);
    return NextResponse.json(view);
  } catch (error) {
    if (error instanceof ArtworkPreparationStateError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    console.error("Failed to finalize the correction", error);
    return NextResponse.json({ error: "Failed to finalize the correction" }, { status: 500 });
  }
}
