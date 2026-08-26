import { NextResponse } from "next/server";

import { ArtworkPreparationStateError } from "@/capabilities/artwork-preparation";
import { getCapabilityGraph } from "@/capabilities/composition";

type RouteContext = { params: Promise<{ projectId: string }> };

/** Phase 27E — removes the most recently accepted correction operation (in-memory session only). INTERNAL ONLY. */
export async function POST(_request: Request, context: RouteContext) {
  const { projectId } = await context.params;
  const graph = getCapabilityGraph();

  if (!(await graph.acquisition.isInternalProject(projectId))) {
    return new Response("Not found", { status: 404 });
  }

  try {
    await graph.artworkPreparation.undoCorrectionOperation(projectId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof ArtworkPreparationStateError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    console.error("Failed to undo correction operation", error);
    return NextResponse.json({ error: "Failed to undo correction operation" }, { status: 500 });
  }
}
