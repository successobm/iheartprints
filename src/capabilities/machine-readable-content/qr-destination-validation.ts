/**
 * SIGNS QR DESTINATION RESOLUTION — customer-supplied destination
 * acceptance.
 *
 * A QR can technically encode arbitrary bytes. This first customer
 * recovery workflow deliberately accepts the SMALLEST product-safe scope
 * (Section K): ordinary web destinations and a few common non-web QR
 * conventions (`tel:`, `mailto:`, `sms:`) — not arbitrary binary/URI
 * payloads, and never an active-content scheme.
 *
 * This function performs SYNTAX validation only. It never fetches,
 * navigates to, resolves redirects for, or tests whether the destination
 * is reachable (Section K/X — "iHeartPrints does not guarantee the
 * external website works", only that the final QR decodes to the exact
 * confirmed text).
 */

/** Schemes explicitly forbidden regardless of anything else — active-content/local-resource schemes a QR should never be allowed to carry (Section X). */
const FORBIDDEN_SCHEMES = ["javascript:", "data:", "vbscript:", "file:"];

/** Schemes a bare `scheme:` prefix is allowed to use, beyond ordinary web links. */
const ALLOWED_NON_WEB_SCHEMES = ["tel:", "mailto:", "sms:"];

const MAX_DESTINATION_LENGTH = 500;

export interface QrDestinationValidationResult {
  ok: boolean;
  /** Customer-safe reason when `ok` is false — never internal jargon. */
  reason: string | null;
}

/**
 * `destination` is untrusted customer input, exactly as they typed it —
 * never trimmed/rewritten before this check (the caller decides normal
 * whitespace trimming; this function only judges what's left). Returns
 * `ok: true` for: an ordinary `http(s)://` URL, a bare domain/path with no
 * scheme (e.g. `get-hibachi.com/book` — extremely common on real signage;
 * the eventual QR simply encodes it as literal text, exactly as supplied),
 * or one of the allowed non-web schemes. Returns `ok: false` for anything
 * empty, oversized, or carrying a forbidden scheme.
 */
export function validateQrDestination(destination: string): QrDestinationValidationResult {
  const trimmed = destination.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: "Enter the link or destination this QR code should open." };
  }
  if (trimmed.length > MAX_DESTINATION_LENGTH) {
    return { ok: false, reason: "That destination is too long." };
  }

  const lower = trimmed.toLowerCase();
  for (const scheme of FORBIDDEN_SCHEMES) {
    if (lower.startsWith(scheme)) {
      return { ok: false, reason: "That destination isn't allowed. Enter a web link, phone number, or email address." };
    }
  }

  const schemeMatch = /^([a-z][a-z0-9+.-]*):/i.exec(trimmed);
  if (schemeMatch) {
    const scheme = `${schemeMatch[1].toLowerCase()}:`;
    const isWeb = scheme === "http:" || scheme === "https:";
    if (!isWeb && !ALLOWED_NON_WEB_SCHEMES.includes(scheme)) {
      return { ok: false, reason: "That destination isn't allowed. Enter a web link, phone number, or email address." };
    }
  }

  // No scheme at all — a bare domain/path ("get-hibachi.com/book") is
  // accepted as literal text, exactly as supplied (Section N: the exact
  // confirmed payload is authority; this function never prepends
  // "https://" or otherwise rewrites it).
  return { ok: true, reason: null };
}
