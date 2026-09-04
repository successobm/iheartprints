import { NextResponse } from "next/server";

import { getProjectRepository } from "@/lib/db";
import { readAcquisitionSessionTokenFromRequest } from "@/lib/http/acquisition-session-cookie";
import { previewSignSafeAreaFit } from "@/lib/services/sign-artwork-service";

type RouteContext = {
  params: Promise<{ projectId: string }>;
};

/**
 * Signs Flat-Raster Production Workflow Correction: fast, in-memory,
 * NEVER-persisted preview of "Fit artwork to safe area" — the
 * whole-composition counterpart to `correction-preview`.
 * `previewSignSafeAreaFit`'s own doc has the full contract, including why
 * this is a clearly-scoped approximation (re-fits the current candidate
 * itself, not the true source). Zero writes, zero Topaz calls. Same
 * internal-session gate as every other internal sign-artwork route. No
 * request body — operates on the project's own current candidate.
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

    const result = await previewSignSafeAreaFit(projectId);
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to preview the safe-area fit";
    console.error("Failed to preview sign safe-area fit", error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
