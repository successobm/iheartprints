import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

import type { ArtworkPreparationView } from "@/capabilities/artwork-preparation";
import { UploadedArtworkPanel } from "./UploadedArtworkPanel";

/**
 * Phase 28F — ONE CUSTOMER ARTWORK REVIEW, NOT TWO.
 *
 * AUDIT FINDING (Section 2, reported before implementation): there is no
 * separate "first small review" component and "second large review"
 * component — both live inside the same `CompareStep` function in
 * `UploadedArtworkPanel.tsx`. The redundancy the human reported is that
 * `CompareStep` renders its OWN heading + `ArtworkComparison` + approve
 * button UNCONDITIONALLY, ABOVE `SeparationReviewPanel` — and
 * `SeparationReviewPanel`'s own proposal-review/final-review screens
 * ALREADY contain their own large Original/Proposed-Removal/Result
 * comparison, their own background-colour inspection, and their own
 * decision actions, whenever there is a real proposal or consequential
 * region to decide (`separationGateActive`). For that class of artwork
 * (the real Chili & Salsa order), the customer saw both.
 *
 * Phase 28G Defect A — a THIRD state now sits in front of both: while
 * `CompareStep` does not yet know which of the above applies
 * (`separationChecking`), it shows neither — only an explicit
 * `ReviewPreparingState` loading card. Critically, this means
 * `CompareStep`'s local `separationState` now STARTS at `"checking"`
 * (previously `null`, treated as "assume not required"), so the VERY
 * FIRST render `renderToString` ever captures is the loading state, not
 * either resolved review. `SeparationReviewPanel` decides the real,
 * resolved status inside its own `useEffect`-driven fetch, which
 * `renderToString` never executes (this repo's test tooling is
 * `node:test` + `renderToString` — no DOM, no effects; see
 * `uploaded-artwork-separation-mount.test.tsx`'s own "HONEST BOUNDARY" doc
 * comment for the established precedent). That makes the initial-render
 * (loading) assertions below directly render-provable, while the two
 * RESOLVED outcomes (no gate / gate active) remain source-level proofs —
 * exactly the same boundary Phase 27E/27G/28A/28E/28F have always drawn.
 */

const PANEL_SOURCE = readFileSync(
  path.join(__dirname, "UploadedArtworkPanel.tsx"),
  "utf8",
);

/**
 * Finds every `{!separationGateActive ? ( ... ) : null}` EXISTENCE-GUARD
 * range in `source` -- i.e. a block that renders nothing at all when the
 * gate is active. Deliberately narrow: `separationGateActive` is also read
 * elsewhere (e.g. inside a className ternary that only changes spacing,
 * never presence) and those uses must NOT be mistaken for an existence
 * guard. Phase 28G: `CompareStep`'s ordinary-review block is now nested
 * INSIDE a `separationChecking ? (...) : !separationGateActive ? (...) :
 * null` ternary rather than a bare `!separationGateActive ? (...) : null`
 * one -- but since `separationGateActive` can only ever be `true` when
 * `separationChecking` is `false` (see `CompareStep`'s own derivation),
 * the substring match below still correctly identifies the same
 * "vanishes when the gate is active" range.
 */
function separationGateActiveExistenceGuardRanges(
  source: string,
): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  const marker = "!separationGateActive ? (";
  let from = 0;
  for (;;) {
    const start = source.indexOf(marker, from);
    if (start === -1) break;
    const end = source.indexOf(") : null}", start);
    assert.ok(end !== -1, "an existence guard opened with '!separationGateActive ? (' must close with ') : null}'");
    ranges.push({ start, end: end + ") : null}".length });
    from = end + 1;
  }
  return ranges;
}

function compareStepSource(): string {
  const start = PANEL_SOURCE.indexOf("function CompareStep(");
  const end = PANEL_SOURCE.indexOf("function ApprovedStep(");
  assert.ok(start !== -1 && end !== -1 && start < end, "could not isolate CompareStep's source");
  return PANEL_SOURCE.slice(start, end);
}

function preparation(overrides: Partial<ArtworkPreparationView> = {}): ArtworkPreparationView {
  return {
    preparationId: "prep-1",
    status: "prepared",
    originalFilename: "chili-salsa.png",
    classification: "REQUIRES_ENHANCEMENT",
    customer: {
      backgroundMessage: "Your artwork has a solid background that can be removed automatically.",
      resolutionMessage: 'Your artwork is smaller than the recommended print resolution for a 6.92"-wide print on the full front. We\'ll need to enhance it before creating the final print-ready file.',
      canPrepare: true,
      prepareActionLabel: "Remove the Background",
      enhancementNeeded: true,
    },
    hasPreparedArtwork: true,
    preparedRevision: "rev-1",
    approved: false,
    widthPx: 1024,
    heightPx: 1536,
    visibleArtworkWidthPx: 995,
    visibleArtworkHeightPx: 1510,
    productSummary: "T-shirts",
    productColor: "Black",
    printPlacement: "full_front",
  } as ArtworkPreparationView;
}

