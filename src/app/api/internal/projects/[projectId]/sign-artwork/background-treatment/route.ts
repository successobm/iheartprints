import { NextResponse } from "next/server";
import { z } from "zod";

import { SIGN_BACKGROUND_TREATMENTS } from "@/lib/domain/types";
import { getProjectRepository } from "@/lib/db";
import { readAcquisitionSessionTokenFromRequest } from "@/lib/http/acquisition-session-cookie";
import { setSignArtworkBackgroundTreatment } from "@/lib/services/sign-artwork-service";
import { SignPreparationStateError } from "@/capabilities/sign-preparation";

type RouteContext = {
  params: Promise<{ projectId: string }>;
};

const bodySchema = z.object({
  treatment: z.enum(SIGN_BACKGROUND_TREATMENTS),
});

/**
 * Constitution amendment 3.2 (§16A.2): the internal operator's own way to
 * durably select KEEP or REMOVE background treatment for a sign's current
 * immutable original. Mirrors `plan/route.ts`'s own internal-session gate
 * exactly: this checks the REQUESTER'S OWN session is verified internal
 * right now, never `isInternalProject(projectId)` — knowing a real project
 * id grants nothing on its own.
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

    const json = await request.json().catch(() => null);
    const parsed = bodySchema.safeParse(json);
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid request" }, { status: 400 });
    }

    const review = await setSignArtworkBackgroundTreatment(projectId, parsed.data.treatment);
    return NextResponse.json(review);
  } catch (error) {
    if (error instanceof SignPreparationStateError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    const message = error instanceof Error ? error.message : "Failed to set the background treatment";
    console.error("Failed to set sign background treatment", error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
