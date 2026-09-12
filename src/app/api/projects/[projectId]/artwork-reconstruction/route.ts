import { NextResponse } from "next/server";
import { z } from "zod";

import { getPersistenceMode } from "@/lib/db";
import {
  ArtworkReconstructionAuthorityError,
  ArtworkReconstructionStateError,
  ArtworkReconstructionServiceError,
  approveArtworkReconstruction,
  rejectArtworkReconstruction,
  requestArtworkReconstruction,
} from "@/lib/services/artwork-reconstruction-service";

type RouteContext = {
  params: Promise<{ projectId: string }>;
};

/**
 * Phase R5 (Confirmed-Authority Raster Reconstruction v1): the three
 * explicit customer actions behind one project-scoped endpoint — mirrors
 * `artwork-fidelity/route.ts`'s own action-discriminator shape exactly.
 *
 *   "request" — "Rebuild my artwork." Requires a CONFIRMED fidelity
 *               contract for the current source (Section G: resolution
 *               insufficiency ALONE is never sufficient — this is an
 *               explicit customer action, never auto-triggered). Idempotent
 *               against an already-in-flight/completed job for the same
 *               (source, confirmed-contract) binding.
 *   "approve"  — the customer's explicit post-reconstruction approval.
 *               Requires a completed candidate still `"pending_review"`.
 *   "reject"   — the customer's explicit rejection. Never automatically
 *               enqueues a retry.
 *
 * `jobId` is required for "approve"/"reject" (a project may have more than
 * one historical reconstruction job) but never for "request" (source-bound,
 * resolved server-side).
 */
const bodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("request") }),
  z.object({ action: z.literal("approve"), jobId: z.string().min(1).max(200) }),
  z.object({ action: z.literal("reject"), jobId: z.string().min(1).max(200) }),
]);

type ReconstructionAction = z.infer<typeof bodySchema>;

function runReconstructionAction(projectId: string, action: ReconstructionAction) {
  switch (action.action) {
    case "request":
      return requestArtworkReconstruction(projectId);
    case "approve":
      return approveArtworkReconstruction(projectId, action.jobId);
    case "reject":
      return rejectArtworkReconstruction(projectId, action.jobId);
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

    const snapshot = await runReconstructionAction(projectId, parsed.data);

    return NextResponse.json({
      ...snapshot,
      persistenceMode: getPersistenceMode(),
    });
  } catch (error) {
    if (
      error instanceof ArtworkReconstructionAuthorityError ||
      error instanceof ArtworkReconstructionStateError
    ) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof ArtworkReconstructionServiceError) {
      const status = error.message === "Project not found" ? 404 : 400;
      return NextResponse.json({ error: error.message }, { status });
    }
    // Never forward a raw error's message/stack from an unexpected failure
    // (e.g. a provider error surfacing past the worker) — could name an
    // internal path, provider detail, or id.
    console.error("[artwork-reconstruction] route failed", error);
    return NextResponse.json(
      { error: "We couldn't rebuild your artwork right now." },
      { status: 500 },
    );
  }
}
