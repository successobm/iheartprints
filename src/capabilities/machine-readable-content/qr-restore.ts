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

import type { MachineReadableRegionBounds, QrFinderCenterEvidence, QrLocalizationConfidence } from "./contracts";
import {
  decodeQrCodes,
  scanForQrFinderCentersInWindow,
  scanForQrFinderPatternsInWindow,
  type RgbaImage,
} from "./qr-detect-decode";

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

/**
 * Intersection-over-union of two bounding boxes. Both inputs here are
 * independent ESTIMATES of the same physical QR (a source-mapped guess and
 * a candidate-detected measurement), never pixel-exact — so this is a
 * "clearly the same object" check, not a precision comparison.
 */
function regionsSubstantiallyOverlap(a: MachineReadableRegionBounds, b: MachineReadableRegionBounds): boolean {
  const ix0 = Math.max(a.xPx, b.xPx);
  const iy0 = Math.max(a.yPx, b.yPx);
  const ix1 = Math.min(a.xPx + a.widthPx, b.xPx + b.widthPx);
  const iy1 = Math.min(a.yPx + a.heightPx, b.yPx + b.heightPx);
  const iw = Math.max(0, ix1 - ix0);
  const ih = Math.max(0, iy1 - iy0);
  const intersection = iw * ih;
  if (intersection <= 0) return false;
  const union = a.widthPx * a.heightPx + b.widthPx * b.heightPx - intersection;
  return union > 0 && intersection / union >= MIN_REGION_OVERLAP_IOU;
}

/** See `regionsSubstantiallyOverlap`'s own doc — deliberately lenient (both boxes are independent estimates, not exact measurements of the same thing), but far above what two UNRELATED regions (e.g. the QR vs. a "FOLLOW US" text block sitting beside it) would ever produce. */
const MIN_REGION_OVERLAP_IOU = 0.15;

/** How far beyond the source-mapped region's own size to search the candidate for independent corroboration — generous enough to absorb the mapped region's own margin imprecision (including a LOW-confidence source estimate's own under-constrained skew — Section F/G of QR LOCALIZATION V3), bounded enough to never reach a genuinely separate, well-spaced second QR (Section I). */
const CANDIDATE_WINDOW_PADDING_FACTOR = 1.5;

function buildCandidateSearchWindow(mapped: MachineReadableRegionBounds): MachineReadableRegionBounds {
  const padX = Math.round(mapped.widthPx * CANDIDATE_WINDOW_PADDING_FACTOR);
  const padY = Math.round(mapped.heightPx * CANDIDATE_WINDOW_PADDING_FACTOR);
  return {
    xPx: mapped.xPx - padX,
    yPx: mapped.yPx - padY,
    widthPx: mapped.widthPx + padX * 2,
    heightPx: mapped.heightPx + padY * 2,
  };
}

/**
 * QR LOCALIZATION V3: the low-confidence rescue path's OWN search window —
 * deliberately NOT `buildCandidateSearchWindow`'s independent-per-axis
 * padding. A low-confidence source's mapped box can be severely
 * asymmetric (Section G: "horizontally over-wide" in the real Get Hibachi
 * case — but just as plausibly vertically over-tall, depending on which 2
 * corners survived), so padding each axis by a fraction of ITS OWN
 * length can fail to reach far enough on the SHORT axis specifically —
 * exactly the true QR's bottom-left corner sitting just outside a window
 * whose height was padded relative to an already-too-short measured
 * height. A SQUARE window, centered on the mapped box and sized from its
 * LARGER dimension, is what actually "compensates for under-constrained
 * source geometry" (Section F) regardless of which axis was
 * short-changed.
 */
function buildLowConfidenceRescueSearchWindow(mapped: MachineReadableRegionBounds): MachineReadableRegionBounds {
  const maxDim = Math.max(mapped.widthPx, mapped.heightPx);
  const pad = Math.round(maxDim * CANDIDATE_WINDOW_PADDING_FACTOR);
  const centerX = mapped.xPx + mapped.widthPx / 2;
  const centerY = mapped.yPx + mapped.heightPx / 2;
  const halfSpan = Math.round(maxDim / 2 + pad);
  return {
    xPx: Math.round(centerX - halfSpan),
    yPx: Math.round(centerY - halfSpan),
    widthPx: halfSpan * 2,
    heightPx: halfSpan * 2,
  };
}

