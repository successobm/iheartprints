import { NextResponse } from "next/server";

import { SignPreparationStateError } from "@/capabilities/sign-preparation";
import type { SignOperatorRegionBoundary } from "@/capabilities/sign-preparation/sign-operator-structural-override";
import { getProjectRepository } from "@/lib/db";
import { readAcquisitionSessionTokenFromRequest } from "@/lib/http/acquisition-session-cookie";
import { confirmOperatorStructuralLayoutForSign } from "@/lib/services/sign-artwork-service";

type RouteContext = {
  params: Promise<{ projectId: string }>;
};

/**
 * Signs Phase 3A: "confirm operator structural layout" — the ONE internal
 * production-operator action that supplies the missing structural
 * interpretation for `reflow_structural_layout` when deterministic
 * segmentation (`sign-layout-segmentation.ts`) is ambiguous or cannot
 * measure a banner structure at all. See `sign-operator-structural-
 * override.ts`'s own doc for exactly what is (and is never) operator-
 * authored — row boundaries only; every colour is independently measured
 * from the actual source pixels, never typed.
 *
 * Same session gate as every other internal sign-artwork route: the
 * REQUESTER'S OWN session must be verified internal right now
 * (`entitlement === "internal"`), never `isInternalProject(projectId)`.
 *
 * `POST` body: `{ regions: SignOperatorRegionBoundary[] }` to record a new
 * override (or replace the existing one — always the single CURRENT
 * override, never a history), or `{ regions: null }` to clear it. Every
 * boundary is independently re-validated against the actual current source
 * pixels inside `SignPreparationCapability.confirmOperatorStructuralLayout`
 * BEFORE anything is persisted — a malformed or unprovable submission is
 * refused with the specific reason, never silently accepted. Immediately
 * re-plans afterward so the response reflects whatever the evidence
 * actually produces (an eligible `reflow_structural_layout` proposal, or
 * still-insufficient/ambiguous, honestly reported either way) — never a
 * separate step the operator has to remember to trigger.
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

    const body = (await request.json().catch(() => null)) as { regions?: SignOperatorRegionBoundary[] | null } | null;
    if (!body || (body.regions !== null && !Array.isArray(body.regions))) {
      return NextResponse.json(
        { error: "Expected a JSON body of the form { regions: [...] | null }." },
        { status: 400 },
      );
    }

    const review = await confirmOperatorStructuralLayoutForSign(projectId, body.regions ?? null);
    return NextResponse.json(review);
  } catch (error) {
    if (error instanceof SignPreparationStateError) {
      const status = error.message.includes("not found") ? 404 : 409;
      return NextResponse.json({ error: error.message }, { status });
    }
    const message =
      error instanceof Error ? error.message : "Failed to record operator structural layout";
    console.error("Failed to confirm operator structural layout", error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
