/**
 * Blank observation document factory — never encodes expected physical outcomes.
 */

import type {
  CalibrationObservationDocument,
  CalibrationRunMetadata,
  CalibrationSheetId,
  SpecimenManifestEntry,
  SpecimenObservation,
} from "./types";

export const OBSERVATION_SCHEMA_VERSION = "dtf_physical_calibration_observation_v1";

export function blankRunMetadata(): CalibrationRunMetadata {
  return {
    date: null,
    printer: null,
    dtfSystemProvider: null,
    ripSoftware: null,
    film: null,
    ink: null,
    powder: null,
    cureSettings: null,
    pressTemperature: null,
    pressTime: null,
    pressPressure: null,
    peelProcedure: null,
    garmentBrandModel: null,
    garmentMaterial: null,
    garmentColor: null,
    operator: null,
    notes: null,
  };
}

export function blankSpecimenObservation(specimenId: string): SpecimenObservation {
  return {
    specimenId,
    survived: null,
    outcome: "not_evaluated",
    visuallyFaithful: null,
    edgeQuality: "not_evaluated",
    negativeSpace: "not_evaluated",
    textLegibility: "not_evaluated",
    tonalAppearance: null,
    photoReferenceId: null,
    notes: null,
    subjective: {
      handRelativeToPair: "not_evaluated",
      flexibility: null,
      breathabilityPerception: null,
      surfaceFeel: null,
      visualVibrancy: null,
      garmentIntegration: null,
    },
  };
}

export function buildBlankObservationDocument(
  sheetId: CalibrationSheetId | "ALL",
  specimens: SpecimenManifestEntry[],
): CalibrationObservationDocument {
  return {
    schemaVersion: OBSERVATION_SCHEMA_VERSION,
    sheetId,
    run: blankRunMetadata(),
    specimens: specimens.map((s) => blankSpecimenObservation(s.id)),
  };
}

/** Lightweight structural validation for filled observation docs. */
export function validateObservationDocument(doc: unknown): string[] {
  const errors: string[] = [];
  if (!doc || typeof doc !== "object") {
    return ["document must be an object"];
  }
  const d = doc as CalibrationObservationDocument;
  if (d.schemaVersion !== OBSERVATION_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${OBSERVATION_SCHEMA_VERSION}`);
  }
  if (!d.run || typeof d.run !== "object") errors.push("run metadata missing");
  if (!Array.isArray(d.specimens)) errors.push("specimens must be an array");
  else {
    for (const s of d.specimens) {
      if (!s.specimenId) errors.push("specimen missing specimenId");
    }
  }
  return errors;
}