/**
 * QR LOCALIZATION V3: how many EXPECTED-module-widths (the source's own
 * module measurement, scaled) a mapped SOURCE finder center may land from
 * a candidate finder center and still count as the SAME physical corner.
 * A genuine correspondence for the real Get Hibachi case landed within
 * ~0.1 modules of the true candidate center — but that measurement came
 * from production-quality QR generation/scanning; smaller or cruder
 * synthetic QR rasters (and any real-world case with coarser stride
 * sampling or genuine centroid imprecision on either side of the
 * transform) can plausibly drift several modules while still being
 * unambiguously the same physical corner. 10 modules remains tiny
 * relative to the candidate image itself, and to the search window's own
 * generous size — never mistakable for an unrelated, well-separated
 * finder pattern elsewhere (see the dedicated "spatial disagreement"
 * regression, which places unrelated content far outside even this
 * tolerance).
 */
const FINDER_CENTER_CORRESPONDENCE_MODULES = 10;

/**
 * Section H: a single matching point is not multi-point corroboration.
 * Requiring at least 2 independently-corresponding finder centers — never
 * all of them, since a genuinely under-constrained source detection may
 * legitimately include a weak/spurious extra cluster alongside its real
 * ones (exactly the real Get Hibachi shape: 3 tightly-consistent real
 * corners plus 1 unrelated borderline cluster) — is what makes this
 * rescue robust rather than brittle.
 */
const MIN_CORROBORATING_FINDER_CENTERS = 2;

/**
 * Greedy nearest-DISTINCT-match: for each mapped source finder center,
 * claims the closest still-unclaimed candidate finder center within
 * `toleranceRadiusPx`. Two source centers can never both claim the same
 * candidate center — that would count one point of evidence twice, not
 * two independent corroborations. A source center with no candidate
 * within tolerance simply contributes nothing (never treated as a
 * contradiction — Section H/G: weak/spurious extra source evidence is
 * tolerated, not held against the rescue).
 */
function countCorroboratingFinderCenters(
  mappedSourceCenters: readonly { xPx: number; yPx: number }[],
  candidateCenters: readonly QrFinderCenterEvidence[],
  toleranceRadiusPx: number,
): number {
  const claimed = new Set<number>();
  let count = 0;
  for (const source of mappedSourceCenters) {
    let bestIndex = -1;
    let bestDist = Infinity;
    for (let i = 0; i < candidateCenters.length; i++) {
      if (claimed.has(i)) continue;
      const candidate = candidateCenters[i];
      const dist = Math.hypot(candidate.xPx - source.xPx, candidate.yPx - source.yPx);
      if (dist <= toleranceRadiusPx && dist < bestDist) {
        bestDist = dist;
        bestIndex = i;
      }
    }
    if (bestIndex >= 0) {
      claimed.add(bestIndex);
      count++;
    }
  }
  return count;
}

export type ReplacementLocalizationFailureReason =
  | "region_mapping_not_trustworthy"
  | "source_localization_low_confidence"
  | "mapped_region_not_square"
  | "candidate_localization_missing"
  | "candidate_localization_disagrees"
  | "insufficient_finder_corroboration";

export interface LocalizedReplacementRegion {
  ok: true;
  /**
   * The validated CANDIDATE-space region to actually composite into —
   * the CANDIDATE's OWN independently-detected bounds, not the naive
   * source-mapped estimate, and never the padded search window (Section
   * L of QR LOCALIZATION V3: "candidate evidence defines the pixels
   * allowed to change" — Section G of QR REPAIR V2: "the artifact being
   * modified should participate in proving the modification region").
   */
  region: MachineReadableRegionBounds;
}

