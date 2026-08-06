import { NextResponse } from "next/server";

import { getConceptImageUrl } from "@/lib/services/conversation-service";

type RouteContext = {
  params: Promise<{ projectId: string; artworkVersionId: string }>;
};

/**
 * Sprint 2K Phase 1: mints a short-lived signed URL for a concept's
 * generated image through `AssetCapability` — never a raw storage key,
 * object path, provider name, or asset id. The browser already has
 * `artworkVersionId` (it's on the customer-safe snapshot); that's the only
 * identifier this endpoint needs.
 *
 * Every failure path (missing project, missing concept, no generated image
 * yet) returns the same generic 404 so this can't be used to enumerate
 * internal state. Never cached — a fresh call always mints a fresh URL,
 * which is how signed URLs "renew transparently" on refresh without ever
 * being persisted anywhere.
 */
export async function GET(_request: Request, context: RouteContext) {
  try {
    const { projectId, artworkVersionId } = await context.params;
    const image = await getConceptImageUrl(projectId, artworkVersionId);

    if (!image) {
      return NextResponse.json({ error: "Image not found" }, { status: 404 });
    }

    return NextResponse.json(image, {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    console.error("Failed to mint concept image URL", error);
    return NextResponse.json({ error: "Image not found" }, { status: 404 });
  }
}
