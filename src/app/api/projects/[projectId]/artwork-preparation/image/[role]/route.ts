import { NextResponse } from "next/server";

import { getPreparationImageUrl } from "@/lib/services/artwork-preparation-service";

type RouteContext = {
  params: Promise<{ projectId: string; role: string }>;
};

/**
 * Mints a short-lived signed URL for one of an uploaded artwork's two
 * renderable images. The browser names a ROLE — never an asset id, never a
 * storage key — exactly like the concept image route it mirrors.
 *
 * Every failure path (unknown project, no upload, not prepared yet, an asset
 * that does not belong to this project) returns the SAME generic 404, so this
 * cannot be used to enumerate internal state. Never cached: a fresh call
 * always mints a fresh URL, which is how signed URLs renew on refresh without
 * ever being persisted.
 */
export async function GET(_request: Request, context: RouteContext) {
  try {
    const { projectId, role } = await context.params;
    if (role !== "original" && role !== "prepared") {
      return NextResponse.json({ error: "Image not found" }, { status: 404 });
    }

    const image = await getPreparationImageUrl(projectId, role);
    if (!image) {
      return NextResponse.json({ error: "Image not found" }, { status: 404 });
    }

    return NextResponse.json(image, {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    console.error("Failed to mint uploaded artwork image URL", error);
    return NextResponse.json({ error: "Image not found" }, { status: 404 });
  }
}
