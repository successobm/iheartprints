import { NextResponse } from "next/server";

import { ArtworkPreparationStateError } from "@/capabilities/artwork-preparation";
import { isAuthorizedForArtworkCorrection } from "@/capabilities/artwork-preparation/artwork-correction-authorization";
import { getCapabilityGraph } from "@/capabilities/composition";
import { getPersistenceMode, getProjectRepository } from "@/lib/db";

type RouteContext = {
  params: Promise<{ projectId: string }>;
};

/**
 * Intelligent Separation Phase 9 / Phase 28K: this project's own
 * consequential-region review state. GET only — reading this never mutates
 * anything.
 *
 * ENFORCED SERVER-SIDE. Phase 28K widened this from "internal staff only"
 * to "internal staff OR this project's own owner" — see
 * `isAuthorizedForArtworkCorrection`'s doc comment for the full audit: a
 * customer whose OWN artwork genuinely needs a consequential-region
 * decision has no other route capable of showing it to them, which was an
 * impossible gate, not a security feature. Still a deliberately
 * uninformative 404, never a 403 (Goal 21/22).
 */
export async function GET(_request: Request, context: RouteContext) {
  try {
    const { projectId } = await context.params;
    const graph = getCapabilityGraph();

    if (!(await isAuthorizedForArtworkCorrection(graph.acquisition, getProjectRepository(), projectId))) {
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
