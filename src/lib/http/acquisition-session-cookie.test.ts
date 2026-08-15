import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ACQUISITION_SESSION_COOKIE,
  acquisitionSessionCookieOptions,
  readAcquisitionSessionToken,
} from "./acquisition-session-cookie";

/**
 * Sprint A4, Goal 5.
 *
 * A malformed, absent, or hostile cookie must resolve to "no session" —
 * never to an exception. This runs on the first line of every project
 * creation, so a throw here is a 500 on the customer's very first request.
 */
describe("acquisition session cookie", () => {
  it("returns null for a missing header", () => {
    assert.equal(readAcquisitionSessionToken(null), null);
    assert.equal(readAcquisitionSessionToken(undefined), null);
    assert.equal(readAcquisitionSessionToken(""), null);
  });

  it("returns null when the header carries other cookies only", () => {
    assert.equal(
      readAcquisitionSessionToken("theme=dark; sidebar=open"),
      null,
    );
  });

  it("reads the token when it is the only cookie", () => {
    assert.equal(
      readAcquisitionSessionToken(`${ACQUISITION_SESSION_COOKIE}=abc123`),
      "abc123",
    );
  });

  it("reads the token from anywhere in a multi-cookie header", () => {
    assert.equal(
      readAcquisitionSessionToken(
        `theme=dark; ${ACQUISITION_SESSION_COOKIE}=abc123; sidebar=open`,
      ),
      "abc123",
    );
  });

  it("tolerates surrounding whitespace", () => {
    assert.equal(
      readAcquisitionSessionToken(`  ${ACQUISITION_SESSION_COOKIE} = abc123 `),
      "abc123",
    );
  });

  it("treats an empty value as no session", () => {
    assert.equal(
      readAcquisitionSessionToken(`${ACQUISITION_SESSION_COOKIE}=`),
      null,
    );
  });

  it("never matches a cookie whose name merely contains ours", () => {
    // `ihp_as_other=x` must not be read as our token — a prefix match here
    // would let an unrelated cookie decide which session a project joins.
    assert.equal(
      readAcquisitionSessionToken(`${ACQUISITION_SESSION_COOKIE}_other=nope`),
      null,
    );
    assert.equal(
      readAcquisitionSessionToken(`x_${ACQUISITION_SESSION_COOKIE}=nope`),
      null,
    );
  });

  it("returns null rather than throwing on malformed percent-encoding", () => {
    assert.equal(
      readAcquisitionSessionToken(`${ACQUISITION_SESSION_COOKIE}=%E0%A4%A`),
      null,
    );
  });

  it("is httpOnly, lax, and root-scoped in every environment", () => {
    for (const isProduction of [true, false]) {
      const options = acquisitionSessionCookieOptions(isProduction);
      assert.equal(options.httpOnly, true);
      assert.equal(options.sameSite, "lax");
      assert.equal(options.path, "/");
      assert.ok(options.maxAge > 0);
    }
  });

  it("is Secure in production and not in development", () => {
    // Not a preference: a Secure cookie is simply never stored over the
    // plain HTTP that `next dev` serves, which would break the funnel on
    // every developer machine while looking like a logic bug.
    assert.equal(acquisitionSessionCookieOptions(true).secure, true);
    assert.equal(acquisitionSessionCookieOptions(false).secure, false);
  });
});
