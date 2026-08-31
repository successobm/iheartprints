/**
 * Signs Phase S4.2A: deterministic derivation of the bounded, fixed image
 * set sent to the semantic provider. Pure — no I/O, no capability imports
 * (mirrors `sign-geometry.ts`/`sign-preservation-deterministic-checks.ts`'s
 * own discipline).
 *
 * Deliberately produces a DATA-INDEPENDENT count: always exactly
 * `SIGN_PRESERVATION_MAX_IMAGE_COUNT` (14) images — 1 source overview, 1
 * reconstruction overview (downsampled to the source's own dimensions,
 * reusing `resampleExact` exactly like `checkSourceSimilarity` already
 * does — no new image dependency), and
 * `SIGN_PRESERVATION_GRID_COLUMNS * SIGN_PRESERVATION_GRID_ROWS` (6)
 * geometrically-corresponding crop PAIRS. The overview pair is
 * same-dimensioned (holistic/structural comparison); each crop pair is
 * DELIBERATELY NOT resized to match — the source crop stays at native
 * source resolution and the reconstruction crop stays at native
 * reconstruction resolution for the identical content area, so small
 * text/price legibility is never sacrificed by a second downsample. Never
 * an AI-selected or data-dependent crop — the grid is a fixed geometric
 * partition of the source frame, unconditionally.
 *
 * Returns `null` (image derivation UNAVAILABLE, not guessed) when the
 * reconstruction content region is not an exact integer multiple of the
 * source dimensions — the same precondition
 * `checkSourceSimilarity` already requires before computing anything.
 */

import { PNG } from "pngjs";

import type { RgbaImage } from "@/capabilities/final-artwork/raster-transform";
import { resampleExact } from "@/capabilities/final-artwork/raster-transform";

import {
  SIGN_PRESERVATION_GRID_COLUMNS,
  SIGN_PRESERVATION_GRID_ROWS,
  SIGN_PRESERVATION_IMAGE_DERIVATION_VERSION,
} from "./contracts";
import type { SignPreservationSemanticImageInput } from "./sign-preservation-semantic-provider";

export function encodeImageAsDataUri(image: RgbaImage): string {
  const png = new PNG({ width: image.width, height: image.height });
  image.data.copy(png.data);
  const bytes = PNG.sync.write(png);
  return `data:image/png;base64,${bytes.toString("base64")}`;
}

function cropRegion(image: RgbaImage, x: number, y: number, width: number, height: number): RgbaImage {
  const data = Buffer.alloc(width * height * 4);
  for (let row = 0; row < height; row += 1) {
    const srcStart = ((y + row) * image.width + x) * 4;
    const destStart = row * width * 4;
    image.data.copy(data, destStart, srcStart, srcStart + width * 4);
  }
  return { width, height, data };
}

export interface SignPreservationSemanticImageSet {
  sourceOverview: SignPreservationSemanticImageInput;
  reconstructionOverview: SignPreservationSemanticImageInput;
  sourceCrops: SignPreservationSemanticImageInput[];
  reconstructionCrops: SignPreservationSemanticImageInput[];
  imageDerivationVersion: typeof SIGN_PRESERVATION_IMAGE_DERIVATION_VERSION;
}

/**
 * `sourceImage` is the immutable original customer artwork, native
 * resolution. `reconstructionContentImage` is the reconstruction's
 * CONTENT REGION ONLY — never the padded final plate (the caller derives
 * this the same way `checkReconstructionToFinalRgb`'s comparison region
 * does; the deterministic black extension is never sent to the semantic
 * provider).
 */
export function deriveSemanticComparisonImages(
  sourceImage: RgbaImage,
  reconstructionContentImage: RgbaImage,
): SignPreservationSemanticImageSet | null {
  const scaleX = reconstructionContentImage.width / sourceImage.width;
  const scaleY = reconstructionContentImage.height / sourceImage.height;
  const isExactIntegerScale =
    Number.isInteger(scaleX) && Number.isInteger(scaleY) && scaleX === scaleY && scaleX > 0;
  if (!isExactIntegerScale) return null;
  const scale = scaleX;

  const sourceOverview: SignPreservationSemanticImageInput = {
    dataUri: encodeImageAsDataUri(sourceImage),
    label: "source overview",
  };
  const { image: reconstructionOverviewImage } = resampleExact(
    reconstructionContentImage,
    sourceImage.width,
    sourceImage.height,
  );
  const reconstructionOverview: SignPreservationSemanticImageInput = {
    dataUri: encodeImageAsDataUri(reconstructionOverviewImage),
    label: "reconstruction overview (normalized to source dimensions)",
  };

  const sourceCrops: SignPreservationSemanticImageInput[] = [];
  const reconstructionCrops: SignPreservationSemanticImageInput[] = [];

  for (let row = 0; row < SIGN_PRESERVATION_GRID_ROWS; row += 1) {
    for (let col = 0; col < SIGN_PRESERVATION_GRID_COLUMNS; col += 1) {
      // Fixed geometric partition of the source frame — every cell
      // boundary computed from row/col/grid size alone, never from image
      // content.
      const x0 = Math.round((col / SIGN_PRESERVATION_GRID_COLUMNS) * sourceImage.width);
      const x1 = Math.round(((col + 1) / SIGN_PRESERVATION_GRID_COLUMNS) * sourceImage.width);
      const y0 = Math.round((row / SIGN_PRESERVATION_GRID_ROWS) * sourceImage.height);
      const y1 = Math.round(((row + 1) / SIGN_PRESERVATION_GRID_ROWS) * sourceImage.height);
      const width = x1 - x0;
      const height = y1 - y0;

      const sourceCrop = cropRegion(sourceImage, x0, y0, width, height);
      sourceCrops.push({
        dataUri: encodeImageAsDataUri(sourceCrop),
        label: `source grid cell (col ${col}, row ${row})`,
      });

      // The geometrically corresponding region in the reconstruction —
      // native resolution, never downsampled, so small text stays legible.
      const reconCrop = cropRegion(
        reconstructionContentImage,
        x0 * scale,
        y0 * scale,
        width * scale,
        height * scale,
      );
      reconstructionCrops.push({
        dataUri: encodeImageAsDataUri(reconCrop),
        label: `reconstruction grid cell (col ${col}, row ${row}), native resolution`,
      });
    }
  }

  return {
    sourceOverview,
    reconstructionOverview,
    sourceCrops,
    reconstructionCrops,
    imageDerivationVersion: SIGN_PRESERVATION_IMAGE_DERIVATION_VERSION,
  };
}
