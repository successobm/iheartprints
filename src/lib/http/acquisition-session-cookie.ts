/**
 * Sprint A4: the acquisition session cookie — reading it off a request and
 * describing how it should be written back.
 *
 * Pure and framework-free on purpose. The parse function takes a raw
 * `Cookie` header string and the attribute builder returns a plain options
 * object, so both are directly unit-testable without constructing a Next.js
 * request or response. Routes do the actual `response.cookies.set(...)`.
 *
 * WHAT IS IN THIS COOKIE
 *
 * One opaque, server-issued token and nothing else. No project id, no
 * email, no entitlement state, no counter, no signature over customer data.
 * Everything the token means lives in `acquisition_sessions`, server-side,
 * which is what makes the value useless to forge: an attacker who invents a
 * token simply gets "no session found", and one who steals a real token
 * gains someone else's free concept — not an escalation, and not something
 * a client-side counter would have prevented either.
 *
 * The cookie is also NOT the authorization input for any paid-value gate.
 * Those resolve authority from `print_projects.acquisition_session_id`
 * instead (see `PrintProject.acquisitionSessionId`), so clearing or
 * tampering with this cookie cannot grant a second free concept on a
 * project that already has one.
 */

/**
 * Short and unbranded. A cookie named `iheartprints_free_concept_used`
 * would advertise the mechanism to anybody reading their own dev tools and
 * invite exactly the tampering the server-side authority makes pointless.
 */
export const ACQUISITION_SESSION_COOKIE = "ihp_as";

/**
 * A year. Long because the cost of a customer losing their session is
 * losing their design work's continuity, and short enough to not be
 * effectively permanent.
 */
export const ACQUISITION_SESSION_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

export interface AcquisitionSessionCookieOptions {
  /** Never readable from JavaScript — it is a credential, not app state. */
  httpOnly: true;
  /**
   * HTTPS-only in production. Left off in local development because
   * `next dev` serves plain HTTP and a `Secure` cookie would simply never
   * be stored, silently breaking the funnel on every developer machine.
   */
  secure: boolean;
  /**
   * `lax`, not `strict`: the session must survive a customer following a
   * link back into their own design from email or a bookmark. Not `none` —
   * nothing embeds this app cross-site, and `none` would be a CSRF-surface
   * widening with no product benefit.
   */
  sameSite: "lax";
  path: "/";
  maxAge: number;
}

export function acquisitionSessionCookieOptions(
  isProduction: boolean = process.env.NODE_ENV === "production",
): AcquisitionSessionCookieOptions {
  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: "lax",
    path: "/",
    maxAge: ACQUISITION_SESSION_COOKIE_MAX_AGE_SECONDS,
  };
}

/**
 * Reads the acquisition session token from a raw `Cookie` header.
 *
 * Returns `null` for a missing header, a missing cookie, or an empty value
 * — all three mean the same thing to every caller ("this request carries no
 * session"), so they are deliberately not distinguished.
 */
export function readAcquisitionSessionToken(
  cookieHeader: string | null | undefined,
): string | null {
  if (!cookieHeader) return null;

  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    const name = part.slice(0, separator).trim();
    if (name !== ACQUISITION_SESSION_COOKIE) continue;
    const value = part.slice(separator + 1).trim();
    if (value.length === 0) return null;
    try {
      return decodeURIComponent(value) || null;
    } catch {
      // A malformed percent-encoding is not a session. Treated as absent
      // rather than thrown: a bad cookie must never 500 a customer request.
      return null;
    }
  }

  return null;
}

/** Convenience for route handlers, which hold a `Request`, not a header string. */
export function readAcquisitionSessionTokenFromRequest(
  request: Pick<Request, "headers">,
): string | null {
  return readAcquisitionSessionToken(request.headers.get("cookie"));
}
