import { createHash } from "crypto";

/**
 * Existing Artwork → Print Ready Phase 1.4: opaque identity of the CURRENT
 * prepared derivation the customer is looking at.
 *
 * Every confirm/undo uploads a NEW prepared asset and repoints
 * `preparedAssetId`. The customer snapshot must carry a revision that
 * changes whenever those bytes change — so the browser can reload the
 * signed URL — without exposing storage keys, provider names, or raw
 * asset ids as a fetchable handle.
 *
 * Contract:
 * - automatic prepare → revision A
 * - guided confirm     → revision B (always new, even if visually similar)
 * - cleanup_preview    → revision unchanged
 * - undo               → revision C (new asset identity, even if bytes match
 *                        an earlier derivation)
 * - no prepared asset  → null
 */
export function opaquePreparedRevision(
  preparedAssetId: string | null | undefined,
): string | null {
  if (!preparedAssetId) return null;
  return createHash("sha256")
    .update(`artwork-preparation:prepared-revision:v1:${preparedAssetId}`)
    .digest("base64url")
    .slice(0, 22);
}

/**
 * Drop an async prepared-image response when a newer revision has already
 * become authoritative. Used so a slow fetch for revision B cannot overwrite
 * the URL already shown for revision C.
 */
export function isStalePreparedImageResponse(args: {
  requestRevision: string | null;
  authoritativeRevision: string | null;
}): boolean {
  return args.requestRevision !== args.authoritativeRevision;
}
