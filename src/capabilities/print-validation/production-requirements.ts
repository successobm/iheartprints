/**
 * Sprint 2M Phase 1 — Goal 2 / Goal 3 / Goal 8: provider-neutral production
 * requirements, derived deterministically from already-collected Design
 * Brief fields. The Design Brief does not (and per Constitution §6.6 should
 * not) collect an explicit production method from the customer — this
 * module infers a best-available production profile from product text the
 * customer already gave in ordinary language, and is honest (`"unknown"`)
 * whenever that inference is not confident, rather than fabricating
 * certainty (Goal 6).
 *
 * Reuses `shared/print-placement-dimensions.ts` for placement-driven target
 * size instead of inventing a second table (Goal 8 — "do not duplicate
 * placement rules").
 */

import type { PrintPlacement } from "@/lib/domain/types";
import { PRODUCT_NOUN_CANONICAL } from "@/capabilities/shared/field-normalization";
import {
  sizingPolicyForPlacement,
  targetDimensionsForPlacement,
} from "@/capabilities/shared/print-placement-dimensions";
import type { ProductionMethod } from "@/capabilities/shared/contracts";

import { minimumRasterDimensionsFor } from "./effective-resolution";
import type {
  PhysicalDimensions,
  ProductionCategory,
  ProductionMethodConfidence,
  ProductionRequirements,
} from "./contracts";

/** Standard production-resolution floor for raster apparel decoration (matches the Constitution's own 300-PPI example). */
const APPAREL_RASTER_TARGET_PPI = 300;
/** Banners/signs are viewed from a distance; a much lower floor is genuinely sufficient. */
const SIGNAGE_TARGET_PPI: number | null = null; // vector output is the primary requirement; see below.

/** A generic default banner size used only when no more specific size is known. Internal only — never shown as "36x72in" to a customer. */
const DEFAULT_SIGNAGE_TARGET_IN: PhysicalDimensions = {
  widthIn: 36, // ~3ft
  heightIn: 72, // ~6ft
};

const SIGNAGE_KEYWORDS =
  /\b(banner|yard sign|vinyl sign|storefront sign|window cling|decal|poster)\b/i;
const LOGO_VECTOR_KEYWORDS =
  /\b(vector logo|logo design|brand logo|business card|letterhead)\b/i;
const EMBROIDERY_KEYWORDS = /\bembroider(?:ed|y)?\b/i;
const SCREEN_PRINT_KEYWORDS = /\bscreen[\s-]?print(?:ed|ing)?\b/i;
const SUBLIMATION_KEYWORDS = /\bsublimat/i;
const DTG_KEYWORDS = /\bdtg\b|direct[\s-]to[\s-]garment/i;
const DTF_KEYWORDS = /\bdtf\b|direct[\s-]to[\s-]film/i;

const APPAREL_NOUN_PATTERN = buildApparelNounPattern();

function buildApparelNounPattern(): RegExp {
  const nouns = Array.from(new Set(Object.keys(PRODUCT_NOUN_CANONICAL))).sort(
    (a, b) => b.length - a.length,
  );
  const escaped = nouns.map((noun) =>
    noun.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  );
  return new RegExp(`\\b(?:${escaped.join("|")})\\b`, "i");
}

export interface ProductionClassification {
  category: ProductionCategory;
  printMethod: ProductionMethod;
  printMethodConfidence: ProductionMethodConfidence;
}

/**
 * Deterministic keyword classification over free-text brief fields the
 * customer already provided. Never guesses beyond what the text supports —
 * an ordinary "T-shirt" with no method keyword lands on `"unknown"`
 * confidence with a `dtf` assumed profile (the one production path this
 * product actually implements today — Constitution's own DTF example),
 * never a fabricated `"confirmed"`.
 */
