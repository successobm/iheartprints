/**
 * Sprint A2 (corrected) — the authority boundary between product scope,
 * decoration context, and requested production output.
 *
 * Three questions, three different SOURCES. Getting the sources wrong is the
 * defect this suite exists to prevent, so each test names the source it is
 * exercising:
 *
 *   PRODUCT SCOPE      "Is this apparel?"          ← brief text
 *   DECORATION CONTEXT "What will they print with?" ← brief text
 *   REQUESTED OUTPUT   "What must we PRODUCE?"      ← STRUCTURED STATE
 *
 * The first A2 pass derived all three from the same prose, so an artifact
 * word anywhere in a brief refused the job ("no separations are needed") and
 * a real request typed in chat was never seen at all. `classifyProduction`
 * no longer interprets prose for the third question — it consumes
 * `TShirtDesignBrief.requestedProductionOutput`, resolved once where the
 * customer speaks.
 *
 * The deterministic resolver's own false-positive matrix lives in
 * `shared/requested-production-output.test.ts`; the conversation → brief →
 * approval → finalization → worker path is proven in
 * `final-artwork-worker-capability.test.ts` and
 * `prepared-upload-finalization.test.ts`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  classifyProduction,
  deriveProductionRequirements,
} from "./production-requirements";
import { toCustomerFinalizationView } from "@/lib/services/conversation-service";
import {
  isUnsupportedRequestedProductionOutput,
  normalizeProductionIntent,
  productionIntentMatches,
  readStoredRequestedProductionOutput,
  UNRECOGNIZED_PRODUCTION_OUTPUT,
  type RequestedProductionOutput,
  type StoredRequestedProductionOutput,
} from "@/lib/domain/types";
import type { ProductionCategory } from "./contracts";

/** The Create New path's inputs, exactly as the worker assembles them. */
function createNew(
  productSummary: string,
  designDescription: string | null = null,
  requestedProductionOutput: StoredRequestedProductionOutput | null = null,
) {
  return classifyProduction({
    productSummary,
    designDescription,
    requestedProductionOutput,
  });
}

/**
 * The Existing Artwork path's inputs, as the worker's prepared-upload branch
 * assembles them: no `designDescription`, because for uploaded artwork the
 * pixels ARE the design — and the SAME structured authority field.
 */
function existingArtwork(
  productSummary: string,
  requestedProductionOutput: StoredRequestedProductionOutput | null = null,
) {
  return classifyProduction({
    productSummary,
    designDescription: null,
    requestedProductionOutput,
  });
}

function expectRasterProfile(
  classification: ReturnType<typeof classifyProduction>,
  label: string,
) {
  assert.equal(
    classification.category,
    "apparel_raster" satisfies ProductionCategory,
    `${label} must stay on the one production profile V1 implements`,
  );
  assert.equal(classification.requestedUnsupportedOutput, null);
}

function requirementsFor(
  productSummary: string,
  requestedProductionOutput: StoredRequestedProductionOutput | null = null,
  designDescription: string | null = null,
) {
  return deriveProductionRequirements({
    printPlacement: "full_front",
    productSummary,
    designDescription,
    requestedProductionOutput,
  });
}

