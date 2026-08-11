import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  isStalePreparedImageResponse,
  opaquePreparedRevision,
} from "./prepared-revision";

describe("opaquePreparedRevision", () => {
  it("is null when there is no prepared asset", () => {
    assert.equal(opaquePreparedRevision(null), null);
    assert.equal(opaquePreparedRevision(undefined), null);
    assert.equal(opaquePreparedRevision(""), null);
  });

  it("changes when the prepared asset identity changes", () => {
    const a = opaquePreparedRevision("asset-automatic");
    const b = opaquePreparedRevision("asset-after-d");
    const c = opaquePreparedRevision("asset-after-r");
    assert.ok(a);
    assert.ok(b);
    assert.ok(c);
    assert.notEqual(a, b);
    assert.notEqual(b, c);
    assert.equal(opaquePreparedRevision("asset-after-d"), b);
  });

  it("does not echo the raw asset id", () => {
    const assetId = "7b09819c-bf1d-4462-bacb-1ec6bfff80ae";
    const revision = opaquePreparedRevision(assetId);
    assert.ok(revision);
    assert.equal(revision.includes(assetId), false);
  });
});

describe("isStalePreparedImageResponse", () => {
  it("accepts a response that still matches the authoritative revision", () => {
    assert.equal(
      isStalePreparedImageResponse({
        requestRevision: "rev-b",
        authoritativeRevision: "rev-b",
      }),
      false,
    );
  });

  it("rejects a late response for a superseded revision", () => {
    // Request B was in flight; confirm R advanced authority to C before B resolved.
    assert.equal(
      isStalePreparedImageResponse({
        requestRevision: "rev-b",
        authoritativeRevision: "rev-c",
      }),
      true,
    );
  });

  it("rejects a late automatic response after the first cleanup confirm", () => {
    assert.equal(
      isStalePreparedImageResponse({
        requestRevision: "rev-a",
        authoritativeRevision: "rev-b",
      }),
      true,
    );
  });
});
