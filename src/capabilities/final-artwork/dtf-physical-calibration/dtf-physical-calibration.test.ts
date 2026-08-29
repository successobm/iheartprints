import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { before, describe, it } from "node:test";
import { PNG } from "pngjs";

import { measureDtfCoverage } from "../dtf-coverage";
import { measureFeatureIntegrity } from "../feature-integrity";
import {
  ALPHA_LEVELS,
  assertManifestIntegrity,
  CALIBRATION_PPI,
  DISTRESS_SEED,
  generateCalibrationBundle,
  POSITIVE_WIDTHS_MM,
  quantizePhysicalWidthMm,
  validateObservationDocument,
  mmToExactPx,
  pxToMm,
  type GeneratedCalibrationBundle,
} from "./index";
import { createTransparentCanvas, drawHLine, INK_BLACK } from "./draw";
import { generateSheetA } from "./sheet-a";

const FAST = { generatedAtIso: "2026-01-01T00:00:00.000Z", measureDiagnostics: false as const };

describe("dtf physical calibration units", () => {
  it("uses the same mm↔px relationship Feature Integrity assumes at 300 PPI", () => {
    const exact = mmToExactPx(0.4);
    assert.ok(Math.abs(exact - (0.4 * CALIBRATION_PPI) / 25.4) < 1e-10);
    const q = quantizePhysicalWidthMm(0.4);
    assert.equal(q.actualPx, Math.max(1, Math.round(exact)));
    assert.equal(q.actualMm, pxToMm(q.actualPx));
    assert.notEqual(q.requestedMm, q.actualMm);
  });

  it("never claims sub-pixel requested widths survive exactly", () => {
    const q = quantizePhysicalWidthMm(0.1);
    assert.equal(q.actualPx, Math.max(1, Math.round(mmToExactPx(0.1))));
    assert.equal(q.actualMm, pxToMm(q.actualPx));
    assert.notEqual(q.actualMm, q.requestedMm);
  });
});

