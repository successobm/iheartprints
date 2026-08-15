import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MAX_EMAIL_LENGTH,
  normalizeEmail,
  validateEmail,
} from "./acquisition-email";

/**
 * Sprint A4, Goal 7 / Goal 21 L+V.
 *
 * The interesting property is not "does the regex work" — it is that this
 * validator is deliberately PERMISSIVE. A false rejection here means a real
 * customer with a real address cannot continue their design session, which
 * is a far worse outcome than accepting an address that turns out not to
 * receive mail (nothing in A4 sends any).
 */
describe("acquisition email validation", () => {
  it("L: rejects an empty or whitespace-only value", () => {
    for (const raw of ["", "   ", "\t\n"]) {
      const result = validateEmail(raw);
      assert.equal(result.valid, false);
      assert.equal(result.valid === false && result.reason, "empty");
    }
  });

  it("L: rejects a non-string body value without throwing", () => {
    for (const raw of [null, undefined, 42, {}, []]) {
      assert.equal(validateEmail(raw).valid, false);
    }
  });

  it("L: rejects values that are obviously not addresses", () => {
    for (const raw of [
      "eric",
      "eric@",
      "@example.com",
      "eric@example",
      "eric example@test.com",
      "eric@exa mple.com",
    ]) {
      const result = validateEmail(raw);
      assert.equal(result.valid, false, `accepted "${raw}"`);
      assert.equal(result.valid === false && result.reason, "invalid_format");
    }
  });

  it("L: rejects an address longer than the RFC 5321 maximum", () => {
    const tooLong = `${"a".repeat(MAX_EMAIL_LENGTH)}@example.com`;
    const result = validateEmail(tooLong);
    assert.equal(result.valid, false);
    assert.equal(result.valid === false && result.reason, "too_long");
  });

  it("M: accepts ordinary addresses and returns the normalized form", () => {
    const result = validateEmail("  Eric@Example.COM  ");
    assert.equal(result.valid, true);
    assert.equal(result.valid === true && result.email, "eric@example.com");
  });

  it("M: accepts plus addressing, subdomains, and long TLDs", () => {
    for (const raw of [
      "eric+iheartprints@printemall.com",
      "eric@mail.printemall.co.uk",
      "eric@printemall.technology",
    ]) {
      assert.equal(validateEmail(raw).valid, true, `rejected "${raw}"`);
    }
  });

  it("V: normalization makes duplicate submissions identical", () => {
    // This is what makes a repeat submission a genuine no-op rather than a
    // second, differently-cased row.
    assert.equal(
      normalizeEmail(" ERIC@PRINTEMALL.COM "),
      normalizeEmail("eric@printemall.com"),
    );
  });

  it("failure messages never name a field, a rule, or a reason code", () => {
    for (const raw of ["", "nope", `${"a".repeat(400)}@x.com`]) {
      const result = validateEmail(raw);
      assert.equal(result.valid, false);
      const message = result.valid === false ? result.message : "";
      assert.doesNotMatch(
        message,
        /regex|pattern|RFC|invalid_format|too_long|schema|field|null|undefined/i,
        `leaked an internal detail: ${message}`,
      );
    }
  });
});