export function classifyProduction(input: {
  productSummary: string | null;
  designDescription: string | null;
}): ProductionClassification {
  const text = `${input.productSummary ?? ""} ${input.designDescription ?? ""}`;

  const isApparel = APPAREL_NOUN_PATTERN.test(text);

  if (isApparel) {
    if (EMBROIDERY_KEYWORDS.test(text)) {
      return {
        category: "apparel_vector",
        printMethod: "embroidery",
        printMethodConfidence: "inferred",
      };
    }
    if (SCREEN_PRINT_KEYWORDS.test(text)) {
      return {
        category: "apparel_vector",
        printMethod: "screen_print",
        printMethodConfidence: "inferred",
      };
    }
    if (SUBLIMATION_KEYWORDS.test(text)) {
      return {
        category: "apparel_raster",
        printMethod: "sublimation",
        printMethodConfidence: "inferred",
      };
    }
    if (DTG_KEYWORDS.test(text)) {
      return {
        category: "apparel_raster",
        printMethod: "dtg",
        printMethodConfidence: "inferred",
      };
    }
    if (DTF_KEYWORDS.test(text)) {
      return {
        category: "apparel_raster",
        printMethod: "dtf",
        printMethodConfidence: "inferred",
      };
    }
    // No explicit method mentioned. DTF/raster is the one production path
    // this product actually generates artwork for today — used as the
    // best-available assumed profile, but never marked "confirmed".
    return {
      category: "apparel_raster",
      printMethod: "unknown",
      printMethodConfidence: "unknown",
    };
  }

  if (SIGNAGE_KEYWORDS.test(text)) {
    return {
      category: "signage",
      printMethod: "signage",
      printMethodConfidence: "inferred",
    };
  }

  if (LOGO_VECTOR_KEYWORDS.test(text)) {
    return {
      category: "logo_vector",
      printMethod: "unknown",
      printMethodConfidence: "inferred",
    };
  }

  return {
    category: "unknown",
    printMethod: "unknown",
    printMethodConfidence: "unknown",
  };
}

export interface DeriveProductionRequirementsInput {
  printPlacement: PrintPlacement | null;
  productSummary: string | null;
  designDescription: string | null;
  /**
   * Live Acceptance Cleanup (Issue 5): the customer's chosen production
   * print WIDTH in inches — authoritative production intent, persisted on
   * `TShirtDesignBrief.intendedPrintWidthIn`. `null`/omitted means "they
   * never expressed one", which resolves to the placement default exactly as
   * before. Never derived from pixel dimensions.
   */
  intendedPrintWidthIn?: number | null;
}

/**
 * Builds the full provider-neutral `ProductionRequirements` profile for a
 * concept. Pure function of already-known brief fields — no I/O, no
 * customer-facing copy, no provider knowledge (Goal 2/3/8).
 */
