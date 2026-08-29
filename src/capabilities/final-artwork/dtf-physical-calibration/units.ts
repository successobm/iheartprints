/**
 * DTF Physical Calibration Phase 2B — shared physical-unit conversions.
 *
 * MUST stay aligned with Feature Integrity / Coverage Intelligence:
 * both use `pitchMm = (confirmedInches * MM_PER_INCH) / pixelCount`.
 * At the apparel-raster 300 PPI target that is exactly `25.4 / 300` mm/px.
 *
 * This module is the ONE place calibration geometry converts mm ↔ px so
 * specimen math never invents a second unit system.
 */

/** Apparel-raster production density target — same as `APPAREL_RASTER_TARGET_PPI`. */
export const CALIBRATION_PPI = 300;

/** Same constant Feature Integrity and Coverage use. */
export const MM_PER_INCH = 25.4;

export function inchesToPx(inches: number, ppi: number = CALIBRATION_PPI): number {
  return Math.round(inches * ppi);
}

export function mmToExactPx(mm: number, ppi: number = CALIBRATION_PPI): number {
  return (mm / MM_PER_INCH) * ppi;
}

export function pxToMm(px: number, ppi: number = CALIBRATION_PPI): number {
  return (px / ppi) * MM_PER_INCH;
}

/**
 * Quantize a requested physical width to whole pixels at the calibration PPI.
 * Never pretends the requested mm survived rasterization exactly.
 */
export function quantizePhysicalWidthMm(
  requestedMm: number,
  ppi: number = CALIBRATION_PPI,
): { requestedMm: number; actualPx: number; actualMm: number } {
  const exactPx = mmToExactPx(requestedMm, ppi);
  const actualPx = Math.max(1, Math.round(exactPx));
  return {
    requestedMm,
    actualPx,
    actualMm: pxToMm(actualPx, ppi),
  };
}

export function isotropicPitchMm(
  widthPx: number,
  heightPx: number,
  widthIn: number,
  heightIn: number,
): number {
  const pitchX = (widthIn * MM_PER_INCH) / widthPx;
  const pitchY = (heightIn * MM_PER_INCH) / heightPx;
  return Math.sqrt(pitchX * pitchY);
}
