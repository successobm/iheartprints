/**
 * DTF Feature Integrity Phase 1 — developer-only diagnostic (Section 20).
 *
 * Runs the SAME pure measurement engine and provisional DTF profile the
 * production pipeline uses (`@/capabilities/final-artwork/feature-integrity`,
 * `@/capabilities/shared/dtf-feature-integrity-profile`) against a local PNG
 * at a given confirmed physical size, and prints a structured report.
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
import {
  classifyDtfFeatureWidth,
  classifyDtfPartialAlphaFeature,
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

function tierLabel(tier: "pass" | "warning" | "blocking"): string {
  return tier === "pass" ? "PASS" : tier === "warning" ? "WARNING" : "BLOCKING";
}

function printReport(m: FeatureIntegrityMeasurement): void {
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

  const positiveTier = classifyDtfFeatureWidth(
    m.positive.globalMinStrokeWidthMm,
    DTF_POSITIVE_FEATURE_BLOCKING_WIDTH_MM,
    DTF_POSITIVE_FEATURE_WARNING_WIDTH_MM,
  );
  console.log(`POSITIVE FEATURES — ${tierLabel(positiveTier)}`);
  console.log(`  components measured:      ${m.positive.totalComponentCount}`);
  console.log(`  minimum stroke width:     ${mm(m.positive.globalMinStrokeWidthMm)}`);
  console.log(`  5th-percentile width:     ${mm(m.positive.percentile5StrokeWidthMm)}`);
  console.log("  narrowest components:");
  for (const c of m.positive.components.slice(0, 5)) {
    console.log(
      `    - bbox ${bboxStr(c.boundsPx)}  minWidth=${mm(c.minStrokeWidthMm)}  area=${c.pixelArea}px`,
    );
  }
  console.log("");

  const negativeTier = classifyDtfFeatureWidth(
    m.negative.globalMinGapWidthMm,
    DTF_NEGATIVE_SPACE_BLOCKING_WIDTH_MM,
    DTF_NEGATIVE_SPACE_WARNING_WIDTH_MM,
  );
  console.log(`NEGATIVE SPACE — ${tierLabel(negativeTier)}`);
  console.log(`  channels measured:        ${m.negative.totalComponentCount}`);
  console.log(`  minimum gap width:        ${mm(m.negative.globalMinGapWidthMm)}`);
  console.log(`  5th-percentile width:     ${mm(m.negative.percentile5GapWidthMm)}`);
  console.log("  narrowest channels:");
  for (const c of m.negative.components.slice(0, 5)) {
    console.log(
      `    - bbox ${bboxStr(c.boundsPx)}  minWidth=${mm(c.minGapWidthMm)}  enclosed=${c.enclosed}  area=${c.pixelArea}px`,
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
  console.log("  smallest components:");
  for (const c of m.isolated.components.slice(0, 5)) {
    console.log(
      `    - bbox ${bboxStr(c.boundsPx)}  diameter=${mm(c.equivalentDiameterMm)}  ` +
        `neighborDist=${mm(c.distanceToNearestNeighborMm)}  partialAlphaFraction=${(c.partialAlphaFraction * 100).toFixed(0)}%`,
    );
  }
  console.log("");

  const partialTier = classifyDtfPartialAlphaFeature(m.partialAlpha.smallestEquivalentDiameterMm);
  console.log(`PARTIAL-ALPHA FEATURES — ${tierLabel(partialTier)} (diagnostic only; never blocking)`);
  console.log(`  total components:         ${m.partialAlpha.totalComponentCount}`);
  console.log(`  fraction of visible art:  ${(m.partialAlpha.partialAlphaFractionOfVisible * 100).toFixed(1)}%`);
  console.log(`  smallest equiv. diameter: ${mm(m.partialAlpha.smallestEquivalentDiameterMm)}`);
  console.log("");

  if (m.limitations.length) {
    console.log("LIMITATIONS:");
    for (const l of m.limitations) console.log(`  - ${l}`);
    console.log("");
  }

  const overall =
    positiveTier === "blocking" || negativeTier === "blocking" || isolatedTier === "blocking"
      ? "BLOCKING"
      : positiveTier === "warning" || negativeTier === "warning" || isolatedTier === "warning" || partialTier === "warning"
        ? "WARNING"
        : "PASS";
  console.log(`OVERALL (informal, for this script only — never a substitute for PrintValidationCapability): ${overall}`);
  console.log("=".repeat(78));
}

function bboxStr(b: { left: number; top: number; width: number; height: number }): string {
  return `[${b.left},${b.top} ${b.width}x${b.height}]`;
}

function main(): void {
  const { input, widthIn, heightIn } = parseArgs(process.argv.slice(2));

  const bytes = readFileSync(input);
  const decoded = PNG.sync.read(bytes);

  const resolvedHeightIn = heightIn ?? (widthIn * decoded.height) / decoded.width;

  const measurement = measureFeatureIntegrity({
    image: { width: decoded.width, height: decoded.height, data: decoded.data },
    confirmedWidthIn: widthIn,
    confirmedHeightIn: resolvedHeightIn,
  });

  printReport(measurement);
  console.log("");
  console.log("Full measurement (JSON):");
  console.log(JSON.stringify(measurement, null, 2));
}

main();
