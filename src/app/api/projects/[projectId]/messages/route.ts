import { NextResponse } from "next/server";
import { z } from "zod";

import { getPersistenceMode } from "@/lib/db";
import { handleUserMessage } from "@/lib/services/conversation-service";

type RouteContext = {
  params: Promise<{ projectId: string }>;
};

const bodySchema = z.object({
  content: z.string().trim().min(1).max(4000),
});

export async function POST(request: Request, context: RouteContext) {
  try {
    const { projectId } = await context.params;
    const json = await request.json();
    const parsed = bodySchema.safeParse(json);

    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid message" }, { status: 400 });
    }

    const snapshot = await handleUserMessage(projectId, parsed.data.content);
    // Chat may enqueue regeneration; the route still never awaits the
    // worker. Interactive `next dev` kick lives in conversation-service.
    return NextResponse.json({
      ...snapshot,
      persistenceMode: getPersistenceMode(),
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to send message";
    const status = message.includes("not found")
      ? 404
      : message.includes("wait")
        ? 409
        : 500;
    console.error("Failed to handle message", error);
    return NextResponse.json({ error: message }, { status });
  }
}
