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

/**
 * Phase 27I — TOOLBOX V1: structural proof of the tool-switching safety
 * contract (§B/§C/§G "no hidden destructive action") and coordinate-
 * transform consistency across the new tools (§N/§O), the same
 * source-level technique the rest of this file already uses for facts a
 * headless-browser check can't cheaply assert at unit-test speed.
 */
describe("CorrectionWorkspace toolbar — Phase 27I safety contract", () => {
  function extractFunctionBody(fnName: string): string {
    const start = WORKSPACE_SOURCE.indexOf(`function ${fnName}(`);
    assert.ok(start >= 0, `function ${fnName} must exist`);
    let depth = 0;
    let i = WORKSPACE_SOURCE.indexOf("{", start);
    const bodyStart = i;
    for (; i < WORKSPACE_SOURCE.length; i += 1) {
      if (WORKSPACE_SOURCE[i] === "{") depth += 1;
      else if (WORKSPACE_SOURCE[i] === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    return WORKSPACE_SOURCE.slice(bodyStart, i + 1);
  }

  it("B/C: switching tools clears any pending Wand selection AND any pending Fill preview -- never applies one", () => {
    const body = extractFunctionBody("selectTool");
    assert.match(body, /setPendingClicks\(\[\]\)/);
    assert.match(body, /setSelection\(null\)/);
    assert.match(body, /setOverlayImg\(null\)/);
    assert.match(body, /setFillPreview\(null\)/);
    // Must never call an apply/fetch as part of switching tools.
    assert.doesNotMatch(body, /fetch\(/);
    assert.doesNotMatch(body, /applyWandSelection|applyFill|submitStroke/);
  });

  it("G: Delete/Backspace only ever applies a pending WAND selection, gated explicitly on activeTool === \"magic_wand\"", () => {
    assert.match(
      WORKSPACE_SOURCE,
      /activeToolRef\.current === "magic_wand" && selectionRef\.current && pendingClicksRef\.current\.length > 0/,
    );
  });

  it("§11: Delete/Backspace does nothing without a pending selection, and is gated behind the text-entry-target guard", () => {
    const keydownBody = extractFunctionBody("onKeyDown");
    // The condition requires `selectionRef.current` truthy AND at least one
    // pending click -- with neither, the `void applyWandSelection()` call
    // is unreachable, so "no pending selection -> Delete does nothing" is
    // structurally guaranteed by the same condition asserted in test G.
    assert.match(keydownBody, /if \(isTextEntryTarget\(e\.target\)\) return;/, "Delete/Backspace must bail out immediately while focus is in a text-entry target");
  });

  describe("Phase 27K: pending-selection vs. applied-removal UX clarity", () => {
    it("§2: a pending Wand selection gets an unmistakable, additional visual marker distinct from the frozen overlay's own styling", () => {
      // Client-side only, drawn on top of (never replacing) the frozen
      // `renderSelectionOverlay` image -- proven by requiring a NEW colour
      // this file never otherwise uses, so it can't be confused with the
      // existing blue pending-click dots or the overlay's own magenta/cyan
      // marching ants.
      assert.match(WORKSPACE_SOURCE, /selection\?\.bounds/);
      assert.match(WORKSPACE_SOURCE, /setLineDash/);
      assert.match(WORKSPACE_SOURCE, /#F59E0B/, "the pending-selection marquee must use a colour distinct from the existing blue pending-click dots and the frozen overlay's own magenta/cyan boundary");
    });

    it("§3: instruction copy is short and state-dependent -- 'select' language with no selection, 'ready to apply' language once one exists", () => {
      assert.match(WORKSPACE_SOURCE, /Click an area to select it\./);
      assert.match(WORKSPACE_SOURCE, /Selection ready — adjust if needed, then remove it\./);
      assert.match(WORKSPACE_SOURCE, /Selection ready — adjust if needed, then restore it\./);
      // The old paragraph explaining the selection mechanism must be gone --
      // superseded by the short two-state copy above (§3: "do not overload
      // the workspace with explanatory text").
      assert.doesNotMatch(WORKSPACE_SOURCE, /will select similar connected pixels/i);
    });

    it("§4: the pending-selection apply action reads 'Remove Selected Area' / 'Restore Selected Area', not the old generic labels", () => {
      assert.match(WORKSPACE_SOURCE, /Remove Selected Area/);
      assert.match(WORKSPACE_SOURCE, /Restore Selected Area/);
      assert.doesNotMatch(WORKSPACE_SOURCE, />Restore Artwork</);
      // The overall Wand sub-MODE toggle button must still say "Remove
      // Background" (§4: "Do not rename the overall Remove Background
      // tool/mode. This applies specifically to the pending Wand selection
      // action.") -- both labels must coexist, not one replacing the other.
      assert.match(WORKSPACE_SOURCE, /data-mode="remove"[^]*?>Remove Background</);
    });

    it("§5/§7: tolerance controls remain Wand-only -- Less/Default/More are not added to Fill, Brush, or Eraser", () => {
      assert.match(WORKSPACE_SOURCE, /data-tolerance="less"/);
      assert.match(WORKSPACE_SOURCE, /data-tolerance="default"/);
      assert.match(WORKSPACE_SOURCE, /data-tolerance="more"/);
      // Exactly one tolerance control group in the whole file (Wand's).
      assert.equal((WORKSPACE_SOURCE.match(/data-tolerance="less"/g) ?? []).length, 1);
    });

    it("§12: the tolerance row and the Remove/Restore Selected Area row both wrap at narrow widths -- no horizontal overflow now that the primary label is longer", () => {
      const toleranceRowMatch = WORKSPACE_SOURCE.match(/<div className="mb-2 flex[^"]*"[^>]*>\s*<button onClick=\{\(\) => changeTolerance\("less"\)\}/);
      assert.ok(toleranceRowMatch, "tolerance row must exist");
      assert.match(toleranceRowMatch![0], /flex-wrap/, "tolerance row must wrap at narrow widths");

      const applyRowMatch = WORKSPACE_SOURCE.match(/<div className="flex[^"]*">\s*\{\/\* Phase 27K §4/);
      assert.ok(applyRowMatch, "the Remove/Restore Selected Area row must exist");
      assert.match(applyRowMatch![0], /flex-wrap/, "the apply-action row must wrap at narrow widths");
    });
  });

  it("N/O: Brush/Eraser strokes use the SAME coordinate transforms (clientToCanvasInternal/canvasToImage) as Wand -- one coordinate system for every tool at any zoom/pan", () => {
    const pointerDownBody = extractFunctionBody("onPointerDown");
    const pointerMoveBody = extractFunctionBody("onPointerMove");
    assert.match(pointerDownBody, /clientToCanvasInternal/);
    assert.match(pointerDownBody, /canvasToImage/);
    assert.match(pointerMoveBody, /clientToCanvasInternal/);
    assert.match(pointerMoveBody, /canvasToImage/);
  });

  it("default tool is the Wand, and it is listed first in the toolbar array", () => {
    assert.match(WORKSPACE_SOURCE, /useState<Tool>\("magic_wand"\)/);
    const toolsArrayMatch = WORKSPACE_SOURCE.match(/const TOOLS[^]*?\];/);
    assert.ok(toolsArrayMatch, "TOOLS array must exist");
    assert.ok(toolsArrayMatch![0].indexOf('"magic_wand"') < toolsArrayMatch![0].indexOf('"restore_fill"'));
  });

  it("brush stroke operations are sent as raw points + radius, never a client-authored raster mask", () => {
    assert.match(WORKSPACE_SOURCE, /tool,\s*points,\s*radius:\s*BRUSH_RADIUS_LEVELS\[brushSizeRef\.current\]/);
    assert.doesNotMatch(WORKSPACE_SOURCE, /mask:/i);
  });
});
