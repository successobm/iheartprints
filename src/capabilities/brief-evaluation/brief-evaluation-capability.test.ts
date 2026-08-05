import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createBriefEvaluationCapability } from "./brief-evaluation-capability";
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

function section(
  evaluation: ReturnType<
    ReturnType<typeof createBriefEvaluationCapability>["evaluate"]
  >,
  key: string,
) {
  const found = evaluation.sections.find((s) => s.section === key);
  assert.ok(found, `expected a section evaluation for "${key}"`);
  return found;
}

const REQUIRED = ["product", "graphics", "requiredWording", "productColor"];
const HIGH_VALUE = ["purpose", "audience", "style", "colors", "printLocation"];
const OPTIONAL = [
  "references",
  "exclusions",
  "additionalNotes",
  "production",
  "layoutPreference",
];

function fullBrief(overrides: Partial<TShirtDesignBrief> = {}) {
  return brief({
    productSummary: "Camp shirts",
    designDescription: "A friendly bear logo walking through pine trees",
    shirtColor: "Navy",
    exactText: "Camp Wildwood 2026",
    ...overrides,
  });
}

describe("BriefEvaluationCapability — coverage policy tiers", () => {
  const capability = createBriefEvaluationCapability();

  it("evaluates every section as unknown on a fresh brief and is not ready", () => {
    const evaluation = capability.evaluate(brief());

    assert.equal(evaluation.sections.length, 14);
    assert.ok(evaluation.sections.every((s) => s.resolution === "unknown"));
    assert.ok(evaluation.sections.every((s) => !s.known));
    assert.ok(evaluation.sections.every((s) => s.confidence === 0));

    assert.equal(evaluation.overall.completeness, 0);
    assert.equal(evaluation.overall.blockingSectionCount, 4);
    assert.equal(evaluation.summaryReadiness.ready, false);
    assert.equal(evaluation.approvalReadiness.ready, false);
    assert.deepEqual(
      [...evaluation.approvalReadiness.blockingSections].sort(),
      [...REQUIRED].sort(),
    );
  });

  it("classifies sections into required / high_value / optional per the coverage policy", () => {
    const evaluation = capability.evaluate(brief());

    for (const key of REQUIRED) {
      const s = section(evaluation, key);
      assert.equal(s.tier, "required", key);
      assert.equal(s.blocking, true, key);
      assert.equal(s.deferrable, false, key);
    }
    for (const key of HIGH_VALUE) {
      const s = section(evaluation, key);
      assert.equal(s.tier, "high_value", key);
      assert.equal(s.blocking, false, key);
      assert.equal(s.deferrable, true, key);
    }
    for (const key of OPTIONAL) {
      const s = section(evaluation, key);
      assert.equal(s.tier, "optional", key);
      assert.equal(s.blocking, false, key);
      assert.equal(s.deferrable, true, key);
    }
  });

  it("is NOT summary-ready with only the four required fields — high-value sections still gate", () => {
    const evaluation = capability.evaluate(fullBrief());

    assert.equal(evaluation.summaryReadiness.ready, false);
    const stillNeeded = HIGH_VALUE;
    for (const key of stillNeeded) {
      assert.equal(section(evaluation, key).resolution, "unknown", key);
    }
  });

  it("becomes summary- and approval-ready once required + high-value are all resolved", () => {
    const evaluation = capability.evaluate(
      fullBrief({
        purpose: "Summer camp fundraiser",
        audience: "Camp families",
        designStyle: "Rustic outdoors",
        preferredColors: ["Forest Green", "Cream"],
        printPlacement: "full_front",
      }),
    );

    assert.equal(evaluation.summaryReadiness.ready, true);
    assert.equal(evaluation.approvalReadiness.ready, true);
    assert.deepEqual(evaluation.approvalReadiness.blockingSections, []);

    // Optional sections remain unresolved without blocking readiness.
    assert.equal(section(evaluation, "references").resolution, "unknown");
  });

  it("high-value deferral resolves the section without content and does not block summary", () => {
    const evaluation = capability.evaluate(
      fullBrief({
        deferredSections: ["purpose", "audience", "style", "colors", "printLocation"],
      }),
    );

    assert.equal(evaluation.summaryReadiness.ready, true);
    for (const key of HIGH_VALUE) {
      const s = section(evaluation, key);
      assert.equal(s.resolution, "deferred_to_designer", key);
      assert.equal(s.known, false, key);
      assert.equal(s.missing, false, key);
    }
  });

  it("required sections cannot be deferred — a bogus deferral entry is ignored", () => {
    const evaluation = capability.evaluate(
      brief({ deferredSections: ["product", "requiredWording"] }),
    );

    assert.equal(section(evaluation, "product").resolution, "unknown");
    assert.equal(section(evaluation, "requiredWording").resolution, "unknown");
    assert.equal(evaluation.summaryReadiness.ready, false);
  });
});

