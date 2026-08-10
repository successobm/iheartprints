import { NextResponse } from "next/server";

import { getPersistenceMode } from "@/lib/db";
import { unselectConcept } from "@/lib/services/conversation-service";

type RouteContext = {
  params: Promise<{ projectId: string }>;
};

/**
 * Live Acceptance Cleanup (Issue 2): explicit "Change Selection" — returns
 * the project to "no concept selected".
 *
 * Its own route rather than a nullable body on `/select`, because it is a
 * different lifecycle transition with different refusals (a mid-flight
 * revision or a running/completed finalization each block it), and a route
 * whose meaning flips on whether a field is null is exactly the kind of
 * ambiguity a stale client gets wrong.
 *
 * Every guarantee is enforced in `ConversationCapability.unselectConcept`,
 * never here: this route only translates the outcome into HTTP.
 */
export async function POST(_request: Request, context: RouteContext) {
  try {
    const { projectId } = await context.params;
    const snapshot = await unselectConcept(projectId);

    return NextResponse.json({
      ...snapshot,
      persistenceMode: getPersistenceMode(),
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to change your selection";
    const status = message.includes("not found")
      ? 404
      : // Every other refusal is a lifecycle conflict (revision in flight,
        // finalization running or complete) — the customer can retry once
        // that finishes, so 409 rather than 500.
        409;
    console.error("Failed to clear concept selection", error);
    return NextResponse.json({ error: message }, { status });
  }
}