function render(overrides: Partial<ArtworkPreparationView> = {}) {
  return renderToString(
    createElement(UploadedArtworkPanel, {
      projectId: "test-project-id",
      step: "compare" as const,
      preparation: preparation(overrides),
      busy: false,
      originalImageUrl: "https://signed.example/original.png",
      preparedImageUrl: "https://signed.example/prepared.png",
      onUpload: () => {},
      onSaveDetails: () => {},
      onPrepare: () => {},
      onApprove: () => {},
      onReconsider: () => {},
    }),
  );
}

describe("Phase 28G Defect A — the very first render fails closed (separation status starts \"checking\")", () => {
  it("A: the explicit review-loading state renders", () => {
    const html = render();
    assert.match(html, /data-review-loading-state/);
    assert.match(html, /Preparing your artwork for review…/);
    assert.match(html, /Checking the background removal and making sure your design stays intact\./);
  });

  it("A: no internal vocabulary leaks into the loading copy", () => {
    const html = render();
    const loadingCardMatch = html.match(/<div[^>]*data-review-loading-state[^>]*>[\s\S]*?<\/div><\/div>/);
    assert.ok(loadingCardMatch, "expected to isolate the loading card's markup");
    assert.doesNotMatch(loadingCardMatch![0], /separation|region map|proposal|capability/i);
  });

  it("B: the ordinary heading + ArtworkComparison do NOT render while checking", () => {
    const html = render();
    assert.doesNotMatch(html, /Review your artwork</);
    assert.doesNotMatch(html, />Original</);
    assert.doesNotMatch(html, /Preview Background/);
  });

  it("B: \"Use This Artwork\" does NOT render while checking", () => {
    const html = render();
    assert.doesNotMatch(html, /Use This Artwork/);
    assert.doesNotMatch(html, /Looks good\?/);
  });

  it("F/G: SeparationReviewPanel is mounted (so its own fetch still fires) but visually hidden while checking -- no legacy review, and no double loading text either", () => {
    const html = render();
    // Mounted: its own initial "checking" copy is present in the markup...
    assert.match(html, /Checking whether this artwork needs a separation review/);
    // ...but inside a `hidden` wrapper, not stacked visibly under the loading card above.
    const hiddenWrapper = html.match(/<div class="hidden">[\s\S]*?<\/div>/);
    assert.ok(hiddenWrapper, "expected the SeparationReviewPanel mount to be wrapped in a hidden container while checking");
    assert.match(hiddenWrapper![0], /Checking whether this artwork needs a separation review/);
  });

  it("the Edit Artwork doorway is present and reachable even while checking (Phase 27H invariant)", () => {
    const html = render();
    assert.match(html, /Edit Artwork/);
    assert.match(html, /data-action="remove-background-manually"/);
  });

  it("\"Keep my original for now\" remains available while checking -- it is a safe exit, not an approval", () => {
    const html = render();
    assert.match(html, /Keep my original for now/);
  });

  it("17: the resolution notice renders even while checking (unrelated fact, not a visual-approval statement)", () => {
    const html = render();
    assert.match(html, /data-resolution-notice/);
    assert.equal((html.match(/data-resolution-notice/g) ?? []).length, 1);
  });
});

