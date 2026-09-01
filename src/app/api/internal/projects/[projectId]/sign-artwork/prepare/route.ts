import { NextResponse } from "next/server";

import { getProjectRepository } from "@/lib/db";
import { readAcquisitionSessionTokenFromRequest } from "@/lib/http/acquisition-session-cookie";
import { prepareSignArtworkForProduction } from "@/lib/services/sign-artwork-service";

type RouteContext = {
  params: Promise<{ projectId: string }>;
};

/**
 * LIVE PRODUCT BLOCKER #4B: the operator's "Prepare artwork" action —
 * deliberately separate from `POST .../sign-artwork/authorize` (Blocker
 * #4/#4A). Authorizing a plan and requesting its production are two
 * different decisions; this route performs ONLY the second one, and
 * refuses outright (through `requestSignFinalArtwork`'s own gate) if the
 * first was never durably recorded for THIS exact plan.
 *
 * Same session gate as every other internal sign-artwork route: the
 * REQUESTER'S OWN session must be verified internal right now
 * (`entitlement === "internal"`), never `isInternalProject(projectId)`.
 *
 * This MAY create/enqueue a `FinalArtworkJob` — the one route in this
 * phase permitted to do so. Idempotent by construction
 * (`FinalArtworkCapability.requestSignFinalArtwork`'s own guarantee): a
 * double click, a page reload, or a retry all resolve to the exact same
 * job rather than creating duplicates.
 */
export async function POST(request: Request, context: RouteContext) {
  try {
    const { projectId } = await context.params;
    const repo = getProjectRepository();

    const token = readAcquisitionSessionTokenFromRequest(request);
    const session = token
      ? await repo.getAcquisitionSessionByToken(token).catch(() => null)
      : null;
    if (!session || session.entitlement !== "internal") {
      return NextResponse.json(
        { error: "This action requires an internal production session." },
        { status: 403 },
      );
    }

    const result = await prepareSignArtworkForProduction(projectId);
    return NextResponse.json(result);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to request production for this artwork";
    console.error("Failed to prepare sign artwork for production", error);
    return NextResponse.json(
      { error: message },
      { status: message.includes("not found") ? 404 : 409 },
    );
  }
}
