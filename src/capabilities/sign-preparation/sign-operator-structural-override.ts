/**
 * Signs Phase 3A: OPERATOR-CONFIRMED structural evidence for
 * `reflow_structural_layout` — the smallest governed mechanism that lets an
 * internal production operator supply the missing structural interpretation
 * when deterministic segmentation (`sign-layout-segmentation.ts`) is
 * `"ambiguous"` or `"not_present"`, WITHOUT building a general layout editor.
 *
 * WHAT THE OPERATOR SUPPLIES, AND NOTHING MORE: an ordered sequence of
 * horizontal row-boundary spans (`SignOperatorRegionBoundary`) — "this span
 * of rows is a structural region" — plus, for the first/last region ONLY
 * (when it touches its own domain edge), a narrower "meaningful content"
 * sub-span within it. Nothing else is operator-authored: colours are always
 * independently MEASURED from the actual source pixels here (`measureLine`,
 * the SAME primitive `sign-layout-segmentation.ts`'s own `classifyRow`
 * uses) — never typed by a human — and every gap between two confirmed
 * regions is likewise measured, never guessed. This keeps operator evidence
 * evidentiary in exactly the same sense deterministic evidence is
 * (Constitution §16A.3): a human points at WHERE structure is; the system
 * still proves WHAT colour is there.
 *
 * OUTPUT SHAPE: `synthesizeSegmentationFromOperatorOverride` produces a
 * `SignStructuralLayoutSegmentationResult` — the IDENTICAL type
 * `segmentStructuralLayout` itself returns — so `evaluateStructuralReflow`/
 * `planSignRepair` need ZERO new branching logic to consume operator
 * evidence: the planner has no idea, and does not need to know, whether a
 * `"measured"` result came from the deterministic scanner or from a
 * validated operator override. All of THIS module's evidence still has to
 * clear the exact same eligibility bar `evaluateStructuralReflow` already
 * enforces (region count, fillEdgeReaching + fillColor on both anchors,
 * gaps present, safe inset) — this module only ever produces `"measured"`
 * or refuses outright (never `"ambiguous"`; an operator override that does
 * not hold up against the actual pixels is simply invalid, full stop).
 *
 * GOVERNANCE: never trusted merely because a `SignPreparation` row carries
 * one. `resolveOperatorStructuralOverride` independently re-validates the
 * embedded `sourceAssetId`/`sourceSha256`/`sourceWidthPx`/`sourceHeightPx`
 * against the CURRENT source before ever using it — the same "never trust
 * a caller-supplied window blindly" discipline `resolveFrameAnalysisWindow`
 * already established for analysis windows. A stale override (source
 * re-uploaded, or a dimension mismatch) is refused, never silently
 * reinterpreted against the new image.
 */

import type { RgbaImage } from "@/capabilities/final-artwork/raster-transform";

import { EDGE_BACKGROUND_TOLERANCE, UNIFORM_MIN_COVERAGE } from "./edge-inspection";
import { measureLine } from "./perimeter-reconstruction";
import type {
  SignStructuralAnalysisWindow,
  SignStructuralGap,
  SignStructuralLayoutSegmentationResult,
  SignStructuralRegion,
} from "./sign-layout-segmentation";

/**
 * One operator-confirmed region span, SOURCE-image-absolute (never window-
 * relative, exactly like every other coordinate this capability records).
 * `contentStartYPx`/`contentEndYPx` are meaningful, and REQUIRED, only for
 * a region that turns out to be the first or last in the ordered sequence
 * AND touches its own domain edge (see `synthesizeSegmentationFromOperatorOverride`) —
 * they mark where this anchor's own background fill ends and its
 * meaningful content (wording/logo) begins, the one fact this module
 * cannot safely derive from row boundaries alone. Provide `null` for every
 * other region (a middle region's `contentBounds` always equals its
 * `sourceBounds`, exactly like the deterministic V1 convention).
 */
export interface SignOperatorRegionBoundary {
  startYPx: number;
  endYPx: number;
  contentStartYPx: number | null;
  contentEndYPx: number | null;
}

