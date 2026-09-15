import { NextResponse } from "next/server";

import { getReconstructionCandidateImageUrl } from "@/lib/services/artwork-reconstruction-service";

type RouteContext = {
  params: Promise<{ projectId: string }>;
};

/**
 * Mints a short-lived signed URL for the current reconstruction candidate
 * image — mirrors `artwork-preparation/image/[role]/route.ts`'s own
 * asset-id-hiding shape. The original source image reuses the EXISTING
 * `artwork-preparation/image/original` route (the same immutable original
 * both surfaces already key off of) — this route exists only for the
 * candidate, which that route has no concept of.
 */
export async function GET(_request: Request, context: RouteContext) {
  try {
    const { projectId } = await context.params;
    const image = await getReconstructionCandidateImageUrl(projectId);
    if (!image) {
      return NextResponse.json({ error: "Image not found" }, { status: 404 });
    }
    return NextResponse.json(image, {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    console.error("Failed to mint reconstruction candidate image URL", error);
    return NextResponse.json({ error: "Image not found" }, { status: 404 });
  }
}
