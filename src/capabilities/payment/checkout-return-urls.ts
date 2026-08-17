/**
 * Sprint A5.3: where the provider sends the customer back to.
 *
 * THE ONE RULE THIS MODULE EXISTS TO ENFORCE: a redirect is navigation, not
 * authority.
 *
 * Stripe will happily interpolate its own `{CHECKOUT_SESSION_ID}` into a
 * success URL, and it is conventional to append something like `?paid=true`.
 * Neither appears here, and neither may be added later. A browser arriving at
 * a URL proves only that a browser arrived at a URL — anybody can type one,
 * bookmark one, or share one, and a customer who abandons payment can still
 * reach the success URL by pressing Back and then Forward. The only thing
 * that will ever activate a `ProductionUnlock` is a verified provider webhook
 * (A5.4).
 *
 * So the parameter is called `checkout` and its success value is `"complete"`
 * — meaning "you have come back from checkout", which is true — rather than
 * `"paid"`, which would be a claim this side of the system cannot make. No UI
 * reads it in this slice; it exists so a future surface can show "we're
 * confirming your payment…" while polling authoritative server state, and so
 * that a customer landing here without the parameter is indistinguishable
 * from one who navigated normally.
 *
 * The origin is server configuration (`IHEARTPRINTS_PUBLIC_BASE_URL`), never
 * a request's `Host`/`Origin` header. A redirect target derived from an
 * attacker-controlled header is an open redirect with a payment page in front
 * of it.
 */

/** Query parameter name. Deliberately neutral — a navigation hint, not a claim. */
export const CHECKOUT_RETURN_PARAM = "checkout";

/** "You came back from the payment page." Never "you paid". */
export const CHECKOUT_RETURN_COMPLETE = "complete";
export const CHECKOUT_RETURN_CANCELLED = "cancelled";

export interface CheckoutReturnUrls {
  successUrl: string;
  cancelUrl: string;
}

/**
 * Both URLs are a pure function of (base URL, project id), so replaying a
 * checkout attempt under the same provider idempotency key rebuilds a
 * byte-identical request — which is what lets the provider return the
 * original session instead of rejecting the replay as a conflicting body.
 */
export function buildCheckoutReturnUrls(
  publicBaseUrl: string,
  projectId: string,
): CheckoutReturnUrls {
  return {
    successUrl: buildReturnUrl(publicBaseUrl, projectId, CHECKOUT_RETURN_COMPLETE),
    cancelUrl: buildReturnUrl(publicBaseUrl, projectId, CHECKOUT_RETURN_CANCELLED),
  };
}

function buildReturnUrl(
  publicBaseUrl: string,
  projectId: string,
  outcome: string,
): string {
  const url = new URL(publicBaseUrl);
  url.searchParams.set("project", projectId);
  url.searchParams.set(CHECKOUT_RETURN_PARAM, outcome);
  return url.toString();
}
