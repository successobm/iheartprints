/**
 * Sprint A5.4: Stripe webhook signature verification.
 *
 * WHY THIS IS HAND-WRITTEN RATHER THAN `stripe.webhooks.constructEvent`
 *
 * The sprint brief explicitly permits adding the official SDK if it would
 * MATERIALLY reduce security risk. It would not, and the judgement is worth
 * recording rather than assumed:
 *
 *   The algorithm is small, fully specified, and has no cryptographic
 *   subtlety: split the `Stripe-Signature` header, HMAC-SHA256 the string
 *   `"{timestamp}.{rawBody}"` with the endpoint's signing secret, compare
 *   against each `v1=` value in constant time, and enforce a timestamp
 *   tolerance. There is no key exchange, no algorithm negotiation, no
 *   certificate chain, and no state.
 *
 *   The four ways an implementation of it actually goes wrong are all
 *   testable from the outside, and every one is covered by
 *   `stripe-webhook-signature.test.ts`: a non-constant-time comparison, a
 *   missing or unenforced tolerance, mishandling a header carrying several
 *   `v1` values, and verifying a re-serialized body instead of the raw bytes.
 *   Vendoring an SDK does not make those tests unnecessary — it makes them
 *   harder to write.
 *
 *   Against that: `stripe` is a large dependency in the highest-trust path in
 *   this repository, whose nine-package dependency list is itself a security
 *   property. A5.3 declined it for the checkout adapter for the same reason,
 *   and splitting the decision — SDK for one half of the same provider
 *   boundary, raw HTTP for the other — would be the worst of both.
 *
 * This module is PURE: no I/O, no clock of its own (the caller injects
 * `nowSeconds`), no logging, no persistence. It answers one question and
 * returns the raw verified bytes; interpreting them is somebody else's job.
 *
 * NOTHING AUTHORITATIVE MAY HAPPEN BEFORE THIS RETURNS `verified: true`. The
 * route does not parse the body, does not touch a repository, and does not
 * name a transaction until then.
 */

import { createHmac, timingSafeEqual } from "crypto";

/** Stripe's header name. Case-insensitive on the wire; normalized by callers. */
export const STRIPE_SIGNATURE_HEADER = "stripe-signature";

/**
 * Stripe's own documented default. Five minutes bounds replay of a captured
 * request: an attacker who records a valid delivery cannot re-send it a day
 * later, because the signed timestamp is inside the MAC and cannot be moved
 * without the secret.
 */
export const DEFAULT_SIGNATURE_TOLERANCE_SECONDS = 300;

/**
 * Every distinct way verification can fail. INTERNAL — a webhook caller
 * receives a bare 400 and learns nothing, because an attacker probing an
 * endpoint must not be told which part of their forgery was wrong.
 */
export type SignatureFailureReason =
  | "missing_header"
  | "malformed_header"
  | "missing_timestamp"
  | "missing_v1_signature"
  | "timestamp_out_of_tolerance"
  | "no_matching_signature"
  | "secret_not_configured";

export type WebhookSignatureResult =
  | { verified: true; payload: string; timestampSeconds: number }
  | { verified: false; reason: SignatureFailureReason };

export interface VerifyWebhookSignatureInput {
  /**
   * THE EXACT RAW BODY BYTES, as received.
   *
   * Never a parsed-and-re-serialized object. `JSON.parse` followed by
   * `JSON.stringify` reorders nothing in practice but changes whitespace,
   * unicode escaping, and number formatting — and the MAC covers bytes, not
   * meaning. A verifier handed re-serialized JSON either rejects every
   * legitimate event or, far worse, gets "fixed" later by someone loosening
   * it.
   */
  rawBody: string;
  /** The `Stripe-Signature` header value, verbatim. */
  signatureHeader: string | null | undefined;
  /** The endpoint's signing secret. */
  secret: string;
  /** Injected so tolerance is testable without faking a global clock. */
  nowSeconds: number;
  toleranceSeconds?: number;
}

/**
 * Verifies a Stripe webhook signature against the raw request body.
 *
 * The header looks like:
 *
 *     t=1699999999,v1=abc…,v1=def…,v0=ignored
 *
 * `v1` may appear MORE THAN ONCE — Stripe sends one per active endpoint
 * secret during a secret rotation. Accepting the request when ANY `v1`
 * matches is what makes rotation possible without downtime; checking only the
 * first would break the moment an operator rotates, which is exactly when a
 * silent verification failure is most damaging. `v0` is a different scheme and
 * is ignored entirely rather than tried as a fallback.
 */
