/**
 * DTF-R1 (independent-review repair, NON-BLOCKING #5) — the clean-master
 * handoff's own CASE B refusal.
 *
 * Mirrors `raster-not-ready-error.ts`'s shape exactly: `safeErrorCode` is
 * the only part meant to travel past a server log or an API response body,
 * and `message` is already the resolver's own customer-safe sentence.
 *
 * Why it is a distinct type rather than a bare `Error`: the DTF-R1 contract
 * is explicit that unresolved production authority must not be dressed up
 * as a processing failure. A bare `Error` from
 * `requestPreparedUploadFinalArtwork` reaches the API route's generic
 * branch, which logs `"Failed to run an artwork preparation action"` and
 * answers `500`. Nothing failed: the system has already decided this
 * artwork needs recovery, recovery has not resolved yet, and production is
 * correctly paused. That is a legitimate, expected business-rule refusal —
 * a `409`, like the raster-first gate's own.
 */
export type RecoveryUnresolvedSafeErrorCode = "ARTWORK_RECOVERY_UNRESOLVED";

export class ArtworkFinalizationRecoveryUnresolvedError extends Error {
  readonly safeErrorCode: RecoveryUnresolvedSafeErrorCode = "ARTWORK_RECOVERY_UNRESOLVED";

  constructor(customerMessage: string) {
    super(customerMessage);
    this.name = "ArtworkFinalizationRecoveryUnresolvedError";
  }
}