describe("A2 authority — decoration context never changes the artifact", () => {
  // The prose in every case below CONTAINS a decoration method, and in some
  // cases an artifact word too. None of it is the authority.

  it("A: screen-print context keeps the raster Production PNG", () => {
    expectRasterProfile(createNew("Screen printed T-shirt"), "screen-print context");
    expectRasterProfile(
      createNew("T-shirt", "Team crest — this may be screen printed later"),
      "deferred screen-print context",
    );
  });

  it("K: embroidery context keeps the raster Production PNG", () => {
    expectRasterProfile(createNew("Embroidered polo logo"), "embroidery context");
    expectRasterProfile(
      createNew("Hoodie", "I want this embroidered on a hoodie"),
      "embroidery intent",
    );
  });

  it("M/N: DTF and DTG map to the supported raster profile", () => {
    const dtf = createNew("DTF T-shirt design");
    const dtg = createNew("DTG hoodie design");
    expectRasterProfile(dtf, "DTF");
    expectRasterProfile(dtg, "DTG");
    assert.equal(dtf.printMethod, "dtf");
    assert.equal(dtg.printMethod, "dtg");
  });

  it("M/N: DTF and DTG carry identical requirements — nothing downstream is promised", () => {
    // iHeartPrints controls the PNG, RGB, physical size and 300 PPI target.
    // It controls no RIP setting, ICC profile, ink, film, powder,
    // pretreatment, press setting, or garment compatibility — so the
    // deliverable cannot differ between two decorator workflows.
    const dtf = requirementsFor("DTF T-shirt");
    const dtg = requirementsFor("DTG T-shirt");
    assert.deepEqual(
      { ...dtf, printMethod: null, notes: null },
      { ...dtg, printMethod: null, notes: null },
    );
  });

  it("the method mention changes no production requirement at all", () => {
    const withMention = requirementsFor("Screen printed T-shirt", null, "Bold team crest");
    const without = requirementsFor("T-shirt", null, "Bold team crest");
    // `printMethod`/`notes` legitimately differ — that IS the context being
    // recorded. Every production requirement must be identical.
    assert.deepEqual(
      { ...withMention, printMethod: null, printMethodConfidence: null, notes: null },
      { ...without, printMethod: null, printMethodConfidence: null, notes: null },
    );
  });

  it("C/D/E/F/H/I: prose containing an artifact word can no longer refuse the job", () => {
    // The audit's false positives, now expressed where they actually reach
    // the classifier: as brief text with NO structured request behind it.
    // Every one of these produced a refusal in the first A2 pass.
    for (const productSummary of [
      "T-shirt — no separations are needed",
      "T-shirt, I already have the DST file",
      "Hoodie — don't digitize this",
      "T-shirt, use the SVG I uploaded as a reference",
      "Tee reading COLOR SEPARATIONS across the front",
      "Shirts for Screen Print Separations LLC",
      "Polo — embroidery digitizing is our business",
    ]) {
      expectRasterProfile(createNew(productSummary), productSummary);
    }
  });
});

describe("A2 authority — an explicit structured request is honored", () => {
  const cases: Array<[RequestedProductionOutput, string]> = [
    ["screen_print_separations", "screen_print_separations"],
    ["embroidery_digitization", "embroidery_digitization"],
    ["vector_output", "vector_production_file"],
    ["sublimation_specific", "sublimation_production_prep"],
  ];

  it("B/G/J/L: each unsupported output leaves the raster profile", () => {
    for (const [requested, expectedDescriptor] of cases) {
      const classification = createNew("T-shirt", null, requested);
      assert.equal(classification.category, "apparel_vector", requested);
      assert.equal(classification.requestedUnsupportedOutput, expectedDescriptor);
    }
  });

  it("B: an unsupported request is never answered with a PNG", () => {
    const requirements = requirementsFor("T-shirt", "screen_print_separations");
    assert.notDeepEqual(requirements.allowedFileFormats, ["png"]);
    assert.equal(requirements.requiredOutputType, "vector");
    // No raster geometry is asserted at all, so nothing downstream can read a
    // satisfied raster target as satisfying the request that was made.
    assert.equal(requirements.minRasterDimensionsPx, null);
    assert.equal(requirements.targetPpi, null);
    assert.ok(
      requirements.notes.some((note) => /does not produce/i.test(note)),
      "the internal trail must state plainly that this artifact is not produced",
    );
  });

  it("the supported output behaves exactly like no request at all", () => {
    // `production_png` is what a retraction resolves to. It must be
    // indistinguishable from `null`, or un-asking would not actually work.
    const explicit = requirementsFor("T-shirt", "production_png");
    const unspecified = requirementsFor("T-shirt", null);
    assert.deepEqual(explicit, unspecified);
    assert.equal(explicit.requiredOutputType, "raster");
  });

  it("a decoration method is never itself a requested output", () => {
    for (const method of ["screen_print", "embroidery", "dtf", "dtg", "sublimation"]) {
      assert.equal(
        isUnsupportedRequestedProductionOutput(method as RequestedProductionOutput),
        false,
        `${method} is a decoration method and must never gate production`,
      );
    }
  });
});

