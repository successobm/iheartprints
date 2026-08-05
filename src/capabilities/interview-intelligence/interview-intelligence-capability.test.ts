import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createBriefEvaluationCapability } from "@/capabilities/brief-evaluation";
import { createDesignIntelligenceCapability } from "@/capabilities/design-intelligence";
import { createProductIntelligenceCapability } from "@/capabilities/product-intelligence";
import { createRevisionIntelligenceCapability } from "@/capabilities/revision-intelligence";
import { createInterviewIntelligenceCapability } from "./interview-intelligence-capability";
import type { TShirtDesignBrief } from "@/lib/domain/types";
import type { InterviewContext } from "@/capabilities/shared/contracts";

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

function emptyContext(overrides: Partial<InterviewContext> = {}): InterviewContext {
  return { pendingSection: null, askCounts: {}, dismissedAdvisories: [], ...overrides };
}

const briefEvaluation = createBriefEvaluationCapability();
const designIntelligence = createDesignIntelligenceCapability(
  createProductIntelligenceCapability(),
);
const revisionIntelligence = createRevisionIntelligenceCapability();
const interviewIntelligence = createInterviewIntelligenceCapability();

function actFor(theBrief: TShirtDesignBrief, context: InterviewContext = emptyContext()) {
  const evaluation = briefEvaluation.evaluate(theBrief);
  const assessment = designIntelligence.assess(theBrief, evaluation);
  return interviewIntelligence.selectNextAct({ evaluation, assessment, context });
}

function revisionActFor(
  previousBrief: TShirtDesignBrief,
  updatedBrief: TShirtDesignBrief,
  context: InterviewContext = emptyContext(),
) {
  const impact = revisionIntelligence.analyze(previousBrief, updatedBrief);
  const evaluation = briefEvaluation.evaluate(updatedBrief);
  const assessment = designIntelligence.assess(updatedBrief, evaluation, impact);
  return interviewIntelligence.selectRevisionAct({ evaluation, assessment, impact, context });
}

describe("InterviewIntelligenceCapability — priority order", () => {
  it("asks for the highest-priority missing required section on a fresh brief", () => {
    const act = actFor(brief());
    assert.equal(act.type, "ask");
    assert.equal(act.type === "ask" ? act.section : null, "product");
  });

  it("moves to the next required section in tie-break order once one is known", () => {
    const act = actFor(brief({ productSummary: "Camp shirts" }));
    assert.equal(act.type, "ask");
    assert.equal(act.type === "ask" ? act.section : null, "graphics");
  });

  it("asks about high-value sections only after all required sections are resolved", () => {
    const full = brief({
      productSummary: "Camp shirts",
      designDescription: "A friendly bear logo",
      shirtColor: "Navy",
      exactText: "Camp Wildwood 2026",
    });
    const act = actFor(full);
    assert.equal(act.type, "ask");
    assert.equal(act.type === "ask" ? act.section : null, "purpose");
  });

  it("clarifies an ambiguous required section before moving to high-value sections", () => {
    const act = actFor(
      brief({
        productSummary: "Camp shirts",
        designDescription: "A friendly bear logo",
        shirtColor: "Navy",
        exactText: "make it cool", // vague, but "provided" — required tier
      }),
    );
    assert.equal(act.type, "clarify");
    assert.equal(act.type === "clarify" ? act.section : null, "requiredWording");
  });

  it("summarizes once required and high-value sections are resolved (deferral counts as resolved)", () => {
    const full = brief({
      productSummary: "Camp shirts",
      designDescription: "A friendly bear logo",
      shirtColor: "Navy",
      exactText: "Camp Wildwood 2026",
      deferredSections: ["purpose", "audience", "style", "colors", "printLocation"],
    });
    const act = actFor(full);
    assert.equal(act.type, "summarize");
  });

  it("never proactively asks about optional sections", () => {
    const full = brief({
      productSummary: "Camp shirts",
      designDescription: "A friendly bear logo",
      shirtColor: "Navy",
      exactText: "Camp Wildwood 2026",
      purpose: "Fundraiser",
      audience: "Camp families",
      designStyle: "Rustic",
      preferredColors: ["Forest Green"],
      printPlacement: "full_front",
    });
    const act = actFor(full);
    // references / exclusions / additionalNotes are all still unknown, but
    // none of them should be asked about.
    assert.equal(act.type, "summarize");
  });
});

