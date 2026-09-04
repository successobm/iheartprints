import { NextResponse } from "next/server";
import { z } from "zod";

import { getProjectRepository } from "@/lib/db";
import { readAcquisitionSessionTokenFromRequest } from "@/lib/http/acquisition-session-cookie";
import { acceptSignQrPrintAsSupplied, SignQrPreservationError } from "@/lib/services/sign-qr-preservation-service";

type RouteContext = {
  params: Promise<{ projectId: string }>;
};

const bodySchema = z.object({
  regionKey: z.string().min(1).max(64),
});

/**
 * SIGNS QR DESTINATION RESOLUTION: the internal operator's own way to
 * explicitly accept a detected-but-undecodable QR "as supplied" — no
 * functioning QR is required for this region. Mirrors the customer-facing
 * `.../sign-artwork/qr-print-as-supplied` route exactly, just under the
 * operator's own actor identity (`confirmedBy: "operator"`).
 */
export async function POST(request: Request, context: RouteContext) {
  try {
    const { projectId } = await context.params;
    const repo = getProjectRepository();

    const token = readAcquisitionSessionTokenFromRequest(request);
    const session = token
      ? await repo.getAcquisitionSessionByToken(token).catch(() => null)
      : null;
    if (!session || session.entitlement !== "internal") {
      return NextResponse.json(
        { error: "This action requires an internal production session." },
        { status: 403 },
      );
    }

    const json = await request.json();
    const parsed = bodySchema.safeParse(json);
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid request" }, { status: 400 });
    }

    const result = await acceptSignQrPrintAsSupplied(projectId, {
      regionKey: parsed.data.regionKey,
      confirmedBy: "operator",
    });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof SignQrPreservationError) {
      const status = error.message.includes("not found") || error.message.includes("No sign artwork") ? 404 : 409;
      return NextResponse.json({ error: error.message }, { status });
    }
    const message = error instanceof Error ? error.message : "Failed to accept the artwork as supplied";
    console.error("Failed to accept sign QR as supplied", error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
