import { NextResponse } from "next/server";

import { SignPreparationStateError, type SignCompositionOperatorInput } from "@/capabilities/sign-preparation";
import { getProjectRepository } from "@/lib/db";
import { readAcquisitionSessionTokenFromRequest } from "@/lib/http/acquisition-session-cookie";
import { confirmSignCompositionPlanForSign } from "@/lib/services/sign-artwork-service";

type RouteContext = {
  params: Promise<{ projectId: string }>;
};

/**
 * Signs Phase 3B (Canvas-First Correction): "confirm composition plan" —
 * the ONE internal production-operator action that builds and persists a
 * canvas-first `SignRepairPlan` from explicit crop/fit/move/fill choices
 * (`sign-composition-plan-builder.ts`). Replaces the automatic
 * `planSignRepair`/`reconstruct_parametric_frame` path for NEW straight-
 * rectangle production — nothing here infers geometry from the artwork's
 * own perimeter; every number in the request body is an operator decision.
 *
 * Same session gate as every other internal sign-artwork route: the
 * REQUESTER'S OWN session must be verified internal right now
 * (`entitlement === "internal"`), never `isInternalProject(projectId)`.
 *
 * `POST` body shape (see `SignCompositionOperatorInput`):
 * `{ reconstruction: {requestedScale,requestedWidthPx,requestedHeightPx} | null,
 *    crop: {xPx,yPx,widthPx,heightPx} | null,
 *    fitBackground: {r,g,b},
 *    fitPlacement: {xPx,yPx} | null,
 *    moves: {sourceStartYPx,heightPx,destStartYPx}[],
 *    fills: {xPx,yPx,widthPx,heightPx,color:{r,g,b}}[] }`
 *
 * A geometrically invalid submission (crop/move/fill outside canvas
 * bounds, an unconfirmed spec, an unsupported policy) is refused with the
 * specific reason, before anything is persisted — never silently clamped.
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

    const body = (await request.json().catch(() => null)) as SignCompositionOperatorInput | null;
    if (
      !body ||
      typeof body !== "object" ||
      !body.fitBackground ||
      !Array.isArray(body.moves) ||
      !Array.isArray(body.fills)
    ) {
      return NextResponse.json(
        { error: "Expected a JSON body describing the composition plan (reconstruction/crop/fitBackground/fitPlacement/moves/fills)." },
        { status: 400 },
      );
    }

    const review = await confirmSignCompositionPlanForSign(projectId, body);
    return NextResponse.json(review);
  } catch (error) {
    if (error instanceof SignPreparationStateError) {
      const status = error.message.includes("not found") ? 404 : 409;
      return NextResponse.json({ error: error.message }, { status });
    }
    const message = error instanceof Error ? error.message : "Failed to build the composition plan";
    console.error("Failed to confirm sign composition plan", error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
