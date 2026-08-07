import { NextResponse } from "next/server";

import { getPersistenceMode } from "@/lib/db";
import { approveFinalDirection } from "@/lib/services/conversation-service";
import { finalizeBodySchema } from "./schema";

type RouteContext = {
  params: Promise<{ projectId: string }>;
};

/**
 * Sprint 2M Phase 2B: the customer's explicit "this is my final direction —
 * prepare it for production" action. Never dispatches any production work
 * inline — this only records the approval and idempotently enqueues a
 * `FinalArtworkJob`; Phase 2B has no worker that claims it yet (mirrors how
 * `brief/decision`'s "approve" enqueues generation without running it).
 */
export async function POST(request: Request, context: RouteContext) {
  try {
    const { projectId } = await context.params;
    const json = await request.json();
    const parsed = finalizeBodySchema.safeParse(json);

    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid request" }, { status: 400 });
    }

    const snapshot = await approveFinalDirection(
      projectId,
      parsed.data.artworkVersionId,
    );

    return NextResponse.json({
      ...snapshot,
      persistenceMode: getPersistenceMode(),
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Failed to approve final direction";
    const status = message.includes("not found") ? 404 : 409;
    console.error("Failed to approve final direction", error);
    return NextResponse.json({ error: message }, { status });
  }
}
