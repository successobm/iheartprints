import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";

import {
  buildStripeSignatureHeader,
  DEFAULT_SIGNATURE_TOLERANCE_SECONDS,
  verifyStripeWebhookSignature,
} from "./stripe-webhook-signature";

/**
 * Sprint A5.4 — THE SIGNATURE MATRIX.
 *
 * This is the security boundary of the whole sprint: everything downstream
 * assumes "the provider really said this", and this file is the only thing
 * that establishes it. The tests are written as an attacker would probe it —
 * each one is a forgery that must fail, plus the legitimate cases that must
 * not be broken by the refusals.
 *
 * No network, no clock: `nowSeconds` is injected, so tolerance is exercised
 * deterministically rather than by sleeping.
 */

const SECRET = "whsec_test_0123456789abcdefghij";
const NOW = 1_700_000_000;
const BODY = JSON.stringify({ id: "evt_1", type: "checkout.session.completed" });

function signedHeader(overrides: {
  body?: string;
  secret?: string;
  timestamp?: number;
  additionalV1Signatures?: string[];
} = {}): string {
  return buildStripeSignatureHeader({
    rawBody: overrides.body ?? BODY,
    secret: overrides.secret ?? SECRET,
    timestampSeconds: overrides.timestamp ?? NOW,
    additionalV1Signatures: overrides.additionalV1Signatures,
  });
}

/**
 * `header` omitted means "sign it correctly"; `header` present means "use
 * exactly this, including `undefined`".
 *
 * The distinction matters: an earlier version of this helper collapsed a
 * deliberately-`undefined` header into a freshly signed one, so the
 * missing-header test was silently asserting against a VALID signature and
 * would have passed even if absent headers were accepted.
 */
function verify(input: {
  body?: string;
  header?: string | null;
  secret?: string;
  now?: number;
}) {
  return verifyStripeWebhookSignature({
    rawBody: input.body ?? BODY,
    signatureHeader: "header" in input ? input.header : signedHeader(),
    secret: input.secret ?? SECRET,
    nowSeconds: input.now ?? NOW,
  });
}

