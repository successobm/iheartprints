import { NextResponse } from "next/server";

import { GARMENT_SIZE_CLASSES, readGarmentSizeClass } from "@/lib/domain/types";
import { getPersistenceMode } from "@/lib/db";
import {
  confirmRecommendedProductionSize,
  setGarmentSizeClass,
} from "@/lib/services/conversation-service";

type RouteContext = {
  params: Promise<{ projectId: string }>;
};

/**
 * Print'em All Phase 1: EXPLICIT CONFIRMATION of the physical production
 * size, and the garment sizing context the recommendation is derived from.
 *
 * Why this is its own route rather than a flag on `POST /print-size`: the two
 * make different claims. `/print-size` records a width somebody is
 * considering; this records that a human approved one, which is the fact a
 * paid provider call is later authorized against. Keeping them apart means no
 * caller can produce a confirmation by accident, and the audit question
 * ("what confirmed this project's size?") has exactly one answer.
 *
 * The route never computes inches. The recommended box comes from
 * `recommendProductionBox` inside the capability, so a client cannot confirm
 * a size the product does not actually recommend — it can only say "yes" to
 * the one the server offered, or state an explicit width through
 * `/print-size`, which is bounded by the placement's technical limit.
 */
export async function POST(request: Request, context: RouteContext) {
  try {
    const { projectId } = await context.params;
    const body = (await request.json().catch(() => ({}))) as {
      garmentSizeClass?: unknown;
      useRecommended?: unknown;
    };

    // A garment size class, when present, is applied FIRST: it decides which
    // box is recommended, and confirming against the old class's box would
    // record consent for a size the operator was not looking at.
    if (body.garmentSizeClass !== undefined) {
      if (body.garmentSizeClass !== null) {
        if (
          typeof body.garmentSizeClass !== "string" ||
          readGarmentSizeClass(body.garmentSizeClass) === null
        ) {
          return NextResponse.json(
            {
              error: `Garment size must be one of: ${GARMENT_SIZE_CLASSES.join(", ")}`,
            },
            { status: 400 },
          );
        }
      }
      const snapshot = await setGarmentSizeClass(
        projectId,
        body.garmentSizeClass === null
          ? null
          : readGarmentSizeClass(body.garmentSizeClass as string),
      );
      if (body.useRecommended !== true) {
        return NextResponse.json({
          ...snapshot,
          persistenceMode: getPersistenceMode(),
        });
      }
    }

    if (body.useRecommended !== true) {
      return NextResponse.json(
        { error: "Nothing to confirm" },
        { status: 400 },
      );
    }

    const snapshot = await confirmRecommendedProductionSize(projectId);

    return NextResponse.json({
      ...snapshot,
      persistenceMode: getPersistenceMode(),
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Failed to confirm the print size";
    const status = message.includes("not found") ? 404 : 409;
    console.error("Failed to confirm production print size", error);
    return NextResponse.json({ error: message }, { status });
  }
}
