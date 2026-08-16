import { NextResponse } from "next/server";
import { z } from "zod";

import { getPersistenceMode } from "@/lib/db";
import { beginCreateNewWorkflow } from "@/lib/services/conversation-service";

/**
 * Correction A: the workflow choice, as its own authority.
 *
 * "Create New Artwork" used to be posted to `/messages` as a synthetic
 * customer sentence, which is how "I'd like you to design new artwork for
 * me." ended up rendered as a customer chat bubble, stored in the Design
 * Brief's Additional Notes, and carried toward the generation prompt. A
 * workflow choice is control state and belongs on a control endpoint —
 * never in the channel reserved for the customer's own creative words.
 *
 * A CLOSED action vocabulary, not a free-text field: `upload_existing` is
 * deliberately absent, because that workflow already has a durable
 * authority of its own (the `ArtworkPreparation` record) and must keep it.
 */

type RouteContext = {
  params: Promise<{ projectId: string }>;
};

const bodySchema = z.object({
  action: z.literal("create_new"),
});

export async function POST(request: Request, context: RouteContext) {
  try {
    const { projectId } = await context.params;
    const json = await request.json();
    const parsed = bodySchema.safeParse(json);

    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid workflow action" }, { status: 400 });
    }

    // Idempotent in the capability, so a double click or a retry after a
    // lost response is a no-op that returns the same authoritative
    // snapshot rather than asking the customer a second question.
    const snapshot = await beginCreateNewWorkflow(projectId);

    return NextResponse.json({
      ...snapshot,
      persistenceMode: getPersistenceMode(),
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to start the workflow";
    console.error("Failed to begin workflow", error);
    return NextResponse.json(
      { error: message },
      { status: message.includes("not found") ? 404 : 500 },
    );
  }
}
