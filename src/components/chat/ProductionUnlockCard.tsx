"use client";

import type {
  CustomerOfferView,
  ProductionUnlockSurface,
} from "@/capabilities/payment";
import {
  CHECKOUT_START_FAILED_MESSAGE,
  PAYMENT_CONFIRMATION_TIMEOUT_MESSAGE,
  PAYMENT_CONFIRMING_MESSAGE,
  PRODUCTION_UNLOCK_ACTION_LABEL,
  PRODUCTION_UNLOCK_UNAVAILABLE_MESSAGE,
  PRODUCTION_UNLOCKED_MESSAGE,
} from "@/capabilities/payment";

/**
 * Sprint A5.5: the commercial surface.
 *
 * COMMERCIAL STATE BELONGS HERE, NOT IN THE TRANSCRIPT. A5.5 adds no
 * assistant message about payment at all — no "pay now", no "payment
 * processing", no "payment complete". The Sprint A4 corrections were largely
 * about a card and a transcript disagreeing with each other about the
 * customer's own state, and payment is the worst possible place to reproduce
 * that: a stale chat line saying "you've used your free concept, we'll let
 * you know when more is available" sitting above a card asking for money is
 * two different stories about the same moment.
 *
 * This component RENDERS state; it never derives it. Which surface to show is
 * decided once, by `resolveProductionUnlockSurface`, from the server's
 * `CustomerPaymentView`. There is no local payment state here and no reading
 * of the URL — `ProductionUnlockSurface` arrives already resolved.
 *
 * THE COMPONENT CANNOT LIE. It has no branch that prints "paid", "payment
 * successful", or "unlocked" for anything other than the
 * `"production_unlocked"` surface, and that surface has exactly one source:
 * an active `ProductionUnlock` on the server.
 */
export function ProductionUnlockCard({
  surface,
  offer,
  busy,
  confirmationTimedOut,
  errorMessage,
  onUnlock,
}: {
  surface: ProductionUnlockSurface;
  /** Present only for `payment_required`. Server-formatted display amount. */
  offer: CustomerOfferView | null;
  /** A request this UI started is in flight. */
  busy: boolean;
  /** Bounded confirmation polling gave up without an answer. */
  confirmationTimedOut: boolean;
  /** Customer-safe, already sanitized. Never provider or internal detail. */
  errorMessage: string | null;
  onUnlock: () => void;
}) {
  if (surface === "none") return null;

  if (surface === "unavailable") {
    // Neutral, and deliberately uninformative. Never names a provider, a
    // configuration variable, or this project's state — and never renders a
    // button whose POST is certain to fail.
    return (
      <div
        className="mt-3 rounded-2xl border border-black/8 bg-white p-4 text-sm text-muted shadow-sm"
        role="status"
      >
        {PRODUCTION_UNLOCK_UNAVAILABLE_MESSAGE}
      </div>
    );
  }

  if (surface === "payment_processing") {
    return (
      <div
        className="mt-3 rounded-2xl border border-black/8 bg-white p-4 text-sm text-muted shadow-sm"
        role="status"
        aria-live="polite"
      >
        {confirmationTimedOut ? (
          // Never invites another payment. A transaction may be `created` or
          // already `paid` at this moment, and "try again" is how somebody
          // gets charged twice for one unlock.
          <span>{PAYMENT_CONFIRMATION_TIMEOUT_MESSAGE}</span>
        ) : (
          <span className="flex items-center gap-2">
            <span className="inline-flex gap-1" aria-hidden="true">
              <span className="animate-pulse">●</span>
              <span className="animate-pulse [animation-delay:150ms]">●</span>
              <span className="animate-pulse [animation-delay:300ms]">●</span>
            </span>
            {PAYMENT_CONFIRMING_MESSAGE}
          </span>
        )}
      </div>
    );
  }

  if (surface === "production_unlocked") {
    // The ONLY place this product says "unlocked", reached only from an
    // active entitlement record. Deliberately just a confirmation line: the
    // action that follows is the EXISTING finalization control, which the
    // customer still chooses to press. Payment never starts production work
    // on its own.
    return (
      <div
        className="mt-3 rounded-2xl border border-black/8 bg-white p-4 text-sm text-ink shadow-sm"
        role="status"
      >
        {PRODUCTION_UNLOCKED_MESSAGE}
      </div>
    );
  }

  // `payment_required`.
  return (
    <div className="mt-3 rounded-2xl border border-black/8 bg-white p-4 shadow-sm">
      <h2 className="text-sm font-medium text-ink">{offer?.title}</h2>
      <p className="mt-1.5 text-sm text-muted">{offer?.description}</p>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        {/* Server-formatted. The client never sees minor units or a currency
            code, so it has nothing to format and cannot disagree about the
            price. */}
        <p className="text-base font-medium text-ink">{offer?.displayAmount}</p>
        <button
          type="button"
          // Disabled while in flight so a double click cannot start two
          // navigations. The durable guarantee is A5.3's outstanding-attempt
          // index, which makes two tabs converge on ONE payment page — this
          // is only the courtesy layer above it.
          disabled={busy}
          aria-busy={busy}
          onClick={onUnlock}
          className="shrink-0 rounded-full bg-ink px-4 py-2 text-xs font-medium text-white transition enabled:hover:bg-ink/90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {PRODUCTION_UNLOCK_ACTION_LABEL}
        </button>
      </div>

      {errorMessage ? (
        // Says a payment was never STARTED — never "payment failed", which
        // would be a lie about an attempt that never reached a card.
        <p className="mt-3 text-sm text-muted" role="alert">
          {errorMessage || CHECKOUT_START_FAILED_MESSAGE}
        </p>
      ) : null}
    </div>
  );
}