describe("BriefEvaluationCapability — required wording modes", () => {
  const capability = createBriefEvaluationCapability();

  it("exactText === null is 'unknown', not confirmed absence", () => {
    const evaluation = capability.evaluate(brief({ exactText: null }));
    const wording = section(evaluation, "requiredWording");
    assert.equal(wording.resolution, "unknown");
    assert.equal(wording.confidence, 0);
  });

  it('exactText === "" is treated as explicit "none" with full confidence', () => {
    const evaluation = capability.evaluate(brief({ exactText: "" }));
    const wording = section(evaluation, "requiredWording");
    assert.equal(wording.resolution, "provided");
    assert.equal(wording.known, true);
    assert.equal(wording.confidence, 100);
    assert.equal(wording.ambiguous, false);
  });

  it("non-empty exactText is 'provided' and scored for ambiguity like any free text", () => {
    const evaluation = capability.evaluate(
      brief({ exactText: "Camp Wildwood 2026" }),
    );
    const wording = section(evaluation, "requiredWording");
    assert.equal(wording.resolution, "provided");
    assert.equal(wording.ambiguous, false);
    assert.ok(wording.confidence >= 90);
  });
});

describe("BriefEvaluationCapability — ambiguity", () => {
  const capability = createBriefEvaluationCapability();

  it("recognizes vague phrasing as provided but low confidence, surfaced as an ambiguity", () => {
    const evaluation = capability.evaluate(brief({ designStyle: "make it cool" }));

    const style = section(evaluation, "style");
    assert.equal(style.known, true);
    assert.equal(style.resolution, "provided");
    assert.equal(style.ambiguous, true);
    assert.ok(style.confidence < 50);

    assert.equal(evaluation.ambiguities.length, 1);
    assert.equal(evaluation.ambiguities[0]?.section, "style");
  });

  it("scores concrete, specific phrasing with high confidence", () => {
    const evaluation = capability.evaluate(
      brief({ designDescription: "A bowling ball striking a row of pins" }),
    );

    const graphics = section(evaluation, "graphics");
    assert.equal(graphics.ambiguous, false);
    assert.ok(graphics.confidence >= 90);
  });
});

describe("BriefEvaluationCapability — print location", () => {
  const capability = createBriefEvaluationCapability();

  it("is unknown when printPlacement is null (never a false default)", () => {
    const evaluation = capability.evaluate(brief({ printPlacement: null }));
    assert.equal(section(evaluation, "printLocation").resolution, "unknown");
  });

  it("is provided with high confidence once the customer picks a placement", () => {
    const evaluation = capability.evaluate(brief({ printPlacement: "left_chest" }));
    const printLocation = section(evaluation, "printLocation");
    assert.equal(printLocation.resolution, "provided");
    assert.match(printLocation.reason, /left chest/);
    assert.ok(printLocation.confidence >= 90);
  });

  it("can be explicitly deferred", () => {
    const evaluation = capability.evaluate(
      brief({ printPlacement: null, deferredSections: ["printLocation"] }),
    );
    assert.equal(
      section(evaluation, "printLocation").resolution,
      "deferred_to_designer",
    );
  });
});

