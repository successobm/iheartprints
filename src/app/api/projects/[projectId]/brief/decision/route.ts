import { NextResponse } from "next/server";

import { getPersistenceMode } from "@/lib/db";
import { submitDesignBriefDecision } from "@/lib/services/conversation-service";
import { briefDecisionBodySchema } from "./schema";

type RouteContext = {
  params: Promise<{ projectId: string }>;
};

export async function POST(request: Request, context: RouteContext) {
  try {
    const { projectId } = await context.params;
    const json = await request.json();
    const parsed = briefDecisionBodySchema.safeParse(json);

    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid action" }, { status: 400 });
    }

    const snapshot = await submitDesignBriefDecision(
      projectId,
      parsed.data.action,
    );

    // Sprint 2H Part 2B: this route never awaits generation. Production
    // stays scheduler/worker driven. Automated tests stay isolated.
    // Interactive `next dev` only: conversation-service may kick
    // `workerScheduler.runBatch()` in-process after enqueue (see
    // `local-generation-trigger.ts`) so local Approve/Create Concepts
    // does not require a manual POST.

    return NextResponse.json({
      ...snapshot,
      persistenceMode: getPersistenceMode(),
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to submit decision";
    const status = message.includes("not found")
      ? 404
      : message.includes("not ready") || message.includes("Cannot ")
        ? 409
        : 500;
    console.error("Failed to submit design brief decision", error);
    return NextResponse.json({ error: message }, { status });
  }
}
