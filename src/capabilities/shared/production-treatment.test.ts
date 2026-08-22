import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { readHalftoneSettings, readProductionTreatment } from "@/lib/domain/types";

import {
  DEFAULT_HALFTONE_ANGLE_DEG,
  DEFAULT_HALFTONE_CHOKE_PX,
  DEFAULT_HALFTONE_LPI,
  DEFAULT_HALFTONE_MIDTONE,
  DEFAULT_PRODUCTION_TREATMENT,
  MAX_HALFTONE_LPI,
  MIN_HALFTONE_LPI,
  MIN_HALFTONE_MIDTONE_FRACTION,
  STANDARD_RASTER_TREATMENT_KEY,
  assessHalftoneEligibility,
  currentProductionTreatmentKey,
  normalizeHalftoneSettings,
  productionTreatmentKey,
  recommendedHalftoneSettings,
  resolveGarmentColor,
  resolveProductionTreatment,
  treatmentKeyMatchesJob,
  type HalftoneEligibilityInput,
} from "./production-treatment";

const BLACK = resolveGarmentColor("Black")!;
const NAVY = resolveGarmentColor("Navy")!;

describe("production treatment vocabulary", () => {
  it("defaults to standard raster, and reads anything unrecognized as standard raster", () => {
    // Fails toward the representation whose validation nothing was relaxed
    // for. A build that cannot interpret a treatment must not produce a plate
    // under rules it does not have.
    assert.equal(DEFAULT_PRODUCTION_TREATMENT, "standard_raster");
    assert.equal(readProductionTreatment(null), "standard_raster");
    assert.equal(readProductionTreatment(undefined), "standard_raster");
    assert.equal(readProductionTreatment("some_future_treatment"), "standard_raster");
    assert.equal(readProductionTreatment(42), "standard_raster");
    assert.equal(readProductionTreatment("halftone_dtf"), "halftone_dtf");
  });
});

describe("garment colour resolution (Goal 4)", () => {
  it("resolves named apparel colours to production RGB", () => {
    assert.equal(BLACK.hex, "#000000");
    assert.deepEqual(BLACK.rgb, { r: 0, g: 0, b: 0 });
    assert.equal(resolveGarmentColor("White")!.hex, "#FFFFFF");
    assert.equal(resolveGarmentColor("  navy blue ")!.hex, "#1B2A44");
    assert.equal(resolveGarmentColor("SPORT GREY")!.hex, "#9AA0A6");
  });

  it("keeps the operator's own label alongside the RGB the engine used", () => {
    // Two different questions: what the operator chose, and what the engine
    // actually did. A future colour-table change must be detectable rather
    // than silently rewriting what past plates were made against.
    const resolved = resolveGarmentColor("Navy Blue")!;
    assert.equal(resolved.label, "Navy Blue");
    assert.equal(resolved.hex, "#1B2A44");
  });

  it("accepts an exact hex for a garment the table has no name for", () => {
    assert.equal(resolveGarmentColor("#7f3ab2")!.hex, "#7F3AB2");
    assert.deepEqual(resolveGarmentColor("#7f3ab2")!.rgb, { r: 127, g: 58, b: 178 });
  });

  it("REFUSES rather than guessing when the colour cannot be resolved", () => {
    // The garment is the screen's entire tonal reference point, so a
    // substituted colour would silently decide which parts of a customer's
    // artwork drop out.
    assert.equal(resolveGarmentColor(null), null);
    assert.equal(resolveGarmentColor(""), null);
    assert.equal(resolveGarmentColor("   "), null);
    assert.equal(resolveGarmentColor("heathered oatmeal marle"), null);
    assert.equal(resolveGarmentColor(42 as never), null);
  });
});

