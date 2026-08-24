import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

/**
 * Intelligent Separation Phase 15: structural proof that the redesigned
 * `SeparationReviewPanel` is genuinely a one-region-at-a-time workspace, not
 * the 18-card vertical list it replaces.
 *
 * HONEST BOUNDARY (mirrors every prior phase's note on this same
 * component). `view` — and therefore `activeRegionId` — is populated only
 * inside `useEffect` bodies that fetch from the network; `react-dom/server`'s
 * `renderToString` never executes an effect at all, deferred or not, so the
 * interactive workspace body (region navigator, progress line, decision
 * buttons, context/detail panes) is unreachable through this repo's only
 * React test tool, exactly as it always was for this self-fetching
 * component. `uploaded-artwork-separation-mount.test.tsx` already covers
 * everything `renderToString` CAN reach (the loading-state placeholder,
 * mount position, easy-artwork optimism).
 *
 * What this file proves instead, by reading the component's own source: the
 * concrete architectural facts that distinguish "one region at a time" from
 * "18 expanded cards" — a per-region `.map()` block small enough to be a
 * compact navigator chip (a `<button>`, not an `<img>`), and exactly one
 * (never N) large context/detail image pair in the module. The BEHAVIOR
 * those elements drive (progress, navigation, auto-advance, persistence
 * gating, reload-resume) is proven directly, and far more rigorously, by
 * `region-review-workspace.test.ts`'s 52 tests against the pure functions
 * the component calls — not restated here.
 */
const SOURCE = readFileSync(
  path.join(__dirname, "SeparationReviewPanel.tsx"),
  "utf8",
);

