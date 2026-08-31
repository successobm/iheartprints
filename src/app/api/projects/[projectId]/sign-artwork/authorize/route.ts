import { NextResponse } from "next/server";

import { SignPreparationStateError } from "@/capabilities/sign-preparation";
import { getPersistenceMode } from "@/lib/db";
import {
  authorizeSignArtwork,
  SignArtworkBridgeError,
} from "@/lib/services/sign-artwork-service";

type RouteContext = {
  params: Promise<{ projectId: string }>;
};

/**
 * LIVE PRODUCT BLOCKER #4: the customer's own self-service production-risk
 * authorization. No request body — this route's own identity IS the
 * `"customer"` actor, server-stamped, the same no-id-to-forge reasoning as
 * every other action in this flow. `SignPreparationCapability
 * .authorizeSignRepairPlan` is the actual gate: a `review_required` plan
 * refuses a `"customer"` actor outright regardless of this route existing
 * — a customer's own click must never be sufficient production-risk
 * judgment for a decision the engine itself flagged for a human.
 */
export async function POST(_request: Request, context: RouteContext) {
  try {
    const { projectId } = await context.params;
    const snapshot = await authorizeSignArtwork(projectId, "customer");

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
      error instanceof Error ? error.message : "Failed to authorize this plan";
    console.error("Failed to authorize sign repair plan (customer)", error);
    return NextResponse.json(
      { error: message },
      { status: message.includes("not found") ? 404 : 500 },
    );
  }
}
