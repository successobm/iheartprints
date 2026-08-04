import { NextResponse } from "next/server";
import { z } from "zod";

import { getPersistenceMode } from "@/lib/db";
import { selectConcept } from "@/lib/services/conversation-service";

type RouteContext = {
  params: Promise<{ projectId: string }>;
};

const bodySchema = z.object({
  artworkVersionId: z.string().uuid(),
});

export async function POST(request: Request, context: RouteContext) {
  try {
    const { projectId } = await context.params;
    const json = await request.json();
    const parsed = bodySchema.safeParse(json);

    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid selection" }, { status: 400 });
    }

    const snapshot = await selectConcept(
      projectId,
      parsed.data.artworkVersionId,
    );

    return NextResponse.json({
      ...snapshot,
      persistenceMode: getPersistenceMode(),
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to select concept";
    const status = message.includes("not found")
      ? 404
      : message.includes("not ready")
        ? 409
        : 500;
    console.error("Failed to select concept", error);
    return NextResponse.json({ error: message }, { status });
  }
}
