import { NextResponse } from "next/server";

import { SignPreparationStateError } from "@/capabilities/sign-preparation";
import { getProjectRepository } from "@/lib/db";
import { readAcquisitionSessionTokenFromRequest } from "@/lib/http/acquisition-session-cookie";
import { applySignSafeAreaFit, SignArtworkBridgeError } from "@/lib/services/sign-artwork-service";

type RouteContext = {
  params: Promise<{ projectId: string }>;
};

/**
 * Signs Flat-Raster Production Workflow Correction: the GOVERNED
 * counterpart to `safe-area-fit-preview` — rebuilds the current plan's
 * exact same operator choices with a safe-area inset, through the SAME
 * `confirmSignCompositionPlan` mechanism `correction-commit` already uses.
 * `applySignSafeAreaFit`'s own doc has the full contract. Metadata-only:
 * persists a new plan (new planKey, invalidating the prior authorization).
 * Producing the actual pixels still requires the SAME re-authorize +
 * prepare steps every other Signs plan change already requires — this
 * route does not skip or shortcut that governance. Same internal-session
 * gate as every other internal sign-artwork route. No request body.
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

    const review = await applySignSafeAreaFit(projectId);
    return NextResponse.json(review);
  } catch (error) {
    if (error instanceof SignPreparationStateError || error instanceof SignArtworkBridgeError) {
      const status = error.message.includes("not found") ? 404 : 409;
      return NextResponse.json({ error: error.message }, { status });
    }
    const message = error instanceof Error ? error.message : "Failed to apply the safe-area fit";
    console.error("Failed to apply sign safe-area fit", error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
