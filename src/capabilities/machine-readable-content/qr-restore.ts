/**
 * Deterministic QR restoration — generate a crisp, machine-verifiable QR
 * from a VERIFIED source payload and composite it into a candidate image,
 * in place of a damaged/unreadable reconstruction.
 *
 * SOURCE-OF-TRUTH RULE (restated — see `qr-preservation.ts`): `payload`
 * here must always be a string this codebase itself decoded from the
 * customer's own source QR (`MachineReadablePreservationInstance
 * .sourceDecodable === true`, matched against its
 * `sourcePayloadSha256`). Nothing in this module accepts a payload from
 * any other origin, and nothing here ever fetches, opens, resolves, or
 * executes it — it is encoded as opaque bytes and nothing else.
 *
 * QUIET ZONE / CRISPNESS (Section L): the replacement is rasterized module
 * by module, each module a flat, unblended, axis-aligned block of pure
 * black or pure white — never anti-aliased, blended, or produced by
 * resizing/interpolating a smaller bitmap. `qrcode`'s own raw module
 * matrix (`QRCode.create`) is the source of the black/white pattern; this
 * module owns every pixel written from there, so no downstream renderer
 * can soften it.
 */

import QRCode from "qrcode";

import type { MachineReadableRegionBounds } from "./contracts";
import { decodeQrCodes, type RgbaImage } from "./qr-detect-decode";

/**
 * Recommended by the QR spec (ISO/IEC 18004 §5.3): at least 4 modules of
 * quiet zone (light-coloured margin) on every side, distinct from the
 * symbol itself, so a scanner's own edge-detection can find where the
 * symbol starts. Never cropped, never reduced below this — Section L.
 */
const QUIET_ZONE_MODULES = 4;

/** Higher error correction (30% of the symbol may be damaged/occluded and still decode) — appropriate for a QR meant to sit inside printed artwork, matching common practice for logo-overlaid QR codes like the customer's own original. */
const ERROR_CORRECTION_LEVEL = "H";

export interface GeneratedQrRaster {
  /** RGBA, 4 bytes/pixel, row-major. Pure black (0,0,0,255) / pure white (255,255,255,255) only — no other values appear anywhere in this buffer. */
  data: Buffer;
  width: number;
  height: number;
  /** The QR's own module grid size (modules per side, symbol only, excluding quiet zone). */
  moduleGridSize: number;
  pixelsPerModule: number;
}

/**
 * Renders `payload` as a crisp QR raster sized to fit within
 * `targetWidthPx` × `targetHeightPx` (the smaller of the two constrains
 * the module pixel size, so the result is always square and never
 * exceeds either bound) with at least `QUIET_ZONE_MODULES` of true quiet
 * zone included in the raster itself. Every pixel is written directly by
 * this function — `qrcode`'s own PNG/canvas renderers are never used, so
 * there is no risk of an intermediate renderer applying anti-aliasing at
 * a non-integer scale.
 */
export function generateReplacementQrRaster(
  payload: string,
  targetWidthPx: number,
  targetHeightPx: number,
): GeneratedQrRaster {
  const symbol = QRCode.create(payload, { errorCorrectionLevel: ERROR_CORRECTION_LEVEL });
  const moduleGridSize = symbol.modules.size;
  const totalModules = moduleGridSize + QUIET_ZONE_MODULES * 2;

  const maxSquare = Math.min(targetWidthPx, targetHeightPx);
  const pixelsPerModule = Math.max(1, Math.floor(maxSquare / totalModules));
  const sideLengthPx = pixelsPerModule * totalModules;

  const data = Buffer.alloc(sideLengthPx * sideLengthPx * 4, 255);
  // Alpha channel: fully opaque everywhere (quiet zone included — it is
  // part of the symbol's own required geometry, not a transparent gap).
  for (let i = 3; i < data.length; i += 4) data[i] = 255;

  for (let moduleRow = 0; moduleRow < moduleGridSize; moduleRow++) {
    for (let moduleCol = 0; moduleCol < moduleGridSize; moduleCol++) {
      const dark = symbol.modules.get(moduleRow, moduleCol) === 1;
      if (!dark) continue; // buffer already initialized to white
      const pxStartX = (moduleCol + QUIET_ZONE_MODULES) * pixelsPerModule;
      const pxStartY = (moduleRow + QUIET_ZONE_MODULES) * pixelsPerModule;
      for (let y = 0; y < pixelsPerModule; y++) {
        const rowStart = ((pxStartY + y) * sideLengthPx + pxStartX) * 4;
        for (let x = 0; x < pixelsPerModule; x++) {
          const i = rowStart + x * 4;
          data[i] = 0;
          data[i + 1] = 0;
          data[i + 2] = 0;
          // alpha already 255
        }
      }
    }
  }

  return { data, width: sideLengthPx, height: sideLengthPx, moduleGridSize, pixelsPerModule };
}

