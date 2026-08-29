import { NextResponse } from "next/server";

import { ArtworkPreparationStateError } from "@/capabilities/artwork-preparation";
import { isAuthorizedForArtworkCorrection } from "@/capabilities/artwork-preparation/artwork-correction-authorization";
import { getCapabilityGraph } from "@/capabilities/composition";
import { getPersistenceMode, getProjectRepository } from "@/lib/db";

type RouteContext = {
  params: Promise<{ projectId: string }>;
};

/**
 * Phase 23 / Phase 28K: this project's own decision about the UNIFIED
 * in-bounds removal proposal — `"pending"` | `"remove_with_exceptions"` |
 * `"preserve_all"` — plus any preserve taps to add or remove this call.
 *
 * ENFORCED SERVER-SIDE — Phase 28K's "internal staff OR this project's own
 * owner" gate; see `isAuthorizedForArtworkCorrection`'s doc comment. Still
 * deliberately does NOT merge into the sibling `decisions/route.ts`: the
 * two request shapes (`regionMapHash` + region-keyed decisions vs.
 * `proposalHash` + a single decision + raw tap coordinates) are different
 * enough that combining them would need a discriminator field and awkward
 * branching for no real benefit — a sibling route matches the existing
 * `approve/route.ts` / `image/route.ts` convention instead.
 *
 * THE CLIENT SENDS RAW TAP COORDINATES, NEVER PIXELS. `addPreserveTaps` is
 * exactly `{ rawTapX, rawTapY }` pairs — no mask, no selected-pixel list, no
 * client-computed selection of any kind. The actual selection is always
 * recomputed server-side from `selectPreserveException`, against a FRESH
 * region/proposal map recomputed from the immutable original on every
 * request.
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
      proposalHash?: unknown;
      decision?: unknown;
      addPreserveTaps?: unknown;
      removePreserveOperationIds?: unknown;
    } | null;

    if (
      !body ||
      typeof body.sourceAssetSha256 !== "string" ||
      typeof body.proposalHash !== "string" ||
      (body.decision !== "pending" && body.decision !== "remove_with_exceptions" && body.decision !== "preserve_all")
    ) {
      return NextResponse.json({ error: "A valid proposal decision request is required" }, { status: 400 });
    }

    const rawTaps = Array.isArray(body.addPreserveTaps) ? body.addPreserveTaps : [];
    const addPreserveTaps = rawTaps.map((t) => {
      const entry = t as { rawTapX?: unknown; rawTapY?: unknown };
      return { rawTapX: entry.rawTapX, rawTapY: entry.rawTapY };
    });
    if (addPreserveTaps.some((t) => typeof t.rawTapX !== "number" || typeof t.rawTapY !== "number")) {
      return NextResponse.json({ error: "Each preserve tap needs numeric rawTapX/rawTapY" }, { status: 400 });
    }

    const removeIds = Array.isArray(body.removePreserveOperationIds)
      ? body.removePreserveOperationIds.filter((id): id is string => typeof id === "string")
      : [];

    const review = await graph.artworkPreparation.submitProposalDecision(projectId, {
      sourceAssetSha256: body.sourceAssetSha256,
      proposalHash: body.proposalHash,
      decision: body.decision,
      addPreserveTaps: addPreserveTaps as Array<{ rawTapX: number; rawTapY: number }>,
      removePreserveOperationIds: removeIds,
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
    console.error("Failed to submit proposal decision", error);
    return NextResponse.json({ error: "Failed to submit proposal decision" }, { status: 500 });
  }
}
