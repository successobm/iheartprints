import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  initialPreviewCommitState,
  requestPreviewCommit,
  resolvePreviewCommitFailure,
  resolvePreviewCommitSuccess,
  shouldRequestPreviewCommit,
} from "./preview-image-commit";

/**
 * Phase 28G Defect D — real customer report: switching the final review's
 * garment-colour preview (Black/White/Red/Gray) showed the new background
 * colour behind the OLD artwork bitmap until the new image finished
 * loading, and rapid switching had no ordering guarantee at all. See
 * `preview-image-commit.ts`'s own doc comment for the full root-cause
 * trace. These are plain function-call tests against the pure reducer
 * underneath `GarmentPreviewImage` — no DOM, no `Image`, no timers, fully
 * deterministic, and able to prove the exact race condition (Section 20.B)
 * a real browser test could only ever prove probabilistically.
 */

const RED = { src: "img?garment=red", backgroundColor: "#B22234" };
const GRAY = { src: "img?garment=gray", backgroundColor: "#C8C8C8" };
const BLACK = { src: "img?garment=black", backgroundColor: "#000000" };

describe("preview-image-commit — atomic commit + stale-response suppression", () => {
  it("A: nothing is committed until the first request resolves", () => {
    const state = initialPreviewCommitState();
    assert.equal(state.committed, null);
    assert.equal(state.switching, true);
  });

  it("A: a successful resolution commits src and backgroundColor TOGETHER", () => {
    let state = initialPreviewCommitState();
    const { state: requested, generation } = requestPreviewCommit(state);
    state = requested;
    state = resolvePreviewCommitSuccess(state, generation, RED);
    assert.deepEqual(state.committed, RED);
    assert.equal(state.switching, false);
    assert.equal(state.failed, false);
  });

  it("B: Gray -> Red -> Black rapidly -- Black wins even though Red resolves LAST", () => {
    let state = initialPreviewCommitState();
    // Gray already committed from an earlier, already-resolved request.
    const gray = requestPreviewCommit(state);
    state = resolvePreviewCommitSuccess(gray.state, gray.generation, GRAY);
    assert.deepEqual(state.committed, GRAY);

    // Click Red, then immediately click Black (Red's own request is still in flight).
    const red = requestPreviewCommit(state);
    state = red.state;
    const black = requestPreviewCommit(state);
    state = black.state;

    // Black resolves FIRST...
    state = resolvePreviewCommitSuccess(state, black.generation, BLACK);
    assert.deepEqual(state.committed, BLACK);

    // ...then Red resolves LATE. It must be silently discarded -- the
    // visible frame must stay Black, never flip back to Red.
    state = resolvePreviewCommitSuccess(state, red.generation, RED);
    assert.deepEqual(state.committed, BLACK, "a stale (superseded) resolution must never overwrite the latest committed frame");
  });

  it("B (arrival-order independence): once a NEWER request has been ISSUED, no earlier request can ever land -- regardless of what order their resolutions arrive in", () => {
    let state = initialPreviewCommitState();
    // Three requests issued in quick succession, in order: Black, Red, Gray (Gray is the LATEST).
    const black = requestPreviewCommit(state);
    state = black.state;
    const red = requestPreviewCommit(state);
    state = red.state;
    const gray = requestPreviewCommit(state);
    state = gray.state;

    // Black's and Red's resolutions arrive first (network can reorder
    // however it likes) -- both must be ignored, since a newer request
    // (Gray) has already been issued.
    state = resolvePreviewCommitSuccess(state, black.generation, BLACK);
    assert.equal(state.committed, null, "Black must not land -- a newer request (Gray) was already issued before Black resolved");
    state = resolvePreviewCommitSuccess(state, red.generation, RED);
    assert.equal(state.committed, null, "Red must not land -- a newer request (Gray) was already issued before Red resolved");

    // Only Gray -- the LAST one issued -- can ever commit.
    state = resolvePreviewCommitSuccess(state, gray.generation, GRAY);
    assert.deepEqual(state.committed, GRAY);

    // Black's resolution arriving even later still cannot undo it.
    state = resolvePreviewCommitSuccess(state, black.generation, BLACK);
    assert.deepEqual(state.committed, GRAY, "a very late resolution for a long-superseded request must never overwrite the latest committed frame");
  });

  it("C: clicking the SAME already-committed background again is not a new request (shouldRequestPreviewCommit)", () => {
    const state = { ...initialPreviewCommitState(), committed: RED, switching: false };
    assert.equal(shouldRequestPreviewCommit(state, RED, null), false);
  });

  it("C: clicking the SAME background that is already in-flight (lastRequested) is not a new request", () => {
    const state = initialPreviewCommitState();
    assert.equal(shouldRequestPreviewCommit(state, RED, RED), false);
  });

  it("C: clicking a genuinely different background IS a new request", () => {
    const state = { ...initialPreviewCommitState(), committed: RED, switching: false };
    assert.equal(shouldRequestPreviewCommit(state, BLACK, RED), true);
  });

  it("E: `switching` is true immediately after a request, before it resolves (drives the loading overlay)", () => {
    const { state } = requestPreviewCommit(initialPreviewCommitState());
    assert.equal(state.switching, true);
  });

  it("F: `switching` clears on a successful resolution", () => {
    const { state: requested, generation } = requestPreviewCommit(initialPreviewCommitState());
    const resolved = resolvePreviewCommitSuccess(requested, generation, RED);
    assert.equal(resolved.switching, false);
  });

  it("G: `switching` clears on a failed resolution too", () => {
    const { state: requested, generation } = requestPreviewCommit(initialPreviewCommitState());
    const resolved = resolvePreviewCommitFailure(requested, generation);
    assert.equal(resolved.switching, false);
    assert.equal(resolved.failed, true);
  });

  it("H: a failure leaves the last valid COMMITTED preview completely intact", () => {
    let state = initialPreviewCommitState();
    const first = requestPreviewCommit(state);
    state = resolvePreviewCommitSuccess(first.state, first.generation, GRAY);
    assert.deepEqual(state.committed, GRAY);

    const second = requestPreviewCommit(state);
    state = resolvePreviewCommitFailure(second.state, second.generation);
    assert.deepEqual(state.committed, GRAY, "a failed switch must not clear or corrupt the previous committed frame");
    assert.equal(state.failed, true);
  });

  it("J: a STALE failure (superseded by a newer request) is ignored -- does not flip `failed` for the current request", () => {
    let state = initialPreviewCommitState();
    const first = requestPreviewCommit(state);
    state = first.state;
    const second = requestPreviewCommit(state);
    state = second.state;

    // The FIRST request's failure arrives late, after the second request already started.
    state = resolvePreviewCommitFailure(state, first.generation);
    assert.equal(state.failed, false, "a stale failure must not mark the CURRENT (newer) request as failed");
    assert.equal(state.switching, true, "the newer request is still genuinely in flight");
  });

  it("D: the selected/committed src and its backgroundColor can never disagree -- they are one atomic value, never two independently-updated fields", () => {
    const { state: requested, generation } = requestPreviewCommit(initialPreviewCommitState());
    const resolved = resolvePreviewCommitSuccess(requested, generation, RED);
    // `committed` is a single object with both fields set in the SAME
    // assignment (see `resolvePreviewCommitSuccess`) -- there is no code
    // path that could set `committed.src` to one background's image while
    // `committed.backgroundColor` still names a different one.
    assert.equal(resolved.committed?.src, RED.src);
    assert.equal(resolved.committed?.backgroundColor, RED.backgroundColor);
  });

  it("I: a request in flight never mutates `committed` at all -- there is no half-updated intermediate value to accidentally render", () => {
    const { state: requested } = requestPreviewCommit(initialPreviewCommitState());
    assert.equal(requested.committed, null, "still nothing committed while switching -- the caller keeps showing the PREVIOUS committed frame, never a partial one");
  });

  it("a newer request clears a previous `failed` flag immediately (Section 10: user can simply try a different colour after an error)", () => {
    let state = initialPreviewCommitState();
    const first = requestPreviewCommit(state);
    state = resolvePreviewCommitFailure(first.state, first.generation);
    assert.equal(state.failed, true);

    const second = requestPreviewCommit(state);
    assert.equal(second.state.failed, false);
  });
});
