import assert from "node:assert/strict";
import { test } from "node:test";

import {
  canApplyCorrectionQueue,
  canShowPixelPreview,
  isClassificationOnlyQueue,
  resolveEffectiveViewMode,
  resolveMainImageSrc,
  type CorrectionPreviewViewState,
} from "./sign-correction-preview-view";

const CANDIDATE_URL = "/api/internal/projects/p1/sign-artwork/production-candidate";

function pixelPreview(overrides: Partial<CorrectionPreviewViewState> = {}): CorrectionPreviewViewState {
  return {
    status: "previewed",
    appliedCount: 1,
    hasPixelChange: true,
    afterPngBase64: "AAAA",
    ...overrides,
  };
}

// 1. no queued corrections → canvas uses current candidate
test("no preview at all: the canvas is forced to the original candidate", () => {
  assert.equal(canShowPixelPreview(null), false);
  assert.equal(resolveEffectiveViewMode("preview", null), "original");
  assert.equal(resolveMainImageSrc("original", null, CANDIDATE_URL), CANDIDATE_URL);
});

// 2 & 7. one queued pixel correction → canvas uses the preview result
test("a real pixel-changing preview: the canvas shows the full corrected result as a preview mode selects it", () => {
  const preview = pixelPreview();
  assert.equal(canShowPixelPreview(preview), true);
  assert.equal(resolveEffectiveViewMode("preview", preview), "preview");
  assert.equal(resolveMainImageSrc("preview", preview, CANDIDATE_URL), "data:image/png;base64,AAAA");
});

// 6. Before/original mode shows the original candidate even with a valid preview present
test("original mode always shows the original candidate, even while a valid preview exists", () => {
  const preview = pixelPreview();
  assert.equal(resolveEffectiveViewMode("original", preview), "original");
  assert.equal(resolveMainImageSrc("original", preview, CANDIDATE_URL), CANDIDATE_URL);
});

// 5. Cancel all (preview reset to null) → canvas returns to the original candidate
test("clearing the queue (preview back to null) forces the canvas back to the original candidate, regardless of the last-chosen toggle", () => {
  assert.equal(resolveEffectiveViewMode("preview", null), "original");
  assert.equal(resolveMainImageSrc(resolveEffectiveViewMode("preview", null), null, CANDIDATE_URL), CANDIDATE_URL);
});

// 8. switching comparison mode never touches the queue — proven structurally:
// neither resolveEffectiveViewMode nor resolveMainImageSrc accepts (or could
// therefore mutate) any queue value at all.
test("view-mode resolution has no access to the correction queue at all", () => {
  assert.equal(resolveEffectiveViewMode.length, 2); // (requestedViewMode, preview) — no queue parameter
  assert.equal(resolveMainImageSrc.length, 3); // (effectiveViewMode, preview, candidateUrl) — no queue parameter
});

// 11. classification-only queue never falsely claims a pixel change
test("a classification-only queue is reported as classification-only, and never offers a pixel preview to show", () => {
  const preview = pixelPreview({ hasPixelChange: false, afterPngBase64: null });
  assert.equal(isClassificationOnlyQueue(preview, 2), true);
  assert.equal(canShowPixelPreview(preview), false);
  assert.equal(resolveEffectiveViewMode("preview", preview), "original");
});

test("a pixel-changing queue is never reported as classification-only", () => {
  assert.equal(isClassificationOnlyQueue(pixelPreview(), 1), false);
});

test("an empty queue (no preview yet) is never reported as classification-only", () => {
  assert.equal(isClassificationOnlyQueue(null, 0), false);
});

// 12. Apply disabled while a preview recompute is in flight
test("Apply is refused while busy, even with an otherwise-fully-matching preview", () => {
  assert.equal(
    canApplyCorrectionQueue({ busy: true, queueLength: 1, preview: pixelPreview({ appliedCount: 1 }) }),
    false,
  );
});

// 13. Apply disabled when the preview failed (refused) or there was no candidate at all
test("Apply is refused when the current preview was refused", () => {
  assert.equal(
    canApplyCorrectionQueue({
      busy: false,
      queueLength: 2,
      preview: pixelPreview({ status: "refused", appliedCount: 1 }),
    }),
    false,
  );
});

test("Apply is refused when there is no production candidate to correct", () => {
  assert.equal(
    canApplyCorrectionQueue({
      busy: false,
      queueLength: 1,
      preview: pixelPreview({ status: "no_candidate", appliedCount: 0, hasPixelChange: false, afterPngBase64: null }),
    }),
    false,
  );
});

test("Apply is refused with no preview at all, even if the queue is somehow non-empty", () => {
  assert.equal(canApplyCorrectionQueue({ busy: false, queueLength: 1, preview: null }), false);
});

test("Apply is refused with an empty queue, even with a stale successful preview object", () => {
  assert.equal(
    canApplyCorrectionQueue({ busy: false, queueLength: 0, preview: pixelPreview({ appliedCount: 0 }) }),
    false,
  );
});

// 14. Apply disabled when the preview's own applied-count disagrees with the current queue length
test("Apply is refused when the preview's appliedCount does not account for the full current queue", () => {
  assert.equal(
    canApplyCorrectionQueue({
      busy: false,
      queueLength: 3,
      preview: pixelPreview({ status: "previewed", appliedCount: 2 }),
    }),
    false,
  );
});

// 15. preview success + matching queue permits the existing Apply path
test("Apply is permitted only when nothing is busy, the queue is non-empty, the preview fully succeeded, and appliedCount matches the queue exactly", () => {
  assert.equal(
    canApplyCorrectionQueue({
      busy: false,
      queueLength: 2,
      preview: pixelPreview({ status: "previewed", appliedCount: 2 }),
    }),
    true,
  );
});