/**
 * The full operator-confirmed structural evidence for one source image, as
 * persisted on `SignPreparation.operatorStructuralOverride`. `regions` is
 * ordered top-to-bottom; every gap between consecutive regions is IMPLIED
 * (never separately supplied) — whatever positive-height span sits between
 * one region's `endYPx` and the next region's `startYPx` is a gap this
 * module independently measures.
 */
export interface SignOperatorStructuralLayoutOverride {
  sourceAssetId: string;
  sourceSha256: string;
  sourceWidthPx: number;
  sourceHeightPx: number;
  analysisWindow: SignStructuralAnalysisWindow | null;
  regions: SignOperatorRegionBoundary[];
}

export type SignOperatorStructuralOverrideResolution =
  | { status: "usable"; segmentation: SignStructuralLayoutSegmentationResult }
  /** Present, but stale (source changed) or structurally invalid against the actual pixels — never used for planning. */
  | { status: "unusable"; reason: string }
  /** No override recorded at all — the ordinary, expected state whenever deterministic segmentation is sufficient. */
  | { status: "absent" };

function colorsMatch(
  a: { r: number; g: number; b: number },
  b: { r: number; g: number; b: number },
  tolerance: number = EDGE_BACKGROUND_TOLERANCE,
): boolean {
  return (
    Math.abs(a.r - b.r) <= tolerance &&
    Math.abs(a.g - b.g) <= tolerance &&
    Math.abs(a.b - b.b) <= tolerance
  );
}

/** Independently measures the dominant colour of ONE row across the domain's full width — refuses (returns `null`) unless that row is itself confidently, opaquely uniform. The same bar `classifyRow` applies for deterministic fill rows; never a lighter standard for operator-marked regions. */
function measureUniformRow(
  image: RgbaImage,
  y: number,
  domainX: number,
  domainWidth: number,
): { r: number; g: number; b: number } | null {
  const line = measureLine(image, domainX, y, 1, 0, domainWidth);
  if (line.dominantColor && line.coverage >= UNIFORM_MIN_COVERAGE && line.transparentFraction === 0) {
    return line.dominantColor;
  }
  return null;
}

/**
 * Independently measures a GAP's own fill colour by checking that every row
 * across its span shares one uniform colour (within `EDGE_BACKGROUND_
 * TOLERANCE` of the first measured row) — never a single-row sample for a
 * multi-row gap, since a gap spanning several rows must be genuinely flat
 * throughout to be trusted as "a single colour represents this space."
 * Returns `null` (refuse) on any non-uniform or non-opaque row, or if the
 * span is empty.
 */
function measureUniformSpan(
  image: RgbaImage,
  startY: number,
  endY: number,
  domainX: number,
  domainWidth: number,
): { r: number; g: number; b: number } | null {
  if (endY <= startY) return null;
  let color: { r: number; g: number; b: number } | null = null;
  for (let y = startY; y < endY; y++) {
    const rowColor = measureUniformRow(image, y, domainX, domainWidth);
    if (!rowColor) return null;
    if (color === null) {
      color = rowColor;
    } else if (!colorsMatch(color, rowColor)) {
      return null;
    }
  }
  return color;
}

/**
 * Validates `override` against the CURRENT source (never trusted from its
 * own embedded identity alone) and, if it holds up, independently measures
 * every fill/gap colour from `image`'s actual pixels to produce a
 * `"measured"` `SignStructuralLayoutSegmentationResult` — otherwise
 * `"unusable"` with an explicit reason. Never returns `"ambiguous"`: an
 * operator override that does not hold up against the real pixels is
 * simply refused, not offered as a softer kind of uncertain evidence.
 */
