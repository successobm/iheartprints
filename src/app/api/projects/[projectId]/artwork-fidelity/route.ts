import { NextResponse } from "next/server";
import { z } from "zod";

import { ArtworkFidelityContractStateError } from "@/capabilities/artwork-fidelity";
import { PROTECTED_MARK_TYPES } from "@/lib/domain/types";
import { getPersistenceMode } from "@/lib/db";
import {
  ArtworkFidelityServiceError,
  confirmArtworkFidelity,
  proposeArtworkFidelity,
} from "@/lib/services/artwork-fidelity-service";

type RouteContext = {
  params: Promise<{ projectId: string }>;
};

/**
 * Universal Raster Reconstruction Phase R4A: the two explicit customer
 * actions in the shared fidelity confirmation step, behind one
 * project-scoped endpoint — mirrors `artwork-preparation/route.ts`'s own
 * action-discriminator shape exactly.
 *
 *   "propose" — "check my artwork for text and symbols". Idempotent against
 *               the current immutable source (a repeat call for unchanged
 *               bytes is a no-op, never a second paid provider call).
 *               NEVER creates confirmed authority — see
 *               `proposeArtworkFidelity`'s own doc comment.
 *   "confirm" — "Confirm Artwork Details". The ONLY action that can create
 *               immutable confirmed authority, and only for an explicit,
 *               customer-submitted set of facts. `confirmedBy` is always
 *               "customer" here — an operator confirmation (if ever
 *               needed) would be a separate, internal-only surface, never
 *               this customer-facing route.
 *
 * Neither action carries a contract id: a project has at most one CURRENT
 * fidelity contract (`ArtworkFidelityCapability.getContract`'s "latest by
 * createdAt" resolution), so there is nothing to name and therefore nothing
 * to forge.
 */
const bodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("propose") }),
  z.object({
    action: z.literal("confirm"),
    confirmedWording: z.array(z.string().min(1).max(500)).max(50),
    confirmedMarks: z.array(z.enum(PROTECTED_MARK_TYPES)).max(PROTECTED_MARK_TYPES.length),
  }),
]);

type FidelityAction = z.infer<typeof bodySchema>;

function runFidelityAction(projectId: string, action: FidelityAction) {
  switch (action.action) {
    case "propose":
      return proposeArtworkFidelity(projectId);
    case "confirm":
      return confirmArtworkFidelity(projectId, {
        confirmedWording: action.confirmedWording,
        confirmedMarks: action.confirmedMarks,
        confirmedBy: "customer",
      });
  }
}

export async function POST(request: Request, context: RouteContext) {
  try {
    const { projectId } = await context.params;
    const json = await request.json();
    const parsed = bodySchema.safeParse(json);

    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid request" }, { status: 400 });
    }

    const snapshot = await runFidelityAction(projectId, parsed.data);

    return NextResponse.json({
      ...snapshot,
      persistenceMode: getPersistenceMode(),
    });
  } catch (error) {
    if (error instanceof ArtworkFidelityContractStateError) {
      const status = error.message.includes("not found") ? 404 : 409;
      return NextResponse.json({ error: error.message }, { status });
    }
    if (error instanceof ArtworkFidelityServiceError) {
      const status = error.message === "Project not found" ? 404 : 400;
      return NextResponse.json({ error: error.message }, { status });
    }
    const message =
      error instanceof Error ? error.message : "We couldn't check your artwork right now.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
