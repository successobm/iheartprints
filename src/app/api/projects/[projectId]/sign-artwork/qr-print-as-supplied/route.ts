import { NextResponse } from "next/server";
import { z } from "zod";

import { getPersistenceMode } from "@/lib/db";
import { getConversation } from "@/lib/services/conversation-service";
import { acceptSignQrPrintAsSupplied, SignQrPreservationError } from "@/lib/services/sign-qr-preservation-service";

type RouteContext = {
  params: Promise<{ projectId: string }>;
};

const bodySchema = z.object({
  regionKey: z.string().min(1).max(64),
});

/**
 * SIGNS QR DESTINATION RESOLUTION: the customer's own explicit "Print as
 * supplied" acknowledgment — no functioning QR is required for this
 * region. No session/cookie check, mirrors `qr-destination/route.ts`'s
 * own identity reasoning exactly. Never claims the QR is verified.
 */
export async function POST(request: Request, context: RouteContext) {
  try {
    const { projectId } = await context.params;
    const json = await request.json();
    const parsed = bodySchema.safeParse(json);
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid request" }, { status: 400 });
    }

    await acceptSignQrPrintAsSupplied(projectId, {
      regionKey: parsed.data.regionKey,
      confirmedBy: "customer",
    });

    const snapshot = await getConversation(projectId);
    if (!snapshot) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }
    return NextResponse.json({ ...snapshot, persistenceMode: getPersistenceMode() });
  } catch (error) {
    if (error instanceof SignQrPreservationError) {
      const status = error.message.includes("not found") || error.message.includes("No sign artwork") ? 404 : 409;
      return NextResponse.json({ error: error.message }, { status });
    }
    const message = error instanceof Error ? error.message : "Failed to save that choice";
    console.error("Failed to accept sign QR as supplied (customer)", error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
