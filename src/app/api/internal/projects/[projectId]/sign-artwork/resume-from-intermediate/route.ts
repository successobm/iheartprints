import { NextResponse } from "next/server";

import { getProjectRepository } from "@/lib/db";
import { readAcquisitionSessionTokenFromRequest } from "@/lib/http/acquisition-session-cookie";
import { resumeSignFromPersistedIntermediate } from "@/lib/services/sign-artwork-service";

type RouteContext = {
  params: Promise<{ projectId: string }>;
};

/**
 * Post-Provider Resume Phase (real Signs acceptance incident): "Resume from
 * persisted intermediate" — deliberately a SEPARATE route from both
 * `POST .../sign-artwork/prepare` and `POST .../sign-artwork/resume-existing-result`.
 * This route exists for the narrow case those two do not cover: a job whose
 * provider stage is ALREADY durably complete (a `pass1_intermediate` asset
 * exists) but which is stuck — most concretely, `status: "running"` with a
 * stale heartbeat, the lease never advanced past persisting that
 * intermediate. It never contacts a provider under any circumstance (see
 * `resumeSignFromPersistedIntermediate`'s own doc for exactly how) and never
 * touches `providerRecoveryAttempts`.
 *
 * Same session gate as every other internal sign-artwork route: the
 * REQUESTER'S OWN session must be verified internal right now
 * (`entitlement === "internal"`), never `isInternalProject(projectId)`.
 *
 * Every precondition (a matching job exists, its status is reclaimable, a
 * "running" lease's heartbeat is genuinely stale rather than a live worker,
 * a persisted intermediate actually exists) is checked inside the
 * capability itself, which fails closed with a `"refused"` + `reason`
 * rather than throwing — this route echoes that reason back verbatim
 * (never a raw stack trace). Never creates a `FinalArtworkJob` — only ever
 * acts on one that already exists.
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

    const result = await resumeSignFromPersistedIntermediate(projectId);
    if (result.outcome === "refused") {
      return NextResponse.json(
        { outcome: "refused", reason: result.reason },
        { status: 409 },
      );
    }
    return NextResponse.json(result);
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Failed to resume this artwork from its persisted intermediate";
    console.error("Failed to resume sign artwork from persisted intermediate", error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
