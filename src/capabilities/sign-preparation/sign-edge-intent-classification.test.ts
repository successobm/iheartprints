/**
 * Edge-Intent Correction Phase: governance for
 * `SignEdgeIntentClassificationRecord` — decode/encode round-trip, malformed
 * shapes never silently trusted, and re-validation against current
 * candidate/plan identity (Section F/K governance).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildEdgeIntentClassificationRecord,
  decodeEdgeIntentClassificationRecord,
  decodeEdgeIntentClassificationRecords,
  encodeEdgeIntentClassificationRecord,
  resolveCurrentEdgeIntentClassifications,
} from "./sign-edge-intent-classification";

function validRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: "abc-123",
    kind: "edge_intent",
    edges: ["left"],
    xPx: 0, yPx: 0, widthPx: 9, heightPx: 400,
    candidateAssetId: "asset-1",
    planKey: "plan-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    createdBy: "operator",
    ...overrides,
  };
}

describe("decodeEdgeIntentClassificationRecord", () => {
  it("accepts a well-formed record", () => {
    const record = decodeEdgeIntentClassificationRecord(validRecord());
    assert.ok(record);
    assert.equal(record?.kind, "edge_intent");
    assert.deepEqual(record?.edges, ["left"]);
  });

  it("accepts the 'protected' kind too", () => {
    const record = decodeEdgeIntentClassificationRecord(validRecord({ kind: "protected" }));
    assert.equal(record?.kind, "protected");
  });

  it("rejects a free-text kind — never a free-text override (Section F)", () => {
    assert.equal(decodeEdgeIntentClassificationRecord(validRecord({ kind: "probably a border" })), null);
  });

  it("rejects an empty edges array", () => {
    assert.equal(decodeEdgeIntentClassificationRecord(validRecord({ edges: [] })), null);
  });

  it("rejects an invalid edge name", () => {
    assert.equal(decodeEdgeIntentClassificationRecord(validRecord({ edges: ["diagonal"] })), null);
  });

  it("rejects non-finite or negative geometry", () => {
    assert.equal(decodeEdgeIntentClassificationRecord(validRecord({ widthPx: 0 })), null);
    assert.equal(decodeEdgeIntentClassificationRecord(validRecord({ xPx: -1 })), null);
    assert.equal(decodeEdgeIntentClassificationRecord(validRecord({ heightPx: Number.NaN })), null);
  });

  it("rejects a missing candidateAssetId/planKey — identity binding is required, never optional", () => {
    assert.equal(decodeEdgeIntentClassificationRecord(validRecord({ candidateAssetId: "" })), null);
    assert.equal(decodeEdgeIntentClassificationRecord(validRecord({ planKey: undefined })), null);
  });

  it("rejects createdBy other than 'operator' — never customer-authored", () => {
    assert.equal(decodeEdgeIntentClassificationRecord(validRecord({ createdBy: "customer" })), null);
  });

  it("rejects a non-object", () => {
    assert.equal(decodeEdgeIntentClassificationRecord(null), null);
    assert.equal(decodeEdgeIntentClassificationRecord("not an object"), null);
  });
});

describe("decodeEdgeIntentClassificationRecords", () => {
  it("drops a malformed entry without discarding the valid ones alongside it", () => {
    const records = decodeEdgeIntentClassificationRecords([
      validRecord({ id: "good-1" }),
      validRecord({ id: "bad", kind: "not_a_real_kind" }),
      validRecord({ id: "good-2" }),
    ]);
    assert.equal(records.length, 2);
    assert.deepEqual(records.map((r) => r.id), ["good-1", "good-2"]);
  });

  it("returns [] for non-array input, never throws", () => {
    assert.deepEqual(decodeEdgeIntentClassificationRecords(null), []);
    assert.deepEqual(decodeEdgeIntentClassificationRecords(undefined), []);
    assert.deepEqual(decodeEdgeIntentClassificationRecords("garbage"), []);
  });
});

describe("encodeEdgeIntentClassificationRecord / buildEdgeIntentClassificationRecord round-trip", () => {
  it("round-trips through encode -> decode unchanged", () => {
    const built = buildEdgeIntentClassificationRecord({
      kind: "edge_intent", edges: ["left", "right"],
      xPx: 1, yPx: 2, widthPx: 3, heightPx: 4,
      candidateAssetId: "asset-9", planKey: "plan-9",
    });
    const decoded = decodeEdgeIntentClassificationRecord(encodeEdgeIntentClassificationRecord(built));
    assert.deepEqual(decoded, built);
  });

  it("stamps a fresh id, createdAt, and createdBy: 'operator' for every new record", () => {
    const a = buildEdgeIntentClassificationRecord({
      kind: "protected", edges: ["top"], xPx: 0, yPx: 0, widthPx: 1, heightPx: 1,
      candidateAssetId: "asset-1", planKey: "plan-1",
    });
    const b = buildEdgeIntentClassificationRecord({
      kind: "protected", edges: ["top"], xPx: 0, yPx: 0, widthPx: 1, heightPx: 1,
      candidateAssetId: "asset-1", planKey: "plan-1",
    });
    assert.notEqual(a.id, b.id, "two separate classifications must never collide on identity");
    assert.equal(a.createdBy, "operator");
    assert.ok(a.createdAt);
  });
});

describe("resolveCurrentEdgeIntentClassifications (Section F/K governance)", () => {
  it("keeps a record whose candidateAssetId and planKey both match current state", () => {
    const record = buildEdgeIntentClassificationRecord({
      kind: "edge_intent", edges: ["left"], xPx: 0, yPx: 0, widthPx: 9, heightPx: 400,
      candidateAssetId: "asset-current", planKey: "plan-current",
    });
    const resolved = resolveCurrentEdgeIntentClassifications([record], "asset-current", "plan-current");
    assert.equal(resolved.length, 1);
    assert.deepEqual(resolved[0], { kind: "edge_intent", edges: ["left"], xPx: 0, yPx: 0, widthPx: 9, heightPx: 400 });
  });

  it("drops a record bound to a DIFFERENT (superseded) candidate asset — never silently governs a materially different rendered candidate", () => {
    const record = buildEdgeIntentClassificationRecord({
      kind: "edge_intent", edges: ["left"], xPx: 0, yPx: 0, widthPx: 9, heightPx: 400,
      candidateAssetId: "asset-old", planKey: "plan-current",
    });
    const resolved = resolveCurrentEdgeIntentClassifications([record], "asset-new", "plan-current");
    assert.equal(resolved.length, 0);
  });

  it("drops a record bound to a DIFFERENT (superseded) plan key", () => {
    const record = buildEdgeIntentClassificationRecord({
      kind: "edge_intent", edges: ["left"], xPx: 0, yPx: 0, widthPx: 9, heightPx: 400,
      candidateAssetId: "asset-current", planKey: "plan-old",
    });
    const resolved = resolveCurrentEdgeIntentClassifications([record], "asset-current", "plan-new");
    assert.equal(resolved.length, 0);
  });

  it("filters a mixed set — several classifications, only the ones matching current identity survive", () => {
    const current = buildEdgeIntentClassificationRecord({
      kind: "edge_intent", edges: ["left"], xPx: 0, yPx: 0, widthPx: 9, heightPx: 400,
      candidateAssetId: "asset-current", planKey: "plan-current",
    });
    const stale = buildEdgeIntentClassificationRecord({
      kind: "edge_intent", edges: ["right"], xPx: 0, yPx: 0, widthPx: 9, heightPx: 400,
      candidateAssetId: "asset-old", planKey: "plan-current",
    });
    const resolved = resolveCurrentEdgeIntentClassifications([current, stale], "asset-current", "plan-current");
    assert.equal(resolved.length, 1);
    assert.deepEqual(resolved[0]!.edges, ["left"]);
  });
});
