import { NextResponse } from "next/server";
import { z } from "zod";

import { ArtworkPreparationStateError } from "@/capabilities/artwork-preparation";
import { getPersistenceMode } from "@/lib/db";
import { PRINT_PLACEMENT_LABELS } from "@/lib/domain/print-placement";
import type { PrintPlacement } from "@/lib/domain/types";
import {
  approvePreparedArtwork,
  prepareUploadedArtwork,
  setUploadedArtworkContext,
} from "@/lib/services/artwork-preparation-service";

type RouteContext = {
  params: Promise<{ projectId: string }>;
};

const PLACEMENTS = Object.keys(PRINT_PLACEMENT_LABELS) as [
  PrintPlacement,
  ...PrintPlacement[],
];

/**
 * The three explicit customer actions in the uploaded-artwork flow, behind
 * one project-scoped endpoint:
 *
 *   "context" — record what we're printing, its colour, and where the print
 *               goes. Production context only; never a creative brief edit.
 *   "prepare" — run deterministic background isolation, producing a NEW
 *               transparent PNG. Local pixel math only, no provider.
 *   "approve" — "this prepared version faithfully represents the artwork I
 *               uploaded". Explicitly NOT a claim that production ran, that
 *               enhancement happened, or that print validation passed.
 *
 * Every one is idempotent server-side, so a double click is always safe.
 */
const bodySchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("context"),
    productSummary: z.string().max(200).nullable().optional(),
    productColor: z.string().max(80).nullable().optional(),
    printPlacement: z.enum(PLACEMENTS).nullable().optional(),
  }),
  z.object({ action: z.literal("prepare") }),
  z.object({ action: z.literal("approve") }),
]);

export async function POST(request: Request, context: RouteContext) {
  try {
    const { projectId } = await context.params;
    const json = await request.json();
    const parsed = bodySchema.safeParse(json);

    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid request" }, { status: 400 });
    }

    const snapshot =
      parsed.data.action === "context"
        ? await setUploadedArtworkContext(projectId, {
            productSummary: parsed.data.productSummary,
            productColor: parsed.data.productColor,
            printPlacement: parsed.data.printPlacement,
          })
        : parsed.data.action === "prepare"
          ? await prepareUploadedArtwork(projectId)
          : await approvePreparedArtwork(projectId);

    return NextResponse.json({
      ...snapshot,
      persistenceMode: getPersistenceMode(),
    });
  } catch (error) {
    if (error instanceof ArtworkPreparationStateError) {
      const status = error.message.includes("not found") ? 404 : 409;
      return NextResponse.json({ error: error.message }, { status });
    }

    const message =
      error instanceof Error ? error.message : "Failed to prepare your artwork";
    console.error("Failed to run an artwork preparation action", error);
    return NextResponse.json(
      { error: message },
      { status: message.includes("not found") ? 404 : 500 },
    );
  }
}