export interface LocalizedReplacementRegionFailure {
  ok: false;
  reason: ReplacementLocalizationFailureReason;
}

/**
 * QR REPAIR V2 — THE REPLACEMENT SAFETY GATE.
 *
 * Detection (proving Print Ready must stay blocked) is deliberately
 * permissive — even weak, 2-of-3-corner evidence is enough to correctly
 * flag "something QR-shaped is here, needs attention." Automatic
 * REPLACEMENT — writing new pixels over a customer's real production
 * artwork — is a categorically higher bar, enforced here, and here only,
 * for the confirmed-destination correction path (the only path whose
 * source bounds come from the heuristic finder-pattern scanner rather
 * than a `decodeQrCodes` precise location).
 *
 * A CONFIRMED DESTINATION IS NOT THE SAME THING AS A CONFIRMED PLACEMENT
 * (Section J) — this function is what keeps those two authorities
 * separate. Two independent paths, chosen by the source's OWN reported
 * `sourceLocalizationConfidence` — never a claim that "low" secretly
 * means "high" (QR LOCALIZATION V3, Section E: that truth is preserved
 * exactly as the detector reported it):
 *
 *   `"high"` — `localizeFromHighConfidenceSource`: the naive proportional
 *     source->candidate mapping must itself be approximately square, and
 *     the ONE high-confidence candidate cluster in a padded search window
 *     around it must substantially overlap that mapped estimate.
 *
 *   `"low"` — `localizeFromLowConfidenceSourceRescue` (QR LOCALIZATION
 *     V3): existence authority (something QR-shaped is genuinely in the
 *     source) is separated from placement authority (exactly where it is
 *     in the candidate). A low-confidence source's own CONFIRMED finder
 *     centers — not its unreliable, possibly badly-skewed bounding box —
 *     are mapped into candidate space and required to independently
 *     correspond (Section H: stronger evidence than a rectangle-overlap
 *     heuristic) to at least `MIN_CORROBORATING_FINDER_CENTERS` of the
 *     ONE high-confidence candidate cluster's own confirmed centers,
 *     found in the same kind of bounded search window. Never "candidate
 *     sees something QR-like, therefore replace it" (Section A/B): with
 *     zero source finder evidence, or with a genuinely uncorroborated
 *     high-confidence candidate detection, this path refuses exactly
 *     like the high-confidence path does.
 *
 * Both paths refuse outright (Section I) unless the search window
 * contains EXACTLY ONE high-confidence candidate cluster — never guessing
 * among several. Both return the CANDIDATE's own detected bounds on
 * success — the artifact actually being modified is what determines
 * where it gets modified, in every case.
 */
export function localizeConfirmedDestinationReplacementRegion(input: {
  sourceBounds: MachineReadableRegionBounds;
  sourceLocalizationConfidence: QrLocalizationConfidence;
  sourceFinderCenters: readonly QrFinderCenterEvidence[];
  sourceImageWidthPx: number;
  sourceImageHeightPx: number;
  candidate: RgbaImage;
}): LocalizedReplacementRegion | LocalizedReplacementRegionFailure {
  if (input.sourceLocalizationConfidence === "high") {
    return localizeFromHighConfidenceSource(input);
  }
  return localizeFromLowConfidenceSourceRescue(input);
}

