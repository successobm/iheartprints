import { NextResponse } from "next/server";

import { getProductionArtworkUrl } from "@/lib/services/conversation-service";

type RouteContext = {
  params: Promise<{ projectId: string }>;
};

/**
 * Sprint 2M Phase 2C (Goal 14): the secure read boundary for a future
 * production-artwork download feature. Not linked from any UI yet — this
 * exists to prove the boundary is real before a purchasing/download product
 * is built on top of it.
 *
 * Mints a short-lived signed URL for the project's current print-ready
 * production PNG through `AssetCapability` — never a raw storage key,
 * object path, or asset id. Every failure path (missing project, not
 * print-ready yet, no production asset resolvable) returns the same
 * generic 404 so this can't be used to probe internal state. Never cached.
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