export function deriveProductionRequirements(
  input: DeriveProductionRequirementsInput,
): ProductionRequirements {
  const classification = classifyProduction(input);
  const notes: string[] = [];
  const intendedPrintWidthIn = input.intendedPrintWidthIn ?? null;

  switch (classification.category) {
    case "apparel_raster": {
      const targetDimensions = targetDimensionsForPlacement(
        input.printPlacement,
        intendedPrintWidthIn,
      );
      if (!targetDimensions) {
        notes.push(
          "Print location is not yet known; target physical dimensions cannot be determined.",
        );
      }
      if (classification.printMethodConfidence === "unknown") {
        notes.push(
          "No explicit production method found in brief text; assumed DTF-style raster requirements as the best-available default.",
        );
      }
      return {
        category: classification.category,
        printMethod: classification.printMethod,
        printMethodConfidence: classification.printMethodConfidence,
        printLocation: input.printPlacement,
        targetDimensions,
        // Print-Ready Normalization Phase 1: the production deliverable's
        // sizing strategy, carried through from the one shared placement
        // policy table so no worker/provider re-derives apparel dimensions.
        // Live Acceptance Cleanup (Issue 5): carrying the customer's chosen
        // width here is what makes their choice authoritative all the way to
        // the plate — output pixels are `targetWidthIn x targetPpi`, so the
        // 300-PPI guarantee holds at whatever width they picked.
        sizing: sizingPolicyForPlacement(
          input.printPlacement,
          intendedPrintWidthIn,
        ),
        requiredOutputType: "raster",
        targetPpi: targetDimensions ? APPAREL_RASTER_TARGET_PPI : null,
        minRasterDimensionsPx: targetDimensions
          ? minimumRasterDimensionsFor(targetDimensions, APPAREL_RASTER_TARGET_PPI)
          : null,
        transparencyRequired: true,
        colorMode: "rgb",
        allowedFileFormats: ["png"],
        artworkBoundaryMarginPercent: 5,
        requiredWordingVerificationRequired: true,
        notes,
      };
    }

    case "apparel_vector": {
      const targetDimensions = targetDimensionsForPlacement(
        input.printPlacement,
        intendedPrintWidthIn,
      );
      notes.push(
        "Vector/digitized source is the primary requirement for this method; raster resolution is not the blocking factor.",
      );
      return {
        category: classification.category,
        printMethod: classification.printMethod,
        printMethodConfidence: classification.printMethodConfidence,
        printLocation: input.printPlacement,
        targetDimensions,
        // Raster physical sizing does not apply to a vector deliverable.
        sizing: null,
        requiredOutputType: "vector",
        targetPpi: null,
        minRasterDimensionsPx: null,
        transparencyRequired: false,
        colorMode: "limited_spot_colors",
        allowedFileFormats: ["svg", "pdf"],
        artworkBoundaryMarginPercent: 5,
        requiredWordingVerificationRequired: true,
        notes,
      };
    }

    case "signage": {
      notes.push(
        "No customer-specified banner/sign size available yet; using a generic placeholder size for internal planning only.",
      );
      return {
        category: classification.category,
        printMethod: classification.printMethod,
        printMethodConfidence: classification.printMethodConfidence,
        printLocation: null,
        targetDimensions: DEFAULT_SIGNAGE_TARGET_IN,
        // Apparel placement sizing does not apply to signage.
        sizing: null,
        requiredOutputType: "vector",
        targetPpi: SIGNAGE_TARGET_PPI,
        minRasterDimensionsPx: null,
        transparencyRequired: false,
        colorMode: "limited_spot_colors",
        allowedFileFormats: ["svg", "pdf"],
        artworkBoundaryMarginPercent: 3,
        requiredWordingVerificationRequired: true,
        notes,
      };
    }

    case "logo_vector": {
      notes.push(
        "Physical raster print dimensions are not the primary requirement for a vector/logo deliverable.",
      );
      return {
        category: classification.category,
        printMethod: classification.printMethod,
        printMethodConfidence: classification.printMethodConfidence,
        printLocation: input.printPlacement,
        targetDimensions: null,
        // Raster physical sizing does not apply to a vector/logo deliverable.
        sizing: null,
        requiredOutputType: "vector",
        targetPpi: null,
        minRasterDimensionsPx: null,
        transparencyRequired: false,
        colorMode: "not_applicable",
        allowedFileFormats: ["svg", "pdf"],
        artworkBoundaryMarginPercent: 5,
        requiredWordingVerificationRequired: true,
        notes,
      };
    }

    case "unknown":
    default: {
      notes.push(
        "Product and production method could not be determined from available brief text.",
      );
      return {
        category: "unknown",
        printMethod: "unknown",
        printMethodConfidence: "unknown",
        printLocation: input.printPlacement,
        targetDimensions: null,
        // Nothing about this product is known well enough to size it.
        sizing: null,
        requiredOutputType: "raster",
        targetPpi: null,
        minRasterDimensionsPx: null,
        transparencyRequired: false,
        colorMode: "not_applicable",
        allowedFileFormats: [],
        artworkBoundaryMarginPercent: 5,
        requiredWordingVerificationRequired: true,
        notes,
      };
    }
  }
}
