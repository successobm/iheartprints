import assert from "node:assert/strict";
import { test } from "node:test";

import { validateQrDestination } from "./qr-destination-validation";

test("accepts an ordinary https URL", () => {
  assert.equal(validateQrDestination("https://get-hibachi.com/book").ok, true);
});

test("accepts an ordinary http URL", () => {
  assert.equal(validateQrDestination("http://example.com").ok, true);
});

test("accepts a bare domain/path with no scheme (common on real signage), exactly as supplied", () => {
  const result = validateQrDestination("get-hibachi.com/book");
  assert.equal(result.ok, true);
});

test("accepts tel:/mailto:/sms:", () => {
  assert.equal(validateQrDestination("tel:+16269494567").ok, true);
  assert.equal(validateQrDestination("mailto:hello@get-hibachi.com").ok, true);
  assert.equal(validateQrDestination("sms:+16269494567").ok, true);
});

test("rejects empty/whitespace-only input", () => {
  assert.equal(validateQrDestination("").ok, false);
  assert.equal(validateQrDestination("   ").ok, false);
});

test("rejects a javascript: scheme", () => {
  const result = validateQrDestination("javascript:alert(1)");
  assert.equal(result.ok, false);
});

test("rejects a data: scheme", () => {
  assert.equal(validateQrDestination("data:text/html,<script>alert(1)</script>").ok, false);
});

test("rejects vbscript: and file: schemes", () => {
  assert.equal(validateQrDestination("vbscript:msgbox(1)").ok, false);
  assert.equal(validateQrDestination("file:///etc/passwd").ok, false);
});

test("rejects an unrecognized scheme (not web, not tel/mailto/sms)", () => {
  assert.equal(validateQrDestination("ftp://example.com/file").ok, false);
});

test("rejects a destination over the maximum length", () => {
  assert.equal(validateQrDestination("https://example.com/" + "a".repeat(600)).ok, false);
});

test("is case-insensitive about forbidden schemes", () => {
  assert.equal(validateQrDestination("JavaScript:alert(1)").ok, false);
  assert.equal(validateQrDestination("  JAVASCRIPT:alert(1)").ok, false);
});

test("never normalizes/rewrites an accepted destination — exact confirmed payload is authority", () => {
  const input = "https://example.com";
  const result = validateQrDestination(input);
  assert.equal(result.ok, true);
  // The function returns only ok/reason — it must never expose a
  // "normalized" value anywhere, confirming the caller has nothing to
  // silently substitute.
  assert.deepEqual(Object.keys(result).sort(), ["ok", "reason"]);
});
