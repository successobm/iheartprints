import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  isRegionOperation,
  parseGuidedCleanupOperations,
} from "./guided-cleanup-operations";
import { MAGIC_SELECT_RULE_V1 } from "./magic-color-selection";

describe("guided cleanup operation log", () => {
  it("N: Phase 1.7 connected magic_color ops default to connected v1 replay", () => {
    const ops = parseGuidedCleanupOperations({
      removals: [
        {
          kind: "magic_color",
          point: { x: 3, y: 4 },
          tolerance: 8,
          connectedOnly: true,
          referenceColor: { r: 1, g: 2, b: 3 },
          selectionKey: "legacy-key",
          pixelCount: 3,
        },
      ],
    });
    assert.equal(ops.length, 1);
    const op = ops[0]!;
    assert.equal(op.kind, "magic_color");
    if (op.kind !== "magic_color") return;
    assert.equal(op.selectionMode, "connected");
    assert.equal(op.ruleVersion, MAGIC_SELECT_RULE_V1);
    assert.equal(op.connectedOnly, true);
    assert.equal(op.selectionKey, "legacy-key");
  });

  it("O: region-only histories without kind remain region ops", () => {
    const ops = parseGuidedCleanupOperations({
      removals: [{ point: { x: 10, y: 20 }, regionKey: "abc", pixelCount: 40 }],
    });
    assert.equal(ops.length, 1);
    const op = ops[0]!;
    assert.equal(isRegionOperation(op), true);
    if (!isRegionOperation(op)) return;
    assert.equal(op.regionKey, "abc");
  });

  it("persists similar mode without reinterpreting it as connected", () => {
    const ops = parseGuidedCleanupOperations({
      removals: [
        {
          kind: "magic_color",
          point: { x: 1, y: 1 },
          tolerance: 8,
          selectionMode: "similar",
          ruleVersion: "magic-select:v2",
          referenceColor: { r: 0, g: 0, b: 0 },
          selectionKey: "similar-key",
          pixelCount: 80,
        },
      ],
    });
    assert.equal(ops[0]!.kind, "magic_color");
    if (ops[0]!.kind !== "magic_color") return;
    assert.equal(ops[0].selectionMode, "similar");
    assert.equal(ops[0].connectedOnly, false);
  });
});
