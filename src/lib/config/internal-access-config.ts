/**
 * Sprint A4 (Goal 16): the ONE authority that can grant a session the
 * internal entitlement — a server-side shared secret, compared in constant
 * time, and nothing else.
 *
 * WHY IT IS SHAPED THIS WAY
 *
 * iHeartPrints has to remain usable internally for real Print'em All work
 * and live acceptance testing after the acquisition gate exists, so a
 * bypass is genuinely required. Every cheap way of building one is wrong:
 *
 *   hardcoded email          an address is not a credential; it appears in
 *                            logs, screenshots, and support tickets, and
 *                            anyone who learns it holds the bypass forever.
 *   browser-local flag       client state can be set by the client. That is
 *                            the definition of not being a control.
 *   secret query string      lands in browser history, referrer headers,
 *                            server access logs, and shared links.
 *   NODE_ENV                 an environment is not an identity, and
 *                            "production must be gated, development must
 *                            not" is precisely the rule that makes the gate
 *                            untested until it reaches customers.
 *
 * What is left is a real secret, presented deliberately, once, to a
 * dedicated endpoint, recorded with an audit timestamp on the session it
 * grants. Production internal use is then an action somebody took, at a
 * time, that can be found afterwards.
 *
 * Deliberately UNSET by default and with NO development fallback (unlike
 * `WORKER_SECRET`, which has one). A well-known default value here would be
 * a published bypass for the entire acquisition funnel; if the variable is
 * absent the grant endpoint simply does not function, in every environment.
 */

import { createHash, timingSafeEqual } from "crypto";

export const INTERNAL_ACCESS_KEY_ENV = "IHEARTPRINTS_INTERNAL_ACCESS_KEY";

/**
 * The header the key is presented in. A header rather than a body field so
 * it is never accidentally logged as request content, and never a URL
 * component.
 */
export const INTERNAL_ACCESS_KEY_HEADER = "x-iheartprints-internal-key";

/**
 * A short floor, not a strength policy. It exists to refuse an obviously
 * accidental value (`"1"`, `"test"`) being configured as the key that
 * unlocks every paid path in the product.
 */
const MIN_INTERNAL_ACCESS_KEY_LENGTH = 24;

export type InternalAccessResult =
  | { authorized: true }
  | { authorized: false; reason: "not_configured" | "missing_key" | "invalid_key" };

function configuredKey(): string | null {
  const raw = process.env[INTERNAL_ACCESS_KEY_ENV]?.trim();
  if (!raw) return null;
  if (raw.length < MIN_INTERNAL_ACCESS_KEY_LENGTH) return null;
  return raw;
}

/** Whether the internal-access grant endpoint is available at all. */
export function isInternalAccessConfigured(): boolean {
  return configuredKey() !== null;
}

/**
 * Constant-time comparison via fixed-width digests — the same construction
 * `verifyWorkerSecret` uses, and for the same two reasons: `timingSafeEqual`
 * throws on length mismatch (which would itself leak length), and hashing
 * first makes every comparison the same size.
 *
 * Never logs, returns, or echoes either value.
 */
function keysMatch(expected: string, provided: string): boolean {
  const expectedDigest = createHash("sha256").update(expected, "utf8").digest();
  const providedDigest = createHash("sha256").update(provided, "utf8").digest();
  return timingSafeEqual(expectedDigest, providedDigest);
}

export function verifyInternalAccessKey(
  provided: string | null,
): InternalAccessResult {
  const expected = configuredKey();
  // Fails closed before looking at what the caller sent: an unconfigured
  // deployment has no internal entitlement to grant, in any environment.
  if (!expected) return { authorized: false, reason: "not_configured" };
  if (!provided) return { authorized: false, reason: "missing_key" };
  if (!keysMatch(expected, provided)) {
    return { authorized: false, reason: "invalid_key" };
  }
  return { authorized: true };
}
