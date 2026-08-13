import { NextResponse } from "next/server";
import { z } from "zod";

import { ArtworkPreparationStateError } from "@/capabilities/artwork-preparation";
import { getPersistenceMode } from "@/lib/db";
import { PRINT_PLACEMENT_LABELS } from "@/lib/domain/print-placement";
import type { PrintPlacement } from "@/lib/domain/types";
import {
  approvePreparedArtwork,
  confirmGuidedCleanup,
  prepareUploadedArtwork,
  prepareUploadedArtworkForPrint,
  previewGuidedCleanup,
  setUploadedArtworkContext,
  undoGuidedCleanup,
} from "@/lib/services/artwork-preparation-service";
import { MAX_IMAGE_DIMENSION_PX } from "@/capabilities/artwork-preparation";
import {
  MAGIC_SELECT_DEFAULT_TOLERANCE,
  MAGIC_SELECT_TOLERANCE_MAX,
  MAGIC_SELECT_TOLERANCE_MIN,
} from "@/capabilities/artwork-preparation/magic-color-selection";

type RouteContext = {
  params: Promise<{ projectId: string }>;
};

const PLACEMENTS = Object.keys(PRINT_PLACEMENT_LABELS) as [
  PrintPlacement,
  ...PrintPlacement[],
];

/**
 * The four explicit customer actions in the uploaded-artwork flow, behind one
 * project-scoped endpoint:
 *
 *   "context"    — record what we're printing, its colour, and where the print
 *                  goes. Production context only; never a creative brief edit.
 *   "prepare"    — run deterministic background isolation, producing a NEW
 *                  transparent PNG. Local pixel math only, no provider.
 *   "approve"    — "this prepared version faithfully represents the artwork I
 *                  uploaded". Explicitly NOT a claim that production ran, that
 *                  enhancement happened, or that print validation passed.
 *   "print_ready"— (Phase 2) produce the final print-ready file from that
 *                  approved prepared artwork. The ONE action that may spend a
 *                  paid reconstruction call, and only when the artwork
 *                  genuinely lacks the pixels for the chosen size.
 *   "cleanup_preview" — (Phase 1.3) identify what a click would remove. Carries
 *                  a COORDINATE. Never mutates; returns a candidate token and
 *                  exact-region highlight when eligible.
 *   "cleanup_confirm" — (Phase 1.3) redeem a preview token and apply the Phase
 *                  1.2 guided-removal persistence path. Revalidates server-side.
 *   "undo_cleanup"— take back the most recent cleanup.
 *
 * Every one is idempotent server-side, so a double click is always safe. None
 * carries an artwork/asset/job id: a project has exactly one preparation, so
 * there is nothing to name and therefore nothing to forge (Goal 18).
 *
 * WHY A COORDINATE IS SAFE TO ACCEPT. It is not an identifier and it grants
 * nothing. The server resolves it against the customer's own image and may
 * only ever PREVIEW a region the automatic pass already classified as enclosed
 * background and then declined on ambiguous geometry (`guided-removal.ts`).
 * Removal requires a second, explicit confirm that revalidates a signed
 * candidate. A forged, random, or out-of-range coordinate therefore resolves
 * to "that's artwork" or "that's off the canvas" and changes nothing.
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
  z.object({ action: z.literal("print_ready") }),
  z.object({
    action: z.literal("cleanup_preview"),
    x: z.number().int().min(0).max(MAX_IMAGE_DIMENSION_PX),
    y: z.number().int().min(0).max(MAX_IMAGE_DIMENSION_PX),
    tool: z.enum(["region", "magic_select"]).optional(),
    tolerance: z
      .number()
      .int()
      .min(MAGIC_SELECT_TOLERANCE_MIN)
      .max(MAGIC_SELECT_TOLERANCE_MAX)
      .optional(),
  }),
  z.object({
    action: z.literal("cleanup_confirm"),
    candidateToken: z.string().min(1).max(4000),
  }),
  z.object({ action: z.literal("undo_cleanup") }),
]);

type PreparationAction = z.infer<typeof bodySchema>;

function runPreparationAction(projectId: string, action: PreparationAction) {
  switch (action.action) {
    case "context":
      return setUploadedArtworkContext(projectId, {
        productSummary: action.productSummary,
        productColor: action.productColor,
        printPlacement: action.printPlacement,
      });
    case "prepare":
      return prepareUploadedArtwork(projectId);
    case "approve":
      return approvePreparedArtwork(projectId);
    case "print_ready":
      return prepareUploadedArtworkForPrint(projectId);
    case "cleanup_preview":
      return previewGuidedCleanup(projectId, {
        point: { x: action.x, y: action.y },
        tool: action.tool ?? "region",
        tolerance: action.tolerance ?? MAGIC_SELECT_DEFAULT_TOLERANCE,
      });
    case "cleanup_confirm":
      return confirmGuidedCleanup(projectId, action.candidateToken);
    case "undo_cleanup":
      return undoGuidedCleanup(projectId);
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

    const snapshot = await runPreparationAction(projectId, parsed.data);

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
