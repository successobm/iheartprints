import { NextResponse } from "next/server";

import { getPersistenceMode } from "@/lib/db";
import { startConversation } from "@/lib/services/conversation-service";

export async function POST() {
  try {
    const snapshot = await startConversation();
    return NextResponse.json({
      ...snapshot,
      persistenceMode: getPersistenceMode(),
    });
  } catch (error) {
    console.error("Failed to create project", error);
    return NextResponse.json(
      { error: "Failed to start conversation" },
      { status: 500 },
    );
  }
}