function localizeFromHighConfidenceSource(input: {
  sourceBounds: MachineReadableRegionBounds;
  sourceImageWidthPx: number;
  sourceImageHeightPx: number;
  candidate: RgbaImage;
}): LocalizedReplacementRegion | LocalizedReplacementRegionFailure {
  const mapped = mapSourceRegionToProportionalCandidateRegion(
    input.sourceBounds,
    input.sourceImageWidthPx,
    input.sourceImageHeightPx,
    input.candidate.width,
    input.candidate.height,
  );
  if (!mapped) return { ok: false, reason: "region_mapping_not_trustworthy" };

  const mappedAspect = Math.max(mapped.widthPx, mapped.heightPx) / Math.max(1, Math.min(mapped.widthPx, mapped.heightPx));
  if (mapped.widthPx <= 0 || mapped.heightPx <= 0 || mappedAspect > 1.35) {
    return { ok: false, reason: "mapped_region_not_square" };
  }

  const window = buildCandidateSearchWindow(mapped);

  const candidateFound = scanForQrFinderPatternsInWindow(input.candidate, window).filter(
    (r) => r.localizationConfidence === "high",
  );
  if (candidateFound.length === 0) {
    return { ok: false, reason: "candidate_localization_missing" };
  }
  if (candidateFound.length > 1) {
    // More than one independently-confident cluster in the search window —
    // never guess which one corresponds to the source region being
    // corrected (Section I).
    return { ok: false, reason: "candidate_localization_disagrees" };
  }

  const candidateRegion = candidateFound[0].bounds;
  if (!regionsSubstantiallyOverlap(mapped, candidateRegion)) {
    return { ok: false, reason: "candidate_localization_disagrees" };
  }

  return { ok: true, region: candidateRegion };
}

/**
 * QR LOCALIZATION V3: the low-confidence-source rescue. See
 * `localizeConfirmedDestinationReplacementRegion`'s own doc for the full
 * rationale — this is deliberately NOT the same square/overlap check the
 * high-confidence path uses, because a low-confidence source's own
 * bounding box is genuinely under-constrained (Section G: it may be
 * "horizontally over-wide" purely because a third corner was never
 * confirmed) and must never be required to already look like a trustworthy
 * square on its own. The bounding box here is used ONLY to build a search
 * window — reconciliation is entirely finder-center correspondence.
 */
function localizeFromLowConfidenceSourceRescue(input: {
  sourceBounds: MachineReadableRegionBounds;
  sourceFinderCenters: readonly QrFinderCenterEvidence[];
  sourceImageWidthPx: number;
  sourceImageHeightPx: number;
  candidate: RgbaImage;
}): LocalizedReplacementRegion | LocalizedReplacementRegionFailure {
  if (input.sourceFinderCenters.length === 0) {
    return { ok: false, reason: "source_localization_low_confidence" };
  }

  const mapped = mapSourceRegionToProportionalCandidateRegion(
    input.sourceBounds,
    input.sourceImageWidthPx,
    input.sourceImageHeightPx,
    input.candidate.width,
    input.candidate.height,
  );
  if (!mapped) return { ok: false, reason: "region_mapping_not_trustworthy" };

  const window = buildLowConfidenceRescueSearchWindow(mapped);

  const candidateFound = scanForQrFinderPatternsInWindow(input.candidate, window).filter(
    (r) => r.localizationConfidence === "high",
  );
  if (candidateFound.length === 0) {
    return { ok: false, reason: "candidate_localization_missing" };
  }
  if (candidateFound.length > 1) {
    // Exactly one high-confidence hypothesis required (Section I) — same
    // rule as the high-confidence path, same reason.
    return { ok: false, reason: "candidate_localization_disagrees" };
  }
  const candidateRegion = candidateFound[0].bounds;

  // The candidate's OWN individual confirmed finder centers, scoped to the
  // SAME bounded window (never the whole canvas — Section I/J: a second,
  // unrelated QR elsewhere must never be unioned in).
  const rawCandidateCenters = scanForQrFinderCentersInWindow(input.candidate, window);
  if (rawCandidateCenters.length === 0) {
    // Should not happen given candidateFound.length === 1 above (a
    // high-confidence region requires >=3 confirmed centers by
    // construction), but fail closed rather than divide by zero below.
    return { ok: false, reason: "candidate_localization_missing" };
  }

  const scaleX = input.candidate.width / input.sourceImageWidthPx;
  const scaleY = input.candidate.height / input.sourceImageHeightPx;
  const mappedSourceCenters = input.sourceFinderCenters.map((c) => ({
    xPx: c.xPx * scaleX,
    yPx: c.yPx * scaleY,
  }));

  // Tolerance — and which candidate centers even count as plausible finder
  // corners at all — is sized from the SOURCE's own measured module width,
  // scaled by the known source->candidate transform, NEVER from an average
  // over the candidate's own centers. A damaged/reconstructed candidate
  // interior (the checkerboard-style damage this whole engagement's own
  // fixtures use, and plausibly a real botched reconstruction) can produce
  // a large volume of tiny, module-width-near-zero coincidental clusters
  // deep inside the symbol — averaging module width over ALL candidate
  // centers lets that noise collapse the tolerance to near-zero. The
  // source measurement is not subject to this failure mode (it is
  // measured directly from the source's OWN 2 confirmed corners, never
  // from the candidate's damaged interior), and scaling it by the exact
  // known transform is precisely the "scale/module estimates are
  // plausible" check Section G asks for — a source measurement mapped
  // with a badly wrong effective scale would simply land nowhere near any
  // candidate center at all, regardless of which centers survive this
  // filter.
  const sourceModuleWidthAvg =
    input.sourceFinderCenters.reduce((sum, c) => sum + c.moduleWidthPx, 0) / input.sourceFinderCenters.length;
  const expectedCandidateModuleWidth = sourceModuleWidthAvg * Math.min(scaleX, scaleY);
  const toleranceRadiusPx = expectedCandidateModuleWidth * FINDER_CENTER_CORRESPONDENCE_MODULES;

  // Candidate centers whose own measured module width is wildly
  // inconsistent with the expected scale are noise, not finder-pattern
  // evidence — excluded before matching rather than merely tolerated,
  // both for correctness (a coincidentally-nearby noise point could
  // otherwise wrongly claim a real correspondence) and to keep the
  // greedy match bounded.
  const plausibleCandidateCenters = rawCandidateCenters.filter(
    (c) => c.moduleWidthPx >= expectedCandidateModuleWidth / 3 && c.moduleWidthPx <= expectedCandidateModuleWidth * 3,
  );

  const corroborated = countCorroboratingFinderCenters(mappedSourceCenters, plausibleCandidateCenters, toleranceRadiusPx);
  if (corroborated < MIN_CORROBORATING_FINDER_CENTERS) {
    return { ok: false, reason: "insufficient_finder_corroboration" };
  }

  return { ok: true, region: candidateRegion };
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
    | "verification_failed_after_composite"
    | "decoded_location_outside_region";
}