/**
 * Writes `raster` into `working` (a full-canvas RGBA buffer,
 * `canvasWidthPx` × `canvasHeightPx`) at `region`, centered within the
 * region if the raster is smaller than it (the raster is always square;
 * `region` need not be). Direct, unblended pixel writes only — the same
 * idiom `sign-composition-steps.ts`'s masked-fill operations use. Pixels
 * in `region` outside the centered raster are left completely untouched
 * (never flattened to a background colour) — Section O: this must not
 * alter anything beyond the QR itself.
 */
export function compositeQrRaster(
  working: Buffer,
  canvasWidthPx: number,
  canvasHeightPx: number,
  region: MachineReadableRegionBounds,
  raster: GeneratedQrRaster,
): void {
  const offsetX = region.xPx + Math.max(0, Math.floor((region.widthPx - raster.width) / 2));
  const offsetY = region.yPx + Math.max(0, Math.floor((region.heightPx - raster.height) / 2));

  for (let y = 0; y < raster.height; y++) {
    const destY = offsetY + y;
    if (destY < 0 || destY >= canvasHeightPx) continue;
    for (let x = 0; x < raster.width; x++) {
      const destX = offsetX + x;
      if (destX < 0 || destX >= canvasWidthPx) continue;
      const srcI = (y * raster.width + x) * 4;
      const destI = (destY * canvasWidthPx + destX) * 4;
      working[destI] = raster.data[srcI];
      working[destI + 1] = raster.data[srcI + 1];
      working[destI + 2] = raster.data[srcI + 2];
      working[destI + 3] = raster.data[srcI + 3];
    }
  }
}

/**
 * Section O: for a purely proportional (resolution-only) transform —
 * source and candidate share the same aspect ratio within `tolerance` —
 * the source QR's own bounding box maps deterministically into candidate
 * coordinates by a single uniform scale factor. Returns `null` (fail
 * closed) when the aspect ratio does not match closely enough to trust a
 * naive scale mapping — Section O's own explicit requirement: "scope
 * automatic QR replacement to transformations where region mapping is
 * deterministic and fail closed elsewhere." A structural composition plan
 * (crop/pad/move) would need its own governed transform lineage to map a
 * region trustworthily; this function deliberately does not attempt that.
 */
export function mapSourceRegionToProportionalCandidateRegion(
  sourceBounds: MachineReadableRegionBounds,
  sourceImageWidthPx: number,
  sourceImageHeightPx: number,
  candidateImageWidthPx: number,
  candidateImageHeightPx: number,
  tolerance = 0.02,
): MachineReadableRegionBounds | null {
  const sourceAspect = sourceImageWidthPx / sourceImageHeightPx;
  const candidateAspect = candidateImageWidthPx / candidateImageHeightPx;
  if (Math.abs(sourceAspect - candidateAspect) / sourceAspect > tolerance) {
    return null;
  }
  const scaleX = candidateImageWidthPx / sourceImageWidthPx;
  const scaleY = candidateImageHeightPx / sourceImageHeightPx;
  return {
    xPx: Math.round(sourceBounds.xPx * scaleX),
    yPx: Math.round(sourceBounds.yPx * scaleY),
    widthPx: Math.round(sourceBounds.widthPx * scaleX),
    heightPx: Math.round(sourceBounds.heightPx * scaleY),
  };
}

export interface QrRestorationResult {
  ok: true;
  /** The composited working buffer — same dimensions as the input candidate, only the QR region's pixels differ. */
  data: Buffer;
  region: MachineReadableRegionBounds;
}

export interface QrRestorationFailure {
  ok: false;
  reason:
    | "region_mapping_not_trustworthy"
    | "verification_failed_after_composite";
}

/**
 * The full deterministic restoration: maps the source region into
 * candidate coordinates, generates a crisp QR from `verifiedPayload`,
 * composites it, and — Section Q's own explicit requirement — DECODES THE
 * ACTUAL COMPOSITED PIXELS before ever reporting success. A generator
 * that ran without error is not proof of anything; only a fresh decode of
 * the literal bytes this function is about to hand back, matching
 * `verifiedPayload` exactly, is.
 */
export function restoreQrInCandidate(input: {
  candidate: RgbaImage;
  sourceBounds: MachineReadableRegionBounds;
  sourceImageWidthPx: number;
  sourceImageHeightPx: number;
  verifiedPayload: string;
}): QrRestorationResult | QrRestorationFailure {
  const region = mapSourceRegionToProportionalCandidateRegion(
    input.sourceBounds,
    input.sourceImageWidthPx,
    input.sourceImageHeightPx,
    input.candidate.width,
    input.candidate.height,
  );
  if (!region) return { ok: false, reason: "region_mapping_not_trustworthy" };

  const raster = generateReplacementQrRaster(input.verifiedPayload, region.widthPx, region.heightPx);
  const working = Buffer.from(input.candidate.data);
  compositeQrRaster(working, input.candidate.width, input.candidate.height, region, raster);

  const [redecoded] = decodeQrCodes({
    width: input.candidate.width,
    height: input.candidate.height,
    data: working,
  });
  if (!redecoded || redecoded.payload !== input.verifiedPayload) {
    return { ok: false, reason: "verification_failed_after_composite" };
  }

  return { ok: true, data: working, region };
}

