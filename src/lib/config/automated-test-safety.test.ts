import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  isAutomatedTestEnvironment,
  AUTOMATED_TEST_SAFETY_ENV_VAR,
} from "./automated-test-safety";

describe("isAutomatedTestEnvironment (release-blocker hotfix)", () => {
  it("is true right now — the test-safety-bootstrap --import preload set it before this file ever loaded", () => {
    assert.equal(isAutomatedTestEnvironment(), true);
  });

  it("reflects the exact env var value deterministically", () => {
    const original = process.env[AUTOMATED_TEST_SAFETY_ENV_VAR];
    try {
      process.env[AUTOMATED_TEST_SAFETY_ENV_VAR] = "1";
      assert.equal(isAutomatedTestEnvironment(), true);

      process.env[AUTOMATED_TEST_SAFETY_ENV_VAR] = "true";
      assert.equal(isAutomatedTestEnvironment(), false, "only the exact string '1' counts — never a loose truthy check");

      delete process.env[AUTOMATED_TEST_SAFETY_ENV_VAR];
      assert.equal(isAutomatedTestEnvironment(), false);
    } finally {
      if (original === undefined) delete process.env[AUTOMATED_TEST_SAFETY_ENV_VAR];
      else process.env[AUTOMATED_TEST_SAFETY_ENV_VAR] = original;
    }
  });
});
