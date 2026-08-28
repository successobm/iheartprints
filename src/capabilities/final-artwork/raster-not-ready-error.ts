/**
 * Phase 28I Section 9/10 — THE RASTER-FIRST HARD GATE's rejection.
 *
 * Mirrors `final-artwork-unavailable-error.ts`'s shape: `safeErrorCode` is
 * the only part meant to travel past a server log or an API response body,
 * so a route handler can translate this into a stable, machine-readable
 * rejection reason without leaking internal vocabulary
 * (`currentRasterStatus` is one of `ProductionVariantStatus`'s own values —
 * customer-safe already, never a validation-check name or provider key).
 *
 * Thrown by `FinalArtworkCapability.requestPreparedUploadFinalArtwork` when
 * the requested treatment is DTF Halftone and the matching Standard Raster
 * variant (same approved preparation, same confirmed physical size) is not
 * genuinely `print_ready` — enforced server-side so a direct
 * `POST /production-treatment` + `POST /artwork-preparation` sequence
 * cannot bypass the UI's own doorway.
 */
export type RasterNotReadySafeErrorCode = "STANDARD_RASTER_NOT_PRINT_READY";

export class ArtworkFinalizationRasterNotReadyError extends Error {
  readonly safeErrorCode: RasterNotReadySafeErrorCode = "STANDARD_RASTER_NOT_PRINT_READY";
  readonly currentRasterStatus: string;

  constructor(currentRasterStatus: string) {
    super(
      `DTF Halftone cannot be created until Standard Raster is Print Ready for this artwork and size (current Standard Raster status: ${currentRasterStatus}).`,
    );
    this.name = "ArtworkFinalizationRasterNotReadyError";
    this.currentRasterStatus = currentRasterStatus;
  }
}
