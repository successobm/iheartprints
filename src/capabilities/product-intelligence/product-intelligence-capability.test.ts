import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createProductIntelligenceCapability } from "./product-intelligence-capability";
import type { TShirtDesignBrief } from "@/lib/domain/types";

function brief(overrides: Partial<TShirtDesignBrief> = {}): TShirtDesignBrief {
  return {
    id: "brief-1",
    projectId: "project-1",
    customerName: null,
    projectName: null,
    productSummary: null,
    designDescription: null,
    exactText: null,
    shirtColor: null,
    printPlacement: null,
    intendedPrintWidthIn: null,
    garmentSizeClass: null,
    productionSizeConfirmedAt: null,
    productionSizeConfirmedWidthIn: null,
    productionSizeConfirmedMaxHeightIn: null,
    requestedProductionOutput: null,
    preferredColors: [],
    designStyle: null,
    additionalInstructions: null,
    audience: null,
    purpose: null,
    exclusions: null,
    deferredSections: [],
    createdAt: "2026-08-04T00:00:00.000Z",
    updatedAt: "2026-08-04T00:00:00.000Z",
    ...overrides,
  };
}

const capability = createProductIntelligenceCapability();

describe("ProductIntelligenceCapability — small placement wording risk", () => {
  it("finds nothing on a clean, empty brief", () => {
    assert.deepEqual(capability.evaluateBrief(brief()), []);
  });

  it("finds nothing when placement is not set yet", () => {
    const findings = capability.evaluateBrief(
      brief({ exactText: "This is quite a long line of required wording text" }),
    );
    assert.equal(findings.length, 0);
  });

  it("finds nothing for short wording on a small placement", () => {
    const findings = capability.evaluateBrief(
      brief({ printPlacement: "left_chest", exactText: "Camp Wildwood" }),
    );
    assert.equal(findings.length, 0);
  });

  it("warns for moderately long wording on left chest", () => {
    const findings = capability.evaluateBrief(
      brief({
        printPlacement: "left_chest",
        exactText: "Camp Wildwood Summer Session Two Thousand Twenty Six Edition",
      }),
    );
    const finding = findings.find((f) => f.code === "small_placement_long_wording");
    assert.ok(finding);
    assert.equal(finding.severity, "warning");
    assert.match(finding.plainLanguage, /left chest/i);
  });

  it("warns (not blocks) for the same long wording on left chest vs. sleeve threshold", () => {
    const wording = Array.from({ length: 10 }, (_, i) => `word${i}`).join(" ");
    const findings = capability.evaluateBrief(
      brief({ printPlacement: "left_chest", exactText: wording }),
    );
    const finding = findings.find((f) => f.code === "small_placement_long_wording");
    assert.equal(finding?.severity, "warning");
  });

  it("escalates to blocking for very long wording specifically on a sleeve", () => {
    const wording = Array.from({ length: 20 }, (_, i) => `word${i}`).join(" ");
    const findings = capability.evaluateBrief(
      brief({ printPlacement: "sleeve", exactText: wording }),
    );
    const finding = findings.find((f) => f.code === "small_placement_long_wording");
    assert.ok(finding);
    assert.equal(finding.severity, "blocking");
    assert.match(finding.plainLanguage, /won't fit|shorter/i);
  });

  it("does not escalate to blocking on left chest even with very long wording", () => {
    const wording = Array.from({ length: 20 }, (_, i) => `word${i}`).join(" ");
    const findings = capability.evaluateBrief(
      brief({ printPlacement: "left_chest", exactText: wording }),
    );
    const finding = findings.find((f) => f.code === "small_placement_long_wording");
    assert.equal(finding?.severity, "warning");
  });

  it("does not fire when the customer explicitly said no required wording", () => {
    const findings = capability.evaluateBrief(
      brief({ printPlacement: "sleeve", exactText: "" }),
    );
    assert.equal(findings.length, 0);
  });
});

describe("ProductIntelligenceCapability — small placement graphic density", () => {
  it("warns when a small placement pairs with a busy design description", () => {
    const findings = capability.evaluateBrief(
      brief({
        printPlacement: "sleeve",
        designDescription: "Covered in intricate line work and tiny characters",
      }),
    );
    const finding = findings.find((f) => f.code === "small_placement_dense_graphics");
    assert.ok(finding);
    assert.equal(finding.severity, "warning");
  });

  it("does not fire for a simple description on a small placement", () => {
    const findings = capability.evaluateBrief(
      brief({ printPlacement: "sleeve", designDescription: "A small anchor icon" }),
    );
    assert.equal(
      findings.some((f) => f.code === "small_placement_dense_graphics"),
      false,
    );
  });

  it("does not fire on a large placement even with a busy description", () => {
    const findings = capability.evaluateBrief(
      brief({
        printPlacement: "full_front",
        designDescription: "Covered in intricate line work and tiny characters",
      }),
    );
    assert.equal(
      findings.some((f) => f.code === "small_placement_dense_graphics"),
      false,
    );
  });
});

describe("ProductIntelligenceCapability — large placement wall of text", () => {
  it("is informational only for very long wording on a full front print", () => {
    const wording = Array.from({ length: 30 }, (_, i) => `word${i}`).join(" ");
    const findings = capability.evaluateBrief(
      brief({ printPlacement: "full_front", exactText: wording }),
    );
    const finding = findings.find((f) => f.code === "full_placement_wall_of_text");
    assert.ok(finding);
    assert.equal(finding.severity, "info");
  });

  it("does not fire for reasonably sized wording on a full back print", () => {
    const findings = capability.evaluateBrief(
      brief({ printPlacement: "full_back", exactText: "Camp Wildwood 2026" }),
    );
    assert.equal(
      findings.some((f) => f.code === "full_placement_wall_of_text"),
      false,
    );
  });
});

describe("ProductIntelligenceCapability — determinism", () => {
  it("the same brief always produces the same findings", () => {
    const input = brief({
      printPlacement: "sleeve",
      exactText: Array.from({ length: 20 }, (_, i) => `word${i}`).join(" "),
      designDescription: "Covered in intricate detail",
    });
    assert.deepEqual(capability.evaluateBrief(input), capability.evaluateBrief(input));
  });
});

describe("ProductIntelligenceCapability — selective rule-pack execution (Sprint 2G Part 2)", () => {
  const richBrief = brief({
    printPlacement: "sleeve",
    exactText: Array.from({ length: 20 }, (_, i) => `word${i}`).join(" "), // triggers wording risk
    designDescription: "Covered in intricate detail", // triggers density risk
  });

  it("runs every rule pack by default (no filter given)", () => {
    const findings = capability.evaluateBrief(richBrief);
    const codes = findings.map((f) => f.code).sort();
    assert.deepEqual(codes, [
      "small_placement_dense_graphics",
      "small_placement_long_wording",
    ]);
  });

  it("runs only the requested rule pack when a filter is given", () => {
    const findings = capability.evaluateBrief(richBrief, [
      "small_placement_long_wording",
    ]);
    assert.deepEqual(findings.map((f) => f.code), ["small_placement_long_wording"]);
  });

  it("runs nothing when no rule packs are affected", () => {
    const findings = capability.evaluateBrief(richBrief, []);
    assert.deepEqual(findings, []);
  });

  it("a wording-only filter never runs the graphics-density rule pack even if it would otherwise fire", () => {
    const findings = capability.evaluateBrief(richBrief, [
      "full_placement_wall_of_text", // wouldn't fire anyway (sleeve, not full) but proves routing, not content
    ]);
    assert.deepEqual(findings, []);
  });
});
