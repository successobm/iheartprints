import { NextResponse } from "next/server";

import { getPersistenceMode } from "@/lib/db";
import { getConversation } from "@/lib/services/conversation-service";

type RouteContext = {
  params: Promise<{ projectId: string }>;
};

export async function GET(_request: Request, context: RouteContext) {
  try {
    const { projectId } = await context.params;
    const snapshot = await getConversation(projectId);

    if (!snapshot) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    return NextResponse.json({
      ...snapshot,
      persistenceMode: getPersistenceMode(),
    });
  } catch (error) {
    console.error("Failed to load project", error);
    return NextResponse.json(
      { error: "Failed to load conversation" },
      { status: 500 },
    );
  }
}
