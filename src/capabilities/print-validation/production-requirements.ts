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
 *
 * ---------------------------------------------------------------------------
 * Sprint A2 — decoration intent is not a production-output request
 * ---------------------------------------------------------------------------
 *
 * This module previously read any decoration-method word as an instruction
 * about which artifact to build: "a screen printed T-shirt" or "an
 * embroidered polo logo" classified as `apparel_vector`, whose vector
 * deliverable nothing produces, so the Final Artwork worker refused the job
 * and an ordinary garment design never reached the one production artifact
 * this product actually makes. The customer had described where their
 * artwork was going; the system heard an order for a file it does not sell.
 *
 * Those are two different questions and are now read separately:
 *
 *   DECORATION CONTEXT  "What might this artwork eventually be used for?"
 *                       → `printMethod`. Informational. Never selects a
 *                         pipeline, never blocks the Production PNG.
 *
 *   REQUESTED OUTPUT    "What production artifact is iHeartPrints being
 *                       asked to produce?"
 *                       → `category` (+ `requestedUnsupportedOutput`). Only
 *                         an explicit request for an artifact this product
 *                         does not make leaves the raster profile.
 *
 * What this does NOT change: `print_ready` still means one thing only — the
 * Production PNG passed authoritative Print Validation for the supported
 * raster profile. A design whose customer mentioned embroidery is not
 * thereby embroidery-ready, digitized, or separated; it is a validated
 * raster design artifact, exactly as it would be without the mention.
 */

import { UNRECOGNIZED_PRODUCTION_OUTPUT } from "@/lib/domain/types";
import type { PrintPlacement, StoredRequestedProductionOutput } from "@/lib/domain/types";
import { PRODUCT_NOUN_CANONICAL } from "@/capabilities/shared/field-normalization";
import { sizingPolicyForProductionBox } from "@/capabilities/shared/garment-production-sizing";
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
  UnsupportedProductionOutput,
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

/**
 * Products outside the iHeartPrints product scope altogether (Constitution
 * §7.13 / AGENTS.md). Not "apparel methods we have not built yet" — different
 * product categories, which need a Constitution amendment rather than a
 * pipeline. Checked only when no apparel noun is present, so "a banner design
 * for our team hoodies" stays an apparel job.
 */
const OUT_OF_SCOPE_PRODUCT_KEYWORDS =
  /\b(banner|yard sign|lawn sign|vinyl sign|storefront sign|window cling|decal|poster|billboard|vehicle (?:graphic|wrap)|car magnet|mug|mugs|tumbler|koozie|coaster|mouse ?pad|keychain|tote bag|sticker|stickers|large[\s-]format|promotional (?:product|item)s?|swag|flyer|flyers|business card|letterhead|brochure)\b/i;
/**
 * Reserved, dormant. Narrowed in the A2 correction: `business card` and
 * `letterhead` moved to the out-of-scope list above, where they belong —
 * they are non-apparel PRODUCTS, not a vector deliverable iHeartPrints might
 * one day produce for a garment.
 */
const LOGO_VECTOR_KEYWORDS = /\b(vector logo|logo design|brand logo)\b/i;

// --- Decoration context (Sprint A2) ----------------------------------------
// What the customer says the artwork will eventually be DECORATED with. This
// is intent about their downstream printing, not a request that iHeartPrints
// produce a different artifact — so none of these may change the production
// category. They are recorded on `printMethod` and nothing more.
const EMBROIDERY_KEYWORDS = /\bembroider(?:ed|y|ing)?\b/i;
const SCREEN_PRINT_KEYWORDS = /\bscreen[\s-]?print(?:ed|ing|s|er)?\b/i;
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
  /** Decoration CONTEXT — see `ProductionRequirements.printMethod`. Never selects the pipeline. */
  printMethod: ProductionMethod;
  printMethodConfidence: ProductionMethodConfidence;
  /** Sprint A2: the unsupported artifact explicitly requested, or `null`. */
  requestedUnsupportedOutput: UnsupportedProductionOutput | null;
}

/**
 * Sprint A2: the decoration method the customer's words point at, as
 * CONTEXT ONLY. Order matters solely for which single method is recorded
 * when a customer names more than one; every branch is production-neutral.
 */
