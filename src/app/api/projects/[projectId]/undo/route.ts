import { NextResponse } from "next/server";

import { getPersistenceMode } from "@/lib/db";
import { undoLastChange } from "@/lib/services/conversation-service";

type RouteContext = {
  params: Promise<{ projectId: string }>;
};

/**
 * Sprint 2G Part 3: explicit action behind an "Undo" control. Undoes only
 * the most recently accepted revision (one level, not arbitrary history
 * editing). A safe no-op with a plain acknowledgment when there is nothing
 * to undo.
 */
export async function POST(_request: Request, context: RouteContext) {
  try {
    const { projectId } = await context.params;
    const snapshot = await undoLastChange(projectId);

    return NextResponse.json({
      ...snapshot,
      persistenceMode: getPersistenceMode(),
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to undo the last change";
    const status = message.includes("not found") ? 404 : 500;
    console.error("Failed to undo the last change", error);
    return NextResponse.json({ error: message }, { status });
  }
}
