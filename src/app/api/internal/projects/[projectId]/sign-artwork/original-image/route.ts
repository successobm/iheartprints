import { getCapabilityGraph } from "@/capabilities/composition";
import { getProjectRepository } from "@/lib/db";
import { readAcquisitionSessionTokenFromRequest } from "@/lib/http/acquisition-session-cookie";

type RouteContext = {
  params: Promise<{ projectId: string }>;
};

/**
 * LIVE PRODUCT BLOCKER #4A: the customer's immutable original sign artwork,
 * for the internal operator review page ONLY — never linked from, or
 * reachable through, any customer-facing surface.
 *
 * Reuses the SAME generic, already-proven asset primitive the apparel
 * separation review image route uses (`AssetCapability.downloadAssetBytes`)
 * rather than inventing new file-serving architecture — see that route's
 * own doc comment for the precedent.
 *
 * Gate mirrors `POST /api/internal/projects/[projectId]/sign-artwork
 * /authorize` exactly: the REQUESTER'S OWN session must be verified
 * internal (`entitlement === "internal"`) right now — never
 * `isInternalProject(projectId)`, and knowing a real project id must grant
 * nothing on its own. Same status-code convention as that route: 403 for
 * no/invalid/non-internal session, 404 for a project or preparation that
 * genuinely doesn't exist.
 */
export async function GET(request: Request, context: RouteContext) {
  try {
    const { projectId } = await context.params;
    const repo = getProjectRepository();

    const token = readAcquisitionSessionTokenFromRequest(request);
    const session = token ? await repo.getAcquisitionSessionByToken(token).catch(() => null) : null;
    if (!session || session.entitlement !== "internal") {
      return new Response("This action requires an internal production session.", { status: 403 });
    }

    const preparation = await repo.getSignPreparation(projectId);
    if (!preparation || preparation.projectId !== projectId) {
      return new Response("Not found", { status: 404 });
    }

    const graph = getCapabilityGraph();
    const downloaded = await graph.assets.downloadAssetBytes(preparation.originalAssetId);
    if (!downloaded) return new Response("Not found", { status: 404 });

    return new Response(new Uint8Array(downloaded.bytes), {
      headers: {
        "Content-Type": downloaded.contentType || "image/png",
        "Cache-Control": "private, no-store",
      },
    });
  } catch (error) {
    console.error("Failed to load sign artwork original image (operator)", error);
    return new Response("Not found", { status: 404 });
  }
}
