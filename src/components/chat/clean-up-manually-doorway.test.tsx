import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

import type { ArtworkPreparationView } from "@/capabilities/artwork-preparation";

import { UploadedArtworkPanel } from "./UploadedArtworkPanel";

/**
 * Phase 28A — MAKE MANUAL CLEANUP AVAILABLE FROM AUTOMATIC BACKGROUND REVIEW.
 *
 * A `NEEDS_REVIEW`-classified upload (automatic preparation refuses to run
 * at all — `customer.canPrepare === false`) reaches `AnalysisStep`, which
 * mounts `SeparationReviewPanel` ("Here's what we found" / "Check what will
 * be removed") but, before this phase, offered no way at all to reach the
 * existing Phase 27 manual correction workspace: only "Change these
 * details". This file proves the new "Clean Up Manually" doorway closes
 * that dead end, mirroring `CompareStep`'s own already-proven
 * "Remove Background Manually" doorway (see
 * "Remove Background Manually routing" in `UploadedArtworkPanel.test.tsx`)
 * without touching that doorway, its wording, or its gating at all.
 *
 * Same HONEST BOUNDARY as the rest of this directory: `renderToString` never
 * runs `onClick` handlers, so state transitions (`correctionMode`) are
 * proven at the source level, and what actually renders in each of the
 * THREE states (`none` / `editing` / `review`) is proven structurally by
 * asserting on `UploadedArtworkPanel.tsx`'s own source alongside the
 * initial render.
 */

function preparation(
  overrides: Partial<ArtworkPreparationView> = {},
): ArtworkPreparationView {
  return {
    preparationId: "prep-1",
    status: "prepared",
    originalFilename: "photo.png",
    classification: "NEEDS_REVIEW",
    customer: {
      backgroundMessage:
        "Your background is complex, so we need a different removal method. A designer will take a look before we go any further.",
      resolutionMessage: null,
      canPrepare: false,
      prepareActionLabel: null,
      enhancementNeeded: false,
    },
    hasPreparedArtwork: false,
    preparedRevision: null,
    approved: false,
    widthPx: 120,
    heightPx: 120,
    visibleArtworkWidthPx: 120,
    visibleArtworkHeightPx: 120,
    productSummary: "T-shirts for our bowling team",
    productColor: "Black",
    printPlacement: "full_front",
    ...overrides,
  } as ArtworkPreparationView;
}

function render(overrides: Partial<ArtworkPreparationView> = {}, busy = false) {
  return renderToString(
    createElement(UploadedArtworkPanel, {
      projectId: "test-project-id",
      step: "review_analysis" as const,
      preparation: preparation(overrides),
      busy,
      originalImageUrl: "https://signed.example/original.png",
      preparedImageUrl: null,
      onUpload: () => {
        throw new Error("must never fire from rendering");
      },
      onSaveDetails: () => {
        throw new Error("must never fire from rendering");
      },
      onPrepare: () => {
        throw new Error("must never fire from rendering");
      },
      onApprove: () => {
        throw new Error("must never fire from rendering");
      },
      onReconsider: () => {
        throw new Error("must never fire from rendering");
      },
    }),
  );
}