describe("settings normalization (Goal 14, Goal 16)", () => {
  it("fills unstated fields with the recommended starting point", () => {
    const settings = normalizeHalftoneSettings({}, BLACK)!;
    assert.equal(settings.lpi, DEFAULT_HALFTONE_LPI);
    assert.equal(settings.angleDeg, DEFAULT_HALFTONE_ANGLE_DEG);
    assert.equal(settings.dotShape, "round");
    assert.equal(settings.midtone, DEFAULT_HALFTONE_MIDTONE);
    assert.equal(settings.chokePx, DEFAULT_HALFTONE_CHOKE_PX);
    assert.equal(settings.garment.hex, BLACK.hex);
    assert.ok(settings.algorithmVersion);
  });

  it("REFUSES out-of-band values rather than clamping them", () => {
    // A clamp would record a setting the operator did not choose, and every
    // one of these numbers is persisted as the explanation for how a physical
    // plate was made.
    assert.equal(normalizeHalftoneSettings({ lpi: MIN_HALFTONE_LPI - 1 }, BLACK), null);
    assert.equal(normalizeHalftoneSettings({ lpi: MAX_HALFTONE_LPI + 1 }, BLACK), null);
    assert.equal(normalizeHalftoneSettings({ lpi: 35.5 }, BLACK), null);
    assert.equal(normalizeHalftoneSettings({ angleDeg: 30 }, BLACK), null);
    assert.equal(normalizeHalftoneSettings({ dotShape: "diamond" }, BLACK), null);
    assert.equal(normalizeHalftoneSettings({ midtone: 3 }, BLACK), null);
    assert.equal(normalizeHalftoneSettings({ midtone: 0.1 }, BLACK), null);
    assert.equal(normalizeHalftoneSettings({ chokePx: 5 }, BLACK), null);
    assert.equal(normalizeHalftoneSettings({ chokePx: -1 }, BLACK), null);
  });

  it("accepts every value inside the band", () => {
    for (let lpi = MIN_HALFTONE_LPI; lpi <= MAX_HALFTONE_LPI; lpi += 1) {
      assert.ok(normalizeHalftoneSettings({ lpi }, BLACK), `${lpi} LPI should be legal`);
    }
    for (const angleDeg of [22.5, 45]) {
      assert.ok(normalizeHalftoneSettings({ angleDeg }, BLACK));
    }
    for (const dotShape of ["round", "ellipse"]) {
      assert.ok(normalizeHalftoneSettings({ dotShape }, BLACK));
    }
  });

  it("rounds midtone to the precision the canonical key records", () => {
    // So a settings value and its own identity string can never disagree by a
    // float artifact — which would make one plate look like two.
    const settings = normalizeHalftoneSettings({ midtone: 1.23456 }, BLACK)!;
    assert.equal(settings.midtone, 1.23);
    assert.match(productionTreatmentKey({ treatment: "halftone_dtf", halftone: settings }), /tone=1\.23/);
  });
});