export function synthesizeSegmentationFromOperatorOverride(
  image: RgbaImage,
  override: SignOperatorStructuralLayoutOverride,
  currentSourceAssetId: string,
  currentSourceSha256: string,
): SignOperatorStructuralOverrideResolution {
  if (
    override.sourceAssetId !== currentSourceAssetId ||
    override.sourceSha256 !== currentSourceSha256 ||
    override.sourceWidthPx !== image.width ||
    override.sourceHeightPx !== image.height
  ) {
    return {
      status: "unusable",
      reason:
        "This operator-confirmed structural evidence was recorded against a different source image (asset, hash, or " +
        "dimensions no longer match the current original) — it can never be reused against a different source.",
    };
  }

  const window = override.analysisWindow;
  if (window) {
    if (
      !Number.isInteger(window.x) ||
      !Number.isInteger(window.y) ||
      !Number.isInteger(window.width) ||
      !Number.isInteger(window.height) ||
      window.width <= 0 ||
      window.height <= 0 ||
      window.x < 0 ||
      window.y < 0 ||
      window.x + window.width > image.width ||
      window.y + window.height > image.height
    ) {
      return { status: "unusable", reason: "The confirmed analysis window is invalid or out of bounds for the current source image." };
    }
  }
  const domain = window ?? { x: 0, y: 0, width: image.width, height: image.height };
  const domainStartY = domain.y;
  const domainEndY = domain.y + domain.height;

  const boundaries = override.regions;
  if (boundaries.length === 0) {
    return { status: "unusable", reason: "No confirmed regions were supplied — at least one is required." };
  }

  // Structural well-formedness: strictly ordered, non-overlapping, and
  // entirely within the analysis domain. Never trusts a caller's own
  // ordering or bounds claims — re-checked here regardless of what a UI
  // already validated client-side.
  let cursor = domainStartY;
  for (let i = 0; i < boundaries.length; i++) {
    const b = boundaries[i]!;
    if (!Number.isInteger(b.startYPx) || !Number.isInteger(b.endYPx) || b.endYPx <= b.startYPx) {
      return { status: "unusable", reason: `Region ${i} has an invalid or zero-height span.` };
    }
    if (b.startYPx < cursor) {
      return { status: "unusable", reason: `Region ${i} overlaps the previous region or the analysis domain's own top edge.` };
    }
    if (b.endYPx > domainEndY) {
      return { status: "unusable", reason: `Region ${i} extends past the analysis domain's own bottom edge.` };
    }
    cursor = b.endYPx;
  }

  const regions: SignStructuralRegion[] = [];
  const gaps: SignStructuralGap[] = [];

  for (let i = 0; i < boundaries.length; i++) {
    const b = boundaries[i]!;
    const isFirst = i === 0;
    const isLast = i === boundaries.length - 1;
    const role = isFirst ? "top_anchor" : isLast ? "bottom_anchor" : "middle";

    const sourceBounds = { startYPx: b.startYPx, heightPx: b.endYPx - b.startYPx };
    // Edge-reaching is DERIVED from position, never trusted from operator
    // input — exactly like the deterministic algorithm's own
    // `owningFillBefore`/`owningFillAfter` never trust anything but the
    // measured run's own start/end against the domain edge.
    const touchesTop = isFirst && b.startYPx === domainStartY;
    const touchesBottom = isLast && b.endYPx === domainEndY;
    const fillEdgeReaching = touchesTop || touchesBottom;

    let contentBounds = sourceBounds;
    let fillColor: { r: number; g: number; b: number } | null = null;

    if (role === "middle") {
      if (b.contentStartYPx !== null || b.contentEndYPx !== null) {
        return { status: "unusable", reason: `Region ${i} is a middle region and must not supply a separate content span.` };
      }
      // No owned fill for a middle region, exactly like the deterministic
      // V1 convention — contentBounds already equals sourceBounds.
    } else if (fillEdgeReaching) {
      if (b.contentStartYPx === null || b.contentEndYPx === null) {
        return {
          status: "unusable",
          reason: `Region ${i} (${role}) touches the analysis domain's own edge and requires its own confirmed content span.`,
        };
      }
      if (
        !Number.isInteger(b.contentStartYPx) ||
        !Number.isInteger(b.contentEndYPx) ||
        b.contentEndYPx <= b.contentStartYPx ||
        b.contentStartYPx < b.startYPx ||
        b.contentEndYPx > b.endYPx
      ) {
        return { status: "unusable", reason: `Region ${i}'s confirmed content span is invalid or not contained within its own region span.` };
      }
      contentBounds = { startYPx: b.contentStartYPx, heightPx: b.contentEndYPx - b.contentStartYPx };

      // Independently measure this anchor's own fill span — the rows
      // strictly outside contentBounds but inside sourceBounds, on the
      // edge-touching side. Never trust the operator's own colour claim;
      // there isn't one — colour is always measured.
      const fillStart = touchesTop ? b.startYPx : b.contentEndYPx;
      const fillEnd = touchesTop ? b.contentStartYPx : b.endYPx;
      const measured = measureUniformSpan(image, fillStart, fillEnd, domain.x, domain.width);
      if (!measured) {
        return {
          status: "unusable",
          reason: `Region ${i}'s (${role}) claimed fill span (rows ${fillStart}-${fillEnd - 1}) is not an affirmatively uniform colour in the actual source — the confirmed boundary does not hold up against the real pixels.`,
        };
      }
      fillColor = measured;
    } else if (b.contentStartYPx !== null || b.contentEndYPx !== null) {
      return {
        status: "unusable",
        reason: `Region ${i} (${role}) does not touch the analysis domain's own edge and must not supply a separate content span.`,
      };
    }

    regions.push({
      id: `operator-region-${i}`,
      sourceBounds,
      contentBounds,
      role,
      fillColor,
      fillEdgeReaching,
      expandable: fillEdgeReaching,
    });

    if (i < boundaries.length - 1) {
      const next = boundaries[i + 1]!;
      const gapStart = b.endYPx;
      const gapEnd = next.startYPx;
      if (gapEnd <= gapStart) {
        return {
          status: "unusable",
          reason: `No gap exists between region ${i} and region ${i + 1} — two directly adjacent confirmed regions with no separating space are not a supported shape (they should be confirmed as one region instead).`,
        };
      }
      const gapColor = measureUniformSpan(image, gapStart, gapEnd, domain.x, domain.width);
      if (!gapColor) {
        return {
          status: "unusable",
          reason: `The space between region ${i} and region ${i + 1} (rows ${gapStart}-${gapEnd - 1}) is not an affirmatively uniform colour in the actual source.`,
        };
      }
      gaps.push({ sourceHeightPx: gapEnd - gapStart, fillColor: gapColor });
    }
  }

  return { status: "usable", segmentation: { status: "measured", regions, gaps, analysisWindow: window } };
}

