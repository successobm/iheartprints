import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

/**
 * Phase 27E, item 13: structural proof that the graduated correction
 * workspace and Final Review satisfy the mobile/desktop layout contract —
 * a large, single artwork surface (not the old 18-card vertical review),
 * required completion controls present, and no fixed-pixel width that
 * would force horizontal overflow at narrow viewports. Full interactive
 * behavior (zoom math, click resolution, additive/subtractive selection)
 * is covered by `magic-wand-correction-capability.test.ts` and the frozen
 * Phase 27C/27D `magic-wand.test.ts`, run unchanged as regression — this
 * file only proves the DOM/CSS-shape facts a real headless-browser check
 * can't cheaply assert at unit-test speed.
 */
const WORKSPACE_SOURCE = readFileSync(path.join(__dirname, "CorrectionWorkspace.tsx"), "utf8");
const REVIEW_SOURCE = readFileSync(path.join(__dirname, "CorrectionFinalReview.tsx"), "utf8");

describe("CorrectionWorkspace structure — required controls present (Phase 27E)", () => {
  it("has exactly one canvas, not one per region/defect", () => {
    assert.equal((WORKSPACE_SOURCE.match(/data-correction-canvas/g) ?? []).length, 1);
  });

  it("the canvas scales to its container width rather than a fixed pixel size (no forced horizontal overflow)", () => {
    assert.match(WORKSPACE_SOURCE, /width:\s*"100%"/);
  });

  it("exposes the required zoom controls: Fit, 100%, -, +, and a live indicator", () => {
    assert.match(WORKSPACE_SOURCE, /data-action="zoom-fit"/);
    assert.match(WORKSPACE_SOURCE, /data-action="zoom-100"/);
    assert.match(WORKSPACE_SOURCE, /data-action="zoom-out"/);
    assert.match(WORKSPACE_SOURCE, /data-action="zoom-in"/);
    assert.match(WORKSPACE_SOURCE, /data-zoom-indicator/);
  });

  it("exposes pan behavior", () => {
    assert.match(WORKSPACE_SOURCE, /data-pan-toggle/);
  });

  it("exposes Restore Missing Artwork and Remove Background modes", () => {
    assert.match(WORKSPACE_SOURCE, /data-mode="restore"/);
    assert.match(WORKSPACE_SOURCE, /data-mode="remove"/);
  });

  it("exposes Undo and Start Over", () => {
    assert.match(WORKSPACE_SOURCE, /data-action="undo-correction"/);
    assert.match(WORKSPACE_SOURCE, /data-action="start-over"/);
  });

  it("exposes exactly one Done Editing action — the required new completion control", () => {
    assert.equal((WORKSPACE_SOURCE.match(/data-action="done-editing"/g) ?? []).length, 1);
    assert.match(WORKSPACE_SOURCE, />Done Editing</);
  });

  it("retains the comparison-against-original panel", () => {
    assert.match(WORKSPACE_SOURCE, /Compare against the original upload/);
  });

  it("carries no leftover 'experimental tool' banner text — graduated, not a developer utility", () => {
    assert.doesNotMatch(WORKSPACE_SOURCE, /[Ee]xperimental local tool/);
  });

  it("keeps operator-facing copy free of algorithm terminology", () => {
    for (const term of [/gradient/i, /confidence score/i, /flood.?fill/i, /connectivity/i, /RGB distance/i]) {
      assert.doesNotMatch(WORKSPACE_SOURCE, term);
    }
  });
});

describe("CorrectionFinalReview structure — inspection + the two deliberate choices (Phase 27E)", () => {
  it("shows the artwork large, not as a thumbnail (no fixed small height, has a generous minHeight)", () => {
    assert.match(REVIEW_SOURCE, /minHeight:\s*320/);
    assert.doesNotMatch(REVIEW_SOURCE, /h-\[(?:[1-9]?[0-9]|1[0-4][0-9])px\]/); // no old-style small fixed-height thumbnail class
  });

  it("exposes Black, White, and Gray inspection surfaces at minimum", () => {
    // [\s\S]* instead of a dotAll ("s") flag -- this repo's test tsconfig
    // targets an ES version older than ES2018, which doesn't support "s".
    assert.match(REVIEW_SOURCE, /"black"[\s\S]*"#000000"/);
    assert.match(REVIEW_SOURCE, /"white"[\s\S]*"#FFFFFF"/);
    assert.match(REVIEW_SOURCE, /"gray"[\s\S]*"#C8C8C8"/);
  });

  it("exposes exactly one review image, not a grid of many", () => {
    assert.equal((REVIEW_SOURCE.match(/data-review-image(?!-)/g) ?? []).length, 1);
  });

  it("requires deliberate operator choice — Back to Editing and Use This Artwork, no auto-approval path", () => {
    assert.match(REVIEW_SOURCE, /data-action="back-to-editing"/);
    assert.match(REVIEW_SOURCE, /data-action="use-this-artwork"/);
    assert.doesNotMatch(REVIEW_SOURCE, /useEffect[^]*finalize/); // finalize must never fire from a mount/effect
  });

  it("carries the original-safety reassurance copy", () => {
    assert.match(REVIEW_SOURCE, /original upload is saved and unchanged/);
  });
});
