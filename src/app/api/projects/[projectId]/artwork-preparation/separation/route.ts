import { NextResponse } from "next/server";

import { ArtworkPreparationStateError } from "@/capabilities/artwork-preparation";
import { getCapabilityGraph } from "@/capabilities/composition";
import { getPersistenceMode } from "@/lib/db";

type RouteContext = {
  params: Promise<{ projectId: string }>;
};

/**
 * Intelligent Separation Phase 9: the operator's consequential-region review
 * state. GET only — reading this never mutates anything.
 *
 * INTERNAL ONLY, ENFORCED SERVER-SIDE, the same gate and the same
 * deliberately uninformative 404 the production-treatment preview route
 * already uses (Goal 21/22). This route does not itself know what "safe" or
 * "consequential" mean — it only decides who may ask.
 */
export async function GET(_request: Request, context: RouteContext) {
  try {
    const { projectId } = await context.params;
    const graph = getCapabilityGraph();

    if (!(await graph.acquisition.isInternalProject(projectId))) {
      return new Response("Not found", { status: 404 });
    }

    const review = await graph.artworkPreparation.getSeparationReview(projectId);

    return NextResponse.json({
      ...review,
      persistenceMode: getPersistenceMode(),
    });
  } catch (error) {
    if (error instanceof ArtworkPreparationStateError) {
      const status = error.message.includes("not found") || error.message.includes("no uploaded") ? 404 : 409;
      return NextResponse.json({ error: error.message }, { status });
    }
    console.error("Failed to load separation review", error);
    return NextResponse.json({ error: "Failed to load separation review" }, { status: 500 });
  }
}