describe("BriefEvaluationCapability — contradictions", () => {
  const capability = createBriefEvaluationCapability();

  it("blocking: every requested artwork color matches the product color", () => {
    const evaluation = capability.evaluate(
      brief({ shirtColor: "Red", preferredColors: ["Red"] }),
    );

    assert.equal(evaluation.contradictions.length, 1);
    const conflict = evaluation.contradictions[0];
    assert.ok(conflict);
    assert.equal(conflict.severity, "blocking");
    assert.equal(conflict.code, "color_clash");
    assert.deepEqual([...conflict.sections].sort(), ["colors", "productColor"]);

    // A blocking contradiction must prevent approval even if everything else is resolved.
    assert.equal(evaluation.approvalReadiness.ready, false);
  });

  it("warning: only some requested artwork colors match the product color", () => {
    const evaluation = capability.evaluate(
      brief({ shirtColor: "Red", preferredColors: ["Red", "White"] }),
    );

    const conflict = evaluation.contradictions[0];
    assert.ok(conflict);
    assert.equal(conflict.severity, "warning");
  });

  it("does not flag a color contradiction when colors differ", () => {
    const evaluation = capability.evaluate(
      brief({ shirtColor: "Navy", preferredColors: ["Gold", "White"] }),
    );
    assert.equal(evaluation.contradictions.length, 0);
  });

  it("detects a minimalist style vs. long required wording contradiction", () => {
    const longWording =
      "This design should say a whole paragraph of text describing our entire camp mission statement and history";
    const evaluation = capability.evaluate(
      brief({ designStyle: "Minimalist", exactText: longWording }),
    );

    const conflict = evaluation.contradictions.find((c) => c.code === "minimalist_wording_clash");
    assert.ok(conflict);
    assert.equal(conflict.severity, "warning");
  });

  it("detects a minimalist style vs. graphic-heavy description contradiction", () => {
    const evaluation = capability.evaluate(
      brief({
        designStyle: "Minimalist and clean",
        designDescription: "Covered in graphics from top to bottom",
      }),
    );

    const conflict = evaluation.contradictions.find((c) => c.code === "minimalist_graphics_clash");
    assert.ok(conflict);
  });

  it("reports contradictions without recommending a fix", () => {
    const evaluation = capability.evaluate(
      brief({ shirtColor: "Red", preferredColors: ["Red"] }),
    );
    for (const conflict of evaluation.contradictions) {
      assert.doesNotMatch(conflict.message, /\bshould\b|\brecommend\b|\btry\b/i);
    }
  });
});

describe("BriefEvaluationCapability — determinism and overall metrics", () => {
  const capability = createBriefEvaluationCapability();

  it("is deterministic: the same brief always produces the same evaluation", () => {
    const input = fullBrief({
      designStyle: "Rustic outdoors",
      preferredColors: ["Forest Green", "Cream"],
      additionalInstructions: "Keep it playful",
    });

    const first = capability.evaluate(input);
    const second = capability.evaluate(input);
    assert.deepEqual(first, second);
  });

  it("computes overall confidence as the average across provided sections only", () => {
    const evaluation = capability.evaluate(
      brief({
        productSummary: "Camp shirts", // concrete -> 90
        designStyle: "make it cool", // ambiguous -> 35
      }),
    );

    const product = section(evaluation, "product");
    const style = section(evaluation, "style");
    const expected = Math.round((product.confidence + style.confidence) / 2);

    assert.equal(evaluation.overall.confidence, expected);
    assert.equal(evaluation.overall.knownSectionCount, 2);
  });

  it("counts deferred sections as resolved (not missing) toward completeness", () => {
    const withoutDefer = capability.evaluate(brief());
    const withDefer = capability.evaluate(
      brief({ deferredSections: ["style", "colors", "printLocation"] }),
    );

    assert.ok(withDefer.overall.completeness > withoutDefer.overall.completeness);
    assert.equal(withDefer.overall.missingSectionCount, withoutDefer.overall.missingSectionCount - 3);
  });
});
