/**
 * DTF Physical Calibration Phase 2B — sheet generation orchestrator.
 *
 * Pure generation + measurement. Writing PNG/JSON to disk is the CLI's job.
 */

import { PNG } from "pngjs";

import {
  DTF_FEATURE_INTEGRITY_PROFILE_VERSION,
  DTF_NEGATIVE_SPACE_BLOCKING_WIDTH_MM,
  DTF_NEGATIVE_SPACE_WARNING_WIDTH_MM,
  DTF_POSITIVE_FEATURE_BLOCKING_WIDTH_MM,
  DTF_POSITIVE_FEATURE_WARNING_WIDTH_MM,
} from "@/capabilities/shared/dtf-feature-integrity-profile";

import { measureDtfCoverage } from "../dtf-coverage";
import { measureFeatureIntegrity } from "../feature-integrity";
import type { RgbaImage } from "../raster-transform";
import { buildBlankObservationDocument } from "./observation";
import { generateSheetA } from "./sheet-a";
import { generateSheetB } from "./sheet-b";
import { generateSheetC } from "./sheet-c";
import type {
  CalibrationBundleManifest,
  CalibrationObservationDocument,
  CalibrationSheetId,
  SheetManifest,
  SpecimenManifestEntry,
} from "./types";
import { CALIBRATION_PPI } from "./units";

export const CALIBRATION_BUNDLE_VERSION = "dtf_physical_calibration_v1";
export const CALIBRATION_ALGORITHM_VERSION = "dtf_physical_calibration_generator_v1";

export interface GeneratedCalibrationSheet {
  sheetId: CalibrationSheetId;
  title: string;
  image: RgbaImage;
  pngBytes: Buffer;
  manifest: SheetManifest;
  observationTemplate: CalibrationObservationDocument;
}

export interface GeneratedCalibrationBundle {
  sheets: GeneratedCalibrationSheet[];
  bundleManifest: CalibrationBundleManifest;
  combinedObservationTemplate: CalibrationObservationDocument;
  experimentalHybridIncluded: boolean;
  summary: {
    sheetCount: number;
    specimenCounts: Record<CalibrationSheetId, number>;
    totalSpecimens: number;
  };
}

function encodeRgbaPng(image: RgbaImage): Buffer {
  const png = new PNG({ width: image.width, height: image.height });
  image.data.copy(png.data);
  return PNG.sync.write(png);
}

function measureSheet(
  image: RgbaImage,
  widthIn: number,
  heightIn: number,
): Pick<SheetManifest, "featureIntegrity" | "coverage" | "warnings"> {
  const warnings: string[] = [];
  const featureIntegrity = measureFeatureIntegrity({
    image,
    confirmedWidthIn: widthIn,
    confirmedHeightIn: heightIn,
    positiveFeatureThresholds: {
      blockingFloorMm: DTF_POSITIVE_FEATURE_BLOCKING_WIDTH_MM,
      warningFloorMm: DTF_POSITIVE_FEATURE_WARNING_WIDTH_MM,
    },
    negativeSpaceThresholds: {
      blockingFloorMm: DTF_NEGATIVE_SPACE_BLOCKING_WIDTH_MM,
      warningFloorMm: DTF_NEGATIVE_SPACE_WARNING_WIDTH_MM,
    },
  });
  const coverage = measureDtfCoverage({
    image,
    confirmedWidthIn: widthIn,
    confirmedHeightIn: heightIn,
  });
  warnings.push(
    "This calibration plate intentionally contains near-floor / failing geometry — Feature Integrity classifications are diagnostic, not production readiness.",
  );
  if (featureIntegrity.limitations.length > 0) {
    warnings.push(...featureIntegrity.limitations);
  }
  if (coverage.limitations.length > 0) {
    warnings.push(...coverage.limitations);
  }
  return { featureIntegrity, coverage, warnings };
}

/**
 * Generate all calibration sheets deterministically.
 * `generatedAtIso` may be injected for stable test snapshots of the manifest envelope.
 */