function decorationContextIn(text: string): {
  printMethod: ProductionMethod;
  printMethodConfidence: ProductionMethodConfidence;
} {
  if (DTF_KEYWORDS.test(text)) {
    return { printMethod: "dtf", printMethodConfidence: "inferred" };
  }
  if (DTG_KEYWORDS.test(text)) {
    return { printMethod: "dtg", printMethodConfidence: "inferred" };
  }
  if (EMBROIDERY_KEYWORDS.test(text)) {
    return { printMethod: "embroidery", printMethodConfidence: "inferred" };
  }
  if (SCREEN_PRINT_KEYWORDS.test(text)) {
    return { printMethod: "screen_print", printMethodConfidence: "inferred" };
  }
  if (SUBLIMATION_KEYWORDS.test(text)) {
    return { printMethod: "sublimation", printMethodConfidence: "inferred" };
  }
  // No method named at all. The raster Production PNG is the one production
  // path this product implements today — used as the best-available assumed
  // profile, but never marked "confirmed".
  return { printMethod: "unknown", printMethodConfidence: "unknown" };
}

/**
 * Sprint A2 (corrected): maps the persisted, structured domain value onto
 * this module's internal descriptor.
 *
 * This module NO LONGER INTERPRETS PROSE to answer "what were we asked to
 * produce?". It consumes an already-resolved authority. The first A2 pass
 * ran artifact-noun regexes over `productSummary`/`designDescription` right
 * here, at the finalization gate, and that was wrong twice over: it blocked
 * valid jobs whose text merely contained an artifact word ("no separations
 * are needed", "I already have the DST file", a company called Screen Print
 * Separations LLC), and it never saw requests typed in chat that those two
 * fields do not carry. Interpretation belongs where the customer speaks —
 * Conversation Understanding, with `shared/requested-production-output.ts`
 * as its deterministic backstop — and the result is persisted on the working
 * brief. Print Validation only reads it.
 */
function describeRequestedOutput(
  requested: StoredRequestedProductionOutput | null | undefined,
): UnsupportedProductionOutput | null {
  switch (requested) {
    case "embroidery_digitization":
      return "embroidery_digitization";
    case "screen_print_separations":
      return "screen_print_separations";
    case "vector_output":
      return "vector_production_file";
    case "sublimation_specific":
      return "sublimation_production_prep";
    // Sprint A2 Correction 2 (Goal 12): FAIL CLOSED. A stored value this
    // build cannot interpret is not "no request" — it is a request we cannot
    // read, and answering it with a Production PNG would be a guess made on
    // the customer's behalf about the one thing they were explicit about.
    case UNRECOGNIZED_PRODUCTION_OUTPUT:
      return "unrecognized_request";
    // `"production_png"` and `null` are both the supported path. `null` is
    // "never asked", which is every historical project and the default for
    // every new one.
    case "production_png":
    case null:
    case undefined:
      return null;
    default:
      // Exhaustiveness guard: a future member of the union that nobody
      // routed here must fail closed too, never fall through to "supported".
      return "unrecognized_request";
  }
}

/**
 * Deterministic classification of PRODUCT SCOPE and DECORATION CONTEXT from
 * brief text, combined with the already-resolved REQUESTED OUTPUT authority.
 * Never guesses beyond what the text supports — an ordinary "T-shirt" with no
 * method keyword lands on `"unknown"` method confidence inside the raster
 * profile, never a fabricated `"confirmed"`.
 *
 * Three orthogonal facts, with sharply different sources — which is the whole
 * correction, since the first A2 pass derived all three from the same prose:
 *
 *   1. PRODUCT SCOPE      — is this apparel? Read from brief text, because
 *                           the product noun genuinely lives there.
 *   2. REQUESTED OUTPUT   — were we asked to produce something we do not
 *                           make? **Read from structured state**, never text.
 *   3. DECORATION CONTEXT — what will they decorate with? Read from brief
 *                           text, and affects `printMethod` only.
 *
 * Only (1) and (2) may move the category. A garment design mentioning screen
 * printing, embroidery, or sublimation as downstream context stays on
 * `apparel_raster` and remains eligible for the Production PNG — which is the
 * design artifact, and is never described as a stitch file, a set of
 * separations, or ready for a method other than the supported raster profile.
 */
