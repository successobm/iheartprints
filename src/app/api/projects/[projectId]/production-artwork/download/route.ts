import { NextResponse } from "next/server";

import { getProductionArtworkDownload } from "@/lib/services/conversation-service";

type RouteContext = {
  params: Promise<{ projectId: string }>;
};

/**
 * Customer download for the project's current print-ready production PNG.
 * Same authorization as the preview route: only when
 * `PrintProject.status === "print_ready"` and a production asset resolves.
 * Streams bytes with a customer-safe Content-Disposition filename — never
 * a storage path, asset id, job id, or provider detail. Every miss is a
 * generic 404.
 */
export async function GET(_request: Request, context: RouteContext) {
  try {
    const { projectId } = await context.params;
    const download = await getProductionArtworkDownload(projectId);

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
    console.error("Failed to download production artwork", error);
    return NextResponse.json({ error: "Image not found" }, { status: 404 });
  }
}

/** RFC 5987-friendly attachment header; filename is already sanitized. */
function contentDispositionAttachment(filename: string): string {
  const safe = filename.replace(/["\\\r\n]/g, "");
  const encoded = encodeURIComponent(safe);
  return `attachment; filename="${safe}"; filename*=UTF-8''${encoded}`;
}
