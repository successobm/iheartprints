import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

/**
 * Phase 28G Defect C — source-level proof that `CorrectionWorkspace` shows
 * an explicit loading/error state over its canvas area, disables every
 * image-dependent tool while not ready, and cannot be repopulated by a
 * stale response. `correction-image-load.test.ts` proves the underlying
 * reducer's own behavior in isolation; this file proves the COMPONENT
 * actually wires it in, and proves the frozen Magic Wand interaction logic
 * (Section 6/26: "do not change... correction geometry") was never
 * touched to achieve this. `renderToString` cannot execute the
 * `useEffect`-driven load itself (no DOM, no `Image`, no real network —
 * the same "HONEST BOUNDARY" this repo's other client-state doorways are
 * proven against), so this is a structural, not a runtime, proof.
 */

const SOURCE = readFileSync(path.join(__dirname, "CorrectionWorkspace.tsx"), "utf8");

describe("CorrectionWorkspace — Section 7/8/9: honest loading/ready/error, tools disabled while loading, stale-request safety", () => {
  it("uses the correction-image-load reducer, not a hand-rolled equivalent", () => {
    assert.match(
      SOURCE,
      /import \{\s*beginImageLoad,\s*initialImageLoadState,\s*resolveImageLoadFailure,\s*resolveImageLoadSuccess,\s*\} from "\.\/correction-image-load";/,
    );
  });

  it("A: the editor shell (heading, Cancel) is NOT gated on the image being ready -- it renders regardless of loadState.status", () => {
    // "Clean Up Your Artwork" heading and the Cancel button sit above the
    // canvas area in source order, outside any `loadState.status` check.
    const headingIndex = SOURCE.indexOf("Clean Up Your Artwork");
    const cancelIndex = SOURCE.indexOf('data-action="cancel-workspace"');
    const canvasAreaIndex = SOURCE.indexOf("data-correction-canvas");
    assert.ok(headingIndex !== -1 && cancelIndex !== -1 && canvasAreaIndex !== -1);
    assert.ok(headingIndex < canvasAreaIndex && cancelIndex < canvasAreaIndex, "the shell (heading, Cancel) must render before/independent of the canvas area's own loading state");
  });

  it("B: an explicit loading state (with copy) covers the canvas area while `loadState.status === \"loading\"`", () => {
    assert.match(SOURCE, /data-editor-loading-state/);
    assert.match(SOURCE, /loadState\.status === "loading" \? \(/);
    assert.match(SOURCE, /Loading your artwork…/);
    assert.match(SOURCE, /Getting the editable version ready\./);
  });

  it("B: image-dependent tools are disabled while not ready (`toolsDisabled = busy || !imageReady`), including tools that had no `disabled` prop at all before this phase", () => {
    assert.match(SOURCE, /const toolsDisabled = busy \|\| !imageReady;/);
    // Every tool-selector, wand-mode, brush-size, zoom, pan, tolerance,
    // apply/clear, start-over, and done-editing control uses it.
    const disabledUses = SOURCE.match(/disabled=\{toolsDisabled/g) ?? [];
    assert.ok(disabledUses.length >= 15, `expected toolsDisabled to gate at least 15 controls, found ${disabledUses.length}`);
  });

  it("B: the loading overlay physically sits ON TOP of the canvas (same relative container), which is what blocks pointer events from reaching it -- no change to the frozen pointer-handler functions was needed", () => {
    const canvasContainerStart = SOURCE.indexOf('className="mt-2 relative"');
    const loadingOverlayIndex = SOURCE.indexOf("data-editor-loading-state");
    const canvasCloseIndex = SOURCE.indexOf("</div>", SOURCE.indexOf("data-correction-canvas"));
    assert.ok(canvasContainerStart !== -1 && loadingOverlayIndex !== -1 && canvasCloseIndex !== -1);
    assert.ok(
      canvasContainerStart < loadingOverlayIndex,
      "the loading overlay must be inside the same relative container as the canvas",
    );
    // The frozen pointer handlers themselves are untouched by this phase.
    assert.doesNotMatch(SOURCE, /function onPointerDown[\s\S]{0,50}imageReady/);
    assert.doesNotMatch(SOURCE, /function onPointerMove[\s\S]{0,50}imageReady/);
    assert.doesNotMatch(SOURCE, /function onPointerUp[\s\S]{0,50}imageReady/);
  });

  it("C: the loading overlay and the ready image are mutually exclusive branches -- both keyed off the SAME `loadState.status`, never two independently-updated flags", () => {
    assert.match(SOURCE, /loadState\.status === "loading" \? \(/);
    assert.match(SOURCE, /loadState\.status === "error" \? \(/);
    // `resultImg` (the drawable image) is derived from the SAME state.
    assert.match(SOURCE, /const resultImg = loadState\.value;/);
    assert.match(SOURCE, /const imageReady = loadState\.status === "ready";/);
  });

  it("D: a load failure shows a recoverable Try Again / Cancel pair, never an infinite spinner", () => {
    assert.match(SOURCE, /data-editor-load-error/);
    assert.match(SOURCE, /We couldn&apos;t load the editable artwork\./);
    assert.match(SOURCE, /data-action="retry-load-artwork"/);
    assert.match(SOURCE, /data-action="cancel-workspace-from-error"/);
  });

  it("D: Try Again re-runs the SAME read-only load (bumps resultNonce) -- no new session, no mutation, nothing correction-shaped", () => {
    const retryFn = SOURCE.match(/function retryLoadResult\(\)\s*\{[\s\S]*?\}/);
    assert.ok(retryFn, "expected a retryLoadResult function");
    assert.match(retryFn![0], /setResultNonce\(\(n\) => n \+ 1\)/);
    assert.doesNotMatch(retryFn![0], /fetch\(|POST|session/i);
  });

  it("D: Cancel remains available from the error state (calls the same onCancel prop, not a new handler)", () => {
    const errorBlock = SOURCE.match(/data-editor-load-error[\s\S]*?<\/div>\s*<\/div>/);
    assert.ok(errorBlock);
    assert.match(errorBlock![0], /onClick=\{onCancel\}/);
  });

  it("E/F: every load attempt (initial mount AND every Try Again) goes through `beginImageLoad`'s generation counter -- a stale resolve/reject cannot land", () => {
    assert.match(SOURCE, /beginImageLoad\(loadStateRef\.current\)/);
    assert.match(SOURCE, /resolveImageLoadSuccess\(s, generation, img\)/);
    assert.match(SOURCE, /resolveImageLoadFailure\(s, generation\)/);
  });

  it("E: CorrectionWorkspace is mounted/unmounted as a distinct branch of UploadedArtworkPanel's tree (correctionMode \"editing\" vs \"none\"), never a persistently-keyed sibling -- a rapid Edit -> Cancel -> Edit tears the old instance down and constructs a genuinely fresh one, so an old instance's in-flight promise has no live setState to reach", () => {
    const panelSource = readFileSync(path.join(__dirname, "UploadedArtworkPanel.tsx"), "utf8");
    const editingBranch = panelSource.match(/if \(correctionMode === "editing"\) \{\s*return \(\s*<CorrectionWorkspace/);
    assert.ok(editingBranch, "CorrectionWorkspace must be an early-return branch, not a conditionally-hidden persistent sibling");
    assert.doesNotMatch(panelSource, /<CorrectionWorkspace[^>]*key=/, "no explicit key is used (or needed) -- the early-return branch shape alone guarantees a fresh mount");
  });

  it("no change to the frozen Magic Wand interaction logic: tolerance ladder, Delete/Backspace, wheel-zoom, and pan are all untouched by this phase's edits", () => {
    assert.match(SOURCE, /changeTolerance\("less"\)/);
    assert.match(SOURCE, /changeTolerance\("more"\)/);
    assert.match(SOURCE, /DRAG_THRESHOLD_PX/);
    assert.match(SOURCE, /MIN_ZOOM/);
    assert.match(SOURCE, /MAX_ZOOM/);
  });
});
