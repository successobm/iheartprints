/**
 * DTF Physical Calibration Phase 2B — developer CLI.
 *
 * Generates deterministic calibration PNG(s), manifests, and blank observation
 * templates into a gitignored output directory.
 *
 * NO NETWORK. NO Topaz. NO production threshold changes.
 *
 * Usage:
 *   npx tsx scripts/generate-dtf-physical-calibration.ts
 *   npx tsx scripts/generate-dtf-physical-calibration.ts --out .tmp-dtf-physical-calibration
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  assertManifestIntegrity,
  generateCalibrationBundle,
} from "@/capabilities/final-artwork/dtf-physical-calibration";

function parseOut(argv: string[]): string {
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--out") return argv[++i] ?? ".tmp-dtf-physical-calibration";
  }
  return ".tmp-dtf-physical-calibration";
}

function main(): void {
  const outDir = path.resolve(parseOut(process.argv.slice(2)));
  mkdirSync(outDir, { recursive: true });

  const bundle = generateCalibrationBundle();

  for (const sheet of bundle.sheets) {
    const integrity = assertManifestIntegrity(sheet.manifest);
    if (integrity.length > 0) {
      throw new Error(`Manifest integrity failed for ${sheet.sheetId}: ${integrity.join("; ")}`);
    }

    const base = sheet.sheetId.toLowerCase().replace("_", "-");
    writeFileSync(path.join(outDir, `${base}.png`), sheet.pngBytes);
    writeFileSync(
      path.join(outDir, `${base}.manifest.json`),
      `${JSON.stringify(sheet.manifest, null, 2)}\n`,
    );
    writeFileSync(
      path.join(outDir, `${base}.observation.blank.json`),
      `${JSON.stringify(sheet.observationTemplate, null, 2)}\n`,
    );

    const fi = sheet.manifest.featureIntegrity;
    const cov = sheet.manifest.coverage;
    console.log(
      `${sheet.sheetId}: ${sheet.manifest.widthIn}in × ${sheet.manifest.heightIn}in ` +
        `(${sheet.manifest.widthPx}×${sheet.manifest.heightPx}px @ ${sheet.manifest.ppi} PPI) — ` +
        `${sheet.manifest.specimenCount} specimens`,
    );
    if (fi) {
      console.log(
        `  FeatureIntegrity: posMin=${fi.positive.globalMinStrokeWidthMm?.toFixed(3) ?? "n/a"}mm ` +
          `negMin=${fi.negative.globalMinGapWidthMm?.toFixed(3) ?? "n/a"}mm ` +
          `isolatedSmallest=${fi.isolated.smallestEquivalentDiameterMm?.toFixed(3) ?? "n/a"}mm ` +
          `posComponents=${fi.positive.totalComponentCount}`,
      );
    }
    if (cov) {
      console.log(
        `  Coverage: strongInk=${(cov.strongInkCoverageFraction * 100).toFixed(2)}% ` +
          `alphaWeighted=${(cov.alphaWeightedCoverageFraction * 100).toFixed(2)}% ` +
          `largeRegions=${cov.continuousRegions.largeRegionCount}`,
      );
    }
  }

  writeFileSync(
    path.join(outDir, "bundle.manifest.json"),
    `${JSON.stringify(bundle.bundleManifest, null, 2)}\n`,
  );
  writeFileSync(
    path.join(outDir, "observation.blank.json"),
    `${JSON.stringify(bundle.combinedObservationTemplate, null, 2)}\n`,
  );

  console.log(`\nWrote calibration artifacts to ${outDir}`);
  console.log(
    `Total specimens: ${bundle.summary.totalSpecimens} across ${bundle.summary.sheetCount} sheets`,
  );
  console.log(
    `Experimental hybrid included: ${bundle.experimentalHybridIncluded ? "yes (HYBRID-EXP-01)" : "no"}`,
  );
}

main();
