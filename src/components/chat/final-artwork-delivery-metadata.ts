export interface ProductionArtworkMetadataInput {
  mimeType: string;
  widthPx: number | null;
  heightPx: number | null;
  transparent: boolean | null;
  /**
   * Live Acceptance Cleanup (Issue 5): the plate's ACTUAL physical size and
   * resolution, read from the production normalization recorded with the
   * file. `null`/absent for an asset produced before that was recorded — in
   * which case the physical size is simply omitted rather than filled in
   * with a default the file may not match.
   */
  widthIn?: number | null;
  heightIn?: number | null;
  dpi?: number | null;
}

/**
 * The delivery card's one-line spec. Physical size leads, because that is
 * what the customer chose and what they can check against their garment;
 * pixel dimensions follow as supporting detail.
 */
export function formatProductionArtworkMetadataLine(
  artwork: ProductionArtworkMetadataInput,
): string {
  const parts: string[] = [];
  const format = mimeTypeLabel(artwork.mimeType);
  if (format) parts.push(format);
  if (artwork.widthIn && artwork.heightIn) {
    parts.push(`${formatInches(artwork.widthIn)}" × ${formatInches(artwork.heightIn)}"`);
  }
  if (artwork.dpi) parts.push(`${Math.round(artwork.dpi)} DPI`);
  if (artwork.widthPx && artwork.heightPx) {
    parts.push(
      `${artwork.widthPx.toLocaleString("en-US")} × ${artwork.heightPx.toLocaleString("en-US")}`,
    );
  }
  if (artwork.transparent === true) parts.push("Transparent background");
  return parts.join(" · ");
}

function formatInches(value: number): string {
  return Number.isInteger(value)
    ? String(value)
    : String(Math.round(value * 100) / 100);
}

function mimeTypeLabel(mimeType: string): string | null {
  const normalized = mimeType.toLowerCase();
  if (normalized === "image/png") return "PNG";
  if (normalized === "image/jpeg" || normalized === "image/jpg") return "JPEG";
  if (normalized === "image/webp") return "WebP";
  return null;
}
