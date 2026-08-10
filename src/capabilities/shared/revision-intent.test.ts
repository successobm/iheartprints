import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isExplicitRevisionIntent } from "./revision-intent";

/**
 * Sprint 2M Phase 2G (Goal 4): explicit conversational revision requests
 * are customer authority to enqueue regeneration automatically; hedged or
 * purely exploratory language never is.
 */
describe("isExplicitRevisionIntent", () => {
  const explicit = [
    "Make the boat larger.",
    "Remove the wording below GLORIOUS.",
    "Change the shirt design to blue and make the logo smaller.",
    "Don't print 'is the boat name'; just use GLORIOUS.",
    "Actually, make it a hoodie.",
  ];

  for (const message of explicit) {
    it(`"${message}" is explicit`, () => {
      assert.equal(isExplicitRevisionIntent(message), true);
    });
  }

  const notExplicit = [
    "Maybe the boat could be bigger.",
    "I'm not sure about the wording.",
    "Do you think this needs more color?",
    "",
    "   ",
  ];

  for (const message of notExplicit) {
    it(`"${message}" is not explicit`, () => {
      assert.equal(isExplicitRevisionIntent(message), false);
    });
  }
});
