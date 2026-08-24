import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  computeObjectContainRect,
  hasInBoundsProposal,
  mapClickToSourcePixel,
  mapSourcePixelToDisplay,
  proposalNeedsDecision,
  selectPrimaryStep,
  submitProposalDecision,
  type ProposalViewLike,
} from "./proposal-review-workspace";

function view(overrides: Partial<ProposalViewLike> = {}): ProposalViewLike {
  return {
    regionMap: { inBoundsProposal: { proposalHash: "hash-1" } },
    proposalDecision: "pending",
    proposalPreserveOps: [],
    readyForFinalApproval: false,
    ...overrides,
  };
}

describe("computeObjectContainRect", () => {
  it("centers a wider-than-tall image inside a taller element (letterboxed top/bottom)", () => {
    // 400x300 natural inside a 400x400 element: scale = min(400/400, 400/300) = 1, content 400x300, centered vertically.
    const rect = computeObjectContainRect(400, 400, 400, 300);
    assert.equal(rect.contentWidth, 400);
    assert.equal(rect.contentHeight, 300);
    assert.equal(rect.contentX, 0);
    assert.equal(rect.contentY, 50);
  });

  it("centers a taller-than-wide image inside a wider element (letterboxed left/right)", () => {
    const rect = computeObjectContainRect(400, 400, 200, 400);
    assert.equal(rect.contentWidth, 200);
    assert.equal(rect.contentHeight, 400);
    assert.equal(rect.contentX, 100);
    assert.equal(rect.contentY, 0);
  });

  it("degenerates to an empty rect for zero/negative dimensions rather than dividing by zero", () => {
    const rect = computeObjectContainRect(0, 400, 200, 400);
    assert.equal(rect.contentWidth, 0);
    assert.equal(rect.contentHeight, 0);
  });
});

describe("mapClickToSourcePixel", () => {
  it("maps a click at the exact center of a square, unletterboxed image to the center source pixel", () => {
    const p = mapClickToSourcePixel(200, 200, 400, 400, 400, 400);
    assert.deepEqual(p, { x: 200, y: 200 });
  });

  it("maps a click in the top-left corner to source pixel (0,0)", () => {
    const p = mapClickToSourcePixel(0, 0, 400, 400, 400, 400);
    assert.deepEqual(p, { x: 0, y: 0 });
  });

  it("clamps a click on the exact bottom-right edge into the last valid pixel, never natural-width itself", () => {
    const p = mapClickToSourcePixel(400, 400, 400, 400, 400, 400);
    assert.deepEqual(p, { x: 399, y: 399 });
  });

  it("returns null for a click inside the letterbox padding, not a false-positive edge pixel", () => {
    // 400x400 element, 400x100 natural (very wide/short) -> letterboxed top/bottom.
    // scale = min(400/400, 400/100) = 1, content 400x100, centered: contentY = 150.
    const insidePadding = mapClickToSourcePixel(200, 10, 400, 400, 400, 100);
    assert.equal(insidePadding, null);
    const insideContent = mapClickToSourcePixel(200, 150, 400, 400, 400, 100);
    assert.deepEqual(insideContent, { x: 200, y: 0 });
  });

  it("scales correctly when the element is much smaller than the natural image (touch/mobile viewport)", () => {
    // 100x100 element, 1000x1000 natural image: a click at (50,50) (dead center) -> source (500,500).
    const p = mapClickToSourcePixel(50, 50, 100, 100, 1000, 1000);
    assert.deepEqual(p, { x: 500, y: 500 });
  });

  it("returns null when the element has no measurable size (e.g. not yet laid out)", () => {
    assert.equal(mapClickToSourcePixel(10, 10, 0, 0, 400, 400), null);
  });
});

describe("mapSourcePixelToDisplay — the inverse mapping for the magnifier", () => {
  it("round-trips a source pixel through display coordinates back to (approximately) itself", () => {
    const display = mapSourcePixelToDisplay(500, 500, 100, 100, 1000, 1000);
    const back = mapClickToSourcePixel(display.x, display.y, 100, 100, 1000, 1000);
    assert.ok(back);
    assert.ok(Math.abs(back!.x - 500) <= 10);
    assert.ok(Math.abs(back!.y - 500) <= 10);
  });

  it("degenerates to the element center rather than NaN when natural dimensions are unknown", () => {
    const display = mapSourcePixelToDisplay(10, 10, 200, 200, 0, 0);
    assert.deepEqual(display, { x: 100, y: 100 });
  });
});

