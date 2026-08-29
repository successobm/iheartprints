/**
 * DTF Feature Integrity + DTF Coverage — developer-only diagnostic
 * (Phase 1 Section 20; extended, not replaced, by Phase 2A Section 20).
 *
 * Runs the SAME pure measurement engines and provisional DTF profile the
 * production pipeline uses (`@/capabilities/final-artwork/feature-integrity`,
 * `@/capabilities/final-artwork/dtf-coverage`,
 * `@/capabilities/shared/dtf-feature-integrity-profile`) against a local PNG
 * at a given confirmed physical size, and prints two structured reports:
 * Feature Integrity (structural-fragility-aware, Phase 2A) and Coverage
 * (objective plate coverage — never a softness/hand claim, see
 * `dtf-coverage-types.ts`'s own doc comment).
 *
 * NO EXTERNAL PROVIDER. No network, no Topaz, no OpenAI. Pure local pixel
 * math, decoding the file directly with `pngjs`.
 *
 * NOT PRODUCTION AUTHORITY. This script exists to let a developer inspect
 * whether the detector's judgment matches a human print operator's intuition
 * about a real file — it does not write to any project, job, or asset, and
 * its output is never consulted by `PrintValidationCapability`.
 *
 * DO NOT COMMIT CUSTOMER ARTWORK. Point `--input` at a local file outside
 * the repository; nothing here writes the input file anywhere.
 *
 * Usage:
 *   npx tsx scripts/diagnose-dtf-feature-integrity.ts --input <path.png> --width <inches> [--height <inches>]
 *
 * When `--height` is omitted, it is derived from the PNG's own aspect ratio.
 */

import { readFileSync } from "node:fs";
import { PNG } from "pngjs";

import { measureFeatureIntegrity } from "@/capabilities/final-artwork/feature-integrity";
import type { FeatureIntegrityMeasurement } from "@/capabilities/final-artwork/feature-integrity";
import { measureDtfCoverage } from "@/capabilities/final-artwork/dtf-coverage";
import type { DtfCoverageMeasurement } from "@/capabilities/final-artwork/dtf-coverage";
import {
  classifyDtfFeatureWidth,
  classifyDtfPartialAlphaFeature,
  classifyStructuralFragility,
  DTF_FEATURE_INTEGRITY_PROFILE_VERSION,
  DTF_ISOLATED_COMPONENT_BLOCKING_DIAMETER_MM,
  DTF_ISOLATED_COMPONENT_WARNING_DIAMETER_MM,
  DTF_NEGATIVE_SPACE_BLOCKING_WIDTH_MM,
  DTF_NEGATIVE_SPACE_WARNING_WIDTH_MM,
  DTF_POSITIVE_FEATURE_BLOCKING_WIDTH_MM,
  DTF_POSITIVE_FEATURE_WARNING_WIDTH_MM,
} from "@/capabilities/shared/dtf-feature-integrity-profile";

function parseArgs(argv: string[]): { input: string; widthIn: number; heightIn: number | null } {
  let input: string | null = null;
  let widthIn: number | null = null;
  let heightIn: number | null = null;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--input") input = argv[++i] ?? null;
    else if (arg === "--width") widthIn = Number(argv[++i]);
    else if (arg === "--height") heightIn = Number(argv[++i]);
  }

  if (!input) {
    throw new Error("Usage: diagnose-dtf-feature-integrity.ts --input <path.png> --width <inches> [--height <inches>]");
  }
  if (widthIn === null || !Number.isFinite(widthIn) || widthIn <= 0) {
    throw new Error("--width <inches> is required and must be a positive number.");
  }
  if (heightIn !== null && (!Number.isFinite(heightIn) || heightIn <= 0)) {
    throw new Error("--height, when given, must be a positive number.");
  }

  return { input, widthIn, heightIn };
}