export interface RestoreAllResult {
  /** True iff at least one instance was actually repaired. `false` (with `data` unchanged from `candidate.data`) when there was nothing to fix (every decodable source instance already matches, or there was nothing fixable at all). */
  changed: boolean;
  data: Buffer;
  restoredCount: number;
  /** Source instances that decoded but could NOT be restored (region mapping untrustworthy, or the composited result failed re-verification) — fail-closed, never silently skipped without being reported. */
  unresolved: { sourceBounds: MachineReadableRegionBounds; reason: QrRestorationFailure["reason"] }[];
}

/**
 * The full governed restoration pass (Section J: 0..N independent
 * instances). Only ever repairs an instance whose SOURCE decoded — CASE 2
 * (fail)/CASE 4 (hard_fail) territory (`qr-preservation.ts`'s own doc) —
 * matched to its candidate counterpart by DECODED PAYLOAD first (an
 * already-correct instance is left completely untouched), falling back to
 * positional order only when neither side offers a decoded-payload match.
 * An undecodable SOURCE instance (review_required) is never touched here
 * — there is no verified payload to restore FROM (Section I's
 * source-of-truth rule) — and is not reported in `unresolved` either,
 * since "restoration" was never applicable to it in the first place.
 */
export function restoreAllFixableQrInstances(input: {
  source: RgbaImage;
  candidate: RgbaImage;
}): RestoreAllResult {
  const sourceDecoded = decodeQrCodes(input.source);
  if (sourceDecoded.length === 0) {
    return { changed: false, data: input.candidate.data, restoredCount: 0, unresolved: [] };
  }

  let working: RgbaImage = input.candidate;
  let restoredCount = 0;
  const unresolved: RestoreAllResult["unresolved"] = [];

  for (const src of sourceDecoded) {
    const candidateDecoded = decodeQrCodes(working);
    const alreadyMatches = candidateDecoded.some((c) => c.payload === src.payload);
    if (alreadyMatches) continue; // CASE 1 (pass) for this instance — never touched.

    const result = restoreQrInCandidate({
      candidate: working,
      sourceBounds: src.bounds,
      sourceImageWidthPx: input.source.width,
      sourceImageHeightPx: input.source.height,
      verifiedPayload: src.payload,
    });

    if (!result.ok) {
      unresolved.push({ sourceBounds: src.bounds, reason: result.reason });
      continue;
    }

    working = { width: working.width, height: working.height, data: result.data };
    restoredCount += 1;
  }

  return { changed: restoredCount > 0, data: working.data, restoredCount, unresolved };
}

/**
 * SIGNS QR DESTINATION RESOLUTION: the sibling of `restoreAllFixableQrInstances`
 * for CONFIRMED-DESTINATION corrections — a source instance that could not
 * be decoded, but whose intended payload a customer/operator has explicitly
 * confirmed (Section J: "confirmed_by_user" is a DIFFERENT authority than
 * a decoded source payload, never silently merged with it). Composites each
 * given `payload` at its own `sourceBounds`' proportionally-mapped region,
 * sequentially into one working buffer, exactly like
 * `restoreAllFixableQrInstances`'s own loop — the only difference is WHERE
 * the payload comes from (an explicit caller-supplied value here, a
 * source decode there). Never decodes the source itself — the caller
 * (`sign-qr-preservation-service.ts`) is the one place that already knows
 * which instances have a governing `confirmed_destination` resolution.
 */
export function restoreFromConfirmedDestinations(input: {
  candidate: RgbaImage;
  sourceImageWidthPx: number;
  sourceImageHeightPx: number;
  corrections: { sourceBounds: MachineReadableRegionBounds; payload: string }[];
}): RestoreAllResult {
  let working: RgbaImage = input.candidate;
  let restoredCount = 0;
  const unresolved: RestoreAllResult["unresolved"] = [];

  for (const correction of input.corrections) {
    const result = restoreQrInCandidate({
      candidate: working,
      sourceBounds: correction.sourceBounds,
      sourceImageWidthPx: input.sourceImageWidthPx,
      sourceImageHeightPx: input.sourceImageHeightPx,
      verifiedPayload: correction.payload,
    });

    if (!result.ok) {
      unresolved.push({ sourceBounds: correction.sourceBounds, reason: result.reason });
      continue;
    }

    working = { width: working.width, height: working.height, data: result.data };
    restoredCount += 1;
  }

  return { changed: restoredCount > 0, data: working.data, restoredCount, unresolved };
}
