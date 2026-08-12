/**
 * Existing Artwork → Print Ready Phase 1.7: the ordered cleanup-operation log.
 *
 * One lineage for both Select Area (region / cavity) and Magic Select
 * (connected colour). Stored in the existing `guided_cleanup` JSONB column —
 * no migration. Records without `kind` are treated as region ops so older
 * preparations replay unchanged.
 *
 * Replay is a pure function of (immutable original, background model, ops).
 */

import type { RgbaImage } from "@/capabilities/final-artwork/raster-transform";

import {
  isolateBackground,
  passThroughTransparentArtwork,
  previewGuidedRemovalAt,
  resolveGuidedRemovalAt,
} from "./background-isolation";
import type { RgbColor } from "./contracts";
import type {
  GuidedRemovalApplication,
  GuidedRemovalPoint,
  GuidedRemovalRecord,
} from "./guided-removal";
import {
  eraseMagicSelection,
  MAGIC_SELECT_RULE_V1,
  selectMagicColorByMode,
  type MagicSelectionMode,
} from "./magic-color-selection";

export type GuidedCleanupTool = "region" | "magic_select";

/** Select Area — enclosed declined cavity region (Phase 1.2/1.3). */
export interface GuidedRegionCleanupOperation extends GuidedRemovalRecord {
  kind?: "region";
}

/** Magic Select — connected or magnetic similar colour from a click. */
export interface GuidedMagicColorCleanupOperation {
  kind: "magic_color";
  point: GuidedRemovalPoint;
  tolerance: number;
  /** Resolved at preview time; replay must not re-infer this. */
  selectionMode: MagicSelectionMode;
  ruleVersion: string;
  /** True iff `selectionMode === "connected"` (Phase 1.7 field). */
  connectedOnly: boolean;
  referenceColor: RgbColor;
  selectionKey: string;
  pixelCount: number;
}

export type GuidedCleanupOperation =
  | GuidedRegionCleanupOperation
  | GuidedMagicColorCleanupOperation;

export function isMagicColorOperation(
  op: GuidedCleanupOperation,
): op is GuidedMagicColorCleanupOperation {
  return op.kind === "magic_color";
}

export function isRegionOperation(
  op: GuidedCleanupOperation,
): op is GuidedRegionCleanupOperation {
  return !isMagicColorOperation(op);
}

export function regionOperations(
  ops: readonly GuidedCleanupOperation[],
): GuidedRemovalRecord[] {
  return ops.filter(isRegionOperation).map((op) => ({
    point: op.point,
    regionKey: op.regionKey,
    pixelCount: op.pixelCount,
  }));
}

/**
 * Narrows the loosely-typed `guided_cleanup` column into an ordered op log.
 * Malformed entries are dropped — never trusted as-is; every op re-resolves
 * against real bytes on derive.
 */
export function parseGuidedCleanupOperations(
  stored: unknown,
): GuidedCleanupOperation[] {
  if (!stored || typeof stored !== "object") return [];
  const removals = (stored as { removals?: unknown }).removals;
  if (!Array.isArray(removals)) return [];

  return removals.flatMap((raw): GuidedCleanupOperation[] => {
    if (!raw || typeof raw !== "object") return [];
    const removal = raw as Record<string, unknown>;
    const point = removal.point as { x?: unknown; y?: unknown } | undefined;
    const x = point?.x;
    const y = point?.y;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return [];

    const floored = { x: Math.floor(x as number), y: Math.floor(y as number) };

    if (removal.kind === "magic_color") {
      const tolerance = removal.tolerance;
      const selectionKey = removal.selectionKey;
      const pixelCount = removal.pixelCount;
      const referenceColor = removal.referenceColor as
        | { r?: unknown; g?: unknown; b?: unknown }
        | undefined;
      if (
        typeof selectionKey !== "string" ||
        selectionKey.length === 0 ||
        !Number.isFinite(tolerance) ||
        !Number.isFinite(pixelCount) ||
        !Number.isFinite(referenceColor?.r) ||
        !Number.isFinite(referenceColor?.g) ||
        !Number.isFinite(referenceColor?.b)
      ) {
        return [];
      }
      const selectionMode: MagicSelectionMode =
        removal.selectionMode === "similar" ? "similar" : "connected";
      const ruleVersion =
        typeof removal.ruleVersion === "string" && removal.ruleVersion.length > 0
          ? removal.ruleVersion
          : MAGIC_SELECT_RULE_V1;
      return [
        {
          kind: "magic_color",
          point: floored,
          tolerance: Math.floor(tolerance as number),
          selectionMode,
          ruleVersion,
          connectedOnly: selectionMode === "connected",
          referenceColor: {
            r: Math.floor(referenceColor!.r as number),
            g: Math.floor(referenceColor!.g as number),
            b: Math.floor(referenceColor!.b as number),
          },
          selectionKey,
          pixelCount: Math.floor(pixelCount as number),
        },
      ];
    }

    return [
      {
        kind: "region",
        point: floored,
        regionKey: typeof removal.regionKey === "string" ? removal.regionKey : "",
        pixelCount: Number.isFinite(removal.pixelCount)
          ? Math.floor(removal.pixelCount as number)
          : 0,
      },
    ];
  });
}

