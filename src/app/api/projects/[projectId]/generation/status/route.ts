import { NextResponse } from "next/server";

import { getGenerationStatus } from "@/lib/services/conversation-service";

type RouteContext = {
  params: Promise<{ projectId: string }>;
};

/**
 * Sprint 2H Part 2A: lightweight, provider-neutral polling endpoint —
 * cheap enough for the conversation to check every few seconds while
 * generation runs in the background. Returns only `{ status }`: never a
 * job id, provider name, queue name, or any other internal detail.
 */
export async function GET(_request: Request, context: RouteContext) {
  try {
    const { projectId } = await context.params;
    const status = await getGenerationStatus(projectId);

    if (!status) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    return NextResponse.json(status);
  } catch (error) {
    console.error("Failed to check generation status", error);
    return NextResponse.json(
      { error: "Failed to check generation status" },
      { status: 500 },
    );
  }
}
