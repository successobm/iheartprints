import { NextResponse } from "next/server";

import { getProjectRepository } from "@/lib/db";
import { readAcquisitionSessionTokenFromRequest } from "@/lib/http/acquisition-session-cookie";
import { getSignBlockedProductionCandidateDownload } from "@/lib/services/sign-artwork-service";

type RouteContext = {
  params: Promise<{ projectId: string }>;
};

/**
 * Blocked Production Candidate Inspection Phase (real Signs acceptance
 * incident: a corrected regeneration produced a final asset that a real
 * OpenAI semantic dispatch then correctly rejected, leaving a completed
 * job with no certified deliverable but a genuine candidate operator
 * staff need to visually inspect): the ONLY route that can ever serve a
 * NOT-print-ready sign production asset — deliberately separate from,
 * and never weakening, `GET .../sign-artwork/download` (which remains
 * READY-validation-only, completely unchanged by this route's existence).
 *
 * This is NOT customer delivery. There is no customer-facing counterpart,
 * and none is ever planned — Constitution §16A.1, mirroring
 * `download/route.ts`'s own identical note. Internal-only, gated
 * identically to every other internal sign-artwork route: the
 * REQUESTER'S OWN session must be verified internal right now
 * (`entitlement === "internal"`), never `isInternalProject(projectId)`.
 *
 * Every precondition (a current-plan job exists and is completed, its
 * latest validation exists and is NOT `"ready"`, the validation's own
 * `assetId` resolves to a real, correctly-lineaged, non-intermediate
 * `production_png` asset) lives in
 * `FinalArtworkCapability.resolveBlockedSignProductionCandidate`, which
 * fails closed (`null`) rather than throwing — this route never
 * distinguishes WHY a miss occurred (Goal 15: no internal reason ever
 * reaches whoever is asking whether a file exists), matching every
 * sibling download route's own discipline. Read-only end to end: no
 * project, job, or validation row is ever created, mutated, or deleted by
 * viewing or downloading this candidate.
 */
export async function GET(request: Request, context: RouteContext) {
  try {
    const { projectId } = await context.params;
    const repo = getProjectRepository();

    const token = readAcquisitionSessionTokenFromRequest(request);
    const session = token
      ? await repo.getAcquisitionSessionByToken(token).catch(() => null)
      : null;
    if (!session || session.entitlement !== "internal") {
      return NextResponse.json(
        { error: "This action requires an internal production session." },
        { status: 403 },
      );
    }

    const download = await getSignBlockedProductionCandidateDownload(projectId);
    if (!download) {
      return NextResponse.json({ error: "Image not found" }, { status: 404 });
    }

    // Safe internal audit line — ids and status only, never bytes, signed
    // URLs, or storage credentials.
    console.info("[sign-artwork] blocked production candidate inspected", {
      projectId,
      jobId: download.jobId,
      validationId: download.validationId,
      assetId: download.assetId,
      action: "blocked_candidate_inspection",
    });

    const headers = new Headers({
      "content-type": download.contentType,
      "content-disposition": contentDispositionAttachment(download.filename),
      // Never cache a blocked, potentially-superseded candidate.
      "cache-control": "no-store",
      // Explicit, machine-readable signal that this is not certified
      // production artwork — never omitted, never overridable.
      "x-iheartprints-production-status": "blocked_requires_review",
    });

    return new NextResponse(new Uint8Array(download.bytes), { status: 200, headers });
  } catch (error) {
    console.error("Failed to serve blocked sign production candidate (operator)", error);
    return NextResponse.json({ error: "Image not found" }, { status: 404 });
  }
}

/** RFC 5987-friendly attachment header; filename is already a fixed, non-secret literal. Mirrors the certified download route's own helper. */
function contentDispositionAttachment(filename: string): string {
  const safe = filename.replace(/["\\\r\n]/g, "");
  const encoded = encodeURIComponent(safe);
  return `attachment; filename="${safe}"; filename*=UTF-8''${encoded}`;
}