describe("hasInBoundsProposal / proposalNeedsDecision", () => {
  it("no proposal at all -> neither has one nor needs a decision", () => {
    const v = view({ regionMap: { inBoundsProposal: null }, proposalDecision: null });
    assert.equal(hasInBoundsProposal(v), false);
    assert.equal(proposalNeedsDecision(v), false);
  });

  it("a proposal exists and is pending -> needs a decision", () => {
    const v = view({ proposalDecision: "pending" });
    assert.equal(hasInBoundsProposal(v), true);
    assert.equal(proposalNeedsDecision(v), true);
  });

  it("a proposal exists and was resolved -> no longer needs a decision", () => {
    assert.equal(proposalNeedsDecision(view({ proposalDecision: "remove_with_exceptions" })), false);
    assert.equal(proposalNeedsDecision(view({ proposalDecision: "preserve_all" })), false);
  });
});

describe("selectPrimaryStep — the primary-workflow router", () => {
  it("no proposal, not ready -> region-workspace (Goal 20/22: old behavior, completely untouched)", () => {
    const v = view({ regionMap: { inBoundsProposal: null }, proposalDecision: null, readyForFinalApproval: false });
    assert.equal(selectPrimaryStep(v, false), "region-workspace");
  });

  it("no proposal, ready -> final-review", () => {
    const v = view({ regionMap: { inBoundsProposal: null }, proposalDecision: null, readyForFinalApproval: true });
    assert.equal(selectPrimaryStep(v, false), "final-review");
  });

  it("proposal exists and pending -> proposal-review, even if some other signal claimed readiness", () => {
    const v = view({ proposalDecision: "pending", readyForFinalApproval: false });
    assert.equal(selectPrimaryStep(v, false), "proposal-review");
  });

  it("proposal decided remove_with_exceptions, not yet ready for final approval is impossible per the server contract, but this router still prefers proposal-preserve over region-workspace when a proposal exists", () => {
    const v = view({ proposalDecision: "remove_with_exceptions", readyForFinalApproval: false });
    assert.equal(selectPrimaryStep(v, false), "proposal-preserve");
  });

  it("everything ready -> final-review regardless of proposal presence", () => {
    const v = view({ proposalDecision: "preserve_all", readyForFinalApproval: true });
    assert.equal(selectPrimaryStep(v, false), "final-review");
  });

  it("forceShowWorkspace pulls the operator back out of final-review even when ready", () => {
    const v = view({ proposalDecision: "preserve_all", readyForFinalApproval: true });
    assert.equal(selectPrimaryStep(v, true), "proposal-preserve");
  });

  it("forceShowWorkspace with no proposal at all lands on region-workspace, not proposal-preserve", () => {
    const v = view({ regionMap: { inBoundsProposal: null }, proposalDecision: null, readyForFinalApproval: true });
    assert.equal(selectPrimaryStep(v, true), "region-workspace");
  });
});

describe("submitProposalDecision — fetch wrapping", () => {
  it("returns the parsed view on success, with defaulted empty tap/removal arrays sent", async () => {
    let sentBody: unknown = null;
    const fetcher = async (_url: string, init?: RequestInit) => {
      sentBody = JSON.parse(init!.body as string);
      return { ok: true, json: async () => ({ state: "review_complete" }) };
    };
    const result = await submitProposalDecision(fetcher, "proj-1", "sha-1", "hash-1", "preserve_all");
    assert.deepEqual(result, { ok: true, view: { state: "review_complete" } });
    assert.deepEqual(sentBody, {
      sourceAssetSha256: "sha-1",
      proposalHash: "hash-1",
      decision: "preserve_all",
      addPreserveTaps: [],
      removePreserveOperationIds: [],
    });
  });

  it("passes through explicit taps and removal ids untouched", async () => {
    let sentBody: unknown = null;
    const fetcher = async (_url: string, init?: RequestInit) => {
      sentBody = JSON.parse(init!.body as string);
      return { ok: true, json: async () => ({}) };
    };
    await submitProposalDecision(
      fetcher,
      "proj-1",
      "sha-1",
      "hash-1",
      "remove_with_exceptions",
      [{ rawTapX: 12, rawTapY: 34 }],
      ["op-1"],
    );
    assert.deepEqual(sentBody, {
      sourceAssetSha256: "sha-1",
      proposalHash: "hash-1",
      decision: "remove_with_exceptions",
      addPreserveTaps: [{ rawTapX: 12, rawTapY: 34 }],
      removePreserveOperationIds: ["op-1"],
    });
  });

  it("a non-ok response never carries a view — nothing for a caller to navigate with by mistake", async () => {
    const fetcher = async () => ({ ok: false, json: async () => ({ error: "That proposal is out of date" }) });
    const result = await submitProposalDecision(fetcher, "proj-1", "sha-1", "hash-1", "preserve_all");
    assert.deepEqual(result, { ok: false, error: "That proposal is out of date" });
  });

  it("a thrown network error is captured as a string error, not an unhandled rejection", async () => {
    const fetcher = async () => {
      throw new Error("network down");
    };
    const result = await submitProposalDecision(fetcher, "proj-1", "sha-1", "hash-1", "preserve_all");
    assert.deepEqual(result, { ok: false, error: "network down" });
  });
});
