/**
 * Sprint A5.4: the only place in this codebase that understands the shape of
 * a Stripe event.
 *
 * Turns verified raw JSON into a `NormalizedPaymentEvent`. Every Stripe field
 * name — `data.object`, `payment_status`, `amount_total`, `client_reference_id`
 * — appears here and nowhere else.
 *
 * DEFENSIVE BY CONSTRUCTION. The input is JSON that arrived over the network;
 * the signature proves it came from Stripe, not that it has the shape this
 * build expects. Every read is a typed narrowing that falls back to `null`, and
 * a shape that cannot be understood becomes an `"ignore"` — never a guess.
 */

import {
  KNOWN_PAYMENT_PROVIDERS,
  type PaymentProviderKey,
} from "@/lib/domain/types";

import { STRIPE_PAYMENT_TRANSACTION_METADATA_KEY } from "./stripe-checkout-provider";
import type { NormalizedPaymentEvent, WebhookAction } from "./webhook-contract";

export const STRIPE_PROVIDER_KEY: PaymentProviderKey = "stripe";

/**
 * THE MINIMUM V1 EVENT SET. Deliberately three, not Stripe's catalogue.
 *
 *   checkout.session.completed
 *     The customer finished checkout. NOT the same as "the money arrived" —
 *     see `readPaymentStatus` below, which is why this is the one event whose
 *     action depends on the payload rather than the type alone.
 *
 *   checkout.session.async_payment_succeeded
 *     A delayed payment method (bank debit, some wallets) settled after the
 *     session completed. This is the event that carries the money for those
 *     methods, and omitting it would leave a genuinely-paid customer locked
 *     out until somebody noticed.
 *
 *   checkout.session.expired
 *     The session lapsed unused. Frees the outstanding attempt so the
 *     customer can start a fresh checkout instead of being handed a dead URL.
 *
 * Everything else — `charge.*`, `payment_intent.*`, `invoice.*`, and the
 * hundred others Stripe can send — is IGNORED and acknowledged. Implementing
 * more would mean writing state machines for transitions this product has no
 * workflow behind.
 *
 * NOT IMPLEMENTED, EXPLICITLY: refunds and disputes (`charge.refunded`,
 * `charge.dispute.created`). See ARCHITECTURE.md §23e — the schema and the
 * revocation path are future-safe and tested, but no event drives them, and a
 * half-implemented refund is worse than an honest manual one.
 */
const CHECKOUT_COMPLETED = "checkout.session.completed";
const CHECKOUT_ASYNC_SUCCEEDED = "checkout.session.async_payment_succeeded";
const CHECKOUT_EXPIRED = "checkout.session.expired";

/**
 * Stripe's `payment_status` for a Checkout Session.
 *
 * ONLY `"paid"` is money. `"unpaid"` is the delayed-settlement case that a
 * later `async_payment_succeeded` will resolve, and `"no_payment_required"`
 * describes a fully-discounted session — this product issues none, so treating
 * it as paid would mean a coupon bug becomes free production reconstruction.
 *
 * This is the check that stops `event.type === "checkout.session.completed"`
 * from being mistaken for proof of payment.
 */
const STRIPE_PAID_STATUS = "paid";

export type StripeEventParseResult =
  | { ok: true; event: NormalizedPaymentEvent }
  /** The body verified but is not a usable Stripe event envelope at all. */
  | { ok: false };

/**
 * Parses and normalizes an ALREADY-VERIFIED Stripe payload.
 *
 * Never call this with unverified bytes. Signature verification happens
 * first, in `verifyStripeWebhookSignature`, and this function has no way to
 * tell whether that happened — which is exactly why the route's ordering is
 * asserted by its own test.
 */
