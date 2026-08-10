import { NextResponse } from "next/server";

import { getPersistenceMode } from "@/lib/db";
import { setProductionPrintWidth } from "@/lib/services/conversation-service";

type RouteContext = {
  params: Promise<{ projectId: string }>;
};

/**
 * Live Acceptance Cleanup (Issue 5): the customer's chosen PRODUCTION print
 * width.
 *
 * A production-specification change, never a creative one: nothing on this
 * path generates artwork, creates an `ArtworkVersion`, approves a brief
 * version, or calls an image provider. Bounds and clamping are decided by
 * the placement policy inside the capability — this route never validates
 * inches itself, so the printable band has exactly one definition.
 */
export async function POST(request: Request, context: RouteContext) {
  try {
    const { projectId } = await context.params;
    const body = (await request.json().catch(() => ({}))) as {
      widthIn?: unknown;
    };

    // `null` is meaningful (return to the placement default); anything else
    // non-numeric is a malformed request, not a default.
    let widthIn: number | null;
    if (body.widthIn === null || body.widthIn === undefined) {
      widthIn = null;
    } else if (typeof body.widthIn === "number" && Number.isFinite(body.widthIn)) {
      widthIn = body.widthIn;
    } else {
      return NextResponse.json(
        { error: "A print width in inches is required" },
        { status: 400 },
      );
    }

    const snapshot = await setProductionPrintWidth(projectId, widthIn);

    return NextResponse.json({
      ...snapshot,
      persistenceMode: getPersistenceMode(),
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to set the print size";
    const status = message.includes("not found") ? 404 : 409;
    console.error("Failed to set production print width", error);
    return NextResponse.json({ error: message }, { status });
  }
}