describe("A2 authority — product scope", () => {
  function expectOutOfScope(productSummary: string) {
    const classification = createNew(productSummary);
    assert.equal(
      classification.category,
      "out_of_scope_product" satisfies ProductionCategory,
      `"${productSummary}" is not an apparel product`,
    );
    const requirements = deriveProductionRequirements({
      printPlacement: null,
      productSummary,
      designDescription: null,
    });
    assert.deepEqual(
      requirements.allowedFileFormats,
      [],
      "an out-of-scope product has no deliverable in any format",
    );
    assert.equal(requirements.sizing, null);
    // Specifically NOT routed into the dormant signage/vector pipeline.
    assert.notEqual(requirements.requiredOutputType, "vector");
  }

  it("O: clearly non-apparel products stay outside the product", () => {
    for (const product of [
      "Yard sign",
      "Vinyl banner",
      "Storefront sign",
      "Vehicle graphic",
      "Promotional mug",
      "Tumbler",
      "Sticker pack",
      "Poster",
      "Business card",
      "Flyer",
      "Promotional products for a trade show",
    ]) {
      expectOutOfScope(product);
    }
  });

  it("O: the requested PRODUCT decides scope, not incidental vocabulary", () => {
    // Every one of these is a garment job whose text merely mentions a
    // non-apparel noun. Scope follows the product, not the words around it.
    expectRasterProfile(
      createNew("T-shirt", "A crest with a ribbon banner beneath it"),
      "banner in the artwork",
    );
    expectRasterProfile(
      createNew("T-shirt for a sign company"),
      "apparel for a sign company",
    );
    expectRasterProfile(
      createNew("Tee", 'The shirt should read "YARD SIGNS DONE RIGHT"'),
      "yard signs as shirt wording",
    );
    expectRasterProfile(
      createNew("Hoodie", "Picture of a banner hanging over a stadium"),
      "banner depicted on a hoodie",
    );
  });

  it("O: an out-of-scope product is out of scope regardless of what was requested", () => {
    // Product scope is decided before requested output — asking for a PNG
    // does not bring a yard sign into the product.
    assert.equal(
      createNew("Yard sign", null, "production_png").category,
      "out_of_scope_product",
    );
  });
});

describe("A2 authority — Existing Artwork uses the same field", () => {
  it("R: an upload with screen-print context is not blocked", () => {
    expectRasterProfile(
      existingArtwork("Screen printed T-shirt"),
      "upload with screen-print context",
    );
    const requirements = deriveProductionRequirements({
      printPlacement: "full_front",
      productSummary: "Screen printed T-shirt",
      designDescription: null,
      intendedPrintWidthIn: 11,
    });
    assert.equal(requirements.requiredOutputType, "raster");
    assert.equal(requirements.sizing?.targetWidthIn, 11);
  });

  it("R: an upload with an explicit separations request makes no supported-output claim", () => {
    const classification = existingArtwork("T-shirt", "screen_print_separations");
    assert.equal(classification.requestedUnsupportedOutput, "screen_print_separations");
    assert.notEqual(classification.category, "apparel_raster");
  });
});

