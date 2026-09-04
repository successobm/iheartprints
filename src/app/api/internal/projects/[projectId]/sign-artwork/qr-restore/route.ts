import { NextResponse } from "next/server";

import { getProjectRepository } from "@/lib/db";
import { readAcquisitionSessionTokenFromRequest } from "@/lib/http/acquisition-session-cookie";
import { restoreSignQrCode } from "@/lib/services/sign-qr-preservation-service";

type RouteContext = {
  params: Promise<{ projectId: string }>;
};

/**
 * SIGNS QR / MACHINE-READABLE CONTENT PRESERVATION: "Restore QR code" —
 * the governed deterministic repair (Sections N/P/Q). Refuses outright
 * (through `restoreSignQrCode`'s own gate) unless a source QR was
 * positively decoded AND the current candidate provably lost or changed
 * it — never reachable for a source that could not itself be verified
 * (`review_required` — Section I's source-of-truth rule). Deterministic,
 * local, no provider call: regenerates the verified payload, composites
 * it into a NEW derived `ProductionAsset` under the SAME job (never
 * overwriting the prior candidate), re-decodes the ACTUAL persisted
 * result, and only then records success.
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

    const result = await restoreSignQrCode(projectId);
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to restore the QR code for this artwork";
    console.error("Failed to restore sign QR code", error);
    return NextResponse.json(
      { error: message },
      { status: message.includes("not found") || message.includes("No sign artwork") ? 404 : 409 },
    );
  }
}