describe("Phase 28A — 'Clean Up Manually' doorway on the automatic background review screen", () => {
  it("A: renders for a NEEDS_REVIEW upload, alongside the automatic review, not in place of it", () => {
    const html = render();
    assert.match(html, /Here&#x27;s what we found/);
    assert.match(html, /Clean Up Manually/);
    assert.match(html, /data-action="clean-up-manually"/);
  });

  it("B: still renders when there is no consequential-region review to show (the 'never successfully runs at all' case) — the true prior dead end", () => {
    // `SeparationReviewPanel` is server-gated and self-fetching; renderToString
    // captures it BEFORE that fetch resolves, so `routedToOperatorReview` is
    // false on this render regardless. The doorway must not depend on that.
    const html = render();
    assert.match(html, /data-action="clean-up-manually"/);
  });

  it("C: absent for every classification other than NEEDS_REVIEW — the automatic-success path is untouched", () => {
    const html = render({
      classification: "REQUIRES_ENHANCEMENT",
      customer: {
        backgroundMessage: "Your artwork has a solid background that can be removed automatically.",
        resolutionMessage: null,
        canPrepare: true,
        prepareActionLabel: "Remove the Background",
        enhancementNeeded: false,
      },
    });
    assert.doesNotMatch(html, /data-action="clean-up-manually"/);
    assert.doesNotMatch(html, /Clean Up Manually/);
  });

  it("wording: the new doorway's own copy carries no internal terminology (separation, region map, correction session, manual override, preparation authority)", () => {
    // Scoped to the doorway's own card, not the whole panel: the
    // PRE-EXISTING (untouched, CSS-`hidden`) SeparationReviewPanel loading
    // copy legitimately contains "separation" already -- see
    // `UploadedArtworkPanel.test.tsx`'s own "11: no provider/algorithm
    // vocabulary leaks" test, which does not forbid that word for exactly
    // this reason. This phase's requirement is that the NEW doorway avoid
    // internal terms, not that this pass purge a pre-existing surface it
    // does not touch.
    const html = render();
    const card = html.match(/data-action="clean-up-manually"[\s\S]{0,600}?<\/div>/);
    assert.ok(card, "Clean Up Manually card must exist");
    const doorwayBlock = html.slice(html.indexOf("Prefer to do it yourself?") - 40, html.indexOf(card![0]) + card![0].length);
    for (const forbidden of [
      /\bseparation\b/i,
      /region map/i,
      /correction session/i,
      /manual override/i,
      /preparation authority/i,
      /\btreatment\b/i,
      /topaz/i,
      /provider/i,
    ]) {
      assert.doesNotMatch(doorwayBlock, forbidden, `leaked internal term: ${forbidden}`);
    }
  });

  it("does not overclaim about the automatic result (no 'failed'/'broken'/'perfect')", () => {
    const html = render();
    for (const overclaim of [/perfect/i, /flawless/i, /failed/i, /broken/i, /damaged/i]) {
      assert.doesNotMatch(html, overclaim);
    }
  });

  it("D: disabled while busy, exactly like the sibling automatic-review actions", () => {
    const html = render({}, true);
    const compact = html.replace(/\s+/g, " ");
    const match = /<button([^>]*)data-action="clean-up-manually"[^>]*>/.exec(compact);
    assert.ok(match, "no Clean Up Manually button rendered");
    assert.match(match![1], /disabled=""/);
  });

  it("the workspace canvas is not present before the doorway is clicked", () => {
    const html = render();
    assert.doesNotMatch(html, /data-correction-canvas/);
  });

  it("responsive: the doorway card uses no fixed pixel width, matching CompareStep's equivalent card -- static half of the 4-viewport check (see report for the live-browser half)", () => {
    const html = render();
    assert.match(html, /data-action="clean-up-manually"/, "doorway card must exist");
    assert.doesNotMatch(html, /\bw-\[\d/, "no fixed pixel width anywhere on this screen");
  });
});

/**
 * Source-level proof of the state machine — same technique as
 * "Remove Background Manually routing" in `UploadedArtworkPanel.test.tsx`,
 * because `renderToString` cannot execute the doorway's `onClick`.
 */
describe("Phase 28A — Clean Up Manually routing (source-level)", () => {
  const PANEL_SOURCE = readFileSync(path.join(__dirname, "UploadedArtworkPanel.tsx"), "utf8");

  function analysisStepSource(): string {
    const start = PANEL_SOURCE.indexOf("function AnalysisStep(");
    const end = PANEL_SOURCE.indexOf("function CompareStep(");
    assert.ok(start !== -1 && end !== -1 && start < end, "could not isolate AnalysisStep's source");
    return PANEL_SOURCE.slice(start, end);
  }

  it("E: AnalysisStep declares its OWN correctionMode state, independent of CompareStep's", () => {
    const source = analysisStepSource();
    assert.match(source, /useState<"none" \| "editing" \| "review">\("none"\)/);
  });

  it("F: the Clean Up Manually button sets correctionMode to 'editing'", () => {
    const source = analysisStepSource();
    assert.match(source, /data-action="clean-up-manually"/);
    assert.match(source, /onClick=\{\(\)\s*=>\s*setCorrectionMode\("editing"\)\}/);
  });

  it("G: 'editing' renders the SAME frozen CorrectionWorkspace, gated on onCancel returning to 'none' — no new editor", () => {
    const source = analysisStepSource();
    assert.match(source, /correctionMode === "editing"/);
    assert.match(source, /<CorrectionWorkspace/);
    assert.match(source, /onCancel=\{\(\)\s*=>\s*setCorrectionMode\("none"\)\}/);
  });

  it("H: 'review' renders the SAME frozen CorrectionFinalReview; Use This Artwork (onUsed) resets to 'none' and reuses onSeparationApproved — no bespoke acceptance path", () => {
    const source = analysisStepSource();
    assert.match(source, /correctionMode === "review"/);
    assert.match(source, /<CorrectionFinalReview/);
    assert.match(source, /onUsed=\{\(\)\s*=>\s*\{\s*setCorrectionMode\("none"\);\s*onSeparationApproved\?\.\(\);?\s*\}\}/);
  });

  it("no new correction route or algorithm import was introduced by this doorway", () => {
    const source = analysisStepSource();
    assert.doesNotMatch(source, /magic-wand-algorithm/);
    assert.doesNotMatch(source, /floodFillSelect|unionMasks|filterClicksContaining/);
  });

  it("I: AnalysisStep's doorway is entirely independent of CompareStep's — neither component's correctionMode can see the other's state", () => {
    // Two separate `useState` calls scoped to two separate function bodies;
    // this just double-checks AnalysisStep is not somehow reusing/sharing
    // CompareStep's declaration (e.g. via a hoisted module-level variable).
    assert.doesNotMatch(PANEL_SOURCE, /let correctionMode|var correctionMode/);
  });
});