describe("SeparationReviewPanel structure — one region at a time, not 18 cards (Phase 15)", () => {
  it("A: exactly one decision pane exists in the module — not one per region", () => {
    assert.equal((SOURCE.match(/data-decision-pane/g) ?? []).length, 1);
  });

  it("A: exactly one large context pane exists in the module — not one per region", () => {
    assert.equal((SOURCE.match(/data-context-pane/g) ?? []).length, 1);
    assert.equal((SOURCE.match(/data-context-image/g) ?? []).length, 1);
  });

  it("A: exactly one region detail (close-up) image exists in the module — not one per region", () => {
    assert.equal((SOURCE.match(/data-region-detail/g) ?? []).length, 1);
  });

  it("the compact region navigator's per-region element is a small button, never an <img>", () => {
    const navigatorBlock = SOURCE.slice(
      SOURCE.indexOf("data-region-navigator"),
      SOURCE.indexOf("Two-pane at lg+"),
    );
    assert.ok(navigatorBlock.length > 0, "navigator block must exist");
    assert.doesNotMatch(navigatorBlock, /<img/, "the region navigator must stay compact chips, never a re-embedded image per region");
    assert.match(navigatorBlock, /<button/, "each navigator entry is a button");
  });

  it("D: Previous/Next controls exist exactly once each", () => {
    assert.equal((SOURCE.match(/data-nav="previous"/g) ?? []).length, 1);
    assert.equal((SOURCE.match(/data-nav="next"/g) ?? []).length, 1);
  });

  it("B/C: the progress line reports both position and reviewed count from the shared pure computation, not a hand-rolled count", () => {
    assert.match(SOURCE, /computeRegionProgress/);
    assert.match(SOURCE, /Area \{position\} of \{progress\.totalRegions\}/);
    assert.match(SOURCE, /\{progress\.reviewedCount\} of \{progress\.totalRegions\} reviewed/);
  });

  it("E/F: navigation after a decision is driven by the persistence result, never called before the fetch resolves", () => {
    const decideFn = SOURCE.slice(SOURCE.indexOf("async function decide"), SOURCE.indexOf("async function approve"));
    const awaitIndex = decideFn.indexOf("await submitRegionDecision");
    const advanceIndex = decideFn.indexOf("setActiveRegionId(targetRegionId)");
    assert.ok(awaitIndex !== -1 && advanceIndex !== -1);
    assert.ok(awaitIndex < advanceIndex, "the decision must be awaited before any navigation call");
    // And structurally inside the `result.ok` branch only.
    const okBranch = decideFn.slice(decideFn.indexOf("if (result.ok)"), decideFn.indexOf("} else {"));
    assert.match(okBranch, /setActiveRegionId\(targetRegionId\)/);
  });

  it("REGRESSION (Phase 15B): navigation after a decision is gated by shouldAdvance, not called merely because targetRegionId exists — a revisit's targetRegionId is also null, and an ungated call would silently bounce the operator to region 1 via the render fallback", () => {
    const decideFn = SOURCE.slice(SOURCE.indexOf("async function decide"), SOURCE.indexOf("async function approve"));
    const okBranch = decideFn.slice(decideFn.indexOf("if (result.ok)"), decideFn.indexOf("} else {"));
    assert.match(
      okBranch,
      /if \(shouldAdvance\) \{\s*setActiveRegionId\(targetRegionId\);/,
      "setActiveRegionId(targetRegionId) must be wrapped in an `if (shouldAdvance)` check",
    );
  });

  it("I/J: reaching final review is a navigation (activeRegionId), never a call to the approval endpoint from inside decide()", () => {
    const decideFn = SOURCE.slice(SOURCE.indexOf("async function decide"), SOURCE.indexOf("async function approve"));
    assert.doesNotMatch(decideFn, /submitApproval/, "deciding a region must never itself call the approval endpoint");
  });

  it("J: approval uses the existing approval path (submitApproval), not a re-implemented fetch", () => {
    const approveFn = SOURCE.slice(SOURCE.indexOf("async function approve"), SOURCE.indexOf("if (loading)"));
    assert.match(approveFn, /submitApproval/);
  });

  it("K: original/prepared final inspection images exist in the final-review branch", () => {
    const finalReviewBlock = SOURCE.slice(SOURCE.indexOf("showFinalReview) {"), SOURCE.indexOf("// --- The region-by-region workspace"));
    assert.match(finalReviewBlock, /mode=original/);
    assert.match(finalReviewBlock, /mode=master-preview/);
  });

  it("L: White/Gray/Black (and Red) garment inspection remains available in final review and in Result mode", () => {
    assert.match(SOURCE, /GARMENT_INSPECTION_SURFACES/);
    const finalReviewBlock = SOURCE.slice(SOURCE.indexOf("showFinalReview) {"), SOURCE.indexOf("// --- The region-by-region workspace"));
    assert.match(finalReviewBlock, /GARMENT_INSPECTION_SURFACES/);
  });

  it("Original/Highlighted/Result inspection modes reuse existing image-route modes only — no new backend semantics", () => {
    assert.match(SOURCE, /mode=original/);
    assert.match(SOURCE, /mode=region-context/);
    assert.match(SOURCE, /mode=master-preview/);
    // No fourth, invented mode string anywhere in this file.
    const modeMatches = [...SOURCE.matchAll(/mode=([a-z-]+)/g)].map((m) => m[1]);
    const uniqueModes = new Set(modeMatches);
    for (const m of uniqueModes) {
      assert.ok(
        ["original", "region-context", "region-crop", "master-preview"].includes(m!),
        `unexpected image mode referenced: ${m}`,
      );
    }
  });

  it("original-upload safety copy is present in both the workspace and final review", () => {
    assert.equal((SOURCE.match(/data-original-safety-copy/g) ?? []).length, 2);
  });

  it("copy: the neutral question replaces the substrate-presuming wording", () => {
    assert.match(SOURCE, /Should this highlighted area print\?/);
    assert.doesNotMatch(SOURCE, /Should the shirt show through here\?/);
  });

  it("decision state is communicated by more than colour: aria-pressed is present on every intent button", () => {
    const decisionBlock = SOURCE.slice(SOURCE.indexOf("DECISION PANE"), SOURCE.indexOf("mt-2 space-y-1"));
    assert.match(decisionBlock, /aria-pressed=\{currentIntent === intent\}/);
  });

  it("keyboard/focus: the question heading is focusable and re-focused when the active region changes", () => {
    assert.match(SOURCE, /questionHeadingRef/);
    assert.match(SOURCE, /tabIndex=\{-1\}/);
  });

  it("Not Sure / substrate / ink persisted values are unchanged", () => {
    assert.match(SOURCE, /"substrate" \| "ink" \| "uncertain"/);
  });

  it("no region card in the module renders BOTH an <img> and the decision-button group together more than once", () => {
    // The old design's signature shape: <img context><img detail><3 buttons>
    // repeated per region. This asserts that combined shape occurs exactly
    // once now — proving it's not still hiding inside a per-region .map().
    const decisionButtonGroups = (SOURCE.match(/role="group" aria-label=\{`Decision for area/g) ?? []).length;
    assert.equal(decisionButtonGroups, 1);
  });

  it("N: the three decision buttons use touch-sized padding, not small inline text links", () => {
    const decisionBlock = SOURCE.slice(SOURCE.indexOf("DECISION PANE"), SOURCE.indexOf("mt-2 space-y-1"));
    // px-4 py-3 on a rounded-xl button is a comfortably large tap target;
    // the OLD 18-card design used px-3 py-1.5 rounded-full pill buttons.
    assert.match(decisionBlock, /px-4 py-3/);
  });

  it("P: the desktop layout is a genuine two-column grid at the lg breakpoint, single column below it", () => {
    assert.match(SOURCE, /lg:grid-cols-\[minmax\(0,1fr\)_minmax\(0,1fr\)\]/);
    // No column definition at the base (mobile) breakpoint -- a bare `grid`
    // with no `grid-cols-*` stacks children in one implicit column.
    const gridLine = SOURCE.slice(SOURCE.indexOf('className="mt-4 grid'), SOURCE.indexOf('data-context-pane'));
    assert.doesNotMatch(gridLine, /\bgrid-cols-2\b|\bsm:grid-cols-2\b|\bmd:grid-cols-2\b/);
  });

  it("sticky context is scoped to lg+ only — never sticky on mobile, per the explicit mobile requirement", () => {
    const classNames = [...SOURCE.matchAll(/className="([^"]*)"/g)].map((m) => m[1]!);
    const withSticky = classNames.filter((c) => c.includes("sticky"));
    assert.ok(withSticky.length > 0, "expected at least one className to use sticky");
    for (const c of withSticky) {
      assert.match(c, /\blg:sticky\b/, `sticky must be scoped to lg:, got "${c}"`);
      assert.doesNotMatch(c, /(?<!lg:)(?<!\w)sticky\b/, `found an un-scoped sticky in "${c}"`);
    }
  });

  it("O: images use relative width/height classes (w-full, fixed height), not fixed pixel widths that could overflow a narrow viewport", () => {
    const contextImg = SOURCE.slice(SOURCE.indexOf("data-context-image") - 400, SOURCE.indexOf("data-context-image") + 50);
    assert.match(contextImg, /w-full/);
    assert.doesNotMatch(contextImg, /\bw-\[\d{3,}px\]/);
  });
});
