import { NextResponse } from "next/server";
import { z } from "zod";

import { getPersistenceMode } from "@/lib/db";
import { confirmSelectedDirection } from "@/lib/services/conversation-service";

type RouteContext = {
  params: Promise<{ projectId: string }>;
};

const bodySchema = z.object({
  artworkVersionId: z.string().uuid(),
});

/**
 * Live Acceptance Corrective Pass (Section 2): the customer's explicit "no
 * more changes, use this design" confirmation — the [Use This Design]
 * action. Distinct from `/select` (only ever "I want to work with this
 * direction"). The sole way `PrintProject.finalDirectionConfirmed` becomes
 * `true`; `FinalArtworkCapability.requestFinalArtwork` refuses to finalize
 * without it.
 */
export async function POST(request: Request, context: RouteContext) {
  try {
    const { projectId } = await context.params;
    const json = await request.json();
    const parsed = bodySchema.safeParse(json);

    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid confirmation" }, { status: 400 });
    }

    const snapshot = await confirmSelectedDirection(
      projectId,
      parsed.data.artworkVersionId,
    );

    return NextResponse.json({
      ...snapshot,
      persistenceMode: getPersistenceMode(),
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to confirm this direction";
    const status = message.includes("not found")
      ? 404
      : message.includes("Select this concept") || message.includes("in progress")
        ? 409
        : 500;
    console.error("Failed to confirm final direction", error);
    return NextResponse.json({ error: message }, { status });
  }
}
