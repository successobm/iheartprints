import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

import { GUIDED_CLEANUP_COPY } from "@/capabilities/artwork-preparation";

import { ArtworkPreviewModal } from "./ArtworkPreviewModal";
import { GuidedCleanupWorkspace } from "./GuidedCleanupWorkspace";

/**
 * Phase 1.4: the large cleanup workspace is the canonical interactive path.
 * Enlarge stays a separate read-only viewer. These SSR checks pin the copy
 * and affordances without needing a browser click harness.
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

  it("X: Enlarge remains read-only (workspace is separate)", () => {
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
});
