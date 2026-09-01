import { NextResponse } from "next/server";

import { SignPreparationStateError } from "@/capabilities/sign-preparation";
import { getProjectRepository } from "@/lib/db";
import { readAcquisitionSessionTokenFromRequest } from "@/lib/http/acquisition-session-cookie";
import {
  planSignArtwork,
  SignArtworkBridgeError,
} from "@/lib/services/sign-artwork-service";

type RouteContext = {
  params: Promise<{ projectId: string }>;
};

/**
 * Internal Replan Action Phase: the operator-facing counterpart of
 * `POST /api/projects/[projectId]/sign-artwork/plan` ("Check my artwork") —
 * exists because that customer route is reachable ONLY through whichever
 * project a browser's own `localStorage` happens to have selected, with no
 * URL-addressable equivalent. An operator who navigates directly to
 * `/internal/projects/[projectId]/sign-authorize` for a project they did not
 * personally upload through their own browser session (a support handoff, an
 * abandoned upload, or — the real case this phase exists for — resuming
 * review of a project whose plan was invalidated after this exact artwork's
 * own real acceptance history) has no other supported way to invoke
 * planning.
 *
 * Deliberately under `/api/internal/`, mirroring `sign-artwork/authorize`'s
 * own reasoning exactly: this gates on the REQUESTER'S OWN session being
 * verified internal right now (`entitlement === "internal"`), never
 * `isInternalProject(projectId)` — knowing a real project id must grant
 * nothing on its own. A caller with no session, an unrecognized session, or
 * an ordinary customer session gets a flat 403 before `projectId` is ever
 * looked at.
 *
 * Calls the IDENTICAL `planSignArtwork` service function the customer route
 * calls — never a second, operator-specific planner, and never a duplicate
 * of `SignPreparationCapability.planSignRepair`'s own logic. Idempotent by
 * that same capability's own construction (recomputes from the immutable
 * original and the confirmed spec every time, overwrites the same
 * `SignPreparation` row) — a double click, a reload, or a retry can never
 * create a second or conflicting plan.
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

    const snapshot = await planSignArtwork(projectId);
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
      error instanceof Error ? error.message : "Failed to check this artwork";
    console.error("Failed to plan sign repair (operator)", error);
    return NextResponse.json(
      { error: message },
      { status: message.includes("not found") ? 404 : 500 },
    );
  }
}
