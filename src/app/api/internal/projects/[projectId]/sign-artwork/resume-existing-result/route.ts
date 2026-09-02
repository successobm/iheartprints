import { NextResponse } from "next/server";

import { getProjectRepository } from "@/lib/db";
import { readAcquisitionSessionTokenFromRequest } from "@/lib/http/acquisition-session-cookie";
import { resumeExhaustedSignProviderResult } from "@/lib/services/sign-artwork-service";

type RouteContext = {
  params: Promise<{ projectId: string }>;
};

/**
 * Exhausted Provider Result Recovery Phase (real Signs acceptance
 * incident): "Resume existing provider result" — deliberately a SEPARATE
 * route from `POST .../sign-artwork/prepare`, not a variant of it. Ordinary
 * "Try Again" (`prepare`) revives a failed job back to `"queued"` and lets
 * the normal claim/dispatch machinery decide resume-vs-submit; THIS route
 * never revives anything through that path and never touches
 * `providerRecoveryAttempts` — it exists ONLY for the narrow case where
 * that normal budget is already exhausted (5/5) but the job's existing
 * paid provider request may still be resumable. It is structurally
 * incapable of a fresh paid submission (see
 * `recoverExhaustedSignProviderResult`'s own doc comment for exactly how).
 *
 * Same session gate as every other internal sign-artwork route: the
 * REQUESTER'S OWN session must be verified internal right now
 * (`entitlement === "internal"`), never `isInternalProject(projectId)`.
 *
 * Every precondition (job exists, is failed, its recovery budget is
 * genuinely exhausted, it has an existing provider request, the provider
 * supports resume-only reads) is checked inside the capability itself,
 * which fails closed with a `"refused"` + `reason` rather than throwing —
 * this route echoes that reason back verbatim (never a raw stack trace),
 * so an operator sees exactly why the action didn't proceed rather than a
 * generic error. Never creates a `FinalArtworkJob` — only ever acts on one
 * that already exists.
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

    const result = await resumeExhaustedSignProviderResult(projectId);
    if (result.outcome === "refused") {
      return NextResponse.json(
        { outcome: "refused", reason: result.reason },
        { status: 409 },
      );
    }
    return NextResponse.json(result);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to resume the existing provider result for this artwork";
    console.error("Failed to resume existing sign provider result", error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
