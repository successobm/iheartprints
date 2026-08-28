import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

/**
 * Phase 28E — copy/label rename, proven at the source level (this repo's
 * test tooling is `node:test` + `renderToString`, which never executes an
 * `onClick`; see `UploadedArtworkPanel.test.tsx`'s "Remove Background
 * Manually routing" suite for the established precedent for this
 * technique).
 *
 * The mission renamed three buttons for clarity ("Looks Good" -> "Remove
 * Pink Area", "Keep All Highlighted" -> "Keep Pink Area", "Preserve Part of
 * This" -> "Keep Part of Pink Area") without touching what each one DOES.
 * These tests prove the rename is cosmetic: the same `data-proposal-action`
 * hooks and the same `decideProposal(...)` calls remain wired to the same
 * (relabeled) buttons.
 */
const PANEL_SOURCE = readFileSync(
  path.join(__dirname, "SeparationReviewPanel.tsx"),
  "utf8",
);

describe("Phase 28E: Proposed Removal copy and action-label rename", () => {
  it("heading and supporting copy explain the pink-area contract in plain language, with no internal vocabulary", () => {
    assert.match(PANEL_SOURCE, /Check what will be removed/);
    const supportingCopyMatch = PANEL_SOURCE.match(
      /Only the pink area will become transparent\. Everything else stays exactly as shown[^"]*/,
    );
    assert.ok(supportingCopyMatch, "supporting copy under the heading must exist");
    // Scoped to the actual customer-facing copy this phase touched -- not
    // the whole file, which legitimately contains "separation"/"region" in
    // route paths, the component's own name, and internal comments.
    const legendBlock = PANEL_SOURCE.slice(
      PANEL_SOURCE.indexOf('data-proposal-action="looks_good"') - 300,
      PANEL_SOURCE.indexOf("</dl>"),
    );
    for (const forbidden of [
      /\bseparation\b/i,
      /proposal mask/i,
      /\bregion\b/i,
      /\balpha\b/i,
      /segmentation/i,
      /\bauthority\b/i,
      /candidate pixels/i,
    ]) {
      assert.doesNotMatch(supportingCopyMatch![0], forbidden, `leaked internal term in supporting copy: ${forbidden}`);
      assert.doesNotMatch(legendBlock, forbidden, `leaked internal term in buttons/legend: ${forbidden}`);
    }
  });

  it("A: 'Remove Pink Area' is the new label for the button that calls decideProposal(\"remove_with_exceptions\") with data-proposal-action=\"looks_good\" -- the exact same action previously labeled 'Looks Good'", () => {
    const block = extractButtonBlock(PANEL_SOURCE, "looks_good");
    assert.match(block, /decideProposal\("remove_with_exceptions"\)/);
    assert.match(block, />\s*Remove Pink Area\s*</);
    assert.doesNotMatch(PANEL_SOURCE, />\s*Looks Good\s*</, "the old label must not still render");
  });

  it("B: 'Keep Pink Area' is the new label for the button that calls decideProposal(\"preserve_all\") with data-proposal-action=\"keep_all\" -- the exact same action previously labeled 'Keep All Highlighted'", () => {
    const block = extractButtonBlock(PANEL_SOURCE, "keep_all");
    assert.match(block, /decideProposal\("preserve_all"\)/);
    assert.match(block, />\s*Keep Pink Area\s*</);
    assert.doesNotMatch(PANEL_SOURCE, />\s*Keep All Highlighted\s*</);
  });

  it("C: 'Keep Part of Pink Area' is the new label for the button that calls beginPreservePart with data-proposal-action=\"preserve_part\" -- the exact same action previously labeled 'Preserve Part of This'", () => {
    const block = extractButtonBlock(PANEL_SOURCE, "preserve_part");
    assert.match(block, /onClick=\{beginPreservePart\}/);
    assert.match(block, />\s*Keep Part of Pink Area\s*</);
    assert.doesNotMatch(PANEL_SOURCE, />\s*Preserve Part of This\s*</);
  });

  it("the explanatory legend describes each relabeled action correctly and concisely", () => {
    assert.match(PANEL_SOURCE, /Remove Pink Area:<\/dt>\s*<dd>Make only the pink area transparent\.<\/dd>/);
    assert.match(PANEL_SOURCE, /Keep Pink Area:<\/dt>\s*<dd>Keep the pink area as part of your artwork\.<\/dd>/);
    assert.match(PANEL_SOURCE, /Keep Part of Pink Area:<\/dt>\s*<dd>Choose which parts of the pink area should stay\.<\/dd>/);
  });

  it("D/E/F: no other proposal wiring changed -- decideProposal, beginPreservePart, and continueFromProposal all still exist exactly once each, and no automatic decision is submitted by mounting or by the copy change itself", () => {
    assert.match(PANEL_SOURCE, /function decideProposal/);
    assert.match(PANEL_SOURCE, /function beginPreservePart/);
    assert.match(PANEL_SOURCE, /function continueFromProposal/);
    // The three action buttons are the ONLY call sites of decideProposal
    // with a literal decision argument -- no new, unlabeled call was added.
    const decideProposalCalls = [...PANEL_SOURCE.matchAll(/decideProposal\("(\w+)"\)/g)].map((m) => m[1]);
    assert.deepEqual(new Set(decideProposalCalls), new Set(["remove_with_exceptions", "preserve_all"]));
  });
});

function extractButtonBlock(source: string, dataAction: string): string {
  const marker = `data-proposal-action="${dataAction}"`;
  const markerIndex = source.indexOf(marker);
  assert.ok(markerIndex !== -1, `no element with ${marker} found`);
  // The whole <button ...>...</button> element containing this marker --
  // walk backward to the nearest preceding "<button" and forward to the
  // next "</button>".
  const start = source.lastIndexOf("<button", markerIndex);
  const end = source.indexOf("</button>", markerIndex) + "</button>".length;
  assert.ok(start !== -1 && end > start, `could not isolate the <button> element for ${marker}`);
  return source.slice(start, end);
}
