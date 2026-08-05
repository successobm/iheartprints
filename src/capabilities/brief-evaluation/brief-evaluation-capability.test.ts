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
    printPlacement: "full_front",
    intendedPrintWidthIn: null,
    preferredColors: [],
    designStyle: null,
    additionalInstructions: null,
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

describe("BriefEvaluationCapability", () => {
  const capability = createBriefEvaluationCapability();

  it("evaluates every section as missing on a fresh brief and is not summary/approval ready", () => {
    const evaluation = capability.evaluate(brief());

    assert.equal(evaluation.sections.length, 14);
    assert.ok(evaluation.sections.every((s) => s.missing));
    assert.ok(evaluation.sections.every((s) => !s.known));
    assert.ok(evaluation.sections.every((s) => s.confidence === 0));

    assert.equal(evaluation.overall.completeness, 0);
    assert.equal(evaluation.overall.confidence, 0);
    assert.equal(evaluation.overall.knownSectionCount, 0);
    assert.equal(evaluation.overall.blockingSectionCount, 4);

    assert.equal(evaluation.summaryReadiness.ready, false);
    assert.equal(evaluation.approvalReadiness.ready, false);
    assert.deepEqual(
      [...evaluation.approvalReadiness.blockingSections].sort(),
      ["graphics", "product", "productColor", "requiredWording"].sort(),
    );
  });

  it("marks the four scripted fields as blocking and everything else optional", () => {
    const evaluation = capability.evaluate(brief());

    for (const key of [
      "product",
      "graphics",
      "productColor",
      "requiredWording",
    ]) {
      assert.equal(section(evaluation, key).blocking, true, key);
      assert.equal(section(evaluation, key).optional, false, key);
    }

    for (const key of [
      "audience",
      "purpose",
      "style",
      "colors",
      "printLocation",
      "references",
      "production",
      "layoutPreference",
      "exclusions",
      "additionalNotes",
    ]) {
      assert.equal(section(evaluation, key).blocking, false, key);
      assert.equal(section(evaluation, key).optional, true, key);
    }
  });

  it("is summary-ready and approval-ready once the four scripted fields are known", () => {
    const evaluation = capability.evaluate(
      brief({
        productSummary: "Camp shirts",
        designDescription: "A friendly bear logo walking through pine trees",
        shirtColor: "Navy",
        exactText: "Camp Wildwood 2026",
      }),
    );

    assert.equal(evaluation.summaryReadiness.ready, true);
    assert.equal(evaluation.approvalReadiness.ready, true);
    assert.deepEqual(evaluation.approvalReadiness.blockingSections, []);

    // Optional/never-gathered sections remain missing without blocking readiness.
    assert.equal(section(evaluation, "audience").missing, true);
    assert.equal(section(evaluation, "printLocation").missing, true);
  });

  it("treats an explicit empty required-wording answer as known with full confidence", () => {
    const evaluation = capability.evaluate(
      brief({
        productSummary: "Camp shirts",
        designDescription: "A friendly bear logo",
        shirtColor: "Navy",
        exactText: "",
      }),
    );

    const wording = section(evaluation, "requiredWording");
    assert.equal(wording.known, true);
    assert.equal(wording.missing, false);
    assert.equal(wording.confidence, 100);
    assert.equal(wording.ambiguous, false);
    assert.equal(evaluation.summaryReadiness.ready, true);
  });

  it("recognizes vague phrasing as known but low confidence, and surfaces it as an ambiguity", () => {
    const evaluation = capability.evaluate(
      brief({ designStyle: "make it cool" }),
    );

    const style = section(evaluation, "style");
    assert.equal(style.known, true);
    assert.equal(style.missing, false);
    assert.equal(style.ambiguous, true);
    assert.ok(style.confidence < 50);

    assert.equal(evaluation.ambiguities.length, 1);
    assert.equal(evaluation.ambiguities[0]?.section, "style");
  });

  it("recognizes other ambiguous filler phrases across sections", () => {
    for (const phrase of [
      "I don't know",
      "whatever looks good",
      "Make it modern",
    ]) {
      const evaluation = capability.evaluate(brief({ designStyle: phrase }));
      const style = section(evaluation, "style");
      assert.equal(style.ambiguous, true, phrase);
      assert.equal(style.known, true, phrase);
    }
  });

  it("scores concrete, specific phrasing with high confidence", () => {
    const evaluation = capability.evaluate(
      brief({
        designDescription: "A bowling ball striking a row of pins",
      }),
    );

    const graphics = section(evaluation, "graphics");
    assert.equal(graphics.known, true);
    assert.equal(graphics.ambiguous, false);
    assert.ok(graphics.confidence >= 90);
  });

  it("detects a color contradiction between requested color and product color", () => {
    const evaluation = capability.evaluate(
      brief({ shirtColor: "Red", preferredColors: ["Red"] }),
    );

    assert.equal(evaluation.contradictions.length, 1);
    const conflict = evaluation.contradictions[0];
    assert.ok(conflict);
    assert.deepEqual([...conflict.sections].sort(), ["colors", "productColor"]);
    assert.match(conflict.message, /Red/);
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

    const conflict = evaluation.contradictions.find((c) =>
      c.sections.includes("requiredWording"),
    );
    assert.ok(conflict);
    assert.deepEqual([...conflict.sections].sort(), [
      "requiredWording",
      "style",
    ]);
  });

  it("detects a minimalist style vs. graphic-heavy description contradiction", () => {
    const evaluation = capability.evaluate(
      brief({
        designStyle: "Minimalist and clean",
        designDescription: "Covered in graphics from top to bottom",
      }),
    );

    const conflict = evaluation.contradictions.find((c) =>
      c.sections.includes("graphics"),
    );
    assert.ok(conflict);
    assert.deepEqual([...conflict.sections].sort(), ["graphics", "style"]);
  });

  it("reports contradictions without recommending a fix", () => {
    const evaluation = capability.evaluate(
      brief({ shirtColor: "Red", preferredColors: ["Red"] }),
    );

    for (const conflict of evaluation.contradictions) {
      assert.doesNotMatch(conflict.message, /\bshould\b|\brecommend\b|\btry\b/i);
    }
  });

  it("is deterministic: the same brief always produces the same evaluation", () => {
    const input = brief({
      productSummary: "Camp shirts",
      designDescription: "A friendly bear logo",
      shirtColor: "Navy",
      exactText: "Camp Wildwood 2026",
      designStyle: "Rustic outdoors",
      preferredColors: ["Forest Green", "Cream"],
      additionalInstructions: "Keep it playful",
    });

    const first = capability.evaluate(input);
    const second = capability.evaluate(input);

    assert.deepEqual(first, second);
  });

  it("computes overall confidence as the average across known sections only", () => {
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
});
