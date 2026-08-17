/**
 * Sprint A5.3: the provider-neutral payment boundary.
 *
 * Exactly the same shape as `FinalArtworkProvider` and
 * `ConceptGenerationProvider`, and for the same reason: an adapter owns 100%
 * of its provider's dialect internally, and nothing outside this file ever
 * learns which payment company exists.
 *
 * WHAT MAY NOT CROSS THIS BOUNDARY, in either direction:
 *
 *   inward   a request body, a cookie, a header, a customer-supplied amount,
 *            currency, price id, profile, project id, or session id. Every
 *            field below is resolved by `PaymentCapability` from durable
 *            server state and server-side configuration.
 *
 *   outward  Stripe types, session objects, event shapes, error codes, or
 *            raw provider responses. `ProductionUnlockCheckoutResult` is
 *            three strings, and `ProviderError` (reused from the concept/
 *            final-artwork providers) is the only failure vocabulary.
 *
 * DELIBERATELY NO WEBHOOK CONTRACT. Verifying and interpreting provider
 * events is A5.4's authority; adding a `verifyWebhook` method here now would
 * be an interface nothing implements against a security boundary nothing
 * enforces yet. The only forward-compatibility this slice owes A5.4 is that
 * the provider is handed our internal transaction id (below) so a verified
 * event can be traced back to a durable row.
 */

import type { ProductionProfile } from "@/lib/domain/types";

/**
 * A fully server-resolved purchase description. Every field's provenance is
 * stated because "where did this value come from" is the entire security
 * property of this slice.
 */
export interface ProductionUnlockCheckoutRequest {
  /**
   * Our own durable `PaymentTransaction.id`, and the reason that row must
   * exist before this call happens.
   *
   * Serves two purposes at once:
   *   - the provider IDEMPOTENCY KEY. Replaying a failed or crashed attempt
   *     with the same key returns the SAME checkout session rather than
   *     creating a second one, which is what makes the
   *     Stripe-and-Postgres-are-not-atomic window survivable.
   *   - the METADATA HANDLE a later verified webhook (A5.4) reconciles
   *     through — one opaque internal id rather than a scattering of
   *     duplicated authority values.
   */
  paymentTransactionId: string;
  /** Resolved from the route path, then re-resolved against durable state. */
  projectId: string;
  /** Server-resolved. V1 has exactly one, and it is never customer-chosen. */
  productionProfile: ProductionProfile;
  /** From server configuration. Positive integer, minor units. */
  amountMinor: number;
  /** From server configuration. Lowercase ISO 4217. */
  currency: string;
  /**
   * Optional provider-side Price object id. When `null` the adapter builds
   * the line item from `amountMinor`/`currency`, keeping one source of truth.
   */
  providerPriceId: string | null;
  /**
   * The buyer's address, read from the acquisition session the PROJECT is
   * bound to. Sent straight to the provider and never returned to a browser —
   * there is no round trip in which a client could substitute one.
   */
  customerEmail: string | null;
  /**
   * Built from server configuration, never from a request header. A redirect
   * target derived from an attacker-controlled `Host`/`Origin` would be an
   * open redirect with a payment page in front of it.
   *
   * Neither URL carries a trusted payment claim — see
   * `buildCheckoutReturnUrls`.
   */
  successUrl: string;
  cancelUrl: string;
}

/**
 * Only what `PaymentCapability` needs to persist and to answer the request.
 * Deliberately not "the provider's session object".
 */
export interface ProductionUnlockCheckoutResult {
  /** Must equal the adapter's own `providerKey`. */
  providerKey: string;
  /** Reconciliation handle. Never authority. */
  providerCheckoutSessionId: string;
  /** Where to send the customer. Provider-issued, short-lived, not a secret. */
  checkoutUrl: string;
  /**
   * Usually `null` at creation — most providers do not create a payment
   * intent until the customer actually pays. Its absence is normal, not a
   * partial result.
   */
  providerPaymentIntentId: string | null;
}

export interface PaymentProvider {
  /** Must match a `PaymentProviderKey` the domain vocabulary recognizes. */
  readonly providerKey: string;
  /**
   * Creates (or, on replay of the same `paymentTransactionId`, returns) one
   * checkout session.
   *
   * MUST throw `ProviderError` and nothing else. The `dispatch` state on that
   * error is load-bearing: `"not_dispatched"` frees the outstanding-attempt
   * slot, anything else leaves the attempt resumable, because a session that
   * may really exist must never be raced by a second one.
   */
  createProductionUnlockCheckout(
    request: ProductionUnlockCheckoutRequest,
  ): Promise<ProductionUnlockCheckoutResult>;
}
