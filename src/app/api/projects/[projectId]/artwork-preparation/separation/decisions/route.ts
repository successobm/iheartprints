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
 * region-intent decisions.
 *
 * ENFORCED SERVER-SIDE — Phase 28K's "internal staff OR this project's own
 * owner" gate; see `isAuthorizedForArtworkCorrection`'s doc comment.
 *
 * THE CLIENT SENDS INTENT, NEVER PIXELS. The request body is exactly
 * `{ sourceAssetSha256, regionMapHash, decisions: [{ regionId, intent }] }`
 * — no mask, no coordinates, no image data of any kind. Everything else
 * (which pixels a `regionId` actually means, whether the hashes are still
 * current) is validated server-side against a FRESH region-map recomputed
 * from the immutable original on every request — never trusted from the
 * client and never cached across requests. An invalid, stale, or malformed
 * request is rejected whole; nothing here ever applies part of a write.
 */
export async function POST(request: Request, context: RouteContext) {
  try {
    const { projectId } = await context.params;
    const graph = getCapabilityGraph();

    if (!(await isAuthorizedForArtworkCorrection(graph.acquisition, getProjectRepository(), projectId))) {
      return new Response("Not found", { status: 404 });
    }

    const body = (await request.json().catch(() => null)) as {
      sourceAssetSha256?: unknown;
      regionMapHash?: unknown;
      decisions?: unknown;
    } | null;

    if (
      !body ||
      typeof body.sourceAssetSha256 !== "string" ||
      typeof body.regionMapHash !== "string" ||
      !Array.isArray(body.decisions)
    ) {
      return NextResponse.json({ error: "A valid decision request is required" }, { status: 400 });
    }

    // Structural validation only — regionId existence, intent legality, and
    // hash currency are the CAPABILITY's job (Goal 22), re-checked against a
    // live region map every call so this route can never drift from it.
    const decisions = body.decisions.map((d) => {
      const entry = d as { regionId?: unknown; intent?: unknown };
      return { regionId: entry.regionId, intent: entry.intent };
    });
    if (
      decisions.some(
        (d) =>
          typeof d.regionId !== "number" ||
          (d.intent !== "substrate" && d.intent !== "ink" && d.intent !== "uncertain"),
      )
    ) {
      return NextResponse.json({ error: "Each decision needs a numeric regionId and a supported intent" }, { status: 400 });
    }

    const review = await graph.artworkPreparation.submitRegionDecisions(projectId, {
      sourceAssetSha256: body.sourceAssetSha256,
      regionMapHash: body.regionMapHash,
      decisions: decisions as Array<{ regionId: number; intent: "substrate" | "ink" | "uncertain" }>,
    });

    return NextResponse.json({
      ...review,
      persistenceMode: getPersistenceMode(),
    });
  } catch (error) {
    if (error instanceof ArtworkPreparationStateError) {
      const status = error.message.includes("not found") || error.message.includes("no uploaded") ? 404 : 409;
      return NextResponse.json({ error: error.message }, { status });
    }
    console.error("Failed to submit region decisions", error);
    return NextResponse.json({ error: "Failed to submit region decisions" }, { status: 500 });
  }
}