describe("dtf physical calibration generation", () => {
  let bundle: GeneratedCalibrationBundle;
  let bundleAgain: GeneratedCalibrationBundle;

  before(() => {
    bundle = generateCalibrationBundle(FAST);
    bundleAgain = generateCalibrationBundle(FAST);
  });

  it("is deterministic byte-for-byte across two runs with fixed timestamp", () => {
    assert.equal(bundle.sheets.length, 3);
    for (let i = 0; i < 3; i += 1) {
      assert.equal(
        createHash("sha256").update(bundle.sheets[i]!.pngBytes).digest("hex"),
        createHash("sha256").update(bundleAgain.sheets[i]!.pngBytes).digest("hex"),
      );
      assert.equal(bundle.sheets[i]!.manifest.specimenCount, bundleAgain.sheets[i]!.manifest.specimenCount);
    }
  });

  it("emits stable unique specimen IDs and on-canvas bounds", () => {
    const ids = new Set<string>();
    for (const sheet of bundle.sheets) {
      assert.deepEqual(assertManifestIntegrity(sheet.manifest), []);
      for (const s of sheet.manifest.specimens) {
        assert.equal(ids.has(s.id), false, `duplicate ${s.id}`);
        ids.add(s.id);
      }
    }
    assert.ok(ids.has("POS-H-040"));
    assert.ok(ids.has("NEG-H-035"));
    assert.ok(ids.has("ISO-DOT-060"));
    assert.ok(ids.has("ALPHA-LINE-128"));
    assert.ok(ids.has("HT-35LPI-50"));
    assert.ok(ids.has("PAIR-LOGO-R"));
    assert.ok(ids.has("PAIR-LOGO-H"));
    assert.ok(ids.has("HYBRID-EXP-01"));
    assert.ok(ids.has("DIST-BLOCK-01"));
    assert.equal(DISTRESS_SEED, 0x2b4c_a1b7);
  });

  it("records requested vs actual physical dimensions for the positive ladder", () => {
    const sheet = generateSheetA();
    for (const mm of POSITIVE_WIDTHS_MM) {
      const id = `POS-H-${String(Math.round(mm * 100)).padStart(3, "0")}`;
      const specimen = sheet.specimens.find((s) => s.id === id);
      assert.ok(specimen, id);
      assert.equal(specimen!.physical?.stroke?.requestedMm, mm);
      assert.ok((specimen!.physical?.stroke?.actualPx ?? 0) >= 1);
      assert.ok((specimen!.physical?.stroke?.actualMm ?? 0) > 0);
    }
  });

  it("integrates Feature Integrity + Coverage on a calibration-scale mini plate", () => {
    const widthIn = 1;
    const heightIn = 1;
    const image = createTransparentCanvas(300, 300);
    const q = quantizePhysicalWidthMm(0.4);
    drawHLine(image, 20, 280, 150, q.actualPx, INK_BLACK);
    const fi = measureFeatureIntegrity({
      image,
      confirmedWidthIn: widthIn,
      confirmedHeightIn: heightIn,
      positiveFeatureThresholds: { blockingFloorMm: 0.4, warningFloorMm: 1.0 },
    });
    const cov = measureDtfCoverage({ image, confirmedWidthIn: widthIn, confirmedHeightIn: heightIn });
    assert.ok(fi.positive.globalMinStrokeWidthMm !== null);
    assert.ok(Math.abs((fi.positive.globalMinStrokeWidthMm ?? 0) - q.actualMm) < 0.15);
    assert.ok(cov.strongInkCoverageFraction > 0);
    assert.ok(cov.strongInkCoverageFraction < 1);
  });

  it("records raster vs halftone pair metadata and experimental hybrid flag", () => {
    assert.equal(bundle.experimentalHybridIncluded, true);
    const sheetC = bundle.sheets.find((s) => s.sheetId === "SHEET_C")!;
    const raster = sheetC.manifest.specimens.find((s) => s.id === "PAIR-GRAD-R");
    const ht = sheetC.manifest.specimens.find((s) => s.id === "PAIR-GRAD-H");
    assert.equal(raster?.pair?.role, "raster");
    assert.equal(ht?.pair?.role, "halftone");
    assert.equal(raster?.pair?.pairGroupId, ht?.pair?.pairGroupId);
    assert.ok(ht?.halftone?.lpi);
    const hybrid = sheetC.manifest.specimens.find((s) => s.id === "HYBRID-EXP-01");
    assert.equal(hybrid?.experimental, true);
    assert.ok(hybrid?.notes?.some((n) => /NOT PRODUCTION/i.test(n)));
  });

  it("covers the alpha ladder levels", () => {
    const sheetB = bundle.sheets.find((s) => s.sheetId === "SHEET_B")!;
    for (const a of ALPHA_LEVELS) {
      assert.ok(sheetB.manifest.specimens.some((s) => s.id === `ALPHA-PATCH-${String(a).padStart(3, "0")}`));
    }
  });

  it("builds a valid blank observation template with subjective hand fields", () => {
    assert.deepEqual(validateObservationDocument(bundle.combinedObservationTemplate), []);
    assert.equal(bundle.combinedObservationTemplate.run.garmentColor, null);
    const first = bundle.combinedObservationTemplate.specimens[0]!;
    assert.equal(first.subjective?.handRelativeToPair, "not_evaluated");
    assert.equal(first.outcome, "not_evaluated");
  });

  it("PNG bytes are real PNGs with expected dimensions and transparency", () => {
    for (const sheet of bundle.sheets) {
      const decoded = PNG.sync.read(sheet.pngBytes);
      assert.equal(decoded.width, sheet.manifest.widthPx);
      assert.equal(decoded.height, sheet.manifest.heightPx);
      let hasT = false;
      for (let i = 3; i < decoded.data.length; i += 4) {
        if (decoded.data[i]! < 255) {
          hasT = true;
          break;
        }
      }
      assert.equal(hasT, true);
    }
  });
});
