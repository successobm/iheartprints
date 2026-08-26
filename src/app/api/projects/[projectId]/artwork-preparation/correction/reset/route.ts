import { NextResponse } from "next/server";

import { ArtworkPreparationStateError } from "@/capabilities/artwork-preparation";
import { getCapabilityGraph } from "@/capabilities/composition";

type RouteContext = { params: Promise<{ projectId: string }> };

/** Phase 27E — "Start Over": resets the session's operations to empty, back to the CURRENT prepared asset unmodified. Never touches the original. INTERNAL ONLY. */
export async function POST(_request: Request, context: RouteContext) {
  const { projectId } = await context.params;
  const graph = getCapabilityGraph();

  if (!(await graph.acquisition.isInternalProject(projectId))) {
    return new Response("Not found", { status: 404 });
  }

  try {
    await graph.artworkPreparation.resetCorrectionSession(projectId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof ArtworkPreparationStateError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    console.error("Failed to reset correction session", error);
    return NextResponse.json({ error: "Failed to reset correction session" }, { status: 500 });
  }
}
