import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ALTERNATIVE_CONCEPTS_WAITING_MESSAGE,
  APPROXIMATE_WAIT_NOTE,
  INITIAL_CONCEPTS_WAITING_MESSAGE,
  NEW_CONCEPT_BATCH_WAITING_MESSAGE,
  PRINT_READY_WAITING_MESSAGE,
  TARGETED_REVISION_WAITING_MESSAGE,
} from "./waiting-copy";

/**
 * Live Acceptance Cleanup — Issue 4.
 *
 * Live finding: initial concepts and targeted revisions both take about 3–4
 * minutes and finalization is comparable, but the copy said only
 * "generating…", so the app read as frozen. These pin the honest expectation
 * to every wait, and pin the guardrails: no fake percentages, no fabricated
 * stages, no promised completion time, no "don't refresh".
 */

const ALL_WAITING_MESSAGES = [
  INITIAL_CONCEPTS_WAITING_MESSAGE,
  NEW_CONCEPT_BATCH_WAITING_MESSAGE,
  ALTERNATIVE_CONCEPTS_WAITING_MESSAGE,
  TARGETED_REVISION_WAITING_MESSAGE,
  PRINT_READY_WAITING_MESSAGE,
];

describe("Waiting copy", () => {
  it("11: initial concept generation states the approximate 3–4 minute expectation", () => {
    assert.match(INITIAL_CONCEPTS_WAITING_MESSAGE, /three concept directions/i);
    assert.match(INITIAL_CONCEPTS_WAITING_MESSAGE, /3–4 minutes/);
    assert.match(INITIAL_CONCEPTS_WAITING_MESSAGE, /patience/i);
  });

  it("12: targeted revision copy states the approximate expectation", () => {
    assert.match(TARGETED_REVISION_WAITING_MESSAGE, /selected concept/i);
    assert.match(TARGETED_REVISION_WAITING_MESSAGE, /3–4 minutes/);
  });

  it("13: print-ready finalization copy states the approximate expectation", () => {
    assert.match(PRINT_READY_WAITING_MESSAGE, /print-ready artwork/i);
    assert.match(PRINT_READY_WAITING_MESSAGE, /3–4 minutes/);
  });

  it("every wait carries the estimate, from the one shared constant", () => {
    for (const message of ALL_WAITING_MESSAGES) {
      assert.ok(
        message.includes(APPROXIMATE_WAIT_NOTE),
        `"${message}" must reuse the shared estimate so it can be revised in one edit`,
      );
    }
  });

  it("stays simple: no fake progress, no promised completion time, no refresh warning", () => {
    for (const message of ALL_WAITING_MESSAGES) {
      assert.doesNotMatch(message, /%|percent/i, "no fabricated percentages");
      assert.doesNotMatch(
        message,
        /\bstep\s*\d|\bstage\b|\bphase\s*\d/i,
        "no fabricated pipeline stages",
      );
      assert.doesNotMatch(
        message,
        /\b(?:will (?:be (?:done|ready)|finish)|exactly|guaranteed)\b/i,
        "never promises an exact completion",
      );
      assert.doesNotMatch(
        message,
        /refresh|reload|close (?:this|the) (?:tab|window)/i,
        "never tells the customer not to refresh",
      );
      // Production settings stay hidden (Constitution §6.4 / AGENTS.md Goal 8).
      assert.doesNotMatch(message, /\bDPI\b|\bPPI\b|upscal|raster|vector|provider/i);
    }
  });
});