describe("Sprint A5.4 — Stripe webhook signature verification", () => {
  /* ================================================================== */
  /* The legitimate cases                                                */
  /* ================================================================== */

  it("A: accepts a correctly signed payload and returns the RAW bytes untouched", () => {
    const result = verify({});
    assert.equal(result.verified, true);
    if (!result.verified) return;
    // The verifier must hand back exactly what it verified. Anything else and
    // the thing that was checked is not the thing that gets parsed.
    assert.equal(result.payload, BODY);
    assert.equal(result.timestampSeconds, NOW);
  });

  it("B: accepts at the exact tolerance boundary, in both directions", () => {
    for (const skew of [
      -DEFAULT_SIGNATURE_TOLERANCE_SECONDS,
      DEFAULT_SIGNATURE_TOLERANCE_SECONDS,
    ]) {
      const stamped = NOW + skew;
      const result = verify({ header: signedHeader({ timestamp: stamped }) });
      assert.equal(
        result.verified,
        true,
        `a signature exactly ${skew}s away must still verify`,
      );
    }
  });

  /* ================================================================== */
  /* GOAL 25 — the bad-signature matrix                                  */
  /* ================================================================== */

  it("C: refuses a MISSING signature header", () => {
    for (const header of [null, undefined, "", "   "]) {
      const result = verify({ header: header as string | null });
      assert.equal(result.verified, false);
    }
  });

  it("D: refuses a MALFORMED header", () => {
    const cases: Array<[string, string]> = [
      ["garbage", "no key=value pair at all"],
      ["v1=abc", "no timestamp"],
      [`t=${NOW}`, "no v1 signature"],
      ["t=,v1=", "empty values"],
      [`t=not-a-number,v1=${"a".repeat(64)}`, "non-numeric timestamp"],
      [`t= ${NOW} ,v1=${"a".repeat(64)}`, "padded timestamp is not a timestamp"],
      [`t=1e9,v1=${"a".repeat(64)}`, "exponent notation is not a timestamp"],
    ];
    for (const [header, why] of cases) {
      assert.equal(verify({ header }).verified, false, `must refuse: ${why}`);
    }
  });

  it("E: refuses a signature made with the WRONG secret", () => {
    const forged = signedHeader({ secret: "whsec_test_attackers_own_secret_xx" });
    assert.equal(verify({ header: forged }).verified, false);
  });

  it("F: refuses a STALE signature beyond tolerance — a captured delivery cannot be replayed later", () => {
    const stale = signedHeader({
      timestamp: NOW - DEFAULT_SIGNATURE_TOLERANCE_SECONDS - 1,
    });
    const result = verify({ header: stale });
    assert.equal(result.verified, false);
    assert.equal(
      result.verified === false && result.reason,
      "timestamp_out_of_tolerance",
    );
  });

  it("G: refuses a FUTURE signature beyond tolerance", () => {
    // Symmetric on purpose: without this, somebody holding a leaked secret
    // could mint a signature that stays valid for as long as they chose.
    const future = signedHeader({
      timestamp: NOW + DEFAULT_SIGNATURE_TOLERANCE_SECONDS + 1,
    });
    assert.equal(verify({ header: future }).verified, false);
  });

  it("H: refuses a body MUTATED after signing", () => {
    const header = signedHeader({ body: BODY });
    const mutated = JSON.stringify({
      id: "evt_1",
      type: "checkout.session.completed",
      injected: true,
    });
    assert.equal(verify({ body: mutated, header }).verified, false);
  });

  it("H2: refuses a body that was merely RE-SERIALIZED — the MAC covers bytes, not meaning", () => {
    // This is the failure a "parse then verify" implementation would have.
    // Same JSON semantically; different bytes.
    const original = '{"id":"evt_1","amount_total":4900}';
    const header = signedHeader({ body: original });
    const reserialized = JSON.stringify(JSON.parse(original), null, 2);

    assert.notEqual(reserialized, original);
    assert.deepEqual(JSON.parse(reserialized), JSON.parse(original));
    assert.equal(verify({ body: reserialized, header }).verified, false);
    // …and the untouched bytes still verify, so the refusal is about the
    // mutation rather than a broken verifier.
    assert.equal(verify({ body: original, header }).verified, true);
  });

  it("I: accepts when ONE of several v1 signatures matches — secret rotation must not break delivery", () => {
    const header = signedHeader({
      additionalV1Signatures: ["b".repeat(64), "c".repeat(64)],
    });
    assert.equal(verify({ header }).verified, true);
  });

  it("J: refuses when NONE of several v1 signatures matches", () => {
    const header = [
      `t=${NOW}`,
      `v1=${"a".repeat(64)}`,
      `v1=${"b".repeat(64)}`,
      `v1=${"c".repeat(64)}`,
    ].join(",");
    const result = verify({ header });
    assert.equal(result.verified, false);
    assert.equal(
      result.verified === false && result.reason,
      "no_matching_signature",
    );
  });

  it("K: ignores unknown schemes rather than treating them as a fallback", () => {
    const real = createHmac("sha256", SECRET)
      .update(`${NOW}.${BODY}`, "utf8")
      .digest("hex");

    // `v0` is a different scheme and must never be tried. A header carrying a
    // valid v0 and no valid v1 is a refusal.
    assert.equal(verify({ header: `t=${NOW},v0=${real}` }).verified, false);
    // But a v0 sitting alongside a good v1 must not break the good one —
    // Stripe adds schemes on its own schedule, not ours.
    assert.equal(
      verify({ header: `t=${NOW},v0=whatever,v1=${real}` }).verified,
      true,
    );
  });

  it("L: refuses a candidate signature of the wrong shape without ever comparing", () => {
    // `Buffer.from(hex, "hex")` truncates silently at the first invalid
    // character, so a right-length non-hex candidate would decode short. The
    // explicit charset check is what stops that becoming a comparison against
    // a truncated buffer.
    for (const candidate of [
      "z".repeat(64),
      "a".repeat(63),
      "a".repeat(65),
      "",
      "0x" + "a".repeat(62),
    ]) {
      assert.equal(
        verify({ header: `t=${NOW},v1=${candidate}` }).verified,
        false,
        `candidate "${candidate.slice(0, 8)}…" must be refused`,
      );
    }
  });

  it("M: refuses when no secret is configured, whatever the header says", () => {
    const result = verifyStripeWebhookSignature({
      rawBody: BODY,
      signatureHeader: signedHeader(),
      secret: "",
      nowSeconds: NOW,
    });
    assert.equal(result.verified, false);
    assert.equal(
      result.verified === false && result.reason,
      "secret_not_configured",
    );
  });

  it("N: the timestamp is inside the MAC — restamping a captured body does not revive it", () => {
    // The attack this defends against: capture a valid old delivery, notice
    // it is refused as stale, and simply edit `t=` to now.
    const captured = signedHeader({ timestamp: NOW - 10_000 });
    const signature = captured.split("v1=")[1]!;
    const restamped = `t=${NOW},v1=${signature}`;

    assert.equal(verify({ header: restamped, now: NOW }).verified, false);
  });
});
