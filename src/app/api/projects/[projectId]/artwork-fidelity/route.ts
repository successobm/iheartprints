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
import { ArtworkFidelityConfirmationValidationError } from "@/lib/services/artwork-fidelity-confirmation";

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
 *               customer-submitted, per-region RESOLUTION of every region
 *               the STORED proposal actually has. `confirmedBy` is always
 *               "customer" here — an operator confirmation (if ever
 *               needed) would be a separate, internal-only surface, never
 *               this customer-facing route.
 *
 * Neither action carries a contract id: a project has at most one CURRENT
 * fidelity contract (`ArtworkFidelityCapability.getContract`'s "latest by
 * createdAt" resolution), so there is nothing to name and therefore nothing
 * to forge.
 *
 * Phase R4A-R (independent-review repair, Blocker 2): "confirm" no longer
 * accepts flat `confirmedWording`/`confirmedMarks` arrays the server simply
 * trusted. It accepts per-region RESOLUTIONS keyed by the stable proposal
 * item ids the STORED proposal itself assigned (`wordingResolutions`/
 * `markResolutions`) — this schema only bounds the WIRE SHAPE (well-formed
 * strings/enums, bounded array sizes); `confirmArtworkFidelity` (via
 * `validateAndDeriveConfirmation`) is what proves every proposed region was
 * actually, unambiguously resolved, server-side, against the real stored
 * proposal — never inferred from this schema alone. `mark` deliberately
 * excludes "NOT_SURE" from its enum entirely: that token can never pass
 * this schema, so it can never even reach the validation function, let
 * alone become confirmed authority.
 */
const wordingResolutionSchema = z.object({
  id: z.string().min(1).max(100),
  text: z.string().max(500).optional(),
  excluded: z.boolean().optional(),
});

const markResolutionSchema = z.object({
  id: z.string().min(1).max(100),
  mark: z.enum([...PROTECTED_MARK_TYPES, "NONE"] as const),
});

const bodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("propose") }),
  z.object({
    action: z.literal("confirm"),
    wordingResolutions: z.array(wordingResolutionSchema).max(50),
    markResolutions: z.array(markResolutionSchema).max(50),
  }),
]);

type FidelityAction = z.infer<typeof bodySchema>;

function runFidelityAction(projectId: string, action: FidelityAction) {
  switch (action.action) {
    case "propose":
      return proposeArtworkFidelity(projectId);
    case "confirm":
      return confirmArtworkFidelity(projectId, {
        wordingResolutions: action.wordingResolutions,
        markResolutions: action.markResolutions,
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
    if (error instanceof ArtworkFidelityConfirmationValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
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
