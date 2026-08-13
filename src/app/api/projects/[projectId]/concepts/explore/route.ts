import { NextResponse } from "next/server";

import { getPersistenceMode } from "@/lib/db";
import { exploreNewConceptBatch } from "@/lib/services/conversation-service";

type RouteContext = {
  params: Promise<{ projectId: string }>;
};

/**
 * Live Acceptance Cleanup (Issue 3): "Show Me 3 New Concepts" — a fresh
 * batch of three creative directions from the SAME approved Design Brief.
 *
 * Distinct from `/concepts/regenerate`, which exists for the opposite
 * situation (the brief changed, so the current batch is stale). Nothing here
 * mutates or re-approves the brief, deletes a prior batch, or infers a
 * selection. Idempotency lives in the capability, so a double click is safe.
 */
export async function POST(_request: Request, context: RouteContext) {
  try {
    const { projectId } = await context.params;
    const snapshot = await exploreNewConceptBatch(projectId);

    // Never awaits generation — production stays scheduler/worker driven.

    return NextResponse.json({
      ...snapshot,
      persistenceMode: getPersistenceMode(),
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to explore new concepts";
    const status = message.includes("not found")
      ? 404
      : message.includes("Cannot generate")
        ? 409
        : 409;
    console.error("Failed to explore new concept directions", error);
    return NextResponse.json({ error: message }, { status });
  }
}
