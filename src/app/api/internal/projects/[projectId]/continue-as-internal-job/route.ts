import { NextResponse } from "next/server";

import { continueAsInternalJob } from "@/capabilities/artwork-preparation/continue-as-internal-job";
import { getCapabilityGraph } from "@/capabilities/composition";
import { getProjectRepository } from "@/lib/db";
import { readAcquisitionSessionTokenFromRequest } from "@/lib/http/acquisition-session-cookie";

type RouteContext = {
  params: Promise<{ projectId: string }>;
};

/**
 * Phase 28P — "Continue as Internal Job".
 *
 * Deliberately under `/api/internal/`, mirroring every other staff-only
 * surface in this codebase, and deliberately checking the REQUESTER'S OWN
 * session rather than `isInternalProject(projectId)`. Those are not the
 * same question: `isInternalProject` asks "was THIS project created under
 * an internal session", which is exactly the thing that must be FALSE for
 * an ordinary customer project — the whole scenario this route exists for.
 * What actually gates this action is "is the person calling it, right now,
 * on a verified internal session" — the same session shape and the same
 * `entitlement === "internal"` check `/internal/access`'s page already
 * performs, reused here rather than reinvented.
 *
 * A caller with no session, an unrecognized session, or an ordinary
 * `"prospect"`/`"engaged"` session gets a flat 403 before `projectId` is
 * ever looked at — knowing a real project id grants nothing on its own,
 * exactly as this phase's mission requires.
 */
export async function POST(request: Request, context: RouteContext) {
  try {
    const { projectId: sourceProjectId } = await context.params;
    const repo = getProjectRepository();

    const token = readAcquisitionSessionTokenFromRequest(request);
    const session = token ? await repo.getAcquisitionSessionByToken(token).catch(() => null) : null;
    if (!session || session.entitlement !== "internal") {
      return NextResponse.json(
        { error: "This action requires an internal production session." },
        { status: 403 },
      );
    }

    const graph = getCapabilityGraph();
    const result = await continueAsInternalJob(
      { repo, assets: graph.assets, acquisition: graph.acquisition },
      { sourceProjectId, actingSessionId: session.id },
    );

    switch (result.outcome) {
      case "created":
        return NextResponse.json({ newProjectId: result.newProjectId, created: true });
      case "already_continued":
        return NextResponse.json({ newProjectId: result.newProjectId, created: false });
      case "not_found":
        return NextResponse.json({ error: "Project not found." }, { status: 404 });
      case "ineligible":
        return NextResponse.json({ error: result.reason }, { status: 409 });
    }
  } catch (error) {
    console.error("Failed to continue artwork as an internal job", error);
    return NextResponse.json(
      { error: "Failed to continue this artwork as an internal job." },
      { status: 500 },
    );
  }
}