export function generateCalibrationBundle(options?: {
  generatedAtIso?: string;
  /** When false, skip Feature Integrity / Coverage (fast unit tests). Default true. */
  measureDiagnostics?: boolean;
}): GeneratedCalibrationBundle {
  const generatedAtIso = options?.generatedAtIso ?? new Date().toISOString();
  const measureDiagnostics = options?.measureDiagnostics !== false;

  const a = generateSheetA();
  const b = generateSheetB();
  const c = generateSheetC();

  const wrap = (
    sheetId: CalibrationSheetId,
    title: string,
    image: RgbaImage,
    specimens: SpecimenManifestEntry[],
    widthIn: number,
    heightIn: number,
  ): GeneratedCalibrationSheet => {
    const measured = measureDiagnostics
      ? measureSheet(image, widthIn, heightIn)
      : { featureIntegrity: null, coverage: null, warnings: ["Diagnostics skipped (measureDiagnostics=false)."] };
    const pngBytes = encodeRgbaPng(image);
    const manifest: SheetManifest = {
      sheetId,
      title,
      algorithmVersion: CALIBRATION_ALGORITHM_VERSION,
      ppi: CALIBRATION_PPI,
      widthIn,
      heightIn,
      widthPx: image.width,
      heightPx: image.height,
      specimenCount: specimens.length,
      specimens,
      featureIntegrity: measured.featureIntegrity,
      coverage: measured.coverage,
      generatedAtIso,
      warnings: measured.warnings,
    };
    return {
      sheetId,
      title,
      image,
      pngBytes,
      manifest,
      observationTemplate: buildBlankObservationDocument(sheetId, specimens),
    };
  };

  const sheetA = wrap("SHEET_A", "Feature Survival", a.image, a.specimens, a.widthIn, a.heightIn);
  const sheetB = wrap(
    "SHEET_B",
    "Alpha / Tonal / Coverage / Halftone",
    b.image,
    b.specimens,
    b.widthIn,
    b.heightIn,
  );
  const sheetC = wrap(
    "SHEET_C",
    "Raster vs Halftone",
    c.image,
    c.specimens,
    c.widthIn,
    c.heightIn,
  );

  const sheets = [sheetA, sheetB, sheetC];
  const allSpecimens = sheets.flatMap((s) => s.manifest.specimens);

  const bundleManifest: CalibrationBundleManifest = {
    bundleVersion: CALIBRATION_BUNDLE_VERSION,
    profileReference: DTF_FEATURE_INTEGRITY_PROFILE_VERSION,
    note:
      "Provisional DTF thresholds are engineering assumptions. Physical print observations must exist before any profile calibration. This bundle does not encode expected physical pass/fail.",
    sheets: sheets.map((s) => s.manifest),
  };

  return {
    sheets,
    bundleManifest,
    combinedObservationTemplate: buildBlankObservationDocument("ALL", allSpecimens),
    experimentalHybridIncluded: c.experimentalHybridIncluded,
    summary: {
      sheetCount: sheets.length,
      specimenCounts: {
        SHEET_A: sheetA.manifest.specimenCount,
        SHEET_B: sheetB.manifest.specimenCount,
        SHEET_C: sheetC.manifest.specimenCount,
      },
      totalSpecimens: allSpecimens.length,
    },
  };
}

/** Assert every specimen id is unique and every bounds rectangle sits on-canvas. */
export function assertManifestIntegrity(manifest: SheetManifest): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const s of manifest.specimens) {
    if (seen.has(s.id)) errors.push(`duplicate specimen id ${s.id}`);
    seen.add(s.id);
    if (s.bounds.x < 0 || s.bounds.y < 0) errors.push(`${s.id} has negative origin`);
    if (s.bounds.x + s.bounds.widthPx > manifest.widthPx + 1) {
      errors.push(`${s.id} exceeds sheet width`);
    }
    if (s.bounds.y + s.bounds.heightPx > manifest.heightPx + 1) {
      errors.push(`${s.id} exceeds sheet height`);
    }
  }
  return errors;
}