describe("the canonical treatment key (test matrix Q, R)", () => {
  it("is a readable description of the plate, not a digest", () => {
    const key = productionTreatmentKey({
      treatment: "halftone_dtf",
      halftone: recommendedHalftoneSettings(BLACK),
    });
    assert.match(key, /^halftone_dtf\//);
    assert.match(key, /lpi=35/);
    assert.match(key, /ang=45/);
    assert.match(key, /dot=round/);
    assert.match(key, /tone=1\.00/);
    assert.match(key, /choke=0/);
    assert.match(key, /garment=#000000/);
  });

  it("changes when ANY input that changes an output pixel changes", () => {
    const base = productionTreatmentKey({
      treatment: "halftone_dtf",
      halftone: recommendedHalftoneSettings(BLACK),
    });
    const variants = [
      normalizeHalftoneSettings({ lpi: 45 }, BLACK)!,
      normalizeHalftoneSettings({ angleDeg: 22.5 }, BLACK)!,
      normalizeHalftoneSettings({ dotShape: "ellipse" }, BLACK)!,
      normalizeHalftoneSettings({ midtone: 1.4 }, BLACK)!,
      normalizeHalftoneSettings({ chokePx: 2 }, BLACK)!,
      // The GARMENT is an input too: it is the screen's tonal reference, so a
      // black-shirt plate and a navy-shirt plate are different plates.
      normalizeHalftoneSettings({}, NAVY)!,
    ];
    const keys = new Set(
      variants.map((halftone) => productionTreatmentKey({ treatment: "halftone_dtf", halftone })),
    );
    assert.equal(keys.size, variants.length, "every variant must be distinct");
    for (const key of keys) assert.notEqual(key, base);
  });

  it("is stable — identical settings always produce the identical key", () => {
    assert.equal(
      productionTreatmentKey({ treatment: "halftone_dtf", halftone: normalizeHalftoneSettings({ lpi: 40 }, BLACK)! }),
      productionTreatmentKey({ treatment: "halftone_dtf", halftone: normalizeHalftoneSettings({ lpi: 40 }, BLACK)! }),
    );
  });

  it("puts legacy jobs and new standard-raster jobs in the SAME bucket", () => {
    // The sentinel the migration's `coalesce(..., 'standard_raster')` writes
    // and the key a standard-raster job carries are deliberately the same
    // string: they are the same production intent, and splitting them would
    // stop every historical job deduplicating against every other.
    assert.equal(
      productionTreatmentKey({ treatment: "standard_raster" }),
      STANDARD_RASTER_TREATMENT_KEY,
    );
    assert.equal(treatmentKeyMatchesJob(STANDARD_RASTER_TREATMENT_KEY, null), true);
    assert.equal(
      treatmentKeyMatchesJob(STANDARD_RASTER_TREATMENT_KEY, STANDARD_RASTER_TREATMENT_KEY),
      true,
    );
  });

  it("fences a legacy job out of a project that has since moved to a halftone", () => {
    const halftoneKey = productionTreatmentKey({
      treatment: "halftone_dtf",
      halftone: recommendedHalftoneSettings(BLACK),
    });
    assert.equal(treatmentKeyMatchesJob(halftoneKey, null), false);
    assert.equal(treatmentKeyMatchesJob(halftoneKey, STANDARD_RASTER_TREATMENT_KEY), false);
  });
});

describe("resolving the durable treatment (fail toward standard raster)", () => {
  const settings = recommendedHalftoneSettings(BLACK);

  it("resolves a complete halftone decision", () => {
    const resolved = resolveProductionTreatment({
      productionTreatment: "halftone_dtf",
      halftoneSettings: settings,
      productionTreatmentSelectedAt: "2026-08-21T00:00:00.000Z",
    });
    assert.equal(resolved.treatment, "halftone_dtf");
  });

  it("falls to standard raster when the decision is not intact", () => {
    // A treatment with no settings, or with no record of a human having
    // chosen it, is a damaged decision — and the only safe reading of a
    // damaged decision is the representation nothing was relaxed for.
    assert.equal(
      resolveProductionTreatment({
        productionTreatment: "halftone_dtf",
        halftoneSettings: null,
        productionTreatmentSelectedAt: "2026-08-21T00:00:00.000Z",
      }).treatment,
      "standard_raster",
    );
    assert.equal(
      resolveProductionTreatment({
        productionTreatment: "halftone_dtf",
        halftoneSettings: settings,
        productionTreatmentSelectedAt: null,
      }).treatment,
      "standard_raster",
    );
  });

  it("can never turn a standard-raster project into a halftone one", () => {
    assert.equal(
      resolveProductionTreatment({
        productionTreatment: "standard_raster",
        halftoneSettings: settings,
        productionTreatmentSelectedAt: "2026-08-21T00:00:00.000Z",
      }).treatment,
      "standard_raster",
    );
    assert.equal(
      currentProductionTreatmentKey({
        productionTreatment: "standard_raster",
        halftoneSettings: settings,
        productionTreatmentSelectedAt: "2026-08-21T00:00:00.000Z",
      }),
      STANDARD_RASTER_TREATMENT_KEY,
    );
  });
});

describe("persisted settings are read fail-closed", () => {
  it("round-trips a complete document", () => {
    const settings = normalizeHalftoneSettings({ lpi: 45, dotShape: "ellipse" }, NAVY)!;
    const read = readHalftoneSettings(JSON.parse(JSON.stringify(settings)));
    assert.deepEqual(read, settings);
  });

  it("returns null on ANY missing or malformed field, never defaults into the gap", () => {
    // These settings ARE the plate. A partial document means "not
    // reproducible", never "reproducible with defaults filled in".
    const complete = JSON.parse(
      JSON.stringify(recommendedHalftoneSettings(BLACK)),
    ) as Record<string, unknown>;

    assert.ok(readHalftoneSettings(complete));
    for (const key of Object.keys(complete)) {
      const damaged = { ...complete };
      delete damaged[key];
      assert.equal(readHalftoneSettings(damaged), null, `missing ${key} must read as null`);
    }
    assert.equal(readHalftoneSettings(null), null);
    assert.equal(readHalftoneSettings("halftone"), null);
    assert.equal(readHalftoneSettings([]), null);
    assert.equal(readHalftoneSettings({ ...complete, lpi: 999 }), null);
    assert.equal(readHalftoneSettings({ ...complete, angleDeg: 30 }), null);
    assert.equal(readHalftoneSettings({ ...complete, dotShape: "diamond" }), null);
    assert.equal(readHalftoneSettings({ ...complete, garment: { hex: "#000000" } }), null);
    assert.equal(
      readHalftoneSettings({ ...complete, garment: { label: "Black", hex: "nope", rgb: { r: 0, g: 0, b: 0 } } }),
      null,
    );
  });
});

describe("eligibility (Goal 3 — an offer, never a success decision)", () => {
  const base: HalftoneEligibilityInput = {
    productionCategory: "apparel_raster",
    productionSizeConfirmed: true,
    preparedSourceAvailable: true,
    garment: BLACK,
    tone: { visiblePixelCount: 10_000, midtoneFraction: 0.6 },
  };

  it("offers the treatment for confirmed, prepared, tonal apparel artwork", () => {
    const result = assessHalftoneEligibility(base);
    assert.equal(result.eligible, true);
  });

  it("HARD-refuses, with no operator override, when there is nothing to treat", () => {
    const cases: Array<[Partial<HalftoneEligibilityInput>, string]> = [
      [{ productionCategory: "apparel_vector" }, "unsupported_production_profile"],
      [{ productionSizeConfirmed: false }, "production_size_unconfirmed"],
      [{ preparedSourceAvailable: false }, "no_prepared_source"],
      [{ garment: null }, "garment_color_unresolved"],
      [{ tone: { visiblePixelCount: 0, midtoneFraction: 0 } }, "no_visible_artwork"],
      [{ tone: null }, "no_visible_artwork"],
    ];
    for (const [override, reason] of cases) {
      const result = assessHalftoneEligibility({ ...base, ...override });
      assert.equal(result.eligible, false, reason);
      assert.equal(result.eligible === false && result.reason, reason);
      assert.equal(result.eligible === false && result.overridable, false);
    }
  });

  it("SOFT-refuses flat artwork, but leaves the door open for a deliberate operator", () => {
    // A solid-colour logo screened at 35 LPI is a solid-colour logo with holes
    // in it — not offered by default. But an operator who deliberately wants
    // the garment-blend look on a flat logo is making a legitimate production
    // choice (Goal 3), so this reason is overridable and the others are not.
    const result = assessHalftoneEligibility({
      ...base,
      tone: { visiblePixelCount: 10_000, midtoneFraction: MIN_HALFTONE_MIDTONE_FRACTION / 2 },
    });
    assert.equal(result.eligible, false);
    assert.equal(result.eligible === false && result.reason, "no_tonal_content");
    assert.equal(result.eligible === false && result.overridable, true);
  });

  it("checks the hard reasons in an order that always names the most fundamental one", () => {
    // Everything missing at once reports the production profile, not the
    // garment colour — an operator is told the thing that has to be true
    // first, rather than the last check that happened to run.
    const result = assessHalftoneEligibility({
      productionCategory: "out_of_scope_product",
      productionSizeConfirmed: false,
      preparedSourceAvailable: false,
      garment: null,
      tone: null,
    });
    assert.equal(result.eligible === false && result.reason, "unsupported_production_profile");
  });
});
