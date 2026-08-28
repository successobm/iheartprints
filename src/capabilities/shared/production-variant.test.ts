import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  PRODUCTION_VARIANT_TREATMENTS,
  classifyVariantAttentionKind,
  describePackageGuidance,
  describeProductionVariantCostSummary,
  describeProductionVariantStatus,
  describeVariantAttentionReason,
  firstBlockingFailedCheck,
  productionVariantDescription,
  productionVariantLabel,
  type ProductionVariantView,
} from "./production-variant";

/**
 * Phase 27P — pure-logic coverage for the multi-variant package's status,
 * cost, and guidance derivation. No capability, no repository, no I/O.
 */

describe("describeProductionVariantStatus", () => {
  it("no job -> not_created", () => {
    assert.equal(describeProductionVariantStatus(null, null), "not_created");
  });

  it("queued/running/recoverable -> processing", () => {
    assert.equal(describeProductionVariantStatus("queued", null), "processing");
    assert.equal(describeProductionVariantStatus("running", null), "processing");
    assert.equal(describeProductionVariantStatus("recoverable", null), "processing");
  });

  it("failed (infrastructure) -> retryable_failure", () => {
    assert.equal(describeProductionVariantStatus("failed", null), "retryable_failure");
  });

  it("cancelled (superseded) -> not_created, never a failure reading", () => {
    assert.equal(describeProductionVariantStatus("cancelled", null), "not_created");
  });

  it("completed + validation ready -> print_ready", () => {
    assert.equal(describeProductionVariantStatus("completed", "ready"), "print_ready");
  });

  it("completed + validation finalization_required -> needs_attention, never retryable_failure", () => {
    assert.equal(
      describeProductionVariantStatus("completed", "finalization_required"),
      "needs_attention",
    );
  });

  it("completed + no validation record at all -> needs_attention (conservative, never print_ready)", () => {
    assert.equal(describeProductionVariantStatus("completed", null), "needs_attention");
  });
});

describe("describeVariantAttentionReason", () => {
  it("reconstruction_sufficiency / effective_resolution / minimum_raster_dimensions -> the exact Section 8 sentence", () => {
    const expected = "Standard Raster needs additional image enhancement at this print size.";
    assert.equal(
      describeVariantAttentionReason("standard_raster", "reconstruction_sufficiency"),
      expected,
    );
    assert.equal(
      describeVariantAttentionReason("standard_raster", "effective_resolution"),
      expected,
    );
    assert.equal(
      describeVariantAttentionReason("standard_raster", "minimum_raster_dimensions"),
      expected,
    );
  });

  it("halftone_tonal_sufficiency -> a halftone-specific plain sentence", () => {
    const reason = describeVariantAttentionReason("halftone_dtf", "halftone_tonal_sufficiency");
    assert.match(reason!, /tonal detail/);
  });

  it("null check -> null (nothing to explain)", () => {
    assert.equal(describeVariantAttentionReason("standard_raster", null), null);
  });

  it("an unrecognized check name never leaks the raw check name -- generic fallback per treatment", () => {
    const raster = describeVariantAttentionReason("standard_raster", "some_future_check");
    const halftone = describeVariantAttentionReason("halftone_dtf", "some_future_check");
    assert.doesNotMatch(raster!, /some_future_check/);
    assert.doesNotMatch(halftone!, /some_future_check/);
    assert.notEqual(raster, halftone);
  });
});

/**
 * Phase 28H Section 10 — DETERMINISTIC vs. OTHER, from actual internal
 * evidence. Standard Raster's validation profile has several OTHER blocking
 * checks entirely unrelated to insufficient resolution
 * (`aspect_ratio_preserved`, `alpha_bound_artwork`, `transparent_dead_canvas`,
 * `physical_width_policy`, ...) -- this proves the classification keys off
 * the SAME three checks `describeVariantAttentionReason` uses for its
 * specific sentence, never a broader "any Standard Raster needs_attention"
 * inference.
 */
describe("classifyVariantAttentionKind", () => {
  it("reconstruction_sufficiency / effective_resolution / minimum_raster_dimensions -> deterministic_enhancement", () => {
    assert.equal(classifyVariantAttentionKind("reconstruction_sufficiency"), "deterministic_enhancement");
    assert.equal(classifyVariantAttentionKind("effective_resolution"), "deterministic_enhancement");
    assert.equal(classifyVariantAttentionKind("minimum_raster_dimensions"), "deterministic_enhancement");
  });

  it("null -> null (nothing to classify)", () => {
    assert.equal(classifyVariantAttentionKind(null), null);
  });

  it("an unrelated blocking check (e.g. aspect ratio distortion, dead canvas, alpha-bound artwork) -> 'other', never 'deterministic_enhancement'", () => {
    for (const check of ["aspect_ratio_preserved", "alpha_bound_artwork", "transparent_dead_canvas", "physical_width_policy", "halftone_tonal_sufficiency"]) {
      assert.equal(classifyVariantAttentionKind(check), "other", `${check} must not be classified as deterministic_enhancement`);
    }
  });
});

