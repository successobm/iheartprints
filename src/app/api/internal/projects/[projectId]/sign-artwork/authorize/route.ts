import { NextResponse } from "next/server";

import { SignPreparationStateError } from "@/capabilities/sign-preparation";
import { getProjectRepository } from "@/lib/db";
import { readAcquisitionSessionTokenFromRequest } from "@/lib/http/acquisition-session-cookie";
import {
  authorizeSignArtwork,
  SignArtworkBridgeError,
} from "@/lib/services/sign-artwork-service";

type RouteContext = {
  params: Promise<{ projectId: string }>;
};

/**
 * LIVE PRODUCT BLOCKER #4: the ONE place a `review_required` rigid-sign
 * plan may be authorized for production — the operator's explicit
 * production-risk judgment on the exact proposed repair (e.g. the seam
 * decision `pad_uniform_background`/`extend_uniform_background` records).
 *
 * Deliberately under `/api/internal/`, mirroring
 * `continue-as-internal-job`'s own reasoning exactly: this gates on the
 * REQUESTER'S OWN session being verified internal right now
 * (`entitlement === "internal"`), never `isInternalProject(projectId)` —
 * that asks a different question (was this PROJECT created under an
 * internal session), and knowing a real project id must grant nothing on
 * its own. A caller with no session, an unrecognized session, or an
 * ordinary customer session gets a flat 403 before `projectId` is ever
 * looked at.
 *
 * `SignPreparationCapability.authorizeSignRepairPlan` remains the actual,
 * independent gate underneath this route — even a verified-internal caller
 * cannot authorize a `blocked` plan (no plan exists to authorize) or a
 * stale plan (the recomputed key must match).
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

    const snapshot = await authorizeSignArtwork(projectId, "operator");
    return NextResponse.json(snapshot);
  } catch (error) {
    if (error instanceof SignArtworkBridgeError) {
      const status = error.message.includes("not found") ? 404 : 409;
      return NextResponse.json({ error: error.message }, { status });
    }
    if (error instanceof SignPreparationStateError) {
      const status = error.message.includes("not found") ? 404 : 409;
      return NextResponse.json({ error: error.message }, { status });
    }

    const message =
      error instanceof Error ? error.message : "Failed to authorize this plan";
    console.error("Failed to authorize sign repair plan (operator)", error);
    return NextResponse.json(
      { error: message },
      { status: message.includes("not found") ? 404 : 500 },
    );
  }
}
