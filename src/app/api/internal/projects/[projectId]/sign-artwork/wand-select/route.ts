import { NextResponse } from "next/server";

import { isToleranceLevel } from "@/capabilities/shared/flood-fill-selection";
import { getProjectRepository } from "@/lib/db";
import { readAcquisitionSessionTokenFromRequest } from "@/lib/http/acquisition-session-cookie";
import { previewSignWandSelection } from "@/lib/services/sign-artwork-service";

type RouteContext = {
  params: Promise<{ projectId: string }>;
};

/**
 * Wand-First Correction UX Phase: one operator wand click. Read-only,
 * zero-persistence, zero-provider-call — `previewSignWandSelection`'s own
 * doc has the full contract (reuses the SAME `floodFillSelect` DTF's own
 * Magic Wand runs, against the CURRENT blocked candidate's own pixels).
 * Same session gate as every other internal sign-artwork route.
 *
 * `POST` body: `{xPx: number, yPx: number, toleranceLevel?: "less"|"default"|"more"}`
 * — the clicked point, in the production candidate's own native pixel
 * space (identical coordinate discipline to every other correction route:
 * the client maps display->source pixels itself, this route only ever sees
 * already-native coordinates).
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

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const xPx = body?.xPx;
    const yPx = body?.yPx;
    const toleranceLevel = body?.toleranceLevel ?? "default";
    if (typeof xPx !== "number" || typeof yPx !== "number" || !isToleranceLevel(toleranceLevel)) {
      return NextResponse.json(
        { error: "Expected {xPx: number, yPx: number, toleranceLevel?: \"less\"|\"default\"|\"more\"}." },
        { status: 400 },
      );
    }

    const result = await previewSignWandSelection(projectId, xPx, yPx, toleranceLevel);
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to compute the wand selection";
    console.error("Failed to compute sign wand selection", error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
