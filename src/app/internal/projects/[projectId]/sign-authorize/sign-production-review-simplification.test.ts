/**
 * Simplify Signs Production Review Phase: source-level structural
 * assertions for the normal-review-screen redesign — mirrors
 * `sign-production-review-download-position.test.ts`'s own established
 * pattern (no full-render harness exists for this async Server Component;
 * see that file's own doc for why).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

describe("Sign Production Review page: one primary approval action", () => {
  const source = readFileSync(
    "src/app/internal/projects/[projectId]/sign-authorize/page.tsx",
    "utf8",
  );

  it("SignApproveAndContinueButton is imported and rendered", () => {
    assert.match(source, /import \{ SignApproveAndContinueButton \} from "\.\/SignApproveAndContinueButton";/);
    assert.match(source, /<SignApproveAndContinueButton\b/);
  });

  it("the old split SignAuthorizeButton is no longer imported or rendered on this page", () => {
    assert.doesNotMatch(source, /SignAuthorizeButton/);
  });

  it("the plain-language SignPlanSummary is imported and rendered", () => {
    assert.match(source, /import \{ SignPlanSummary \} from "\.\/SignPlanSummary";/);
    assert.match(source, /<SignPlanSummary\b/);
  });

  it("both the summary and the approval action are gated on NOT yet authorized — never shown once a decision is already made", () => {
    const summaryIndex = source.indexOf("<SignPlanSummary");
    const buttonIndex = source.indexOf("<SignApproveAndContinueButton");
    const beforeSummary = source.slice(Math.max(0, summaryIndex - 400), summaryIndex);
    const beforeButton = source.slice(Math.max(0, buttonIndex - 400), buttonIndex);
    assert.match(beforeSummary, /!isAuthorized/);
    assert.match(beforeButton, /!isAuthorized/);
  });

  it("only ONE component renders '<SignApproveAndContinueButton' on the page (never duplicated)", () => {
    const count = (source.match(/<SignApproveAndContinueButton\b/g) ?? []).length;
    assert.equal(count, 1);
  });
});

describe("Sign Production Review page: technical/diagnostic detail is closed by default", () => {
  const source = readFileSync(
    "src/app/internal/projects/[projectId]/sign-authorize/page.tsx",
    "utf8",
  );

  it("Production details never has an `open` attribute any more — always closed by default", () => {
    const match = source.match(/<details[^>]*>\s*<summary[^>]*>Production details<\/summary>/);
    assert.ok(match, "sanity: the Production details <details><summary> pair must exist");
    assert.doesNotMatch(match![0], /\bopen\b/, "Production details must never force itself open");
  });

  it("the operator override tooling section is now labeled 'Advanced details', not 'Plan details'", () => {
    assert.doesNotMatch(source, /Plan details/);
    assert.match(source, /Advanced details/);
  });

  it("Advanced details has no `open` attribute either — closed by default", () => {
    const match = source.match(/<details[^>]*>\s*<summary[^>]*>Advanced details<\/summary>/);
    assert.ok(match, "sanity: the Advanced details <details><summary> pair must exist");
    assert.doesNotMatch(match![0], /\bopen\b/);
  });

  it("the development-phase name 'Phase 3B' never appears anywhere on this page", () => {
    assert.doesNotMatch(source, /Phase 3B/);
  });

  it("structural-region tooling still renders, but only inside Advanced details (capability preserved, never removed)", () => {
    const advancedStart = source.indexOf("Advanced details");
    const advancedEnd = source.indexOf("</details>", advancedStart);
    const structuralIndex = source.indexOf("<SignStructuralLayoutForm");
    assert.ok(structuralIndex >= 0, "sanity: structural-region tooling must still exist");
    assert.ok(
      structuralIndex > advancedStart && structuralIndex < advancedEnd,
      "SignStructuralLayoutForm must render inside Advanced details, never in the normal flow",
    );
  });

  it("canvas-first manual composition tooling still renders, but only inside Advanced details (capability preserved, never removed)", () => {
    const advancedStart = source.indexOf("Advanced details");
    const advancedEnd = source.indexOf("</details>", advancedStart);
    const compositionIndex = source.indexOf("<SignCompositionPlanForm");
    assert.ok(compositionIndex >= 0, "sanity: canvas-first composition tooling must still exist");
    assert.ok(
      compositionIndex > advancedStart && compositionIndex < advancedEnd,
      "SignCompositionPlanForm must render inside Advanced details, never in the normal flow",
    );
  });

  it("neither advanced tool is ever auto-invoked — no call to either route outside of an explicit form submit handler", () => {
    // Both forms POST from their own `handleSubmit`; this page.tsx itself
    // must never fetch either route directly.
    assert.doesNotMatch(source, /fetch\(`\/api\/internal\/projects\/\$\{projectId\}\/sign-artwork\/structural-layout`/);
    assert.doesNotMatch(source, /fetch\(`\/api\/internal\/projects\/\$\{projectId\}\/sign-artwork\/composition-plan`/);
  });

  it("plan risk classification, findings, and per-step technical detail remain inside Production details, never before it", () => {
    const productionDetailsStart = source.indexOf("Production details");
    const riskLabelIndex = source.indexOf("Plan risk classification");
    const stepsIndex = source.indexOf("Proposed preparation");
    assert.ok(riskLabelIndex > productionDetailsStart);
    assert.ok(stepsIndex > productionDetailsStart);
  });
});