/**
 * The full deterministic restoration: maps the source region into
 * candidate coordinates (or uses `regionOverride` directly when the
 * caller has already independently validated one — see
 * `localizeConfirmedDestinationReplacementRegion`), generates a crisp QR
 * from `verifiedPayload`, composites it, and — Section Q's own explicit
 * requirement — DECODES THE ACTUAL COMPOSITED PIXELS before ever
 * reporting success. A generator that ran without error is not proof of
 * anything; only a fresh decode of the literal bytes this function is
 * about to hand back is.
 *
 * QR REPAIR V2 (Section M/P): decoding the right PAYLOAD somewhere in the
 * image is not, by itself, proof placement was correct — this function
 * additionally requires the redecoded QR's OWN location (jsQR's precise
 * corners) to substantially overlap the region actually composited into.
 * A decodable QR in the wrong place must never report success.
 */
export function restoreQrInCandidate(input: {
  candidate: RgbaImage;
  sourceBounds: MachineReadableRegionBounds;
  sourceImageWidthPx: number;
  sourceImageHeightPx: number;
  verifiedPayload: string;
  /** When provided, composite into this CANDIDATE-space region directly instead of computing one via `mapSourceRegionToProportionalCandidateRegion` — used by the confirmed-destination path once its own safety gate has independently validated a region against the candidate's own pixels. */
  regionOverride?: MachineReadableRegionBounds;
}): QrRestorationResult | QrRestorationFailure {
  const region =
    input.regionOverride ??
    mapSourceRegionToProportionalCandidateRegion(
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

  // Section I: the candidate may legitimately already contain OTHER real,
  // decodable QR codes (a different instance's own already-composited
  // replacement, or an unrelated pre-existing valid QR elsewhere on the
  // sign) — searching for the ONE decoded result matching this specific
  // `verifiedPayload`, rather than trusting whichever `decodeQrCodes`
  // happens to report first, is what keeps multiple simultaneous QR
  // corrections independent of each other.
  const allDecoded = decodeQrCodes({
    width: input.candidate.width,
    height: input.candidate.height,
    data: working,
  });
  const redecoded = allDecoded.find((d) => d.payload === input.verifiedPayload);
  if (!redecoded) {
    return { ok: false, reason: "verification_failed_after_composite" };
  }
  if (!regionsSubstantiallyOverlap(region, redecoded.bounds)) {
    return { ok: false, reason: "decoded_location_outside_region" };
  }

  return { ok: true, data: working, region };
}

export interface RestoreAllResult {
  /** True iff at least one instance was actually repaired. `false` (with `data` unchanged from `candidate.data`) when there was nothing to fix (every decodable source instance already matches, or there was nothing fixable at all). */
  changed: boolean;
  data: Buffer;
  restoredCount: number;
  /** Source instances that decoded but could NOT be restored (region mapping untrustworthy, the composited result failed re-verification, or — confirmed-destination corrections only — the replacement safety gate refused an untrustworthy region) — fail-closed, never silently skipped without being reported. */
  unresolved: {
    sourceBounds: MachineReadableRegionBounds;
    reason: QrRestorationFailure["reason"] | ReplacementLocalizationFailureReason;
  }[];
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
 * given `payload` sequentially into one working buffer, exactly like
 * `restoreAllFixableQrInstances`'s own loop — the only difference is WHERE
 * the payload comes from (an explicit caller-supplied value here, a
 * source decode there). Never decodes the source itself — the caller
 * (`sign-qr-preservation-service.ts`) is the one place that already knows
 * which instances have a governing `confirmed_destination` resolution.
 *
 * QR REPAIR V2: unlike `restoreAllFixableQrInstances` (whose `sourceBounds`
 * come from a precise `decodeQrCodes` location), a `confirmed_destination`
 * correction's `sourceBounds` come from the heuristic finder-pattern
 * scanner — so EVERY correction is first run through
 * `localizeConfirmedDestinationReplacementRegion` (Section J: "CONFIRMED
 * PAYLOAD DOES NOT EQUAL CONFIRMED PLACEMENT"). A correction whose region
 * cannot be independently validated is reported in `unresolved` with the
 * gate's own specific reason and is NEVER composited — no pixels are
 * touched for it at all.
 */
export function restoreFromConfirmedDestinations(input: {
  candidate: RgbaImage;
  sourceImageWidthPx: number;
  sourceImageHeightPx: number;
  corrections: {
    sourceBounds: MachineReadableRegionBounds;
    sourceLocalizationConfidence: QrLocalizationConfidence;
    sourceFinderCenters: readonly QrFinderCenterEvidence[];
    payload: string;
  }[];
}): RestoreAllResult {
  let working: RgbaImage = input.candidate;
  let restoredCount = 0;
  const unresolved: RestoreAllResult["unresolved"] = [];

  for (const correction of input.corrections) {
    const localized = localizeConfirmedDestinationReplacementRegion({
      sourceBounds: correction.sourceBounds,
      sourceLocalizationConfidence: correction.sourceLocalizationConfidence,
      sourceFinderCenters: correction.sourceFinderCenters,
      sourceImageWidthPx: input.sourceImageWidthPx,
      sourceImageHeightPx: input.sourceImageHeightPx,
      candidate: working,
    });
    if (!localized.ok) {
      unresolved.push({ sourceBounds: correction.sourceBounds, reason: localized.reason });
      continue;
    }

    const result = restoreQrInCandidate({
      candidate: working,
      sourceBounds: correction.sourceBounds,
      sourceImageWidthPx: input.sourceImageWidthPx,
      sourceImageHeightPx: input.sourceImageHeightPx,
      verifiedPayload: correction.payload,
      regionOverride: localized.region,
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
