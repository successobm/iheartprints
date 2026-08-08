import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { AUTOMATED_TEST_SAFETY_ENV_VAR } from "./automated-test-safety";
import {
  decideLocalGenerationTrigger,
  resolveLocalGenerationTriggerDecision,
  resolveShouldAutoTriggerLocalGenerationWorker,
  shouldAutoTriggerLocalGenerationWorker,
} from "./local-generation-trigger-policy";

describe("local-generation-trigger-policy", () => {
  it("live automated test process never auto-triggers", () => {
    assert.equal(process.env[AUTOMATED_TEST_SAFETY_ENV_VAR], "1");
    assert.equal(shouldAutoTriggerLocalGenerationWorker(), false);
    assert.deepEqual(decideLocalGenerationTrigger(), {
      allowed: false,
      reason: "automated_test",
    });
  });

  it("production never auto-triggers, even outside automated tests", () => {
    assert.deepEqual(
      resolveLocalGenerationTriggerDecision({
        nodeEnv: "production",
        automatedTest: false,
      }),
      { allowed: false, reason: "production" },
    );
    assert.equal(
      resolveShouldAutoTriggerLocalGenerationWorker({
        nodeEnv: "production",
        automatedTest: false,
      }),
      false,
    );
    assert.equal(
      resolveShouldAutoTriggerLocalGenerationWorker({
        nodeEnv: "production",
        automatedTest: true,
      }),
      false,
    );
  });

  it("automated tests never auto-trigger, even when NODE_ENV is development", () => {
    assert.deepEqual(
      resolveLocalGenerationTriggerDecision({
        nodeEnv: "development",
        automatedTest: true,
      }),
      { allowed: false, reason: "automated_test" },
    );
    assert.equal(
      resolveShouldAutoTriggerLocalGenerationWorker({
        nodeEnv: undefined,
        automatedTest: true,
      }),
      false,
    );
  });

  it("interactive next-dev may auto-trigger after enqueue", () => {
    assert.deepEqual(
      resolveLocalGenerationTriggerDecision({
        nodeEnv: "development",
        automatedTest: false,
      }),
      { allowed: true },
    );
    assert.equal(
      resolveShouldAutoTriggerLocalGenerationWorker({
        nodeEnv: "development",
        automatedTest: false,
      }),
      true,
    );
    assert.equal(
      resolveShouldAutoTriggerLocalGenerationWorker({
        nodeEnv: undefined,
        automatedTest: false,
      }),
      true,
    );
  });
});
