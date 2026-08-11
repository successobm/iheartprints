import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

import { GUIDED_CLEANUP_COPY } from "@/capabilities/artwork-preparation";

import { ArtworkPreviewModal } from "./ArtworkPreviewModal";
import { GuidedCleanupWorkspace } from "./GuidedCleanupWorkspace";
import {
  DEFAULT_PREVIEW_BACKGROUND,
  PREVIEW_BACKGROUND_COLORS,
  PREVIEW_BACKGROUND_COPY,
  PREVIEW_BACKGROUNDS,
  previewBackgroundSurfaceStyle,
} from "./preview-background";

/**
 * Phase 1.4: the large cleanup workspace is the canonical interactive path.
 * Enlarge stays a separate read-only viewer. These SSR checks pin the copy
 * and affordances without needing a browser click harness.
 *
 * Phase 1.5: Preview Background is presentation-only (White default).
 */

describe("GuidedCleanupWorkspace", () => {
  function render(props: Partial<Parameters<typeof GuidedCleanupWorkspace>[0]> = {}) {
    return renderToString(
      createElement(GuidedCleanupWorkspace, {
        preparedImageUrl: "https://signed.example/prepared.png",
        preparedRevision: "rev-test",
        sourceWidthPx: 100,
        sourceHeightPx: 100,
        busy: false,
        removalCount: 0,
        cleanupMessage: null,
        pendingHighlight: null,
        onSelectPoint: () => {},
        onConfirm: () => {},
        onCancelPreview: () => {},
        onUndo: () => {},
        onDone: () => {},
        ...props,
      }),
    );
  }

  it("opens a large interactive prepared surface", () => {
    const html = render();

    assert.match(html, /Clean up background/i);
    assert.match(html, /Click background to preview removing it/);
    assert.match(html, /data-cleanup-viewport/);
    assert.match(html, /data-zoom-factor="1"/);
    assert.match(html, /data-zoom-percent="100%"/);
    assert.match(html, /Fit/);
    assert.match(html, /Zoom In/);
    assert.match(html, /Zoom Out/);
    assert.match(html, /data-prepared-revision="rev-test"/);
    assert.match(html, new RegExp(GUIDED_CLEANUP_COPY.exitActionLabel));
    assert.doesNotMatch(html, /Use Prepared Artwork|Approve/i);
    assert.doesNotMatch(html, /brush|lasso|eraser|freehand/i);
  });

  it("Phase 1.6B: the artwork surface advertises SELECTION, not dragging", () => {
    const html = render();

    // The defect this replaces: `cursor-grab` above Fit told the customer that
    // dragging was the primary gesture while clicking was the only one that
    // did anything. Crosshair is now the resting state at every zoom level.
    assert.match(html, /cursor-crosshair/);
    assert.match(html, /data-primary-gesture="select"/);
    assert.match(html, /data-pan-modifier="none"/);
    assert.doesNotMatch(html, /cursor-grab/);
  });

  it("Phase 1.6B: busy still reads as busy", () => {
    const html = render({ busy: true });
    assert.match(html, /cursor-wait/);
    assert.match(html, /data-primary-gesture="busy"/);
    assert.doesNotMatch(html, /cursor-crosshair/);
  });

  it("Phase 1.6B: the pan gesture is told to the customer once it is usable", () => {
    // Nothing to pan at Fit, so nothing to say.
    assert.doesNotMatch(render(), /data-pan-hint/);
    assert.match(GUIDED_CLEANUP_COPY.panHint, /Space/);
    // ...and no production settings leak into the hint.
    assert.doesNotMatch(GUIDED_CLEANUP_COPY.panHint, /DPI|pixel|resolution|model/i);
  });

  it("A: workspace defaults to White QA background", () => {
    const html = render();
    assert.equal(DEFAULT_PREVIEW_BACKGROUND, "white");
    assert.match(html, /data-preview-background="white"/);
    assert.match(html, new RegExp(PREVIEW_BACKGROUND_COLORS.white));
    assert.match(html, new RegExp(PREVIEW_BACKGROUND_COPY.label));
  });

  it("regression: workspace render path never throws on Preview Background surface", () => {
    // Catches the live Phase 1.5 ReferenceError where a stale module called
    // bare `transparencySurfaceStyle(...)` without an import binding.
    // renderToString executes the style expression — source-string checks alone
    // are not enough.
    assert.doesNotThrow(() => {
      const html = render();
      assert.match(html, /data-qa-surface="preview-background"/);
      assert.match(html, /data-preview-background="white"/);
      assert.match(html, /background-color:#FFFFFF/);
      assert.match(html, /Preview Background/);
      assert.match(html, /data-preview-background-option="white"/);
    });

    for (const background of PREVIEW_BACKGROUNDS) {
      assert.doesNotThrow(() => {
        const html = render({ initialPreviewBackground: background });
        assert.match(html, new RegExp(`data-preview-background="${background}"`));
        assert.match(
          html,
          new RegExp(
            `background-color:${PREVIEW_BACKGROUND_COLORS[background].replace("#", "\\#")}`,
          ),
        );
        assert.match(html, /src="https:\/\/signed\.example\/prepared\.png"/);
        assert.match(html, /data-prepared-revision="rev-test"/);
        assert.match(html, /data-zoom-factor="1"/);
        // Background switching is presentation-only: no approve affordance.
        assert.doesNotMatch(html, /Use Prepared Artwork|Approve/i);
      });
    }
  });

  it("regression: GuidedCleanupWorkspace source never calls transparencySurfaceStyle", () => {
    const sourcePath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "GuidedCleanupWorkspace.tsx",
    );
    const source = readFileSync(sourcePath, "utf8");
    assert.doesNotMatch(source, /transparencySurfaceStyle/);
    assert.match(source, /previewBackgroundSurfaceStyle/);
    assert.match(source, /from "\.\/preview-background"/);
  });

  it("B: White / Gray / Black options render", () => {
    const html = render();
    assert.match(html, /data-preview-background-option="white"/);
    assert.match(html, /data-preview-background-option="gray"/);
    assert.match(html, /data-preview-background-option="black"/);
    assert.match(html, />White</);
    assert.match(html, />Gray</);
    assert.match(html, />Black</);
  });

  it("C/D/E: prepared src and revision are independent of QA background style", () => {
    const html = render({
      preparedImageUrl: "https://signed.example/prepared.png",
      preparedRevision: "rev-immutable",
    });
    assert.match(html, /src="https:\/\/signed\.example\/prepared\.png"/);
    assert.match(html, /data-prepared-revision="rev-immutable"/);
    // Presentation helper never invents a different asset URL.
    for (const background of ["white", "gray", "black"] as const) {
      const style = previewBackgroundSurfaceStyle(background);
      assert.equal(style.backgroundColor, PREVIEW_BACKGROUND_COLORS[background]);
      assert.equal(Object.keys(style).length, 1);
    }
  });

  it("F/G/I: pending candidate highlight stays mounted with QA background", () => {
    const pending = render({
      removalCount: 2,
      pendingHighlight: {
        bounds: { left: 10, top: 20, right: 40, bottom: 50, width: 30, height: 30 },
        overlayDataUrl: "data:image/png;base64,candidate-token",
      },
    });
    assert.match(pending, /data:image\/png;base64,candidate-token/);
    assert.match(pending, /data-candidate-highlight-frame/);
    assert.match(pending, /data-preview-background="white"/);
    assert.match(pending, /Remove This Area/);
    // While a preview is pending, Undo yields to Confirm/Cancel (unchanged).
    assert.doesNotMatch(pending, /Undo Last Removal/);

    const afterRemovals = render({ removalCount: 2, pendingHighlight: null });
    assert.match(afterRemovals, /Undo Last Removal/);
    assert.match(afterRemovals, /data-preview-background="white"/);
  });

  it("H: zoom factor and preview background are independently attributed", () => {
    const html = render();
    assert.match(html, /data-zoom-factor="1"/);
    assert.match(html, /data-preview-background="white"/);
    // Fit is the only zoom reset path; QA background sits beside the zoom
    // toolbar and does not own Fit/scroll reset.
    assert.match(html, /aria-label="Fit"/);
    assert.match(html, /role="radiogroup"/);
  });

  it("J: Cancel affordance remains for zero-mutation dismiss", () => {
    const html = render({
      pendingHighlight: {
        bounds: { left: 10, top: 20, right: 40, bottom: 50, width: 30, height: 30 },
        overlayDataUrl: "data:image/png;base64,abc",
      },
    });
    assert.match(html, />Cancel</);
    assert.match(html, /data-preview-background="white"/);
  });

  it("K/L/M: confirm, undo, and Done remain available as before", () => {
    const pending = render({
      pendingHighlight: {
        bounds: { left: 10, top: 20, right: 40, bottom: 50, width: 30, height: 30 },
        overlayDataUrl: "data:image/png;base64,abc",
      },
    });
    assert.match(pending, /Remove This Area/);
    assert.match(pending, />Cancel</);
    assert.match(pending, /Done/);

    const afterRemoval = render({
      preparedRevision: "rev-after-confirm",
      removalCount: 1,
    });
    assert.match(afterRemoval, /Undo Last Removal/);
    assert.match(afterRemoval, /data-prepared-revision="rev-after-confirm"/);
    assert.match(afterRemoval, /Done/);
  });

  it("A: workspace starts in Fit (100%)", () => {
    const html = render();
    assert.match(html, /data-zoom-factor="1"/);
    assert.match(html, /data-zoom-percent="100%"/);
    assert.match(html, /aria-label="Zoom Out"[^>]*disabled|disabled[^>]*aria-label="Zoom Out"/);
  });

  it("exposes zoom toolbar buttons with accessible labels", () => {
    const html = render();
    assert.match(html, /aria-label="Fit"/);
    assert.match(html, /aria-label="Zoom In"/);
    assert.match(html, /aria-label="Zoom Out"/);
    assert.match(html, /role="toolbar"/);
  });

  it("N: candidate highlight stays inside the zoomed artwork container", () => {
    const html = render({
      pendingHighlight: {
        bounds: { left: 10, top: 20, right: 40, bottom: 50, width: 30, height: 30 },
        overlayDataUrl: "data:image/png;base64,abc",
      },
    });
    assert.match(html, /data:image\/png;base64,abc/);
    assert.match(html, /border-dashed/);
    // Overlay is a sibling of the artwork img inside the relative content span.
    assert.match(html, /data-cleanup-artwork[\s\S]*data:image\/png;base64,abc/);
  });

  it("P: Cancel affordance is present without zoom-reset copy", () => {
    const html = render({
      pendingHighlight: {
        bounds: { left: 10, top: 20, right: 40, bottom: 50, width: 30, height: 30 },
        overlayDataUrl: "data:image/png;base64,abc",
      },
    });
    assert.match(html, />Cancel</);
    assert.match(html, /data-zoom-factor="1"/);
  });

  it("X / N: Enlarge remains read-only (workspace is separate)", () => {
    // Covered by the sibling ArtworkPreviewModal suite below — pin that this
    // interactive surface is the only place with Zoom / click-to-clean.
    const html = render();
    assert.match(html, /Zoom In/);
    assert.match(html, /Click background to preview removing it/);
  });

  it("remounts the base image when preparedRevision changes", () => {
    const first = render({ preparedRevision: "rev-a" });
    const second = render({ preparedRevision: "rev-b" });
    assert.match(first, /data-prepared-revision="rev-a"/);
    assert.match(second, /data-prepared-revision="rev-b"/);
    assert.notEqual(first, second);
  });

  it("renders the authoritative highlight and confirm actions for a pending preview", () => {
    const html = render({
      pendingHighlight: {
        bounds: { left: 10, top: 20, right: 40, bottom: 50, width: 30, height: 30 },
        overlayDataUrl: "data:image/png;base64,abc",
      },
    });

    assert.match(html, /Remove this area\?/i);
    assert.match(html, /Remove This Area/);
    assert.match(html, />Cancel</);
    assert.match(html, /data:image\/png;base64,abc/);
    assert.match(html, /border-dashed/);
    assert.doesNotMatch(html, /Undo Last Removal/);
  });

  it("offers Undo Last Removal inside the workspace after removals", () => {
    assert.doesNotMatch(render({ removalCount: 0 }), /Undo Last Removal/);
    assert.match(render({ removalCount: 1 }), /Undo Last Removal/);
  });

  it("surfaces refusal copy without mutating affordances", () => {
    const html = render({
      cleanupMessage:
        "That area looks like part of the artwork, so we left it unchanged.",
    });

    assert.match(
      html,
      /That area looks like part of the artwork, so we left it unchanged\./,
    );
    assert.doesNotMatch(html, /Remove This Area/);
  });

  it("L: confirm controls do not include an exit that would close across confirms", () => {
    // Workspace open/closed is owned by the parent; confirm only calls
    // onConfirm. Done/Escape/backdrop call onDone. Re-rendering with a new
    // preparedRevision must keep the dialog mounted while the parent keeps
    // workspaceOpen true.
    const html = render({
      preparedRevision: "rev-after-confirm",
      removalCount: 1,
      pendingHighlight: {
        bounds: { left: 10, top: 20, right: 40, bottom: 50, width: 30, height: 30 },
        overlayDataUrl: "data:image/png;base64,abc",
      },
    });
    assert.match(html, /role="dialog"/);
    assert.match(html, /data-prepared-revision="rev-after-confirm"/);
    assert.match(html, /Remove This Area/);
    assert.match(html, /Done/);
  });
});

describe("ArtworkPreviewModal — Enlarge stays view-only", () => {
  it("marks the enlarge surface as view only with no cleanup actions", () => {
    const html = renderToString(
      createElement(ArtworkPreviewModal, {
        title: "Prepared artwork",
        url: "https://signed.example/prepared.png",
        showTransparencyCheckerboard: true,
        onClose: () => {},
      }),
    );

    assert.match(html, /View only — nothing can be changed here/);
    assert.doesNotMatch(html, /Clean Up Background|Remove This Area|Click background/);
    assert.doesNotMatch(html, /cursor-crosshair/);
    assert.doesNotMatch(html, /Use Prepared Artwork|Approve/i);
  });

  it("N: prepared enlarge may reuse a QA Preview Background without approving", () => {
    const html = renderToString(
      createElement(ArtworkPreviewModal, {
        title: "Prepared artwork",
        url: "https://signed.example/prepared.png",
        showTransparencyCheckerboard: false,
        previewBackground: "white",
        onClose: () => {},
      }),
    );

    assert.match(html, /data-preview-background="white"/);
    assert.match(html, new RegExp(PREVIEW_BACKGROUND_COLORS.white));
    assert.doesNotMatch(html, /Use Prepared Artwork|Approve/i);
  });
});
