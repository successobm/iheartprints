import { NextResponse } from "next/server";

import { SignPreparationStateError } from "@/capabilities/sign-preparation";
import { getPersistenceMode } from "@/lib/db";
import {
  planSignArtwork,
  SignArtworkBridgeError,
} from "@/lib/services/sign-artwork-service";

type RouteContext = {
  params: Promise<{ projectId: string }>;
};

/**
 * LIVE PRODUCT BLOCKER #3: "Check my artwork" — the customer's explicit
 * request to run the existing Signs inspection/diagnosis/planning
 * capability and see a customer-safe translation of what it found.
 *
 * No request body: nothing to choose here, same reasoning as every other
 * no-body action route in this flow — the project has exactly one
 * `SignPreparation`, so there is nothing to name and therefore nothing to
 * forge. Deterministic and provider-free — `SignPreparationCapability` has
 * no provider port of any kind, so this route can never dispatch Topaz or
 * OpenAI.
 */
export async function POST(_request: Request, context: RouteContext) {
  try {
    const { projectId } = await context.params;
    const snapshot = await planSignArtwork(projectId);

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
      error instanceof Error ? error.message : "Failed to check your artwork";
    console.error("Failed to plan sign repair", error);
    return NextResponse.json(
      { error: message },
      { status: message.includes("not found") ? 404 : 500 },
    );
  }
}