/**
 * Resolves a `SignPreparation`'s persisted `operatorStructuralOverride`
 * (a loosely-typed `Record<string, unknown>`, narrowed here) into a
 * `SignOperatorStructuralOverrideResolution` — the single entry point
 * `sign-preparation-capability.ts`'s planning orchestration uses, never
 * reading the raw persisted field directly. `"absent"` for `null`/`undefined`
 * (nothing recorded); a malformed persisted shape (should be unreachable in
 * practice, since only this module's own writer ever constructs one) is
 * treated as `"unusable"` rather than throwing.
 */
export function resolveOperatorStructuralOverride(
  image: RgbaImage,
  raw: Record<string, unknown> | null,
  currentSourceAssetId: string,
  currentSourceSha256: string,
): SignOperatorStructuralOverrideResolution {
  if (!raw) return { status: "absent" };
  const override = raw as unknown as SignOperatorStructuralLayoutOverride;
  if (
    typeof override.sourceAssetId !== "string" ||
    typeof override.sourceSha256 !== "string" ||
    typeof override.sourceWidthPx !== "number" ||
    typeof override.sourceHeightPx !== "number" ||
    !Array.isArray(override.regions)
  ) {
    return { status: "unusable", reason: "The recorded operator structural evidence is malformed." };
  }
  return synthesizeSegmentationFromOperatorOverride(image, override, currentSourceAssetId, currentSourceSha256);
}
