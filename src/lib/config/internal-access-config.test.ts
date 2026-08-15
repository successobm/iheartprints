import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import {
  INTERNAL_ACCESS_KEY_ENV,
  isInternalAccessConfigured,
  verifyInternalAccessKey,
} from "./internal-access-config";

/**
 * Sprint A4, Goal 16 / Goal 21 T.
 *
 * The property that matters most is the one about ABSENCE: with no key
 * configured, there is no internal entitlement to grant, in any
 * environment. `WORKER_SECRET` has a development fallback; this
 * deliberately does not, because a well-known default here would be a
 * published bypass for the entire acquisition funnel.
 */
describe("internal access key", () => {
  const original = process.env[INTERNAL_ACCESS_KEY_ENV];

  afterEach(() => {
    if (original === undefined) delete process.env[INTERNAL_ACCESS_KEY_ENV];
    else process.env[INTERNAL_ACCESS_KEY_ENV] = original;
  });

  const VALID_KEY = "a".repeat(40);

  it("fails closed when nothing is configured — no dev fallback exists", () => {
    delete process.env[INTERNAL_ACCESS_KEY_ENV];
    assert.equal(isInternalAccessConfigured(), false);

    const result = verifyInternalAccessKey(VALID_KEY);
    assert.equal(result.authorized, false);
    assert.equal(result.authorized === false && result.reason, "not_configured");
  });

  it("fails closed when configured with an obviously accidental value", () => {
    for (const weak of ["1", "test", "secret", "changeme"]) {
      process.env[INTERNAL_ACCESS_KEY_ENV] = weak;
      assert.equal(isInternalAccessConfigured(), false, `accepted "${weak}"`);
      assert.equal(verifyInternalAccessKey(weak).authorized, false);
    }
  });

  it("refuses a missing key even when configured", () => {
    process.env[INTERNAL_ACCESS_KEY_ENV] = VALID_KEY;
    const result = verifyInternalAccessKey(null);
    assert.equal(result.authorized, false);
    assert.equal(result.authorized === false && result.reason, "missing_key");
  });

  it("refuses a wrong key, including one that is merely a prefix", () => {
    process.env[INTERNAL_ACCESS_KEY_ENV] = VALID_KEY;
    for (const wrong of ["b".repeat(40), VALID_KEY.slice(0, 39), `${VALID_KEY}x`]) {
      const result = verifyInternalAccessKey(wrong);
      assert.equal(result.authorized, false);
      assert.equal(result.authorized === false && result.reason, "invalid_key");
    }
  });

  it("T: authorizes the exact configured key", () => {
    process.env[INTERNAL_ACCESS_KEY_ENV] = VALID_KEY;
    assert.equal(isInternalAccessConfigured(), true);
    assert.equal(verifyInternalAccessKey(VALID_KEY).authorized, true);
  });

  it("tolerates surrounding whitespace in the configured value", () => {
    // Copy-pasted secrets pick up whitespace constantly; a deployment that
    // silently never authorizes is worse than trimming.
    process.env[INTERNAL_ACCESS_KEY_ENV] = `  ${VALID_KEY}  `;
    assert.equal(verifyInternalAccessKey(VALID_KEY).authorized, true);
  });
});
