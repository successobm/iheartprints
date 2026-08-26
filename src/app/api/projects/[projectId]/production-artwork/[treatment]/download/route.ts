import { NextResponse } from "next/server";

import { getProductionArtworkDownloadForVariant } from "@/lib/services/conversation-service";
import { PRODUCTION_VARIANT_TREATMENTS } from "@/capabilities/shared/production-variant";

type RouteContext = {
  params: Promise<{ projectId: string; treatment: string }>;
};

/**
 * Print'em All Phase 3 (Goal 16 — DOWNLOAD IDENTITY): the treatment-scoped
 * sibling of `/production-artwork/download`.
 *
 * `treatment` names exactly ONE of V1's two production variants
 * (`standard_raster` | `halftone_dtf`) — never "whatever is currently
 * selected". An unrecognized segment is a 400, not a fallback to the
 * unscoped deliverable; guessing which variant a malformed request meant
 * would reintroduce the exact ambiguity this route exists to remove.
 *
 * Same authorization posture as the unscoped route: no separate auth check
 * here — `getProductionArtworkDownloadForVariant` resolves through the same
 * capability the package view itself is built from, so a variant that does
 * not exist for this project (including every halftone request against a
 * project that has never used it — halftone selection is itself
 * internal-only) resolves to `null` and this returns a generic 404,
 * identical in shape to "this project has no production artwork at all".
 */
export async function GET(_request: Request, context: RouteContext) {
  try {
    const { projectId, treatment } = await context.params;

    if (!isProductionVariantTreatment(treatment)) {
      return NextResponse.json({ error: "Invalid variant" }, { status: 400 });
    }

    const download = await getProductionArtworkDownloadForVariant(projectId, treatment);
    if (!download) {
      return NextResponse.json({ error: "Image not found" }, { status: 404 });
    }

    const headers = new Headers({
      "content-type": download.contentType,
      "content-disposition": contentDispositionAttachment(download.filename),
      "cache-control": "no-store",
    });

    return new NextResponse(new Uint8Array(download.bytes), {
      status: 200,
      headers,
    });
  } catch (error) {
    console.error("Failed to download production artwork variant", error);
    return NextResponse.json({ error: "Image not found" }, { status: 404 });
  }
}

function isProductionVariantTreatment(
  value: string,
): value is (typeof PRODUCTION_VARIANT_TREATMENTS)[number] {
  return (PRODUCTION_VARIANT_TREATMENTS as readonly string[]).includes(value);
}

/** RFC 5987-friendly attachment header; filename is already sanitized. */
function contentDispositionAttachment(filename: string): string {
  const safe = filename.replace(/["\\\r\n]/g, "");
  const encoded = encodeURIComponent(safe);
  return `attachment; filename="${safe}"; filename*=UTF-8''${encoded}`;
}
