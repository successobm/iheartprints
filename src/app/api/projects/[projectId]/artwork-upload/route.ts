import { NextResponse } from "next/server";

import {
  ArtworkPreparationStateError,
  ArtworkUploadRejectedError,
  MAX_UPLOAD_BYTES,
} from "@/capabilities/artwork-preparation";
import { capRequestBodyBytes, isRequestBodyTooLargeError } from "@/capabilities/artwork-preparation/capped-request-body";
import { getPersistenceMode } from "@/lib/db";
import { uploadArtwork } from "@/lib/services/artwork-preparation-service";

const MAX_UPLOAD_MB = Math.round(MAX_UPLOAD_BYTES / (1024 * 1024));
const FILE_TOO_LARGE_MESSAGE = `This image is too large. Upload an image up to ${MAX_UPLOAD_MB} MB.`;

type RouteContext = {
  params: Promise<{ projectId: string }>;
};

/**
 * Existing Artwork → Print Ready Phase 1: project-scoped ingress for artwork
 * the customer already owns.
 *
 * SECURITY NOTES, since this is the first route in the codebase that accepts
 * customer-supplied binary content:
 *
 *   - Scope. The upload is bound to `projectId` from the path and nothing
 *     else. There is no way for a request to name a target project other
 *     than the one it addressed, and the capability re-verifies ownership of
 *     every row it touches. (This codebase has no user authentication layer
 *     at all — see ARCHITECTURE.md §23 — so "authenticated" here means
 *     project-scoped authorization, which is the strongest statement that is
 *     currently true.)
 *   - Bytes are authoritative. The declared `Content-Type` and the filename
 *     are both treated as untrusted claims: the real format comes from the
 *     magic signature, and the filename is sanitized for DISPLAY only and
 *     never used to build a storage path.
 *   - Size is bounded three ways, and authoritatively. `Content-Length` is
 *     rejected early when it already exceeds the limit (cheap, no body read
 *     at all for a well-behaved oversized request); the body stream itself
 *     is then capped WHILE it is read (`capRequestBodyBytes` — Large Raster
 *     Upload Limit Audit), so a missing, lying, or chunked-transfer-encoded
 *     request can no longer force an unbounded buffer the way it previously
 *     could (`ARCHITECTURE.md` §23 item 2, now closed); and the resulting
 *     `File`'s own `.size` is re-checked as a final, cheap belt-and-braces
 *     assertion.
 *   - Decode limits are enforced against the PNG header before any bitmap is
 *     allocated (`image-decode.ts`), which is what makes a decompression
 *     bomb a 400 rather than an out-of-memory kill.
 *
 * Never calls a provider, never enqueues a job, never mutates artwork.
 */
export async function POST(request: Request, context: RouteContext) {
  try {
    const { projectId } = await context.params;

    const declaredLength = Number(request.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_UPLOAD_BYTES) {
      return NextResponse.json({ error: FILE_TOO_LARGE_MESSAGE }, { status: 413 });
    }

    // Large Raster Upload Limit Audit: the check above only catches a
    // TRUTHFUL declared Content-Length — a missing, lying, or chunked-
    // transfer-encoded request was previously bounded by nothing, because
    // `request.formData()` buffers the entire body into memory before any
    // further size check runs (`ARCHITECTURE.md` §23 item 2). Wrapping the
    // request's own body stream enforces the SAME cap while it is being
    // read, so a malicious or malformed Content-Length can no longer
    // defeat it.
    const cappedRequest = capRequestBodyBytes(request, MAX_UPLOAD_BYTES);

    let form: FormData;
    try {
      form = await cappedRequest.formData();
    } catch (error) {
      if (isRequestBodyTooLargeError(error)) {
        return NextResponse.json({ error: FILE_TOO_LARGE_MESSAGE }, { status: 413 });
      }
      return NextResponse.json(
        { error: "We couldn't read that upload. Please try again." },
        { status: 400 },
      );
    }

    const file = form.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json(
        { error: "Please choose an image file to upload." },
        { status: 400 },
      );
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      return NextResponse.json({ error: FILE_TOO_LARGE_MESSAGE }, { status: 413 });
    }

    const bytes = Buffer.from(await file.arrayBuffer());
    const snapshot = await uploadArtwork(projectId, {
      bytes,
      declaredContentType: file.type || null,
      filename: file.name || null,
    });

    return NextResponse.json({
      ...snapshot,
      persistenceMode: getPersistenceMode(),
    });
  } catch (error) {
    // A rejected upload is a customer-facing explanation, not a server
    // error: its message is authored in `upload-limits.ts` and carries no
    // internal detail.
    if (error instanceof ArtworkUploadRejectedError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: 400 },
      );
    }
    if (error instanceof ArtworkPreparationStateError) {
      const status = error.message.includes("not found") ? 404 : 409;
      return NextResponse.json({ error: error.message }, { status });
    }

    console.error("Failed to accept uploaded artwork", error);
    return NextResponse.json(
      { error: "We couldn't accept that upload. Please try again." },
      { status: 500 },
    );
  }
}
