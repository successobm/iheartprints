import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { computeDisplayPpi, deriveEdgeChips, deriveOverallFitLabel } from "./sign-workspace-status";

describe("deriveEdgeChips", () => {
  it("orders chips TOP/RIGHT/BOTTOM/LEFT regardless of input order", () => {
    const chips = deriveEdgeChips([
      { edge: "left", protectedResult: "fail", edgeIntentPresent: false },
      { edge: "top", protectedResult: "fail", edgeIntentPresent: false },
      { edge: "bottom", protectedResult: "unknown", edgeIntentPresent: false },
      { edge: "right", protectedResult: "fail", edgeIntentPresent: true },
    ]);
    assert.deepEqual(
      chips.map((c) => c.edge),
      ["top", "right", "bottom", "left"],
    );
  });

  it("matches the real acceptance project's known edge evidence (TOP/RIGHT/LEFT fail, BOTTOM unknown)", () => {
    const chips = deriveEdgeChips([
      { edge: "top", protectedResult: "fail", edgeIntentPresent: false },
      { edge: "right", protectedResult: "fail", edgeIntentPresent: false },
      { edge: "bottom", protectedResult: "unknown", edgeIntentPresent: false },
      { edge: "left", protectedResult: "fail", edgeIntentPresent: false },
    ]);
    assert.deepEqual(
      chips.map((c) => `${c.edge.toUpperCase()} ${c.label}`),
      ["TOP FAIL", "RIGHT FAIL", "BOTTOM UNKNOWN", "LEFT FAIL"],
    );
    assert.equal(
      chips.every((c) => !c.pass),
      true,
    );
  });

  it("marks an edge pass only when protectedResult is exactly pass", () => {
    const chips = deriveEdgeChips([{ edge: "top", protectedResult: "pass", edgeIntentPresent: true }]);
    assert.equal(chips[0].pass, true);
    assert.equal(chips[0].edgeIntent, true);
  });

  it("renders a missing edge as an explicit placeholder rather than dropping it", () => {
    const chips = deriveEdgeChips([{ edge: "top", protectedResult: "pass", edgeIntentPresent: false }]);
    const right = chips.find((c) => c.edge === "right");
    assert.ok(right);
    assert.equal(right.label, "—");
    assert.equal(right.pass, false);
  });

  it("returns four chips even for an empty input", () => {
    assert.equal(deriveEdgeChips([]).length, 4);
  });
});

describe("deriveOverallFitLabel", () => {
  it("is READY only for an exact pass status", () => {
    assert.equal(deriveOverallFitLabel("pass"), "READY");
  });

  it("is BLOCKED for fail", () => {
    assert.equal(deriveOverallFitLabel("fail"), "BLOCKED");
  });

  it("is BLOCKED for unknown — never treated as passing", () => {
    assert.equal(deriveOverallFitLabel("unknown"), "BLOCKED");
  });

  it("is BLOCKED for any unrecognized status — fail-closed, never fail-open", () => {
    assert.equal(deriveOverallFitLabel("something_else"), "BLOCKED");
  });
});

describe("computeDisplayPpi", () => {
  it("averages both axes and rounds", () => {
    assert.equal(computeDisplayPpi(154.5, 155.3), 155);
  });

  it("matches the real acceptance project's known ~154.9 PPI", () => {
    assert.equal(computeDisplayPpi(154.9, 154.9), 155);
  });

  it("falls back to the single known axis when the other is null", () => {
    assert.equal(computeDisplayPpi(160, null), 160);
    assert.equal(computeDisplayPpi(null, 140), 140);
  });

  it("returns null only when both axes are unknown", () => {
    assert.equal(computeDisplayPpi(null, null), null);
  });
});