function mm(value: number | null): string {
  return value === null ? "n/a" : `${value.toFixed(2)}mm`;
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function tierLabel(tier: "pass" | "warning" | "blocking"): string {
  return tier === "pass" ? "PASS" : tier === "warning" ? "WARNING" : "BLOCKING";
}

function bboxStr(b: { left: number; top: number; width: number; height: number }): string {
  return `[${b.left},${b.top} ${b.width}x${b.height}]`;
}

function printFeatureIntegrityReport(m: FeatureIntegrityMeasurement): void {
  const effectivePpiWidth = 25.4 / m.pixelPitchXMm;
  const effectivePpiHeight = 25.4 / m.pixelPitchYMm;

  console.log("=".repeat(78));
  console.log("DTF Feature Integrity — diagnostic report");
  console.log(`Profile: ${DTF_FEATURE_INTEGRITY_PROFILE_VERSION} (PROVISIONAL — see shared/dtf-feature-integrity-profile.ts)`);
  console.log("=".repeat(78));
  console.log(`Raster dimensions:    ${m.productionWidthPx} x ${m.productionHeightPx} px`);
  console.log(`Physical dimensions:  ${m.confirmedWidthIn.toFixed(3)}in x ${m.confirmedHeightIn.toFixed(3)}in`);
  console.log(`Effective PPI:        ${effectivePpiWidth.toFixed(1)} x ${effectivePpiHeight.toFixed(1)}`);
  console.log("");

  const positive = m.positive.worstStructuralComponent;
  const positiveResult = positive
    ? classifyStructuralFragility(
        positive.minStrokeWidthMm,
        positive.fractionBelowBlockingFloor,
        positive.fractionBelowWarningFloor,
        DTF_POSITIVE_FEATURE_BLOCKING_WIDTH_MM,
        DTF_POSITIVE_FEATURE_WARNING_WIDTH_MM,
      )
    : null;
  console.log(`POSITIVE FEATURES — ${positiveResult ? tierLabel(positiveResult.effectiveTier) : "PASS"}${positiveResult && positiveResult.kind !== "robust" ? ` (${positiveResult.kind})` : ""}`);
  console.log(`  components measured:      ${m.positive.totalComponentCount}`);
  console.log(`  minimum stroke width:     ${mm(m.positive.globalMinStrokeWidthMm)}`);
  console.log(`  5th-percentile width:     ${mm(m.positive.percentile5StrokeWidthMm)}`);
  if (positive) {
    console.log(
      `  worst component:          min=${mm(positive.minStrokeWidthMm)}  ` +
        `belowBlockingFloor=${pct(positive.fractionBelowBlockingFloor)}  belowWarningFloor=${pct(positive.fractionBelowWarningFloor)}`,
    );
  }
  console.log("  narrowest components (min / p25 / median — a min close to its own median means STRUCTURAL, not incidental):");
  for (const c of m.positive.components.slice(0, 8)) {
    console.log(
      `    - bbox ${bboxStr(c.boundsPx)}  min=${mm(c.minStrokeWidthMm)}  p25=${mm(c.p25StrokeWidthMm)}  median=${mm(c.medianStrokeWidthMm)}  ` +
        `belowBlockingFloor=${c.structuralFractions ? pct(c.structuralFractions.fractionBelowBlockingFloor) : "n/a"}  area=${c.pixelArea}px`,
    );
  }
  console.log("");

  const negative = m.negative.worstStructuralComponent;
  const negativeResult = negative
    ? classifyStructuralFragility(
        negative.minGapWidthMm,
        negative.fractionBelowBlockingFloor,
        negative.fractionBelowWarningFloor,
        DTF_NEGATIVE_SPACE_BLOCKING_WIDTH_MM,
        DTF_NEGATIVE_SPACE_WARNING_WIDTH_MM,
      )
    : null;
  console.log(`NEGATIVE SPACE — ${negativeResult ? tierLabel(negativeResult.effectiveTier) : "PASS"}${negativeResult && negativeResult.kind !== "robust" ? ` (${negativeResult.kind})` : ""}`);
  console.log(`  channels measured:        ${m.negative.totalComponentCount}`);
  console.log(`  minimum gap width:        ${mm(m.negative.globalMinGapWidthMm)}`);
  console.log(`  5th-percentile width:     ${mm(m.negative.percentile5GapWidthMm)}`);
  console.log("  narrowest channels:");
  for (const c of m.negative.components.slice(0, 8)) {
    console.log(
      `    - bbox ${bboxStr(c.boundsPx)}  min=${mm(c.minGapWidthMm)}  median=${mm(c.medianGapWidthMm)}  enclosed=${c.enclosed}  ` +
        `belowBlockingFloor=${c.structuralFractions ? pct(c.structuralFractions.fractionBelowBlockingFloor) : "n/a"}  area=${c.pixelArea}px`,
    );
  }
  console.log("");

  const isolatedTier = classifyDtfFeatureWidth(
    m.isolated.smallestEquivalentDiameterMm,
    DTF_ISOLATED_COMPONENT_BLOCKING_DIAMETER_MM,
    DTF_ISOLATED_COMPONENT_WARNING_DIAMETER_MM,
  );
  console.log(`ISOLATED COMPONENTS — ${tierLabel(isolatedTier)}`);
  console.log(`  total components:         ${m.isolated.totalComponentCount}`);
  console.log(`  smallest equiv. diameter: ${mm(m.isolated.smallestEquivalentDiameterMm)}`);
  console.log(
    `  micro-component population: count=${m.isolated.microComponents.microComponentCount}  ` +
      `fractionOfPrintedArea=${pct(m.isolated.microComponents.fractionOfPrintedArea)}  ` +
      `meanPartialAlphaFraction=${pct(m.isolated.microComponents.meanPartialAlphaFraction)}`,
  );
  console.log("  smallest components:");
  for (const c of m.isolated.components.slice(0, 5)) {
    console.log(
      `    - bbox ${bboxStr(c.boundsPx)}  diameter=${mm(c.equivalentDiameterMm)}  ` +
        `neighborDist=${mm(c.distanceToNearestNeighborMm)}  partialAlphaFraction=${pct(c.partialAlphaFraction)}`,
    );
  }
  console.log("");

  const partialTier = classifyDtfPartialAlphaFeature(m.partialAlpha.smallestEquivalentDiameterMm);
  console.log(`PARTIAL-ALPHA FEATURES — ${tierLabel(partialTier)} (diagnostic only; never blocking)`);
  console.log(`  total components:         ${m.partialAlpha.totalComponentCount}`);
  console.log(`  fraction of visible art:  ${pct(m.partialAlpha.partialAlphaFractionOfVisible)}`);
  console.log(`  smallest equiv. diameter: ${mm(m.partialAlpha.smallestEquivalentDiameterMm)}`);
  console.log("");

  if (m.limitations.length) {
    console.log("LIMITATIONS:");
    for (const l of m.limitations) console.log(`  - ${l}`);
    console.log("");
  }

  const overall =
    positiveResult?.effectiveTier === "blocking" || negativeResult?.effectiveTier === "blocking" || isolatedTier === "blocking"
      ? "BLOCKING"
      : positiveResult?.effectiveTier === "warning" ||
          negativeResult?.effectiveTier === "warning" ||
          isolatedTier === "warning" ||
          partialTier === "warning"
        ? "WARNING"
        : "PASS";
  console.log(`OVERALL (informal, for this script only — never a substitute for PrintValidationCapability): ${overall}`);
  console.log("=".repeat(78));
}

function printCoverageReport(c: DtfCoverageMeasurement): void {
  console.log("");
  console.log("=".repeat(78));
  console.log("DTF Coverage — diagnostic report (objective plate properties only — NOT a softness/hand prediction)");
  console.log("=".repeat(78));
  console.log(`Plate dimensions:     ${c.plateWidthPx} x ${c.plateHeightPx} px`);
  console.log(`Physical dimensions:  ${c.confirmedWidthIn.toFixed(3)}in x ${c.confirmedHeightIn.toFixed(3)}in`);
  console.log(`Plate area:           ${c.plateAreaMm2.toFixed(1)}mm²`);
  console.log("");
  console.log(`Visible coverage:        ${pct(c.visibleCoverageFraction)}  (${c.physicalVisibleAreaMm2.toFixed(1)}mm²)`);
  console.log(`Strong-ink coverage:     ${pct(c.strongInkCoverageFraction)}  (${c.physicalStrongInkAreaMm2.toFixed(1)}mm²)`);
  console.log(`Partial-alpha coverage:  ${pct(c.partialAlphaCoverageFraction)}`);
  console.log(
    `Alpha-weighted coverage: ${pct(c.alphaWeightedCoverageFraction)}  (${c.alphaWeightedEquivalentAreaMm2.toFixed(1)}mm² ink-equivalent — NOT an ink-consumption claim)`,
  );
  console.log("");
  console.log("Alpha bands:");
  for (const band of c.alphaBands) {
    console.log(`  ${band.band.padEnd(11)} ${pct(band.fractionOfPlate).padStart(7)}  (${band.pixelCount}px)`);
  }
  console.log("");
  console.log("Largest continuous strong-ink regions:");
  console.log(
    `  total regions: ${c.continuousRegions.totalComponentCount}   large regions (>=5% of printed area): ${c.continuousRegions.largeRegionCount}`,
  );
  for (const region of c.continuousRegions.components.slice(0, 5)) {
    console.log(
      `    - bbox ${bboxStr(region.boundsPx)}  area=${region.physicalAreaMm2.toFixed(1)}mm²  ` +
        `ofPlate=${pct(region.fractionOfPlateArea)}  ofPrinted=${pct(region.fractionOfPrintedArea)}`,
    );
  }
  if (c.limitations.length) {
    console.log("");
    console.log("LIMITATIONS:");
    for (const l of c.limitations) console.log(`  - ${l}`);
  }
  console.log("=".repeat(78));
}

function main(): void {
  const { input, widthIn, heightIn } = parseArgs(process.argv.slice(2));

  const bytes = readFileSync(input);
  const decoded = PNG.sync.read(bytes);

  const resolvedHeightIn = heightIn ?? (widthIn * decoded.height) / decoded.width;
  const image = { width: decoded.width, height: decoded.height, data: decoded.data };

  const featureIntegrity = measureFeatureIntegrity({
    image,
    confirmedWidthIn: widthIn,
    confirmedHeightIn: resolvedHeightIn,
    positiveFeatureThresholds: {
      blockingFloorMm: DTF_POSITIVE_FEATURE_BLOCKING_WIDTH_MM,
      warningFloorMm: DTF_POSITIVE_FEATURE_WARNING_WIDTH_MM,
    },
    negativeSpaceThresholds: {
      blockingFloorMm: DTF_NEGATIVE_SPACE_BLOCKING_WIDTH_MM,
      warningFloorMm: DTF_NEGATIVE_SPACE_WARNING_WIDTH_MM,
    },
  });
  const coverage = measureDtfCoverage({ image, confirmedWidthIn: widthIn, confirmedHeightIn: resolvedHeightIn });

  printFeatureIntegrityReport(featureIntegrity);
  printCoverageReport(coverage);

  console.log("");
  console.log("Full measurement (JSON):");
  console.log(JSON.stringify({ featureIntegrity, coverage }, null, 2));
}

main();
