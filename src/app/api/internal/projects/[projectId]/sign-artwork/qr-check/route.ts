import { NextResponse } from "next/server";

import { getProjectRepository } from "@/lib/db";
import { readAcquisitionSessionTokenFromRequest } from "@/lib/http/acquisition-session-cookie";
import { checkSignQrPreservation } from "@/lib/services/sign-qr-preservation-service";

type RouteContext = {
  params: Promise<{ projectId: string }>;
};

/**
 * SIGNS QR / MACHINE-READABLE CONTENT PRESERVATION: "Check QR code" —
 * read-only to the artwork. Decodes the immutable source and the current
 * production candidate, compares, and persists the result as a NEW
 * `ProductionAssetValidation` for the SAME (unmodified) asset — mirrors
 * the SAME "explicit operator re-check, not automatic" pattern as
 * `SignCheckArtworkButton`'s own `.../sign-artwork/plan` route. Never
 * creates a candidate, never touches a pixel, never calls a provider.
 *
 * Same internal-session gate as every other internal sign-artwork route:
 * the REQUESTER'S OWN session must be verified internal right now.
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

    const result = await checkSignQrPreservation(projectId);
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to check the QR code for this artwork";
    console.error("Failed to check sign QR preservation", error);
    return NextResponse.json(
      { error: message },
      { status: message.includes("not found") || message.includes("No sign artwork") ? 404 : 409 },
    );
  }
}
