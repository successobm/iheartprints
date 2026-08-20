/**
 * Sprint A5.3: every customer-facing string the checkout boundary can
 * produce — which is exactly one.
 *
 * ONE SENTENCE FOR EVERY REFUSAL, deliberately.
 *
 * `createCheckout` can refuse for a dozen genuinely different internal
 * reasons: the project does not exist, its acquisition authority could not be
 * loaded, it is internal, it is legacy, no email has been captured, it is
 * already unlocked, nothing has been designed yet, a revision is pending, the
 * customer has asked for an artifact V1 does not produce, no price is
 * configured, no provider is configured, the provider call failed. Every one
 * of them returns this string.
 *
 * That is not laziness about copy. Distinguishable refusals are an oracle: an
 * attacker holding a guessed project id could otherwise enumerate which
 * projects exist, which are already paid for, and which are internal, purely
 * by reading error text. The same reasoning that gives
 * `ACQUISITION_UNAVAILABLE_MESSAGE` one uniform sentence applies here with
 * more force, because the answers are now about money.
 *
 * It is also honest for the ordinary case. Almost every real refusal in this
 * slice is "this deployment cannot take payments yet", and none of the others
 * is something the customer did wrong.
 *
 * The internal reason is logged server-side (`CheckoutRefusalReason`) so an
 * operator can always tell the cases apart — the information is preserved,
 * just not published.
 *
 * Deliberately says nothing about price, availability dates, or what unlocking
 * would include. A5.3 has no customer payment UI and no approved offer copy;
 * writing "unlock this design for $X" here would be shipping a commercial
 * promise through an error string.
 */

export const CHECKOUT_UNAVAILABLE_MESSAGE =
  "We can't set up a payment for this design right now.";

/**
 * Sprint A5.5 — THE OFFER, in the customer's words.
 *
 * WHAT IS BEING SOLD, stated the way the product actually works: permission
 * for THIS design to go through production preparation. Not a file, not
 * credits, not a subscription, and not "unlimited" anything.
 *
 * Every claim here is one V1 can keep today. Deliberately absent, because
 * none of them is true: unlimited revisions, more concepts, vector or
 * embroidery output, printing or fulfilment, and any suggestion of
 * commercial or IP clearance (Constitution §17.1 — the product never states
 * or implies artwork is licensed, cleared, or owned).
 *
 * Also deliberately absent: the word "PNG". The deliverable V1 produces
 * happens to be a validated production PNG, but that is a fact about the
 * current pipeline, not about what the customer bought — and naming the file
 * format is exactly the framing that would make a later embroidery or vector
 * profile look like a different product rather than the same purchase.
 */
export const PRODUCTION_UNLOCK_OFFER_TITLE = "Unlock this design for production";

export const PRODUCTION_UNLOCK_OFFER_DESCRIPTION =
  "You've chosen your design. Unlock it to prepare the production-ready artwork and download the finished file.";

/** The action itself. A verb about the design, never "Buy". */
export const PRODUCTION_UNLOCK_ACTION_LABEL = "Unlock This Design";

/**
 * Shown while a payment we may or may not have received is being confirmed.
 *
 * Says only what is true: we are checking. It never claims payment succeeded
 * — the browser arriving back from a payment page is not evidence of that,
 * and only a verified webhook can be.
 */
export const PAYMENT_CONFIRMING_MESSAGE = "Confirming your payment…";

/**
 * Shown when confirmation has not arrived within the bounded polling window.
 *
 * DELIBERATELY DOES NOT INVITE ANOTHER PAYMENT. A transaction may well be
 * `created` or already `paid` at this moment, and telling somebody to try
 * again is how a customer ends up charged twice for one unlock. It asks them
 * to wait and reload, which is the only safe instruction while the outcome is
 * genuinely unknown.
 */
export const PAYMENT_CONFIRMATION_TIMEOUT_MESSAGE =
  "Payment is still being confirmed. You can refresh this page shortly.";

/**
 * Shown once an active `ProductionUnlock` exists. The one place the product
 * says "unlocked", and it is rendered only from that entitlement record.
 */
export const PRODUCTION_UNLOCKED_MESSAGE =
  "Your design is unlocked for production.";

/**
 * Shown when this deployment is not currently able to sell — no price
 * configured, no provider, or unresolvable authority.
 *
 * Neutral and uninformative, for the same reason `CHECKOUT_UNAVAILABLE_MESSAGE`
 * is: it must not reveal whether the cause is configuration, this project's
 * state, or something else. Never mentions a provider, a variable, or a
 * setting.
 */
export const PRODUCTION_UNLOCK_UNAVAILABLE_MESSAGE =
  "Production unlock is temporarily unavailable.";

/**
 * Shown when creating a checkout failed before the customer reached a payment
 * page.
 *
 * Says nothing happened, because nothing did — and in particular does NOT say
 * "payment failed", which would be a lie about an attempt that never started
 * and would frighten somebody whose card was never touched.
 */
export const CHECKOUT_START_FAILED_MESSAGE =
  "We couldn't start the payment just now. Please try again.";
