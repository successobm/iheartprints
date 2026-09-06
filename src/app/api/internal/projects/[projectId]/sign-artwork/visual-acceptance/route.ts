import { NextResponse } from "next/server";

import { getProjectRepository } from "@/lib/db";
import { readAcquisitionSessionTokenFromRequest } from "@/lib/http/acquisition-session-cookie";
import { acceptSignCandidateVisualArtwork } from "@/lib/services/sign-candidate-visual-acceptance-service";

type RouteContext = {
  params: Promise<{ projectId: string }>;
};

/**
 * Signs QR Visual Revision Acceptance: "Approve revised artwork" — records
 * a human's explicit visual acceptance of the exact CURRENT production
 * candidate. Takes no body: the candidate being approved is resolved
 * entirely server-side (`acceptSignCandidateVisualArtwork`), never from a
 * client-supplied asset id — mirrors `qr-check`/`qr-restore`'s identical
 * no-body-input shape.
 *
 * Same internal-session gate as every other internal sign-artwork route.
 */
export async function POST(request: Request, context: RouteContext) {
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

    const result = await acceptSignCandidateVisualArtwork(projectId);
    return NextResponse.json(result);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to approve the revised artwork for this project";
    console.error("Failed to record sign candidate visual acceptance", error);
    return NextResponse.json(
      { error: message },
      { status: message.includes("No sign production plan") ? 404 : 409 },
    );
  }
}