describe("InterviewIntelligenceCapability — contradictions", () => {
  it("a blocking contradiction produces a clarification ahead of everything else", () => {
    const act = actFor(
      brief({
        productSummary: "Camp shirts",
        designDescription: "A friendly bear logo",
        shirtColor: "Red",
        preferredColors: ["Red"],
        exactText: "Camp Wildwood 2026",
      }),
    );
    assert.equal(act.type, "clarify");
    assert.match(act.type === "clarify" ? act.message : "", /may not be visible/i);
  });

  it("a resolved contradiction disappears after a correction", () => {
    const clashing = brief({
      productSummary: "Camp shirts",
      designDescription: "A friendly bear logo",
      shirtColor: "Red",
      preferredColors: ["Red"],
      exactText: "Camp Wildwood 2026",
    });
    const fixed = { ...clashing, preferredColors: ["White"] };
    const act = actFor(fixed);
    assert.notEqual(act.type, "clarify");
  });

  it("a warning-only contradiction does not prevent summary and is not exposed as an internal code", () => {
    const full = brief({
      productSummary: "Camp shirts",
      designDescription: "A friendly bear logo",
      shirtColor: "Red",
      preferredColors: ["Red", "White"], // partial overlap -> warning, not blocking
      exactText: "Camp Wildwood 2026",
      purpose: "Fundraiser",
      audience: "Camp families",
      designStyle: "Rustic",
      printPlacement: "full_front",
    });
    const act = actFor(full, emptyContext());
    assert.equal(act.type, "advise");
    if (act.type === "advise") {
      assert.doesNotMatch(act.message, /color_clash|blocking|warning/i);
      assert.doesNotMatch(act.message, /\d+%/);
    }
  });

  it("an already-dismissed advisory is not surfaced again, and summary follows", () => {
    const full = brief({
      productSummary: "Camp shirts",
      designDescription: "A friendly bear logo",
      shirtColor: "Red",
      preferredColors: ["Red", "White"],
      exactText: "Camp Wildwood 2026",
      purpose: "Fundraiser",
      audience: "Camp families",
      designStyle: "Rustic",
      printPlacement: "full_front",
    });
    const evaluation = briefEvaluation.evaluate(full);
    const assessment = designIntelligence.assess(full, evaluation);
    const advisory = assessment.recommendations[0];
    assert.ok(advisory);

    const act = interviewIntelligence.selectNextAct({
      evaluation,
      assessment,
      context: emptyContext({ dismissedAdvisories: [advisory.id] }),
    });
    assert.equal(act.type, "summarize");
  });
});

