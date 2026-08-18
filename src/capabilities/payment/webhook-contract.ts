/**
 * Sprint A5.4: the provider-neutral shape of a VERIFIED payment notification.
 *
 * Everything above `PaymentProvider` sees only this. No Stripe event object,
 * no session object, no `payment_status` string, no nested `data.object`, and
 * no field name a payment company chose ever reaches the repository, the
 * domain model, `AcquisitionCapability`, `FinalArtworkCapability`, or the UI.
 *
 * WHAT IS DELIBERATELY ABSENT: the customer's email, billing details, card
 * metadata, provider customer/account ids, and the raw payload. The
 * reconciliation needs none of them — it compares provider-reported figures
 * against a durable row it already has — and carrying them further would put
 * payment PII into the application's domain layer and, from there, into logs.
 */

/**
 * WHAT THE PLATFORM SHOULD DO about a verified event, decided by the provider
 * adapter (which is the only thing that understands the provider's taxonomy)
 * and executed by the atomic authority.
 *
 * A closed vocabulary of three, not a mirror of the provider's event list:
 *
 *   "activate" — money has genuinely arrived for a checkout. The ONLY action
 *                that can produce an entitlement.
 *   "expire"   — a checkout session lapsed unused. Frees the outstanding
 *                attempt so the customer can start a new one. Never applied
 *                to a paid transaction.
 *   "ignore"   — validly signed, deliberately not acted on: an event type
 *                this build does not implement, or a completed checkout whose
 *                payment has NOT settled.
 */
export type WebhookAction = "activate" | "expire" | "ignore";

/**
 * A verified event, normalized.
 *
 * Every field is either the provider's identity for the event (needed for
 * idempotency and forensics) or a figure to be COMPARED against stored state.
 * Nothing here may establish a new fact: `projectId`, `acquisitionSessionId`,
 * and `productionProfile` are deliberately absent, because a webhook that
 * could supply them could unlock a different customer's project.
 */
export interface NormalizedPaymentEvent {
  /** The provider's own event id. The idempotency key. */
  providerEventId: string;
  /** The provider's event type, verbatim, recorded for forensics only. */
  eventType: string;
  action: WebhookAction;
  /**
   * OUR internal `PaymentTransaction.id`, read back out of the metadata this
   * platform put there at checkout creation.
   *
   * A HANDLE, never authority. It is used to LOOK UP a durable row, and every
   * fact about the purchase then comes from that row. `null` when the event
   * carries none — which is normal for event types this build ignores, and is
   * `"unmatched"` for ones it does not.
   */
  paymentTransactionId: string | null;
  /**
   * The provider's checkout session id. Cross-checked against the stored
   * transaction: trusting the metadata handle while ignoring this would mean
   * one mislabelled metadata value could pay off the wrong transaction.
   */
  providerCheckoutSessionId: string | null;
  /** Bound only after reconciliation succeeds; UNIQUE in the database. */
  providerPaymentIntentId: string | null;
  /** Compared EXACTLY against the stored amount. No conversion, no tolerance. */
  amountMinor: number | null;
  /** Compared EXACTLY against the stored currency. Lowercase ISO 4217. */
  currency: string | null;
}
