import { NextResponse } from "next/server";

import { getGeometryQualificationDerivativeImageUrl } from "@/lib/services/artwork-geometry-qualification-service";

type RouteContext = {
  params: Promise<{ projectId: string }>;
};

/**
 * Mints a short-lived signed URL for the current geometry-normalized
 * derivative image — mirrors `artwork-reconstruction/image/route.ts`'s own
 * asset-id-hiding shape exactly.
 */
export async function GET(_request: Request, context: RouteContext) {
  try {
    const { projectId } = await context.params;
    const image = await getGeometryQualificationDerivativeImageUrl(projectId);
    if (!image) {
      return NextResponse.json({ error: "Image not found" }, { status: 404 });
    }
    return NextResponse.json(image, {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    console.error("Failed to mint geometry qualification derivative image URL", error);
    return NextResponse.json({ error: "Image not found" }, { status: 404 });
  }
}
