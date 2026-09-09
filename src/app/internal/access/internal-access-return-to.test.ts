import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { resolveInternalAccessReturnTo } from "./internal-access-return-to";

/**
 * Production Operator Access Blocker fix: "Review in production workspace"
 * -> "Get internal access" -> a successful grant must return the operator
 * to the exact project/review page they were trying to reach, never lose
 * their place and never become an open redirect. See that function's own
 * doc for the exact defenses.
 */
describe("resolveInternalAccessReturnTo", () => {
  it("accepts the real Sign Production Review destination this flow actually generates", () => {
    assert.equal(
      resolveInternalAccessReturnTo("/internal/projects/0858d192-e74e-40b5-8532-a91bc4bcdf8e/sign-authorize"),
      "/internal/projects/0858d192-e74e-40b5-8532-a91bc4bcdf8e/sign-authorize",
    );
  });

  it("accepts an ordinary root-relative path", () => {
    assert.equal(resolveInternalAccessReturnTo("/internal/projects/abc/continue"), "/internal/projects/abc/continue");
  });

  it("falls back to '/' when absent", () => {
    assert.equal(resolveInternalAccessReturnTo(undefined), "/");
  });

  it("falls back to '/' for an empty string", () => {
    assert.equal(resolveInternalAccessReturnTo(""), "/");
  });

  it("falls back to '/' for a repeated query param (arrives as an array)", () => {
    assert.equal(resolveInternalAccessReturnTo(["/a", "/b"]), "/");
  });

  it("falls back to '/' for a bare relative path with no leading slash", () => {
    assert.equal(resolveInternalAccessReturnTo("evil.example"), "/");
  });

  it("falls back to '/' for a protocol-relative URL (//host) - the classic open-redirect shape", () => {
    assert.equal(resolveInternalAccessReturnTo("//evil.example"), "/");
    assert.equal(resolveInternalAccessReturnTo("//evil.example/phish"), "/");
  });

  it("falls back to '/' for a backslash-prefixed path some browsers treat as protocol-relative", () => {
    assert.equal(resolveInternalAccessReturnTo("/\\evil.example"), "/");
  });

  it("falls back to '/' for an absolute URL with a scheme", () => {
    assert.equal(resolveInternalAccessReturnTo("https://evil.example"), "/");
    assert.equal(resolveInternalAccessReturnTo("javascript://evil.example"), "/");
  });

  it("falls back to '/' for a scheme smuggled inside a root-relative-looking path", () => {
    assert.equal(resolveInternalAccessReturnTo("/redirect:https://evil.example"), "/");
    assert.equal(resolveInternalAccessReturnTo("/a/https://evil.example"), "/");
  });
});
