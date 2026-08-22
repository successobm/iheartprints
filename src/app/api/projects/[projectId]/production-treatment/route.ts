import { NextResponse } from "next/server";

import { getPersistenceMode } from "@/lib/db";
import { PRODUCTION_TREATMENT_NOT_AVAILABLE_MESSAGE } from "@/capabilities/conversation";
import { selectProductionTreatment } from "@/lib/services/conversation-service";

type RouteContext = {
  params: Promise<{ projectId: string }>;
};

/**
 * Print'em All Phase 2: the operator's PRODUCTION TREATMENT choice.
 *
 * INTERNAL ONLY, ENFORCED SERVER-SIDE. This route does not check the
 * entitlement itself — `ConversationCapability.selectProductionTreatment`
 * does, on the write, from the project's own acquisition session. Putting the
 * gate at the capability rather than here is what makes it impossible to add
 * a second entry point that forgets it, and it is the reason the answer this
 * route gives and the answer the UI renders cannot disagree.
 *
 * A production-specification change only: nothing on this path generates
 * artwork, creates an `ArtworkVersion`, approves a brief version, spends a
 * provider credit, or touches the immutable prepared source. Changing the
 * treatment supersedes any queued finalization job for the old settings and
 * lets the next request enqueue one for the new ones — it never re-aims work
 * that is already running.
 *
 * Settings BOUNDS are decided inside the capability, so the supported LPI
 * band, angles, and dot shapes have exactly one definition; this route never
 * validates a screen setting itself.
 */
export async function POST(request: Request, context: RouteContext) {
  try {
    const { projectId } = await context.params;
    const body = (await request.json().catch(() => ({}))) as {
      treatment?: unknown;
      halftone?: unknown;
    };

    if (body.treatment !== "standard_raster" && body.treatment !== "halftone_dtf") {
      return NextResponse.json(
        { error: "A supported production treatment is required" },
        { status: 400 },
      );
    }

    const halftone =
      body.halftone && typeof body.halftone === "object" && !Array.isArray(body.halftone)
        ? (body.halftone as Record<string, unknown>)
        : undefined;

    const snapshot = await selectProductionTreatment(projectId, {
      treatment: body.treatment,
      // Passed through as an untyped request. `normalizeHalftoneSettings`
      // REFUSES anything outside the supported band rather than clamping it,
      // so an out-of-range value becomes an error the operator sees — never a
      // silently different plate than the one they asked for.
      halftone: halftone as never,
    });

    return NextResponse.json({
      ...snapshot,
      persistenceMode: getPersistenceMode(),
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Failed to set the production treatment";
    // A non-internal caller gets 404, not 403. "Forbidden" would confirm the
    // endpoint exists and that there is a tier they are not in; the response
    // an unauthorized caller sees is indistinguishable from a project that is
    // not there.
    const status =
      message === PRODUCTION_TREATMENT_NOT_AVAILABLE_MESSAGE || message.includes("not found")
        ? 404
        : 409;
    if (status !== 404) {
      console.error("Failed to set production treatment", error);
    }
    return NextResponse.json({ error: message }, { status });
  }
}
