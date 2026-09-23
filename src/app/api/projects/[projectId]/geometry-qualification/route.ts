import { NextResponse } from "next/server";
import { z } from "zod";

import { getPersistenceMode } from "@/lib/db";
import {
  ArtworkGeometryQualificationAuthorityError,
  ArtworkGeometryQualificationServiceError,
  ArtworkGeometryQualificationStateError,
  confirmGeometryQualification,
  rejectGeometryQualification,
} from "@/lib/services/artwork-geometry-qualification-service";

type RouteContext = {
  params: Promise<{ projectId: string }>;
};

/**
 * Phase R6A (Geometry-Qualified Clean Master v1): the two explicit customer
 * actions behind one project-scoped endpoint — mirrors
 * `artwork-reconstruction/route.ts`'s own action-discriminator shape
 * exactly.
 *
 *   "confirm" — "Looks good — continue." Server-authoritative: resolves
 *               the CURRENT qualification from project state, never a
 *               client-supplied qualification/asset id (Section 13 of the
 *               R6A implementation task).
 *   "reject"  — "Something is missing." Never mutates the derivative/
 *               candidate, never proceeds to Signs, never regenerates
 *               automatically.
 */
const bodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("confirm") }),
  z.object({ action: z.literal("reject") }),
]);

type GeometryQualificationAction = z.infer<typeof bodySchema>;

function runGeometryQualificationAction(
  projectId: string,
  action: GeometryQualificationAction,
) {
  switch (action.action) {
    case "confirm":
      return confirmGeometryQualification(projectId);
    case "reject":
      return rejectGeometryQualification(projectId);
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

    const snapshot = await runGeometryQualificationAction(projectId, parsed.data);

    return NextResponse.json({
      ...snapshot,
      persistenceMode: getPersistenceMode(),
    });
  } catch (error) {
    if (
      error instanceof ArtworkGeometryQualificationAuthorityError ||
      error instanceof ArtworkGeometryQualificationStateError
    ) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof ArtworkGeometryQualificationServiceError) {
      const status = error.message === "Project not found" ? 404 : 400;
      return NextResponse.json({ error: error.message }, { status });
    }
    // Never forward a raw error's message/stack from an unexpected failure
    // — could name an internal path or id.
    console.error("[geometry-qualification] route failed", error);
    return NextResponse.json(
      { error: "We couldn't save your decision right now." },
      { status: 500 },
    );
  }
}
