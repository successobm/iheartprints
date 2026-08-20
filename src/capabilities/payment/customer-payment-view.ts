/**
 * Sprint A5.5: THE ONE CUSTOMER-FACING COMMERCIAL AUTHORITY.
 *
 * Every payment-related thing a customer can see — whether an offer appears,
 * what it costs, whether a confirmation spinner shows, whether the
 * finalization action is reachable — resolves from the single view this
 * module defines. No component derives payment state of its own.
 *
 * WHY THAT RULE IS WRITTEN DOWN RATHER THAN ASSUMED
 *
 * Sprint A4 Corrections C and C2 both fixed the same shape of bug: one rule
 * ("has the free concept been delivered?") had grown two slightly different
 * consumers, so the concept card and the chat transcript disagreed about the
 * customer's own state. Commercial state is a strictly worse place for that
 * to happen — the two answers would be "you owe us money" and "you don't".
 *
 * So `PaymentCapability` derives ONE `CustomerPaymentView` from durable
 * server authority, and `resolveProductionUnlockSurface` below is the ONE
 * function that turns it into something to render.
 *
 * This module is PURE — no repository, no I/O, no React. The client imports
 * it directly, which is what makes "the client does not decide" checkable
 * rather than aspirational.
 */

/**
 * What the SERVER can establish about this project's commercial state, from
 * durable records alone.
 *
 *   "not_applicable"      — there is nothing commercial to show. No email
 *                           captured yet, an internal or legacy project,
 *                           nothing designed to buy, a pending revision, or
 *                           a requested output V1 does not produce. The UI
 *                           shows no payment surface at all.
 *   "payment_required"    — this project is eligible for a production
 *                           unlock and does not have one.
 *   "production_unlocked" — an ACTIVE `ProductionUnlock` exists. The ONLY
 *                           value that means paid, and it comes from the
 *                           entitlement record rather than from any payment
 *                           record, redirect, or client flag.
 *   "unavailable"         — the project would be eligible, but this
 *                           deployment cannot currently sell (no price, no
 *                           provider, unresolvable authority). A neutral
 *                           state, never a checkout button that is certain
 *                           to fail.
 *
 * Deliberately NOT a mirror of `PaymentTransaction.status`. A transaction is
 * an attempt; this is what the customer is entitled to.
 */
export type CustomerPaymentState =
  | "not_applicable"
  | "payment_required"
  | "production_unlocked"
  | "unavailable";

/**
 * The safe, renderable description of what is for sale.
 *
 * `displayAmount` is formatted SERVER-SIDE and is the only monetary value
 * that crosses the boundary. The raw minor-unit amount and the currency code
 * are deliberately absent: a client that received them would inevitably
 * format them, and a second formatter is a second source of truth about what
 * something costs. Price authority stays where A5.3 put it.
 *
 * Never carries a provider price id, a session id, a transaction id, or any
 * configuration detail.
 */
export interface CustomerOfferView {
  /** The semantic offer. Never "Buy PNG". */
  title: string;
  /** One sentence about what unlocking actually does. */
  description: string;
  /** Server-formatted, e.g. "$49.00". */
  displayAmount: string;
}

export interface CustomerPaymentView {
  state: CustomerPaymentState;
  /** Present only for `"payment_required"`. */
  offer: CustomerOfferView | null;
  /**
   * An outstanding checkout attempt exists for this project (the customer
   * has been sent to a payment page and it has neither completed nor
   * lapsed).
   *
   * NOT "processing", and emphatically not "paid". It is durable evidence
   * that a payment page was opened, which is a different fact from whether
   * anybody paid — a customer who opened checkout and closed the tab leaves
   * exactly this state behind. It exists so the UI can tell the difference
   * between "come back and pay" and "we are waiting to hear about a payment
   * you just made", and it is only ever combined with a navigation hint (see
   * `resolveProductionUnlockSurface`), never read as an entitlement.
   */
  checkoutPending: boolean;
}

/** The surface the UI should render. One of these, ever. */
export type ProductionUnlockSurface =
  | "none"
  | "payment_required"
  | "payment_processing"
  | "production_unlocked"
  | "unavailable";

export interface ProductionUnlockSurfaceInput {
  payment: CustomerPaymentView;
  /**
   * The customer's browser arrived carrying `?checkout=complete`.
   *
   * NAVIGATION CONTEXT, NEVER AUTHORITY. Anybody can type that URL, bookmark
   * it, or reach it with the browser's Forward button after abandoning
   * payment. It is allowed to influence exactly one thing: whether an
   * unpaid-but-attempted project shows "come back and pay" or "we're
   * confirming your payment". Both of those grant nothing.
   *
   * The function below is written so that this input CANNOT produce
   * `"production_unlocked"` — that value has a single source, and it is the
   * server's `payment.state`.
   */
  returnedFromCheckout: boolean;
}

/**
 * THE ONE PLACE a payment view becomes something to render.
 *
 * Read the `production_unlocked` branch first: it depends on
 * `payment.state` and nothing else. `returnedFromCheckout` is not consulted
 * on that path at all, so no combination of query parameters, reloads, or
 * client state can reach it. That is the property `payment-ui-cannot-lie`
 * asserts by exhausting every input combination.
 */
export function resolveProductionUnlockSurface(
  input: ProductionUnlockSurfaceInput,
): ProductionUnlockSurface {
  // The entitlement. Server authority only.
  if (input.payment.state === "production_unlocked") return "production_unlocked";

  if (input.payment.state === "unavailable") return "unavailable";
  if (input.payment.state === "not_applicable") return "none";

  // `payment_required` — the customer may or may not have just paid, and the
  // server genuinely cannot tell yet. Only the provider knows, and only the
  // verified webhook will say. Showing the confirmation surface needs BOTH a
  // durable attempt AND the navigation hint: the hint alone would confirm a
  // payment nobody made, and the attempt alone would leave an abandoned
  // checkout spinning forever.
  if (input.returnedFromCheckout && input.payment.checkoutPending) {
    return "payment_processing";
  }

  return "payment_required";
}
