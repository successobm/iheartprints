import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  extractRevisionDelta,
  isChangeClause,
  splitRequestedChanges,
} from "./revision-delta";

/**
 * True Source-Image Targeted Revision (Section 5 — delta plumbing).
 *
 * The customer's instruction is the only place the requested DELTA exists.
 * These prove it decomposes into the changes they actually asked for,
 * generically — no product nouns, no per-scenario keywords.
 */
describe("splitRequestedChanges", () => {
  it("splits two independent requested changes into two entries", () => {
    assert.deepEqual(
      splitRequestedChanges("change the font to retro and remove the sunset"),
      ["change the font to retro", "remove the sunset"],
    );
  });

  it("splits a border change and a shape change (the live acceptance case)", () => {
    assert.deepEqual(
      splitRequestedChanges("make the border red and change it to a shield"),
      ["make the border red", "change it to a shield"],
    );
  });

  it("keeps a single targeted change as exactly one change", () => {
    assert.deepEqual(splitRequestedChanges("make the car larger"), [
      "make the car larger",
    ]);
  });

  it("never splits a connector that is part of one clause", () => {
    // "black and white" is one value, not two instructions.
    assert.deepEqual(splitRequestedChanges("make it black and white"), [
      "make it black and white",
    ]);
    assert.deepEqual(
      splitRequestedChanges("make the shield red and the text white"),
      ["make the shield red and the text white"],
    );
  });

  it("handles comma-separated changes and more than two of them", () => {
    assert.deepEqual(
      splitRequestedChanges(
        "make the car larger, remove the sunset and change the font to retro",
      ),
      ["make the car larger", "remove the sunset", "change the font to retro"],
    );
  });

  it("strips polite scaffolding so a clause reads as a bare imperative", () => {
    assert.deepEqual(
      splitRequestedChanges("Can you please make the border red, and also remove the sunset?"),
      ["make the border red", "remove the sunset"],
    );
  });

  it("returns nothing for an empty instruction", () => {
    assert.deepEqual(splitRequestedChanges("   "), []);
    assert.deepEqual(splitRequestedChanges(""), []);
  });

  it("keeps a non-imperative instruction whole rather than inventing changes", () => {
    assert.deepEqual(splitRequestedChanges("the shield should feel vintage"), [
      "the shield should feel vintage",
    ]);
  });

  it("is generic — the same shapes work for an unrelated subject", () => {
    assert.deepEqual(
      splitRequestedChanges("enlarge the boat and swap the banner for a ribbon"),
      ["enlarge the boat", "swap the banner for a ribbon"],
    );
  });
});

/**
 * Live Acceptance Cleanup — Issue 1.
 *
 * Live failure: "make the 3 SONS text the same color as the ball, everything
 * else stays the same" arrived as ONE requested change with the preservation
 * clause glued onto the end, so the strongest signal in the message reached
 * the provider as part of the change description rather than as a constraint
 * on it. Generic by sentence shape — no bowling, no product nouns.
 */
describe("extractRevisionDelta — blanket preservation", () => {
  it("1: separates the change from 'everything else stays the same'", () => {
    const delta = extractRevisionDelta(
      "make the 3 SONS text the same color as the ball, everything else stays the same",
    );

    assert.deepEqual(delta.requestedChanges, [
      "make the 3 SONS text the same color as the ball",
    ]);
    assert.equal(delta.preserveEverythingElse, true);
    // The untouched element is emphatically NOT part of the requested change.
    assert.doesNotMatch(delta.requestedChanges.join(" "), /\bMY\b/);
  });

  it("2: 'make the wheels chrome; leave everything else the same' targets only the wheels", () => {
    const delta = extractRevisionDelta(
      "make the wheels chrome; leave everything else the same",
    );

    assert.deepEqual(delta.requestedChanges, ["make the wheels chrome"]);
    assert.equal(delta.preserveEverythingElse, true);
  });

  it("recognizes the blanket clause however the customer phrases it", () => {
    for (const instruction of [
      "make only the word SALE red, everything else stays the same",
      "change the top line to blue and don't change anything else",
      "make the number 25 gold — leave the rest alone",
      "change the dog collar to red, keep everything else the same",
      "make the wheels chrome, no other changes",
      "make the border red; nothing else changes",
    ]) {
      const delta = extractRevisionDelta(instruction);
      assert.equal(
        delta.preserveEverythingElse,
        true,
        `"${instruction}" states a blanket preservation`,
      );
      assert.equal(delta.requestedChanges.length, 1, instruction);
      assert.doesNotMatch(
        delta.requestedChanges[0]!,
        /everything else|the rest|no other changes|nothing else|don'?t change/i,
        "the constraint must not survive inside the change description",
      );
    }
  });

  it("keeps the targeted change intact — only the blanket clause is removed", () => {
    assert.deepEqual(
      extractRevisionDelta("make only the word SALE red, everything else stays the same")
        .requestedChanges,
      ["make only the word SALE red"],
    );
    assert.deepEqual(
      extractRevisionDelta("change the top line to blue and don't change anything else")
        .requestedChanges,
      ["change the top line to blue"],
    );
  });

  it("never invents a blanket preservation the customer did not state", () => {
    for (const instruction of [
      "make the border red",
      "make it black and white",
      "change the font to retro and remove the sunset",
    ]) {
      assert.equal(
        extractRevisionDelta(instruction).preserveEverythingElse,
        false,
        instruction,
      );
    }
  });

  it("an instruction that is ONLY a preservation asks for no change at all", () => {
    const delta = extractRevisionDelta("everything else stays the same");
    assert.deepEqual(delta.requestedChanges, []);
    assert.equal(delta.preserveEverythingElse, true);
  });
});

describe("isChangeClause", () => {
  it("recognizes imperative change clauses", () => {
    assert.equal(isChangeClause("make the border red"), true);
    assert.equal(isChangeClause("remove the sunset"), true);
    assert.equal(isChangeClause("please enlarge the car"), true);
  });

  it("rejects statements that are not instructions to change the artwork", () => {
    assert.equal(isChangeClause("the shield should feel vintage"), false);
    assert.equal(isChangeClause("that looks great"), false);
  });
});
