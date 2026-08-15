/**
 * Sprint A4: pragmatic email normalization and validation for the
 * acquisition gate. Pure, synchronous, no I/O, no network.
 *
 * WHAT THIS IS FOR, precisely
 *
 * The customer is giving us an address so they can keep working on their
 * design. That is the entire contract. This module therefore rejects only
 * what is obviously not an email address — an empty box, a missing `@`, a
 * domain with no dot, something absurdly long. It deliberately does NOT:
 *
 *   - send a verification message
 *   - issue a one-time code
 *   - create an account or a password
 *   - check MX records, disposable-domain lists, or deliverability
 *   - imply marketing consent of any kind
 *
 * Anything stricter would reject real addresses (RFC 5322 permits far more
 * than any practical regex accepts) and would turn a one-field continuation
 * prompt into a sign-up flow, which is not what this gate is.
 */

/**
 * The maximum length of an email address, from RFC 5321: 64-octet local
 * part + "@" + 255-octet domain. Bounded here so an oversized value is
 * refused before it ever reaches persistence.
 */
export const MAX_EMAIL_LENGTH = 320;

/**
 * Deliberately loose: one or more non-space, non-`@` characters, an `@`, a
 * domain with at least one dot and no spaces. This is the standard
 * "pragmatic" shape, chosen because the alternative — a long RFC-shaped
 * pattern — reads as authoritative while still being wrong at the edges,
 * and the cost of a false rejection here is a customer who cannot continue.
 */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type EmailValidationFailure =
  | "empty"
  | "too_long"
  | "invalid_format";

export type EmailValidationResult =
  | { valid: true; email: string }
  | { valid: false; reason: EmailValidationFailure; message: string };

/**
 * Normalizes the WHOLE address to lowercase, not just the domain.
 *
 * The local part is technically case-sensitive per RFC 5321, so this is a
 * deliberate, stated simplification: every mail provider iHeartPrints will
 * plausibly encounter treats it case-insensitively, and normalizing the
 * whole string is what makes "Eric@Example.com" and "eric@example.com" the
 * same prospect rather than two — which is exactly the property duplicate
 * submission needs (Goal 21 V).
 */
export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * Validates a raw, customer-typed address and returns the normalized form.
 *
 * Failure messages are customer-safe by construction: they describe the
 * input, never the validator, never a field name, never a reason code.
 */
export function validateEmail(raw: unknown): EmailValidationResult {
  if (typeof raw !== "string") {
    return {
      valid: false,
      reason: "empty",
      message: "Enter your email address to continue.",
    };
  }

  const normalized = normalizeEmail(raw);

  if (normalized.length === 0) {
    return {
      valid: false,
      reason: "empty",
      message: "Enter your email address to continue.",
    };
  }
  if (normalized.length > MAX_EMAIL_LENGTH) {
    return {
      valid: false,
      reason: "too_long",
      message: "That email address is too long.",
    };
  }
  if (!EMAIL_PATTERN.test(normalized)) {
    return {
      valid: false,
      reason: "invalid_format",
      message: "That doesn't look like an email address.",
    };
  }

  return { valid: true, email: normalized };
}