describe("A2 Correction 2 — fail-closed and legacy normalization", () => {
  it("B: an unreadable stored value never degrades to the supported PNG", () => {
    // Goal 12. `null` and an unrecognized string are backward-compatible in
    // OPPOSITE directions and must never be merged: `null` is a fact ("never
    // asked"), the sentinel is an absence of knowledge ("asked for something
    // we cannot read"). Guessing PNG for the second answers, on the
    // customer's behalf, the one thing they were explicit about.
    assert.equal(readStoredRequestedProductionOutput("holo_foil_v9"), UNRECOGNIZED_PRODUCTION_OUTPUT);
    assert.equal(isUnsupportedRequestedProductionOutput(UNRECOGNIZED_PRODUCTION_OUTPUT), true);

    const classification = classifyProduction({
      productSummary: "T-shirt",
      designDescription: null,
      requestedProductionOutput: UNRECOGNIZED_PRODUCTION_OUTPUT,
    });
    assert.equal(classification.category, "apparel_vector");
    assert.equal(classification.requestedUnsupportedOutput, "unrecognized_request");

    const requirements = requirementsFor("T-shirt", UNRECOGNIZED_PRODUCTION_OUTPUT);
    assert.notDeepEqual(requirements.allowedFileFormats, ["png"]);
    assert.equal(requirements.targetPpi, null);
  });

  it("A/W: legacy NULL and explicit production_png normalize to one identity", () => {
    // Goal 20. This is what keeps a legacy job (NULL) deduplicating against a
    // new one ("production_png") — without it, an old row would stop matching
    // and a double click could produce a second job, and for uploads a second
    // paid reconstruction. Mirrors the migration's `coalesce(...)` index.
    assert.equal(normalizeProductionIntent(null), "production_png");
    assert.equal(normalizeProductionIntent(undefined), "production_png");
    assert.equal(normalizeProductionIntent("production_png"), "production_png");
    assert.equal(productionIntentMatches(null, "production_png"), true);
    assert.equal(productionIntentMatches("production_png", null), true);
    assert.equal(productionIntentMatches(null, null), true);
    // …and genuinely different requests never collide.
    assert.equal(productionIntentMatches(null, "screen_print_separations"), false);
    assert.equal(
      productionIntentMatches("screen_print_separations", "embroidery_digitization"),
      false,
    );
    // The fail-closed sentinel is its own identity, never the PNG's.
    assert.equal(productionIntentMatches(UNRECOGNIZED_PRODUCTION_OUTPUT, null), false);
  });

  it("Q/R/S: the customer view follows the CURRENT request, not the last achievement", () => {
    // Goal 18. `project.status` is a durable record of the past; the customer
    // is asking about now.
    assert.deepEqual(
      toCustomerFinalizationView("print_ready", "completed", "screen_print_separations"),
      { status: "needs_review" },
      "a stale print_ready must not answer a new, unmet request",
    );
    assert.deepEqual(
      toCustomerFinalizationView("print_ready", "completed", UNRECOGNIZED_PRODUCTION_OUTPUT),
      { status: "needs_review" },
      "fail closed for an unreadable request too",
    );
    assert.deepEqual(
      toCustomerFinalizationView("print_ready", "completed", "production_png"),
      { status: "print_ready" },
      "R: retracting to PNG lets the existing plate answer again",
    );
    // No job for the current request → offer the action, never a stale verdict.
    assert.deepEqual(
      toCustomerFinalizationView("finalization_required", null, "production_png", false),
      { status: "not_requested" },
    );
    // Goal 19: a superseded job must not read as "preparing" forever.
    assert.deepEqual(
      toCustomerFinalizationView("finalizing", "cancelled", "production_png"),
      { status: "not_requested" },
    );
    // V1-A.2 preserved: a real provider failure is still retryable.
    assert.deepEqual(
      toCustomerFinalizationView("finalizing", "failed", "production_png"),
      { status: "retryable_failure" },
    );
  });
});

