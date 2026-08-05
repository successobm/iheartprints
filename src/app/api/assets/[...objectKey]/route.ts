import { promises as fs } from "fs";
import { NextResponse } from "next/server";

import {
  contentTypeForObjectKey,
  resolveAssetPath,
  verifyAssetToken,
} from "@/capabilities/asset-storage";

type RouteContext = {
  params: Promise<{ objectKey: string[] }>;
};

/**
 * Sprint 2H Part 2A: serves signed-URL requests for the local filesystem
 * storage backend (`FilesystemAssetStorageProvider`) — the local/dev/test
 * mirror of what a real Supabase Storage signed URL provides directly.
 * Never lists a bucket, never serves without a valid, unexpired token, and
 * never trusts the requested path without `resolveAssetPath`'s traversal
 * guard.
 */
export async function GET(request: Request, context: RouteContext) {
  const { objectKey: segments } = await context.params;
  const objectKey = segments.join("/");

  const url = new URL(request.url);
  const expires = Number(url.searchParams.get("expires"));
  const token = url.searchParams.get("token") ?? "";

  if (!verifyAssetToken(objectKey, expires, token)) {
    return NextResponse.json(
      { error: "Invalid or expired asset link" },
      { status: 403 },
    );
  }

  let filePath: string;
  try {
    filePath = resolveAssetPath(objectKey);
  } catch {
    return NextResponse.json({ error: "Invalid asset reference" }, { status: 400 });
  }

  let bytes: Buffer;
  try {
    bytes = await fs.readFile(filePath);
  } catch {
    return NextResponse.json({ error: "Asset not found" }, { status: 404 });
  }

  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      "content-type": contentTypeForObjectKey(objectKey),
      // Private — this is a signed, expiring, per-asset URL, not a public one.
      "cache-control": "private, max-age=60",
    },
  });
}