describe("InterviewIntelligenceCapability — production concerns (Sprint 2G)", () => {
  it("a production advisory is raised ahead of unresolved high-value sections", () => {
    const full = brief({
      productSummary: "Camp shirts",
      designDescription: "A friendly bear logo",
      shirtColor: "Navy",
      exactText: "Camp Wildwood Summer Session Two Thousand Twenty Six Edition", // > 8 words
      printPlacement: "left_chest", // small placement -> long-wording finding
      // purpose/audience/style/colors are all still unresolved.
    });
    const act = actFor(full);
    assert.equal(act.type, "advise");
    if (act.type === "advise") {
      assert.match(act.message, /left chest/i);
      assert.equal(act.followUpSection, "requiredWording");
    }
  });

  it("a blocking-severity production finding still surfaces as dismissible advice, not a hard clarify", () => {
    const longWording = Array.from({ length: 20 }, (_, i) => `word${i}`).join(" ");
    const full = brief({
      productSummary: "Camp shirts",
      designDescription: "A friendly bear logo",
      shirtColor: "Navy",
      exactText: longWording, // > 15 words on a sleeve -> blocking severity
      printPlacement: "sleeve",
    });
    const act = actFor(full);
    assert.equal(act.type, "advise");
    if (act.type === "advise") {
      assert.match(act.message, /won't fit|shorter/i);
    }
  });

  it("dismissing a production advisory moves on to the next unresolved high-value section", () => {
    const full = brief({
      productSummary: "Camp shirts",
      designDescription: "A friendly bear logo",
      shirtColor: "Navy",
      exactText: "Camp Wildwood Summer Session Two Thousand Twenty Six Edition",
      printPlacement: "left_chest",
    });
    const evaluation = briefEvaluation.evaluate(full);
    const assessment = designIntelligence.assess(full, evaluation);
    const advisory = assessment.recommendations.find((r) => r.kind === "production");
    assert.ok(advisory);

    const act = interviewIntelligence.selectNextAct({
      evaluation,
      assessment,
      context: emptyContext({ dismissedAdvisories: [advisory.id] }),
    });
    assert.equal(act.type, "ask");
    assert.equal(act.type === "ask" ? act.section : null, "purpose");
  });

  it("an info-severity production finding is never surfaced as an advise act", () => {
    const wording = Array.from({ length: 30 }, (_, i) => `word${i}`).join(" ");
    const full = brief({
      productSummary: "Camp shirts",
      designDescription: "A friendly bear logo",
      shirtColor: "Navy",
      exactText: wording, // > 25 words on full_front -> info only
      printPlacement: "full_front",
    });

    const evaluation = briefEvaluation.evaluate(full);
    const assessment = designIntelligence.assess(full, evaluation);
    const infoFinding = assessment.recommendations.find(
      (r) => r.kind === "production",
    );
    assert.ok(infoFinding, "expected the wall-of-text finding to exist in the assessment");
    assert.equal(infoFinding.severity, "info");

    const act = interviewIntelligence.selectNextAct({
      evaluation,
      assessment,
      context: emptyContext(),
    });
    // Never consumes a turn — moves straight to the next unresolved high-value section.
    assert.equal(act.type, "ask");
    assert.equal(act.type === "ask" ? act.section : null, "purpose");
  });
});

describe("InterviewIntelligenceCapability — selectRevisionAct (Sprint 2G Part 2)", () => {
  const approvedBrief = brief({
    productSummary: "Camp shirts",
    designDescription: "A friendly bear logo",
    shirtColor: "Navy",
    exactText: "Camp Wildwood 2026",
    purpose: "Fundraiser",
    audience: "Camp families",
    designStyle: "Rustic",
    preferredColors: ["Forest Green"],
    printPlacement: "full_front",
  });

  it("a no-op revision produces await_customer", () => {
    const act = revisionActFor(approvedBrief, approvedBrief);
    assert.equal(act.type, "await_customer");
  });

  it("a simple product change with nothing ambiguous or newly flagged continues naturally", () => {
    const act = revisionActFor(
      approvedBrief,
      { ...approvedBrief, productSummary: "Camp hoodies" },
    );
    assert.equal(act.type, "await_customer");
  });

  it("a color change that creates a blocking contradiction produces a clarify", () => {
    const act = revisionActFor(
      approvedBrief,
      { ...approvedBrief, shirtColor: "Forest Green", preferredColors: ["Forest Green"] },
    );
    assert.equal(act.type, "clarify");
    assert.match(act.type === "clarify" ? act.message : "", /may not be visible/i);
  });

  it("a wording change that creates a new production concern produces an advise act", () => {
    const longWording = Array.from({ length: 20 }, (_, i) => `word${i}`).join(" ");
    const act = revisionActFor(
      { ...approvedBrief, printPlacement: "sleeve" },
      { ...approvedBrief, printPlacement: "sleeve", exactText: longWording },
    );
    assert.equal(act.type, "advise");
    assert.match(act.type === "advise" ? act.message : "", /won't fit|shorter/i);
  });

  it("a style change that is itself vague produces a clarify for that section only", () => {
    const act = revisionActFor(approvedBrief, { ...approvedBrief, designStyle: "make it cool" });
    assert.equal(act.type, "clarify");
    assert.equal(act.type === "clarify" ? act.section : null, "style");
  });

  it("does not re-surface an unrelated pre-existing issue the revision didn't touch", () => {
    // audience is fine here; only productColor changes — no ambiguity or
    // advisory should fire even though other sections exist.
    const act = revisionActFor(approvedBrief, { ...approvedBrief, shirtColor: "Black" });
    assert.equal(act.type, "await_customer");
  });

  it("an already-dismissed revision advisory does not resurface", () => {
    const longWording = Array.from({ length: 20 }, (_, i) => `word${i}`).join(" ");
    const previous = { ...approvedBrief, printPlacement: "sleeve" as const };
    const updated = { ...previous, exactText: longWording };

    const impact = revisionIntelligence.analyze(previous, updated);
    const evaluation = briefEvaluation.evaluate(updated);
    const assessment = designIntelligence.assess(updated, evaluation, impact);
    const advisory = assessment.recommendations.find((r) => r.kind === "production");
    assert.ok(advisory);

    const act = interviewIntelligence.selectRevisionAct({
      evaluation,
      assessment,
      impact,
      context: emptyContext({ dismissedAdvisories: [advisory.id] }),
    });
    assert.equal(act.type, "await_customer");
  });
});

describe("InterviewIntelligenceCapability — repetition avoidance", () => {
  it("re-asking the same missing section uses different phrasing on retry", () => {
    const first = actFor(brief(), emptyContext());
    const second = actFor(brief(), emptyContext({ pendingSection: "product", askCounts: { product: 1 } }));

    assert.equal(first.type, "ask");
    assert.equal(second.type, "ask");
    if (first.type === "ask" && second.type === "ask") {
      assert.notEqual(first.message, second.message);
    }
  });
});

describe("InterviewIntelligenceCapability — no internal detail leaks to customers", () => {
  it("never includes a numeric confidence percentage in any message", () => {
    const full = brief({
      productSummary: "Camp shirts",
      designDescription: "make it cool",
      shirtColor: "Navy",
      exactText: "Camp Wildwood 2026",
    });
    const act = actFor(full);
    const message = "message" in act ? act.message : "";
    assert.doesNotMatch(message, /\d+%/);
  });
});
