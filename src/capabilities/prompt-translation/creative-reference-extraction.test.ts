import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { extractCreativeReferences } from "./creative-reference-extraction";

describe("extractCreativeReferences — Sprint 2K Phase 3 (Goal 4)", () => {
  it("pulls a 'spin off from' pop-culture reference out of content, keeping the rest", () => {
    const result = extractCreativeReferences(
      "its a retro design spin off from the old tv show my 3 sons, but i want it bowling themed",
    );
    assert.match(result.content, /retro design/i);
    assert.match(result.content, /bowling themed/i);
    assert.doesNotMatch(result.content, /tv show/i);
    assert.equal(result.inspirations.length, 1);
    assert.match(result.inspirations[0]!, /tv show my 3 sons/i);
  });

  it("pulls an 'inspired by' reference out of content", () => {
    const result = extractCreativeReferences("A retro bowling logo inspired by an old sitcom");
    assert.match(result.content, /retro bowling logo/i);
    assert.doesNotMatch(result.content, /sitcom/i);
    assert.deepEqual(
      result.inspirations.map((i) => i.toLowerCase()),
      ["an old sitcom"],
    );
  });

  it("pulls a 'like an old ...' reference out of content", () => {
    const result = extractCreativeReferences("Make it like an old travel poster");
    assert.doesNotMatch(result.content, /travel poster/i);
    assert.equal(result.inspirations.length, 1);
    assert.match(result.inspirations[0]!, /old travel poster/i);
  });

  it("does not treat an ordinary 'I'd like a ...' request as a reference", () => {
    const result = extractCreativeReferences("I'd like a black bowling ball graphic");
    assert.equal(result.inspirations.length, 0);
    assert.match(result.content, /black bowling ball graphic/i);
  });

  it("leaves content with no reference cue untouched", () => {
    const result = extractCreativeReferences("A friendly bear mascot holding a fish");
    assert.equal(result.content, "A friendly bear mascot holding a fish");
    assert.deepEqual(result.inspirations, []);
  });

  it("handles empty input", () => {
    assert.deepEqual(extractCreativeReferences(""), { content: "", inspirations: [] });
    assert.deepEqual(extractCreativeReferences("   "), { content: "", inspirations: [] });
  });

  it("extracts an 'in the style of' reference (comic-book / old travel-poster style requests)", () => {
    const result = extractCreativeReferences(
      "A bowling ball and pins in the style of 1950s advertising art",
    );
    assert.doesNotMatch(result.content, /advertising art/i);
    assert.match(result.inspirations[0]!, /1950s advertising art/i);
  });
});
