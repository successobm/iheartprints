import { NextResponse } from "next/server";

import { ArtworkPreparationStateError } from "@/capabilities/artwork-preparation";
import { getCapabilityGraph } from "@/capabilities/composition";

type RouteContext = { params: Promise<{ projectId: string }> };

/**
 * Phase 27E — read-only: how many operations are in this project's
 * correction session right now. Lets the workspace UI seed its
 * "Corrections applied" counter from server truth when it mounts (e.g.
 * after "Back to Editing"), instead of a client-only counter that would
 * reset to 0 on remount despite the session itself being intact.
 * INTERNAL ONLY.
 */
export async function GET(_request: Request, context: RouteContext) {
  const { projectId } = await context.params;
  const graph = getCapabilityGraph();

  if (!(await graph.acquisition.isInternalProject(projectId))) {
    return new Response("Not found", { status: 404 });
  }

  try {
    const info = await graph.artworkPreparation.getCorrectionSessionInfo(projectId);
    return NextResponse.json(info);
  } catch (error) {
    if (error instanceof ArtworkPreparationStateError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    console.error("Failed to load correction session status", error);
    return NextResponse.json({ error: "Failed to load correction session status" }, { status: 500 });
  }
}
