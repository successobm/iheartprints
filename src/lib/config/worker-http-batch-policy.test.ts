import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { AUTOMATED_TEST_SAFETY_ENV_VAR } from "./automated-test-safety";
import {
  resolveAwaitGenerationWorkerBatch,
  shouldAwaitGenerationWorkerBatch,
} from "./worker-http-batch-policy";

describe("shouldAwaitGenerationWorkerBatch", () => {
  it("live automated test process awaits even when NODE_ENV is not production", () => {
    assert.equal(process.env[AUTOMATED_TEST_SAFETY_ENV_VAR], "1");
    assert.equal(shouldAwaitGenerationWorkerBatch(), true);
  });

  it("resolveAwaitGenerationWorkerBatch: production always awaits", () => {
    assert.equal(
      resolveAwaitGenerationWorkerBatch({ nodeEnv: "production", automatedTest: false }),
      true,
    );
    assert.equal(
      resolveAwaitGenerationWorkerBatch({ nodeEnv: "production", automatedTest: true }),
      true,
    );
  });

  it("resolveAwaitGenerationWorkerBatch: automated tests always await", () => {
    assert.equal(
      resolveAwaitGenerationWorkerBatch({ nodeEnv: "development", automatedTest: true }),
      true,
    );
    assert.equal(
      resolveAwaitGenerationWorkerBatch({ nodeEnv: undefined, automatedTest: true }),
      true,
    );
  });

  it("resolveAwaitGenerationWorkerBatch: interactive next-dev may detach", () => {
    assert.equal(
      resolveAwaitGenerationWorkerBatch({ nodeEnv: "development", automatedTest: false }),
      false,
    );
  });
});
