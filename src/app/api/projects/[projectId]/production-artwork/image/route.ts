import { NextResponse } from "next/server";

import { getProductionArtworkUrl } from "@/lib/services/conversation-service";

type RouteContext = {
  params: Promise<{ projectId: string }>;
};

/**
 * Secure read boundary for print-ready production artwork preview.
 * Mints a short-lived signed URL plus customer-safe metadata through
 * `conversation-service` — never a raw storage key, object path, asset id,
 * job id, or provider detail. Every failure path returns the same generic
 * 404. Never cached.
 */
export async function GET(_request: Request, context: RouteContext) {
  try {
    const { projectId } = await context.params;
    const image = await getProductionArtworkUrl(projectId);

    if (!image) {
      return NextResponse.json({ error: "Image not found" }, { status: 404 });
    }

    return NextResponse.json(image, {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    console.error("Failed to mint production artwork URL", error);
    return NextResponse.json({ error: "Image not found" }, { status: 404 });
  }
}