export function classifyProduction(input: {
  productSummary: string | null;
  designDescription: string | null;
  /**
   * The persisted authority from `TShirtDesignBrief.requestedProductionOutput`.
   * Optional so every existing caller keeps today's behavior: absent and
   * `null` both mean "the customer never asked for a particular artifact",
   * which is the supported Production PNG path.
   */
  requestedProductionOutput?: StoredRequestedProductionOutput | null;
}): ProductionClassification {
  const text = `${input.productSummary ?? ""} ${input.designDescription ?? ""}`;

  const isApparel = APPAREL_NOUN_PATTERN.test(text);

  if (isApparel) {
    const decoration = decorationContextIn(text);
    const requestedUnsupportedOutput = describeRequestedOutput(
      input.requestedProductionOutput,
    );

    // An explicit request for an artifact this product does not make. Never
    // satisfied by a raster fallback — see `ProductionCategory`.
    if (requestedUnsupportedOutput) {
      return {
        category: "apparel_vector",
        printMethod: decoration.printMethod,
        printMethodConfidence: decoration.printMethodConfidence,
        requestedUnsupportedOutput,
      };
    }

    // Ordinary garment artwork. The decoration method, if any was named, is
    // carried as context and changes nothing about the artifact produced.
    return {
      category: "apparel_raster",
      printMethod: decoration.printMethod,
      printMethodConfidence: decoration.printMethodConfidence,
      requestedUnsupportedOutput: null,
    };
  }

  // Not apparel. A non-apparel print product is outside the product scope
  // entirely — it does not enter an unsupported production pipeline, and it
  // is not an apparel method awaiting implementation.
  if (OUT_OF_SCOPE_PRODUCT_KEYWORDS.test(text)) {
    return {
      category: "out_of_scope_product",
      printMethod: "unknown",
      printMethodConfidence: "unknown",
      requestedUnsupportedOutput: null,
    };
  }

  if (LOGO_VECTOR_KEYWORDS.test(text)) {
    return {
      category: "logo_vector",
      printMethod: "unknown",
      printMethodConfidence: "inferred",
      requestedUnsupportedOutput: null,
    };
  }

  return {
    category: "unknown",
    printMethod: "unknown",
    printMethodConfidence: "unknown",
    requestedUnsupportedOutput: null,
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
  /**
   * Sprint A2 (corrected): the persisted structured authority from
   * `TShirtDesignBrief.requestedProductionOutput`. Absent/`null` = the
   * customer never asked for a particular artifact = the supported
   * Production PNG path, which is every historical project's behavior.
   */
  requestedProductionOutput?: StoredRequestedProductionOutput | null;
  /**
   * Phase 28C: the HEIGHT half of an explicit human confirmation
   * (`ConfirmedProductionSize.boxMaxHeightIn`, `confirmed-production-size.ts`)
   * — a garment-class-aware containing BOX bound, never a bare width's
   * placement-wide technical ceiling.
   *
   * Before this field existed, this module always sized production off
   * `sizingPolicyForPlacement` alone, whose `maxHeightIn` is the PLACEMENT's
   * generic technical limit (14in for a full front/back) — much looser than
   * any garment recommendation (10.5in for Standard Adult, 8.5in for Youth,
   * ...). A confirmed WIDTH that happens to equal the placement default (as
   * every garment-box recommendation's width does, by construction) left
   * `sizingPolicyForPlacement` returning that same loose 14in ceiling
   * unchanged — so a tall design correctly confirmed against a 10.5x10.5
   * Standard Adult box was still produced against a 10.5x14 envelope,
   * oversized relative to the box a human actually approved.
   *
   * `undefined`/`null` preserves EXACTLY today's behavior (the placement's
   * own technical `maxHeightIn`) — every caller that does not pass this
   * (a legacy job, a not-yet-confirmed project, a `generated_concept` whose
   * caller has not been updated) sizes exactly as before. Passing it only
   * ever NARROWS the height ceiling below the placement's technical limit —
   * never widens it — because it always originates from a human-approved
   * box, never invented here.
   */
  confirmedMaxHeightIn?: number | null;
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
          "No decoration method found in brief text; assumed DTF-style raster requirements as the best-available default.",
        );
      } else if (
        classification.printMethod === "embroidery" ||
        classification.printMethod === "screen_print" ||
        classification.printMethod === "sublimation"
      ) {
        // Sprint A2: recorded so the trail is explicit about what this
        // deliverable is and is not. The customer named a decoration method
        // iHeartPrints does not produce production files for; they did not
        // ask iHeartPrints to produce one. The Production PNG is the design
        // artifact, and `print_ready` continues to mean exactly what it
        // always has — validated for the supported raster profile only.
        notes.push(
          `Decoration context only (${classification.printMethod}); no production artifact for that method was requested, and none is claimed. Deliverable remains the raster Production PNG.`,
        );
      }
      return {
        category: classification.category,
        printMethod: classification.printMethod,
        printMethodConfidence: classification.printMethodConfidence,
        requestedUnsupportedOutput: null,
        printLocation: input.printPlacement,
        targetDimensions,
        // Print-Ready Normalization Phase 1: the production deliverable's
        // sizing strategy, carried through from the one shared placement
        // policy table so no worker/provider re-derives apparel dimensions.
        // Live Acceptance Cleanup (Issue 5): carrying the customer's chosen
        // width here is what makes their choice authoritative all the way to
        // the plate — output pixels are `targetWidthIn x targetPpi`, so the
        // 300-PPI guarantee holds at whatever width they picked.
        //
        // Phase 28C: when a confirmed BOX height exists, it narrows the
        // placement's generic technical ceiling down to the garment
        // recommendation a human actually approved — see
        // `confirmedMaxHeightIn`'s own doc comment above for why the
        // placement policy alone is not authoritative for a tall design.
        // `sizingPolicyForProductionBox` is the SAME function
        // `sizingPolicyForConfirmedSize`/`describePrintReadySize` already use
        // for the pre-finalization preview, so the figure shown before
        // finalizing and the plate produced afterwards read the confirmed
        // box identically.
        sizing: applyConfirmedMaxHeight(
          sizingPolicyForPlacement(input.printPlacement, intendedPrintWidthIn),
          input.confirmedMaxHeightIn,
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
        `Customer explicitly requested a production artifact iHeartPrints does not produce (${classification.requestedUnsupportedOutput}); the current deliverable is the raster Production PNG only, and it must not be presented as satisfying that request. A vector/digitized source is the primary requirement for the requested artifact — raster resolution is not the blocking factor.`,
      );
      return {
        category: classification.category,
        printMethod: classification.printMethod,
        printMethodConfidence: classification.printMethodConfidence,
        requestedUnsupportedOutput: classification.requestedUnsupportedOutput,
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

    // Sprint A2: the product is not apparel. iHeartPrints does not produce
    // artwork for it at all — this is a product-scope decision (Constitution
    // §7.13), not an apparel production profile awaiting implementation, so
    // nothing here describes a deliverable or a path toward one.
    case "out_of_scope_product": {
      notes.push(
        "Product is outside the iHeartPrints product scope (apparel artwork); no production artifact is produced for it.",
      );
      return {
        category: classification.category,
        printMethod: classification.printMethod,
        printMethodConfidence: classification.printMethodConfidence,
        requestedUnsupportedOutput: null,
        printLocation: null,
        targetDimensions: null,
        sizing: null,
        // Nothing is produced for this product. `"raster"` mirrors the
        // `unknown` arm purely so no caller reads a vector deliverable into
        // an out-of-scope request; `allowedFileFormats: []` is the load-
        // bearing statement that there is no deliverable.
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

    // Reserved, dormant — no classification reaches this today. See
    // `ProductionCategory`.
    case "signage": {
      notes.push(
        "No customer-specified banner/sign size available yet; using a generic placeholder size for internal planning only.",
      );
      return {
        category: classification.category,
        printMethod: classification.printMethod,
        printMethodConfidence: classification.printMethodConfidence,
        requestedUnsupportedOutput: null,
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
        requestedUnsupportedOutput: null,
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
        "Product and decoration method could not be determined from available brief text.",
      );
      return {
        category: "unknown",
        printMethod: "unknown",
        printMethodConfidence: "unknown",
        requestedUnsupportedOutput: null,
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

/**
 * Narrows a placement policy's height ceiling to a confirmed garment box's
 * height, when one is known. `null`/`undefined` — no confirmed box, or no
 * policy to narrow at all — returns `policy` completely untouched, which is
 * every existing call site's exact prior behavior.
 *
 * Only ever NARROWS: `sizingPolicyForProductionBox` reuses `policy`'s own
 * `targetWidthIn` (unchanged) and simply substitutes `maxHeightIn`. Nothing
 * here can widen a technical limit or invent a width nobody confirmed.
 */
function applyConfirmedMaxHeight(
  policy: ReturnType<typeof sizingPolicyForPlacement>,
  confirmedMaxHeightIn: number | null | undefined,
): ReturnType<typeof sizingPolicyForPlacement> {
  if (!policy || confirmedMaxHeightIn === null || confirmedMaxHeightIn === undefined) {
    return policy;
  }
  return sizingPolicyForProductionBox(policy, policy.targetWidthIn, confirmedMaxHeightIn);
}