describe("A2 Correction 3 — the oldest-job helper has no production callers", () => {
  it("O: only the dev-only stranded-job recovery still calls getFinalArtworkJobByApprovalId", async () => {
    // Goal 8. That helper returns the oldest job for an approval regardless
    // of requested output, which is precisely how a historical PNG used to be
    // delivered as fulfillment of a separations request. Delivery no longer
    // goes through it. This pins that: if a new caller appears, it must be
    // checked against `resolveCurrentMatchingProductionJob` first.
    const { readdir, readFile } = await import("node:fs/promises");
    const path = await import("node:path");

    const srcRoot = path.resolve(process.cwd(), "src");
    const callers: string[] = [];

    async function walk(dir: string): Promise<void> {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
          continue;
        }
        if (!entry.name.endsWith(".ts") && !entry.name.endsWith(".tsx")) continue;
        // Tests may reference it freely; so may the repository/store files
        // that declare and implement it.
        if (entry.name.includes(".test.")) continue;
        if (/(^|[\\/])(repository|local-store|supabase-store)\.ts$/.test(full)) continue;

        const source = await readFile(full, "utf8");
        // Only count real call sites, not the doc comments explaining why
        // this helper is deprecated.
        if (/repo\.getFinalArtworkJobByApprovalId\(/.test(source)) {
          callers.push(path.relative(srcRoot, full).replace(/\\/g, "/"));
        }
      }
    }

    await walk(srcRoot);
    assert.deepEqual(callers, ["lib/services/local-final-artwork-trigger.ts"]);
  });
});

describe("A2 invariants", () => {
  it("W: absent/null requested output is backward compatible", () => {
    // Every project that existed before this field, and every project whose
    // customer simply never mentioned an artifact, must behave exactly as it
    // always has. Omitting the property entirely is the historical shape.
    const omitted = classifyProduction({
      productSummary: "T-shirt",
      designDescription: "A bear mascot",
    });
    const explicitNull = createNew("T-shirt", "A bear mascot", null);
    assert.deepEqual(omitted, explicitNull);
    assert.equal(omitted.category, "apparel_raster");

    const requirements = deriveProductionRequirements({
      printPlacement: "full_front",
      productSummary: "T-shirt",
      designDescription: null,
    });
    assert.equal(requirements.requiredOutputType, "raster");
    assert.deepEqual(requirements.allowedFileFormats, ["png"]);
  });

  it("print_ready still means one thing — a validated raster Production PNG", () => {
    // The raster contract itself is unchanged by A2 and its correction.
    // Pinned across method mentions so a future sprint cannot quietly widen
    // it to "ready for every apparel method".
    for (const productSummary of [
      "T-shirt",
      "Screen printed T-shirt",
      "Embroidered polo",
      "Sublimated shirt",
      "DTF hoodie",
    ]) {
      const requirements = requirementsFor(productSummary);
      assert.equal(requirements.requiredOutputType, "raster");
      assert.deepEqual(requirements.allowedFileFormats, ["png"]);
      assert.equal(requirements.colorMode, "rgb");
      assert.equal(requirements.transparencyRequired, true);
      assert.equal(requirements.targetPpi, 300);
    }
  });

  it("the raster deliverable is never described as method-ready or digitized", () => {
    const requirements = deriveProductionRequirements({
      printPlacement: "left_chest",
      productSummary: "Embroidered polo logo",
      designDescription: null,
    });
    const trail = requirements.notes.join(" ");
    assert.ok(!/digitiz/i.test(trail));
    assert.ok(!/embroidery[\s-]?ready/i.test(trail));
    assert.ok(!/stitch/i.test(trail));
    assert.match(trail, /decoration context only/i);
  });

  it("V: no internal production identifier leaks into the customer view", () => {
    // Every unsupported outcome collapses to the same plain-language state.
    // The internal reason lives only on `FinalArtworkJob.lastError`, which
    // no customer surface reads.
    const view = toCustomerFinalizationView("finalization_required");
    assert.deepEqual(view, { status: "needs_review" });

    const serialized = JSON.stringify(view);
    for (const internal of [
      "apparel_raster",
      "apparel_vector",
      "out_of_scope_product",
      "signage",
      "logo_vector",
      "production_png",
      "vector_output",
      "vector_production_file",
      "screen_print_separations",
      "embroidery_digitization",
      "sublimation_specific",
      "create_vector_version",
    ]) {
      assert.ok(
        !serialized.includes(internal),
        `customer view must never carry the internal identifier "${internal}"`,
      );
    }
  });
});
