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
