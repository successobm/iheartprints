import { NextResponse } from "next/server";
import { z } from "zod";

import { getPersistenceMode } from "@/lib/db";
import { getConversation } from "@/lib/services/conversation-service";
import { confirmSignQrDestination, SignQrPreservationError } from "@/lib/services/sign-qr-preservation-service";

type RouteContext = {
  params: Promise<{ projectId: string }>;
};

const bodySchema = z.object({
  regionKey: z.string().min(1).max(64),
  destination: z.string().min(1).max(500),
});

/**
 * SIGNS QR DESTINATION RESOLUTION: the customer's own self-service action
 * — "we found a QR code, but it doesn't scan; here's where it should go."
 * No session/cookie check: this route's own identity IS the `"customer"`
 * actor, server-stamped, the same no-id-to-forge reasoning as every other
 * customer-facing sign-artwork action (`sign-artwork/authorize`,
 * `sign-artwork/plan`). `regionKey` is never trusted blindly —
 * `confirmSignQrDestination` itself re-derives the CURRENT set of
 * undecodable source regions and refuses anything that doesn't match one,
 * so a forged/stale `regionKey` can never create a phantom resolution.
 *
 * If a production candidate already exists, the correction is attempted
 * immediately (Section U) — the customer never sees or touches the
 * internal production workspace either way; they only ever get back their
 * own updated project snapshot.
 */
export async function POST(request: Request, context: RouteContext) {
  try {
    const { projectId } = await context.params;
    const json = await request.json();
    const parsed = bodySchema.safeParse(json);
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid request" }, { status: 400 });
    }

    await confirmSignQrDestination(projectId, {
      regionKey: parsed.data.regionKey,
      destination: parsed.data.destination,
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
    const message = error instanceof Error ? error.message : "Failed to save that destination";
    console.error("Failed to confirm sign QR destination (customer)", error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