export interface PreparedDeriveInput {
  image: RgbaImage;
  backgroundColor: RgbColor;
  tolerance: number;
  /** When true, skip isolation and only apply magic ops on a copy. */
  alreadyTransparent: boolean;
  operations: readonly GuidedCleanupOperation[];
}

export interface PreparedDeriveResult {
  image: RgbaImage;
  /** Isolation diagnostics from the automatic (+ region-only) path. */
  record: ReturnType<typeof isolateBackground>["record"];
  cavities: ReturnType<typeof isolateBackground>["cavities"];
  speckle: ReturnType<typeof isolateBackground>["speckle"];
  /** Accepted ops in order — what must be persisted. */
  applied: GuidedCleanupOperation[];
  /** Region-shaped application mirror for asset metadata compatibility. */
  guided: GuidedRemovalApplication;
}

/**
 * Deterministic prepared-bytes derivation.
 *
 * Region-only histories keep the classic `isolateBackground(...guided points)`
 * path so existing fixtures stay byte-identical.
 *
 * Histories that include Magic Select start from automatic isolation, then
 * apply every op in order on the working RGBA buffer.
 */
export function derivePreparedFromOperations(
  input: PreparedDeriveInput,
): PreparedDeriveResult {
  const { image, backgroundColor, tolerance, alreadyTransparent, operations } =
    input;
  const model = { backgroundColor, tolerance };

  if (alreadyTransparent) {
    const base = passThroughTransparentArtwork(image, backgroundColor, tolerance);
    return applyOperationsOnWorking({
      working: base.image,
      baseRecord: base.record,
      cavities: base.cavities,
      speckle: base.speckle,
      sourceForRegions: image,
      model,
      operations,
    });
  }

  const hasMagic = operations.some(isMagicColorOperation);
  if (!hasMagic) {
    const isolated = isolateBackground(image, {
      backgroundColor,
      tolerance,
      guidedRemovalPoints: operations.map((op) => op.point),
    });
    const applied: GuidedCleanupOperation[] = isolated.guided.applied.map(
      (record) => ({
        kind: "region" as const,
        point: record.point,
        regionKey: record.regionKey,
        pixelCount: record.pixelCount,
      }),
    );
    return {
      image: isolated.image,
      record: isolated.record,
      cavities: isolated.cavities,
      speckle: isolated.speckle,
      applied,
      guided: isolated.guided,
    };
  }

  const automatic = isolateBackground(image, {
    backgroundColor,
    tolerance,
    guidedRemovalPoints: [],
  });
  return applyOperationsOnWorking({
    working: automatic.image,
    baseRecord: automatic.record,
    cavities: automatic.cavities,
    speckle: automatic.speckle,
    sourceForRegions: image,
    model,
    operations,
  });
}

