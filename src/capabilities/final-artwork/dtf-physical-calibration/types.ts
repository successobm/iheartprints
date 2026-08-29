/**
 * Manifest + observation types for DTF physical calibration.
 *
 * Manifests describe GENERATED geometry (objective).
 * Observations record PHYSICAL print results (filled after printing).
 * Neither encodes expected pass/fail for physical survival.
 */

import type { DtfCoverageMeasurement } from "../dtf-coverage";
import type { FeatureIntegrityMeasurement } from "../feature-integrity";

export type CalibrationSheetId = "SHEET_A" | "SHEET_B" | "SHEET_C";

export type SpecimenCategory =
  | "positive_stroke"
  | "diagonal_curve"
  | "negative_space"
  | "isolated_component"
  | "typography"
  | "distress"
  | "partial_alpha"
  | "continuous_coverage"
  | "halftone"
  | "raster_vs_halftone"
  | "experimental_hybrid"
  | "label";

export interface PhysicalSize {
  requestedMm: number | null;
  actualPx: number | null;
  actualMm: number | null;
}

export interface SpecimenBounds {
  x: number;
  y: number;
  widthPx: number;
  heightPx: number;
}

export interface SpecimenManifestEntry {
  id: string;
  sheetId: CalibrationSheetId;
  category: SpecimenCategory;
  label: string;
  bounds: SpecimenBounds;
  requested?: Record<string, number | string | boolean | null>;
  physical?: {
    width?: PhysicalSize;
    height?: PhysicalSize;
    diameter?: PhysicalSize;
    stroke?: PhysicalSize;
    channel?: PhysicalSize;
  };
  rgba?: { r: number; g: number; b: number; a: number };
  typography?: {
    text: string;
    style: string;
    nominalCapHeightMm: number;
    nominalStrokeMm: number;
    renderedCapHeightPx: number;
    renderedStrokePx: number;
    note: string;
  };
  halftone?: {
    lpi: number;
    angleDeg: number;
    dotShape: string;
    midtone: number;
    chokePx: number;
    garmentHex: string;
    algorithmVersion: string;
  };
  pair?: {
    role: "raster" | "halftone" | "hybrid_experimental";
    pairGroupId: string;
  };
  experimental?: boolean;
  notes?: string[];
}

export interface SheetManifest {
  sheetId: CalibrationSheetId;
  title: string;
  algorithmVersion: string;
  ppi: number;
  widthIn: number;
  heightIn: number;
  widthPx: number;
  heightPx: number;
  specimenCount: number;
  specimens: SpecimenManifestEntry[];
  featureIntegrity: FeatureIntegrityMeasurement | null;
  coverage: DtfCoverageMeasurement | null;
  generatedAtIso: string;
  warnings: string[];
}

export interface CalibrationBundleManifest {
  bundleVersion: string;
  profileReference: string;
  note: string;
  sheets: SheetManifest[];
}

/** Run-level observation metadata — filled by the printer/operator after physical production. */
export interface CalibrationRunMetadata {
  date: string | null;
  printer: string | null;
  dtfSystemProvider: string | null;
  ripSoftware: string | null;
  film: string | null;
  ink: string | null;
  powder: string | null;
  cureSettings: string | null;
  pressTemperature: string | null;
  pressTime: string | null;
  pressPressure: string | null;
  peelProcedure: string | null;
  garmentBrandModel: string | null;
  garmentMaterial: string | null;
  /** Critical for halftone integration comparisons. */
  garmentColor: string | null;
  operator: string | null;
  notes: string | null;
}

export type SurvivalOutcome = "complete" | "partial" | "failed" | "not_evaluated";
export type NegativeSpaceOutcome = "open" | "partial" | "closed" | "not_applicable" | "not_evaluated";
export type SubjectiveHand =
  | "noticeably_lighter"
  | "slightly_lighter"
  | "similar"
  | "slightly_heavier"
  | "noticeably_heavier"
  | "not_evaluated";

export interface SpecimenObservation {
  specimenId: string;
  survived: boolean | null;
  outcome: SurvivalOutcome;
  visuallyFaithful: boolean | null;
  edgeQuality: "clean" | "ragged" | "blurred" | "halo" | "not_evaluated" | null;
  negativeSpace: NegativeSpaceOutcome | null;
  textLegibility: "legible" | "marginal" | "illegible" | "not_applicable" | "not_evaluated" | null;
  tonalAppearance: string | null;
  photoReferenceId: string | null;
  notes: string | null;
  /** SUBJECTIVE — not a pixel measurement. */
  subjective?: {
    handRelativeToPair?: SubjectiveHand;
    flexibility?: string | null;
    breathabilityPerception?: string | null;
    surfaceFeel?: string | null;
    visualVibrancy?: string | null;
    garmentIntegration?: string | null;
  };
}

export interface CalibrationObservationDocument {
  schemaVersion: string;
  sheetId: CalibrationSheetId | "ALL";
  run: CalibrationRunMetadata;
  specimens: SpecimenObservation[];
}