describe("firstBlockingFailedCheck", () => {
  it("finds the first blocking-severity fail, skipping passes and non-blocking fails", () => {
    const report = {
      checks: [
        { check: "a", status: "pass", severity: "blocking", reason: "" },
        { check: "b", status: "fail", severity: "warning", reason: "" },
        { check: "c", status: "fail", severity: "blocking", reason: "" },
        { check: "d", status: "fail", severity: "blocking", reason: "" },
      ],
    };
    assert.equal(firstBlockingFailedCheck(report), "c");
  });

  it("null/malformed report -> null, never throws", () => {
    assert.equal(firstBlockingFailedCheck(null), null);
    assert.equal(firstBlockingFailedCheck(undefined), null);
    assert.equal(firstBlockingFailedCheck({}), null);
    assert.equal(firstBlockingFailedCheck({ checks: "not an array" } as never), null);
  });

  it("every check passing -> null", () => {
    assert.equal(
      firstBlockingFailedCheck({
        checks: [{ check: "a", status: "pass", severity: "blocking", reason: "" }],
      }),
      null,
    );
  });
});

describe("describeProductionVariantCostSummary", () => {
  it("no job -> empty, zero-cost facts", () => {
    const summary = describeProductionVariantCostSummary(null, null);
    assert.deepEqual(summary, {
      provider: null,
      externalProviderCalls: 0,
      paidProviderUsed: false,
      retryCount: 0,
    });
  });

  it("local provider (halftone or raster interpolation) -> never paid, zero external calls", () => {
    const summary = describeProductionVariantCostSummary(
      { attempts: 1, providerKey: "local_halftone_dtf" },
      null,
    );
    assert.equal(summary.paidProviderUsed, false);
    assert.equal(summary.externalProviderCalls, 0);
    assert.equal(summary.provider, "local_halftone_dtf");
  });

  it("topaz -- paid, one external call when a provider request id was recorded", () => {
    const summary = describeProductionVariantCostSummary(
      { attempts: 1, providerKey: "topaz_transparency_upscale" },
      "req-123",
    );
    assert.equal(summary.paidProviderUsed, true);
    assert.equal(summary.externalProviderCalls, 1);
  });

  it("topaz with no recorded provider request id -- paid provider, but zero calls actually left the process", () => {
    const summary = describeProductionVariantCostSummary(
      { attempts: 1, providerKey: "topaz_transparency_upscale" },
      null,
    );
    assert.equal(summary.paidProviderUsed, true);
    assert.equal(summary.externalProviderCalls, 0);
  });

  it("retryCount is attempts - 1, floored at 0", () => {
    assert.equal(
      describeProductionVariantCostSummary({ attempts: 1, providerKey: null }, null).retryCount,
      0,
    );
    assert.equal(
      describeProductionVariantCostSummary({ attempts: 3, providerKey: null }, null).retryCount,
      2,
    );
    assert.equal(
      describeProductionVariantCostSummary({ attempts: 0, providerKey: null }, null).retryCount,
      0,
    );
  });
});

function variant(overrides: Partial<ProductionVariantView>): ProductionVariantView {
  return {
    treatment: "standard_raster",
    label: productionVariantLabel("standard_raster"),
    description: productionVariantDescription("standard_raster"),
    status: "not_created",
    finalArtworkJobId: null,
    finalAssetId: null,
    createdAt: null,
    physicalWidthIn: null,
    physicalHeightIn: null,
    pixelWidth: null,
    pixelHeight: null,
    halftone: null,
    attentionReason: null,
    attentionKind: null,
    costSummary: describeProductionVariantCostSummary(null, null),
    ...overrides,
  };
}

describe("describePackageGuidance", () => {
  it("both ready -> the exact Section 8 'both files' sentence", () => {
    const guidance = describePackageGuidance([
      variant({ treatment: "standard_raster", status: "print_ready" }),
      variant({ treatment: "halftone_dtf", status: "print_ready", label: "DTF Halftone" }),
    ]);
    assert.equal(
      guidance,
      "Both files are print ready. Your printer can choose the version that works best for their equipment and production process.",
    );
  });

  it("one ready, one needs attention -> combines the ready label with the other's plain-language reason", () => {
    const guidance = describePackageGuidance([
      variant({ treatment: "standard_raster", status: "needs_attention", attentionReason: "Standard Raster needs additional image enhancement at this print size." }),
      variant({
        treatment: "halftone_dtf",
        label: "DTF Halftone",
        status: "print_ready",
      }),
    ]);
    assert.equal(
      guidance,
      "Your DTF Halftone file is print ready. Standard Raster needs additional image enhancement at this print size.",
    );
  });

  it("nothing ready yet -> null (no guidance to give)", () => {
    assert.equal(
      describePackageGuidance([
        variant({ status: "not_created" }),
        variant({ treatment: "halftone_dtf", status: "not_created" }),
      ]),
      null,
    );
  });

  it("one ready, nothing else terminal -> null (no contrast to draw yet)", () => {
    assert.equal(
      describePackageGuidance([
        variant({ status: "print_ready" }),
        variant({ treatment: "halftone_dtf", status: "not_created" }),
      ]),
      null,
    );
  });
});

describe("V1 scope", () => {
  it("exactly two variant treatments -- standard_raster and halftone_dtf, no more", () => {
    assert.deepEqual(PRODUCTION_VARIANT_TREATMENTS, ["standard_raster", "halftone_dtf"]);
  });

  it("never claims one variant is universally 'better' than the other", () => {
    for (const treatment of PRODUCTION_VARIANT_TREATMENTS) {
      assert.doesNotMatch(productionVariantDescription(treatment), /\bbetter\b/i);
      assert.doesNotMatch(productionVariantLabel(treatment), /\bbetter\b/i);
    }
  });
});