export function normalizeStripeEvent(rawPayload: string): StripeEventParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawPayload);
  } catch {
    return { ok: false };
  }

  const envelope = asRecord(parsed);
  if (!envelope) return { ok: false };

  const providerEventId = asNonEmptyString(envelope.id);
  const eventType = asNonEmptyString(envelope.type);
  // Without an id there is no idempotency key, and without a type there is
  // nothing to decide. Either absence makes the body unusable rather than
  // ignorable — an "ignored" record keyed on nothing would itself be a bug.
  if (!providerEventId || !eventType) return { ok: false };

  const session = asRecord(asRecord(envelope.data)?.object);

  // An event type this build does not implement. Recorded and acknowledged so
  // the provider stops retrying, and acted on in no way whatsoever.
  if (
    eventType !== CHECKOUT_COMPLETED &&
    eventType !== CHECKOUT_ASYNC_SUCCEEDED &&
    eventType !== CHECKOUT_EXPIRED
  ) {
    return { ok: true, event: ignoredEvent(providerEventId, eventType) };
  }

  if (!session) {
    return { ok: true, event: ignoredEvent(providerEventId, eventType) };
  }

  const paymentTransactionId = readTransactionHandle(session);
  const providerCheckoutSessionId = asNonEmptyString(session.id);

  if (eventType === CHECKOUT_EXPIRED) {
    return {
      ok: true,
      event: {
        providerEventId,
        eventType,
        action: "expire",
        paymentTransactionId,
        providerCheckoutSessionId,
        // An expiry carries no money and must never bind a payment intent or
        // be compared against an amount.
        providerPaymentIntentId: null,
        amountMinor: null,
        currency: null,
      },
    };
  }

  // COMPLETION IS NOT PAYMENT. The action degrades to `"ignore"` unless Stripe
  // itself says the money settled — the single most important line in this
  // file.
  const action: WebhookAction =
    asNonEmptyString(session.payment_status) === STRIPE_PAID_STATUS
      ? "activate"
      : "ignore";

  return {
    ok: true,
    event: {
      providerEventId,
      eventType,
      action,
      paymentTransactionId,
      providerCheckoutSessionId,
      providerPaymentIntentId: readPaymentIntentId(session.payment_intent),
      amountMinor: asPositiveInteger(session.amount_total),
      // Stripe reports lowercase ISO 4217; normalized rather than trusted so
      // the exact comparison downstream is a comparison of like with like.
      currency: asNonEmptyString(session.currency)?.toLowerCase() ?? null,
    },
  };
}

function ignoredEvent(
  providerEventId: string,
  eventType: string,
): NormalizedPaymentEvent {
  return {
    providerEventId,
    eventType,
    action: "ignore",
    paymentTransactionId: null,
    providerCheckoutSessionId: null,
    providerPaymentIntentId: null,
    amountMinor: null,
    currency: null,
  };
}

/**
 * Reads OUR transaction id back out of the session.
 *
 * Checked in both places this platform wrote it at checkout creation —
 * `metadata[…]` and `client_reference_id` — because they are set together and
 * either surviving is enough to find the row. Both are only ever a lookup
 * handle; the durable row supplies every actual fact.
 */
function readTransactionHandle(session: Record<string, unknown>): string | null {
  const metadata = asRecord(session.metadata);
  const fromMetadata = metadata
    ? asNonEmptyString(metadata[STRIPE_PAYMENT_TRANSACTION_METADATA_KEY])
    : null;
  if (fromMetadata) return fromMetadata;
  return asNonEmptyString(session.client_reference_id);
}

/** `payment_intent` is a string id, or an expanded object, or absent. */
function readPaymentIntentId(raw: unknown): string | null {
  const direct = asNonEmptyString(raw);
  if (direct) return direct;
  const expanded = asRecord(raw);
  return expanded ? asNonEmptyString(expanded.id) : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Amounts are minor units and must be whole and positive. A non-integer or
 * non-positive figure is not something to round or clamp — it is a value this
 * build does not understand, and `null` makes the exact comparison downstream
 * fail closed.
 */
function asPositiveInteger(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return null;
  }
  return value;
}

/** Guards the provider vocabulary at the boundary, for the same fail-closed reason. */
export function isKnownPaymentProvider(value: string): value is PaymentProviderKey {
  return (KNOWN_PAYMENT_PROVIDERS as readonly string[]).includes(value);
}
