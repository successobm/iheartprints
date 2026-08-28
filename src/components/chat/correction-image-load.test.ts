import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  beginImageLoad,
  initialImageLoadState,
  resolveImageLoadFailure,
  resolveImageLoadSuccess,
} from "./correction-image-load";

/**
 * Phase 28G Defect C — real customer report: opening "Edit Artwork" left
 * the canvas area genuinely blank (no loading state at all) for roughly 20
 * seconds. See `correction-image-load.ts`'s own doc comment for the root
 * cause and the stale-request guarantee this module provides. Plain
 * function-call tests against the pure reducer underneath
 * `CorrectionWorkspace` -- no DOM, no `Image`, no timers.
 */

describe("correction-image-load — loading/ready/error + stale-request suppression", () => {
  it("starts in \"loading\", with no value yet", () => {
    const state = initialImageLoadState<string>();
    assert.equal(state.status, "loading");
    assert.equal(state.value, null);
  });

  it("C: a successful resolution moves to \"ready\" and carries the value", () => {
    const { state: begun, generation } = beginImageLoad(initialImageLoadState<string>());
    const resolved = resolveImageLoadSuccess(begun, generation, "the-image");
    assert.equal(resolved.status, "ready");
    assert.equal(resolved.value, "the-image");
  });

  it("D: a failure moves to \"error\"", () => {
    const { state: begun, generation } = beginImageLoad(initialImageLoadState<string>());
    const resolved = resolveImageLoadFailure(begun, generation);
    assert.equal(resolved.status, "error");
  });

  it("D: Try Again (a second `beginImageLoad`) returns to \"loading\"", () => {
    const first = beginImageLoad(initialImageLoadState<string>());
    const failed = resolveImageLoadFailure(first.state, first.generation);
    const retried = beginImageLoad(failed);
    assert.equal(retried.state.status, "loading");
  });

  it("D: after Try Again succeeds, status is \"ready\" and the value is the RETRY's value, not any earlier one", () => {
    const first = beginImageLoad(initialImageLoadState<string>());
    const failed = resolveImageLoadFailure(first.state, first.generation);
    const retry = beginImageLoad(failed);
    const resolved = resolveImageLoadSuccess(retry.state, retry.generation, "retry-image");
    assert.equal(resolved.status, "ready");
    assert.equal(resolved.value, "retry-image");
  });

  it("E: a STALE success (from an attempt superseded by a newer one) is ignored", () => {
    const first = beginImageLoad(initialImageLoadState<string>());
    const second = beginImageLoad(first.state);
    // The FIRST attempt's success arrives late, after a second attempt already started.
    const afterStaleSuccess = resolveImageLoadSuccess(second.state, first.generation, "stale-image");
    assert.equal(afterStaleSuccess.status, "loading", "the still-pending second attempt's status must not be disturbed");
    assert.equal(afterStaleSuccess.value, null, "a stale success must never populate `value`");
  });

  it("F: a STALE failure (from an attempt superseded by a newer one) is ignored", () => {
    const first = beginImageLoad(initialImageLoadState<string>());
    const second = beginImageLoad(first.state);
    const afterStaleFailure = resolveImageLoadFailure(second.state, first.generation);
    assert.equal(afterStaleFailure.status, "loading", "a stale failure must not flip the current (newer) attempt to error");
  });

  it("a genuine (non-stale) failure leaves a previously-loaded value untouched", () => {
    const first = beginImageLoad(initialImageLoadState<string>());
    const ready = resolveImageLoadSuccess(first.state, first.generation, "original-image");
    const retry = beginImageLoad(ready);
    const failed = resolveImageLoadFailure(retry.state, retry.generation);
    assert.equal(failed.status, "error");
    assert.equal(failed.value, "original-image", "a failed refresh must not erase the artwork already loaded");
  });
});
