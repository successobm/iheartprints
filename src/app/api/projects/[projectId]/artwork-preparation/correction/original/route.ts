import { ArtworkPreparationStateError } from "@/capabilities/artwork-preparation";
import { isAuthorizedForArtworkCorrection } from "@/capabilities/artwork-preparation/artwork-correction-authorization";
import { getCapabilityGraph } from "@/capabilities/composition";
import { getProjectRepository } from "@/lib/db";

type RouteContext = { params: Promise<{ projectId: string }> };

/** Phase 27E — read-only: the immutable original, for the workspace's "compare to original" panel. Phase 28K: internal staff OR this project's own owner (see `isAuthorizedForArtworkCorrection`). */
export async function GET(_request: Request, context: RouteContext) {
  const { projectId } = await context.params;
  const graph = getCapabilityGraph();

  if (!(await isAuthorizedForArtworkCorrection(graph.acquisition, getProjectRepository(), projectId))) {
    return new Response("Not found", { status: 404 });
  }

  try {
    const bytes = await graph.artworkPreparation.getCorrectionOriginalPng(projectId);
    return new Response(new Uint8Array(bytes), { headers: { "Content-Type": "image/png", "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof ArtworkPreparationStateError) {
      return new Response(error.message, { status: 409 });
    }
    console.error("Failed to load the original artwork for correction", error);
    return new Response("Failed to load the original artwork", { status: 500 });
  }
}
