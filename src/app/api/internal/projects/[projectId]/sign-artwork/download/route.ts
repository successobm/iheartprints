import { NextResponse } from "next/server";

import { getProjectRepository } from "@/lib/db";
import { readAcquisitionSessionTokenFromRequest } from "@/lib/http/acquisition-session-cookie";
import { getSignProductionArtworkDownload } from "@/lib/services/sign-artwork-service";

type RouteContext = {
  params: Promise<{ projectId: string }>;
};

/**
 * LIVE PRODUCT BLOCKER #4B: the operator download for THIS project's
 * current, AUTHORITATIVE print-ready sign production PNG — the actual
 * corrected file, not a preview. Same shape as the customer-facing
 * `GET /api/projects/[projectId]/production-artwork/download` (same
 * "resolve the one exact validated asset, then stream its real bytes"
 * pattern, same `Content-Disposition` header, same generic-404-on-any-miss
 * discipline), applied through the sign authority's own parallel resolver
 * rather than the apparel-shaped one.
 *
 * Internal-only, gated identically to every other internal sign-artwork
 * route: the REQUESTER'S OWN session must be verified internal right now.
 * Rigid signs have no customer-facing production surface in V1
 * (Constitution §16A.1) — there is deliberately no customer counterpart to
 * this route yet.
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

    const download = await getSignProductionArtworkDownload(projectId);
    if (!download) {
      return NextResponse.json({ error: "Image not found" }, { status: 404 });
    }

    const headers = new Headers({
      "content-type": download.contentType,
      "content-disposition": contentDispositionAttachment(download.filename),
      "cache-control": "no-store",
    });

    return new NextResponse(new Uint8Array(download.bytes), { status: 200, headers });
  } catch (error) {
    console.error("Failed to download sign production artwork (operator)", error);
    return NextResponse.json({ error: "Image not found" }, { status: 404 });
  }
}

/** RFC 5987-friendly attachment header; filename is already sanitized. Mirrors the customer download route's own helper. */
function contentDispositionAttachment(filename: string): string {
  const safe = filename.replace(/["\\\r\n]/g, "");
  const encoded = encodeURIComponent(safe);
  return `attachment; filename="${safe}"; filename*=UTF-8''${encoded}`;
}