function applyOperationsOnWorking(input: {
  working: RgbaImage;
  baseRecord: ReturnType<typeof isolateBackground>["record"];
  cavities: ReturnType<typeof isolateBackground>["cavities"];
  speckle: ReturnType<typeof isolateBackground>["speckle"];
  sourceForRegions: RgbaImage;
  model: { backgroundColor: RgbColor; tolerance: number };
  operations: readonly GuidedCleanupOperation[];
}): PreparedDeriveResult {
  const working: RgbaImage = {
    width: input.working.width,
    height: input.working.height,
    data: Buffer.from(input.working.data),
  };

  const applied: GuidedCleanupOperation[] = [];
  const regionApplied: GuidedRemovalRecord[] = [];
  let guidedPixelCount = 0;

  for (const op of input.operations) {
    if (isMagicColorOperation(op)) {
      if (applied.some((prior) => isMagicColorOperation(prior) && prior.selectionKey === op.selectionKey)) {
        continue;
      }
      const result = selectMagicColorByMode(
        working,
        op.point,
        op.tolerance,
        op.selectionMode,
      );
      if (result.outcome !== "eligible" || !result.selection) continue;
      // Replay integrity: persisted key/count/mode must match re-selection.
      if (
        result.selection.selectionKey !== op.selectionKey ||
        result.selection.pixelCount !== op.pixelCount ||
        result.selection.tolerance !== op.tolerance ||
        result.selection.selectionMode !== op.selectionMode
      ) {
        continue;
      }
      eraseMagicSelection(working, result.selection.mask);
      applied.push({
        kind: "magic_color",
        point: result.selection.point,
        tolerance: result.selection.tolerance,
        selectionMode: result.selection.selectionMode,
        ruleVersion: result.selection.ruleVersion,
        connectedOnly: result.selection.connectedOnly,
        referenceColor: result.selection.referenceColor,
        selectionKey: result.selection.selectionKey,
        pixelCount: result.selection.pixelCount,
      });
      guidedPixelCount += result.selection.pixelCount;
      continue;
    }

    if (regionApplied.some((record) => record.regionKey === op.regionKey && op.regionKey)) {
      continue;
    }
    const resolution = resolveGuidedRemovalAt(input.sourceForRegions, op.point, {
      backgroundColor: input.model.backgroundColor,
      tolerance: input.model.tolerance,
      applied: regionApplied,
    });
    if (resolution.outcome !== "eligible" || !resolution.region) continue;

    // Erase the cavity on the WORKING prepared image (post-automatic). Region
    // pixels are already known from the original candidate map via re-resolve;
    // walk the working buffer and clear anything still visible at those coords
    // by re-identifying through preview path: use region bounds + key via
    // resolve's region pixelCount — we need the actual pixels. Re-use
    // identify by building candidates would be needed. resolveGuidedRemovalAt
    // only returns bounds/count. For erase we need labels.
    //
    // Practical approach: flood the ORIGINAL candidate region by calling
    // selectConnectedMagicColor is wrong. Use isolateBackground's guided
    // application on a throwaway... Better: import previewGuidedRemovalAt's
    // candidates. Export erase from guided-removal apply one region.
    eraseRegionByRecomputing(input.sourceForRegions, working, op.point, {
      backgroundColor: input.model.backgroundColor,
      tolerance: input.model.tolerance,
      applied: regionApplied,
    });

    const record: GuidedRemovalRecord = {
      point: { x: Math.floor(op.point.x), y: Math.floor(op.point.y) },
      regionKey: resolution.region.regionKey,
      pixelCount: resolution.region.pixelCount,
    };
    regionApplied.push(record);
    applied.push({ kind: "region", ...record });
    guidedPixelCount += record.pixelCount;
  }

  const guided: GuidedRemovalApplication = {
    mask: new Uint8Array(working.width * working.height),
    applied: regionApplied,
    rejected: [],
    removedRegionCount: regionApplied.length,
    removedPixelCount: guidedPixelCount,
  };

  const magicCount = applied.filter(isMagicColorOperation).length;
  const record = {
    ...input.baseRecord,
    guidedRegionsRemoved: regionApplied.length + magicCount,
    guidedPixelsRemoved: guidedPixelCount,
  };

  return {
    image: working,
    record,
    cavities: input.cavities,
    speckle: input.speckle,
    applied,
    guided,
  };
}

/**
 * Clears one eligible cavity region on `working` by walking the ORIGINAL
 * candidate label map (region identity is defined on the original).
 */
function eraseRegionByRecomputing(
  original: RgbaImage,
  working: RgbaImage,
  point: GuidedRemovalPoint,
  options: {
    backgroundColor: RgbColor;
    tolerance: number;
    applied: readonly GuidedRemovalRecord[];
  },
): void {
  const preview = previewGuidedRemovalAt(original, point, options);
  if (preview.resolution.outcome !== "eligible" || !preview.resolution.region) {
    return;
  }
  const labelIndex = preview.candidates.keys.indexOf(
    preview.resolution.region.regionKey,
  );
  if (labelIndex < 0) return;

  const { width, height } = working;
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    if (preview.candidates.labels[pixel] !== labelIndex) continue;
    working.data[pixel * 4 + 3] = 0;
  }
}