describe("Phase 28F/28G — source-level proof: the three-way review state (checking / no gate / gate active) routes correctly", () => {
  it("A/B: the heading + ArtworkComparison are gated behind `separationChecking ? (...) : !separationGateActive ? (...) : null` -- suppressed in BOTH the checking and gate-active cases", () => {
    const source = compareStepSource();
    const ternaryStart = source.indexOf("{separationChecking ? (");
    assert.ok(ternaryStart !== -1, "expected the three-way ternary to start with `separationChecking`");
    const headingToComparisonBlock = source.slice(
      ternaryStart,
      source.indexOf("</ArtworkComparison>") !== -1
        ? source.indexOf("</ArtworkComparison>")
        : source.indexOf("/>", source.indexOf("<ArtworkComparison")),
    );
    assert.match(headingToComparisonBlock, /<ReviewPreparingState \/>/);
    assert.match(headingToComparisonBlock, /!separationGateActive \? \(/);
    assert.match(headingToComparisonBlock, /Review your artwork/);
    assert.match(headingToComparisonBlock, /<ArtworkComparison/);
  });

  it("C: SeparationReviewPanel is NEVER conditioned on separationGateActive -- it always mounts and decides for itself whether to show anything (only its VISIBILITY, via a `hidden` class, is conditioned on separationChecking)", () => {
    const source = compareStepSource();
    const panelIndex = source.indexOf("<SeparationReviewPanel");
    assert.ok(panelIndex !== -1, "SeparationReviewPanel must be mounted in CompareStep");
    for (const range of separationGateActiveExistenceGuardRanges(source)) {
      assert.ok(
        panelIndex < range.start || panelIndex > range.end,
        "SeparationReviewPanel must not sit inside a separationGateActive existence guard",
      );
    }
    assert.match(source, /separationChecking \? "hidden" : "mt-3"/);
  });

  it("the Edit Artwork doorway is NOT conditioned on separationGateActive OR separationChecking -- reachable regardless (Phase 27H invariant)", () => {
    const source = compareStepSource();
    const doorwayIndex = source.indexOf('data-action="remove-background-manually"');
    assert.ok(doorwayIndex !== -1, "the Edit Artwork doorway must exist");
    for (const range of separationGateActiveExistenceGuardRanges(source)) {
      assert.ok(
        doorwayIndex < range.start || doorwayIndex > range.end,
        "the Edit Artwork doorway must not sit inside a separationGateActive existence guard",
      );
    }
    // Not wrapped in any `separationChecking ? (...) : null`-shaped guard either.
    assert.ok(
      !/separationChecking\s*\?\s*\([\s\S]{0,600}data-action="remove-background-manually"/.test(source),
      "the Edit Artwork doorway must not be nested inside a separationChecking existence guard",
    );
  });

  it("Defect B: the Edit Artwork doorway appears AFTER the SeparationReviewPanel mount point in source order (below the review, not above it)", () => {
    const source = compareStepSource();
    const panelIndex = source.indexOf("<SeparationReviewPanel");
    const doorwayIndex = source.indexOf('data-action="remove-background-manually"');
    assert.ok(panelIndex !== -1 && doorwayIndex !== -1);
    assert.ok(panelIndex < doorwayIndex, "expected the review area (SeparationReviewPanel mount) to precede the Edit Artwork doorway");
  });

  it("M: the approval button and its guidance copy are gated on BOTH !separationChecking and !separationGateActive -- required decisions (or an unresolved check) still block it", () => {
    const source = compareStepSource();
    assert.match(source, /!separationChecking && !separationGateActive \? \(/);
    const guards = source.match(/!separationChecking && !separationGateActive/g) ?? [];
    assert.ok(guards.length >= 2, "both the guidance copy block and the approve button must guard on the same compound condition");
    assert.match(source, /onClick=\{onApprove\}/);
  });

  it("F: Use This Artwork calls the exact same onApprove prop -- no new approval mechanism", () => {
    const source = compareStepSource();
    const approveBlock = source.match(/onClick=\{onApprove\}[\s\S]{0,400}/);
    assert.ok(approveBlock);
    assert.match(approveBlock![0], /Use This Artwork/);
  });

  it("H/I: opening Edit Artwork and Cancel are wired exactly as before -- CorrectionWorkspace receives no mutating props, onCancel resets to 'none' (the same consolidated review, not a removed one)", () => {
    const source = compareStepSource();
    const workspaceBlock = source.match(/<CorrectionWorkspace[\s\S]*?\/>/);
    assert.ok(workspaceBlock);
    // Only projectId + the two pure navigation callbacks -- no onApprove,
    // no onSeparationApproved, nothing that could mutate on open.
    assert.doesNotMatch(workspaceBlock![0], /onApprove/);
    assert.match(workspaceBlock![0], /onCancel=\{\(\)\s*=>\s*setCorrectionMode\("none"\)\}/);
  });

  it("J/K: Final Review wiring is unchanged -- Use This Artwork inside manual Final Review resets to 'none' and reuses onSeparationApproved, never a duplicate generic review", () => {
    const source = compareStepSource();
    const reviewBlock = source.match(/<CorrectionFinalReview[\s\S]*?\/>/);
    assert.ok(reviewBlock);
    assert.match(reviewBlock![0], /onUsed=\{\(\)\s*=>\s*\{\s*setCorrectionMode\("none"\);\s*onSeparationApproved\?\.\(\);?\s*\}\}/);
  });

  it("the initial state is literally \"checking\", not `null` -- fail closed by construction, not by a runtime coincidence", () => {
    const source = compareStepSource();
    assert.match(source, /useState<SeparationCheckStatus>\("checking"\)/);
  });

  it("18.B: exactly ONE Edit Artwork action exists -- not duplicated between the loading state, the ordinary review, and the gate-active review", () => {
    const source = compareStepSource();
    const occurrences = source.match(/data-action="remove-background-manually"/g) ?? [];
    assert.equal(occurrences.length, 1, "the Edit Artwork doorway must be a single, shared element -- never one copy per review state");
  });

  it("17.G: an \"error\" status (the initial separation check failed outright) is treated the SAME as gate-active -- separationGateActive is neither `\"checking\"` nor `\"review_not_required\"`, so any other value (including \"error\") withholds the ordinary approval review, never falling back to it silently", () => {
    const source = compareStepSource();
    assert.match(
      source,
      /const separationGateActive = !separationChecking && separationState !== "review_not_required";/,
    );
    // This is a structural guarantee, not an enumeration: `"error"` needs
    // no special case here because it is simply "some other value" --
    // exactly like `"review_required"` etc. See
    // `separation-check-status.test.ts` for the unit-level proof that
    // `computeSeparationCheckStatus` actually reports `"error"` (rather
    // than silently `"review_not_required"`) when the initial check fails.
  });
});
