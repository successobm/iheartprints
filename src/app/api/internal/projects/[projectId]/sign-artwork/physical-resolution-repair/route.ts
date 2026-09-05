import { NextResponse } from "next/server";

import { getProjectRepository } from "@/lib/db";
import { readAcquisitionSessionTokenFromRequest } from "@/lib/http/acquisition-session-cookie";
import { repairSignPhysicalResolutionMetadata } from "@/lib/services/sign-qr-preservation-service";

type RouteContext = {
  params: Promise<{ projectId: string }>;
};

/**
 * Fix Existing Final Sign Candidate Physical-Resolution Metadata Repair
 * Phase: "Fix print size metadata" — the governed, metadata-ONLY repair
 * for a current candidate whose embedded physical-resolution density is
 * missing or disagrees with the ordered production size (real Get Hibachi
 * production incident). Never alters a single artwork pixel — see
 * `repairSignPhysicalResolutionMetadata`'s own doc for the full pixel-
 * identity proof this performs before persisting anything. Idempotent: a
 * candidate whose metadata already agrees produces no new asset.
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

    const result = await repairSignPhysicalResolutionMetadata(projectId);
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to correct this artwork's print-size metadata";
    console.error("Failed to repair sign physical-resolution metadata", error);
    return NextResponse.json(
      { error: message },
      { status: message.includes("not found") || message.includes("No sign artwork") ? 404 : 409 },
    );
  }
}
