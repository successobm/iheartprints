import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  isAutomatedTestEnvironment,
  AUTOMATED_TEST_SAFETY_ENV_VAR,
} from "./automated-test-safety";

describe("isAutomatedTestEnvironment (release-blocker hotfix)", () => {
  it("is true right now — the test-safety-bootstrap --import preload set it before this file ever loaded", () => {
    assert.equal(isAutomatedTestEnvironment(), true);
    assert.equal(process.env[AUTOMATED_TEST_SAFETY_ENV_VAR], "1");
  });
});
