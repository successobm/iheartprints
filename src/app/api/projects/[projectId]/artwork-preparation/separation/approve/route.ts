import { NextResponse } from "next/server";

import { ArtworkPreparationStateError } from "@/capabilities/artwork-preparation";
import { isAuthorizedForArtworkCorrection } from "@/capabilities/artwork-preparation/artwork-correction-authorization";
import { getCapabilityGraph } from "@/capabilities/composition";
import { getPersistenceMode, getProjectRepository } from "@/lib/db";

type RouteContext = {
  params: Promise<{ projectId: string }>;
};

/**
 * Intelligent Separation Phase 9 / Phase 28K: THE FINAL APPROVAL for this
 * project's own artwork (Goal 18) — the "Use This Artwork" action once
 * consequential-region review is required. This is the customer's own
 * approval action, not a staff-only one, once Phase 28F mounted this review
 * directly into their flow.
 *
 * ENFORCED SERVER-SIDE — Phase 28K's "internal staff OR this project's own
 * owner" gate; see `isAuthorizedForArtworkCorrection`'s doc comment. Takes
 * no body — approval authorizes exactly the decisions already persisted,
 * never a payload the client could substitute at the last moment.
 *
 * This is the ONLY action on this surface that mutates production authority
 * (`preparedAssetId`/`preparedArtworkVersionId`). The capability refuses
 * unless every consequential region carries a current operator decision —
 * this route adds no leniency of its own.
 */
export async function POST(_request: Request, context: RouteContext) {
  try {
    const { projectId } = await context.params;
    const graph = getCapabilityGraph();

    if (!(await isAuthorizedForArtworkCorrection(graph.acquisition, getProjectRepository(), projectId))) {
      return new Response("Not found", { status: 404 });
    }

    const review = await graph.artworkPreparation.approveSeparationMaster(projectId);

    return NextResponse.json({
      ...review,
      persistenceMode: getPersistenceMode(),
    });
  } catch (error) {
    if (error instanceof ArtworkPreparationStateError) {
      const status = error.message.includes("not found") || error.message.includes("no uploaded") ? 404 : 409;
      return NextResponse.json({ error: error.message }, { status });
    }
    console.error("Failed to approve the separation master", error);
    return NextResponse.json({ error: "Failed to approve the separation master" }, { status: 500 });
  }
}