export function verifyStripeWebhookSignature(
  input: VerifyWebhookSignatureInput,
): WebhookSignatureResult {
  if (!input.secret) return { verified: false, reason: "secret_not_configured" };

  const header = input.signatureHeader?.trim();
  if (!header) return { verified: false, reason: "missing_header" };

  const parsed = parseSignatureHeader(header);
  if (!parsed) return { verified: false, reason: "malformed_header" };
  if (parsed.timestamp === null) {
    return { verified: false, reason: "missing_timestamp" };
  }
  if (parsed.v1Signatures.length === 0) {
    return { verified: false, reason: "missing_v1_signature" };
  }

  // TOLERANCE IS CHECKED BEFORE THE MAC, deliberately. A stale-but-genuinely-
  // signed replay is refused on age alone, so a captured delivery cannot be
  // re-sent later. Symmetric on purpose: a timestamp far in the FUTURE is just
  // as wrong as one far in the past, and accepting it would let an attacker
  // holding a leaked secret mint a signature that stays valid as long as they
  // chose.
  const tolerance = input.toleranceSeconds ?? DEFAULT_SIGNATURE_TOLERANCE_SECONDS;
  if (Math.abs(input.nowSeconds - parsed.timestamp) > tolerance) {
    return { verified: false, reason: "timestamp_out_of_tolerance" };
  }

  // The signed material is "{timestamp}.{rawBody}" — the timestamp is INSIDE
  // the MAC, which is what stops an attacker from taking a valid old body and
  // simply stamping a fresh `t=` on it.
  const expected = createHmac("sha256", input.secret)
    .update(`${parsed.timestamp}.${input.rawBody}`, "utf8")
    .digest();

  for (const candidate of parsed.v1Signatures) {
    if (constantTimeMatches(expected, candidate)) {
      return {
        verified: true,
        payload: input.rawBody,
        timestampSeconds: parsed.timestamp,
      };
    }
  }

  return { verified: false, reason: "no_matching_signature" };
}

interface ParsedSignatureHeader {
  timestamp: number | null;
  v1Signatures: string[];
}

/**
 * Returns `null` only for a header with no parseable `key=value` pair at all.
 * A header carrying unknown schemes alongside valid ones parses fine — Stripe
 * adds new ones over time, and a verifier that rejected unrecognized
 * companions would break on their schedule rather than ours.
 */
function parseSignatureHeader(header: string): ParsedSignatureHeader | null {
  let timestamp: number | null = null;
  const v1Signatures: string[] = [];
  let sawPair = false;

  for (const part of header.split(",")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    sawPair = true;

    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();

    if (key === "t") {
      // Digits only. `Number(" 12 ")` is 12 and `Number("1e9")` is a billion;
      // neither is a timestamp Stripe would send, and accepting exotic
      // spellings only widens what an attacker may put here.
      if (/^\d+$/.test(value)) timestamp = Number(value);
      continue;
    }
    if (key === "v1" && value.length > 0) {
      v1Signatures.push(value);
    }
  }

  if (!sawPair) return null;
  return { timestamp, v1Signatures };
}

/**
 * Constant-time comparison of the expected MAC against a hex candidate.
 *
 * `timingSafeEqual` throws on a length mismatch — which would itself leak the
 * length — so the candidate is checked for shape first. A malformed candidate
 * returns `false` without ever reaching the comparison, and every well-formed
 * one takes the same path.
 *
 * `Buffer.from(hex, "hex")` silently truncates at the first invalid character,
 * so the explicit hex-charset test is load-bearing: without it, a candidate of
 * the right length made of non-hex characters would decode to a short buffer
 * and never reach a real comparison at all.
 */
function constantTimeMatches(expected: Buffer, candidateHex: string): boolean {
  if (candidateHex.length !== expected.length * 2) return false;
  if (!/^[0-9a-fA-F]+$/.test(candidateHex)) return false;

  const candidate = Buffer.from(candidateHex, "hex");
  if (candidate.length !== expected.length) return false;

  return timingSafeEqual(expected, candidate);
}

/**
 * Builds a `Stripe-Signature` header for a payload. TEST SUPPORT ONLY, and
 * exported here rather than duplicated in a test file so the fixtures a test
 * signs are produced by the same understanding of the format the verifier
 * has — a test that signs with its own private helper can pass while both
 * halves are wrong together.
 *
 * Never called by production code.
 */
export function buildStripeSignatureHeader(input: {
  rawBody: string;
  secret: string;
  timestampSeconds: number;
  /** Extra `v1` values placed BEFORE the real one, for rotation tests. */
  additionalV1Signatures?: string[];
}): string {
  const signature = createHmac("sha256", input.secret)
    .update(`${input.timestampSeconds}.${input.rawBody}`, "utf8")
    .digest("hex");

  const parts = [`t=${input.timestampSeconds}`];
  for (const extra of input.additionalV1Signatures ?? []) {
    parts.push(`v1=${extra}`);
  }
  parts.push(`v1=${signature}`);
  return parts.join(",");
}
