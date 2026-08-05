import { NextResponse } from "next/server";

import { getPersistenceMode } from "@/lib/db";
import { regenerateConcepts } from "@/lib/services/conversation-service";

type RouteContext = {
  params: Promise<{ projectId: string }>;
};

/**
 * Sprint 2G Part 3: explicit action behind the persistent "Generate Updated
 * Concepts" control — no chat message required. Re-approves the working
 * brief and generates a fresh, additional batch of concepts; prior
 * concepts are never deleted.
 */
export async function POST(_request: Request, context: RouteContext) {
  try {
    const { projectId } = await context.params;
    const snapshot = await regenerateConcepts(projectId);

    return NextResponse.json({
      ...snapshot,
      persistenceMode: getPersistenceMode(),
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to regenerate concepts";
    const status = message.includes("not found")
      ? 404
      : message.includes("Cannot generate")
        ? 409
        : 500;
    console.error("Failed to regenerate concepts", error);
    return NextResponse.json({ error: message }, { status });
  }
}
