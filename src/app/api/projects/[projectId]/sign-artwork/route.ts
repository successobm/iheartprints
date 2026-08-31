import { NextResponse } from "next/server";
import { z } from "zod";

import { SignPreparationStateError } from "@/capabilities/sign-preparation";
import { getPersistenceMode } from "@/lib/db";
import {
  confirmSignArtworkSize,
  SignArtworkBridgeError,
} from "@/lib/services/sign-artwork-service";

type RouteContext = {
  params: Promise<{ projectId: string }>;
};

/**
 * LIVE PRODUCT BLOCKER #1: the ONE customer action in the Sign branch of the
 * Existing Artwork flow — "here is the ordered physical size". See
 * `sign-artwork-service.ts` for what this bridges into.
 *
 * Bounded the same way `MAX_SANE_ORDERED_IN` bounds it downstream
 * (`sign-preparation/sign-spec.ts`) — this schema only rejects garbage; the
 * capability itself is the authority on what a supported sign size is.
 */
const bodySchema = z.object({
  orderedWidthIn: z.number().finite().positive().max(1000),
  orderedHeightIn: z.number().finite().positive().max(1000),
});

export async function POST(request: Request, context: RouteContext) {
  try {
    const { projectId } = await context.params;
    const json = await request.json();
    const parsed = bodySchema.safeParse(json);
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid request" }, { status: 400 });
    }

    const snapshot = await confirmSignArtworkSize(projectId, parsed.data);

    return NextResponse.json({
      ...snapshot,
      persistenceMode: getPersistenceMode(),
    });
  } catch (error) {
    if (error instanceof SignArtworkBridgeError) {
      const status = error.message.includes("not found") ? 404 : 409;
      return NextResponse.json({ error: error.message }, { status });
    }
    if (error instanceof SignPreparationStateError) {
      const status = error.message.includes("not found") ? 404 : 409;
      return NextResponse.json({ error: error.message }, { status });
    }

    const message =
      error instanceof Error ? error.message : "Failed to save your sign details";
    console.error("Failed to confirm sign artwork size", error);
    return NextResponse.json(
      { error: message },
      { status: message.includes("not found") ? 404 : 500 },
    );
  }
}
