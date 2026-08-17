/**
 * Sprint A5.3: THE ONE SERVER-AUTHORITATIVE DESCRIPTION OF WHAT IS FOR SALE.
 *
 * iHeartPrints sells exactly one thing: *unlock this design for production*
 * — one project, one production profile. This module resolves the price of
 * that offer, and it is the only place a price exists in the codebase.
 *
 * WHY A PRICE MUST NEVER COME FROM ANYWHERE ELSE
 *
 * A browser that can influence an amount can buy a $500 unlock for $0.50. So
 * the amount is not merely "validated on the server" — it is never accepted
 * from a request at all, at any layer. `PaymentCapability` reads this module,
 * freezes the result onto the durable `PaymentTransaction`, and hands it to
 * the provider. The HTTP body carries no commercial authority whatsoever
 * (see the checkout route's `strict()` empty schema).
 *
 * FAIL CLOSED, WITH NO DEVELOPMENT FALLBACK — deliberately, and for the same
 * reason `internal-access-config.ts` has none. A default price would be a
 * published price: every deployment that forgot to configure one would
 * quietly start charging it, and a wrong amount is not a degraded experience,
 * it is a billing incident. An unconfigured deployment simply cannot create
 * checkouts, in every environment.
 *
 * Contrast `final-artwork-provider-config.ts`, which defaults to a safe local
 * provider: there, a default is the harmless option. Here there is no
 * harmless default, so there is no default.
 *
 * Pure and side-effect-free (no logging) so it stays trivially testable —
 * logging belongs to whatever consumes the result, exactly as in
 * `generation-provider-config.ts`.
 *
 * SERVER-ONLY. Never imported by a client component. The amount reaches a
 * browser only if some future surface deliberately renders it as display
 * copy, resolved server-side.
 */

import {
  APPAREL_RASTER_PRODUCTION_PROFILE,
  type ProductionProfile,
} from "@/lib/domain/types";

export const PRODUCTION_UNLOCK_CURRENCY_ENV = "PRODUCTION_UNLOCK_CURRENCY";
export const PRODUCTION_UNLOCK_AMOUNT_MINOR_ENV =
  "PRODUCTION_UNLOCK_AMOUNT_MINOR";
export const PRODUCTION_UNLOCK_PROVIDER_PRICE_ID_ENV =
  "PRODUCTION_UNLOCK_PROVIDER_PRICE_ID";

/**
 * A sanity floor and ceiling, not a pricing policy. They exist to refuse an
 * obviously accidental value — a stray `0`, or a figure that is far more
 * likely to be a units mistake (dollars typed where cents were meant, or
 * cents typed where dollars were) than a real intention.
 *
 * Minor units throughout: 5000 is $50.00, not $5000.
 */
const MIN_AMOUNT_MINOR = 1;
const MAX_AMOUNT_MINOR = 10_000_00;

/** Lowercase ISO 4217, matching the database CHECK and Stripe's own casing. */
const CURRENCY_PATTERN = /^[a-z]{3}$/;

export type ProductionUnlockOfferUnavailableCode =
  | "PRODUCTION_UNLOCK_PRICE_NOT_CONFIGURED"
  | "PRODUCTION_UNLOCK_PRICE_INVALID";

/**
 * The resolved offer. `mode: "unavailable"` is a first-class outcome rather
 * than a thrown error, mirroring `FinalArtworkProviderConfig`: every caller
 * has a correct, safe behavior for "I cannot establish what this costs"
 * (refuse), and a 500 on a customer request buys nothing that a clean refusal
 * does not.
 */
export type ProductionUnlockOfferConfig =
  | {
      mode: "configured";
      /**
       * The profile this offer unlocks. Not configurable: V1 sells exactly
       * one production path, and reading it from an env var would let a typo
       * sell a profile the product does not implement.
       */
      productionProfile: ProductionProfile;
      /** Positive integer, minor units. */
      amountMinor: number;
      /** Lowercase ISO 4217. */
      currency: string;
      /**
       * An optional provider-side Price object id.
       *
       * When absent (the default), the adapter builds the line item from
       * `amountMinor`/`currency` above, which keeps ONE source of truth for
       * the price and makes drift between our durable record and what the
       * customer is actually charged impossible.
       *
       * When present, the provider's Price object decides what is charged and
       * this module can no longer guarantee the two agree — nothing here can
       * read a remote Price without a network call. That is a real, accepted
       * trade for operators who need provider-side price management (tax
       * behavior, multi-currency, promotions), and it is stated rather than
       * hidden: `amountMinor`/`currency` remain what the durable transaction
       * records, and reconciling them is an operator responsibility.
       */
      providerPriceId: string | null;
    }
  | {
      mode: "unavailable";
      safeErrorCode: ProductionUnlockOfferUnavailableCode;
      /** Non-secret, server-log-only. Never customer-facing. */
      internalReason: string;
    };

export function getProductionUnlockOfferConfig(): ProductionUnlockOfferConfig {
  const rawAmount = process.env[PRODUCTION_UNLOCK_AMOUNT_MINOR_ENV]?.trim() ?? "";
  const rawCurrency = process.env[PRODUCTION_UNLOCK_CURRENCY_ENV]?.trim() ?? "";

  // Unset is the ordinary state of a deployment that has not chosen a price
  // yet, and is reported separately from a MALFORMED value: one is "nobody
  // has decided", the other is "somebody decided wrongly", and an operator
  // reading a log needs to know which.
  if (!rawAmount && !rawCurrency) {
    return {
      mode: "unavailable",
      safeErrorCode: "PRODUCTION_UNLOCK_PRICE_NOT_CONFIGURED",
      internalReason: `${PRODUCTION_UNLOCK_AMOUNT_MINOR_ENV} and ${PRODUCTION_UNLOCK_CURRENCY_ENV} are not set.`,
    };
  }
  if (!rawAmount) {
    return {
      mode: "unavailable",
      safeErrorCode: "PRODUCTION_UNLOCK_PRICE_NOT_CONFIGURED",
      internalReason: `${PRODUCTION_UNLOCK_AMOUNT_MINOR_ENV} is not set.`,
    };
  }
  if (!rawCurrency) {
    return {
      mode: "unavailable",
      safeErrorCode: "PRODUCTION_UNLOCK_PRICE_NOT_CONFIGURED",
      internalReason: `${PRODUCTION_UNLOCK_CURRENCY_ENV} is not set.`,
    };
  }

  const currency = rawCurrency.toLowerCase();
  if (!CURRENCY_PATTERN.test(currency)) {
    return {
      mode: "unavailable",
      safeErrorCode: "PRODUCTION_UNLOCK_PRICE_INVALID",
      internalReason: `${PRODUCTION_UNLOCK_CURRENCY_ENV} must be a 3-letter ISO 4217 code.`,
    };
  }

  // THE RAW STRING IS VALIDATED, NOT JUST ITS NUMERIC VALUE — and this is a
  // billing correctness check, not pedantry.
  //
  // `Number.isInteger(Number("49.00"))` is TRUE, because `Number("49.00")` is
  // `49`. An operator who writes `PRODUCTION_UNLOCK_AMOUNT_MINOR=49.00`
  // meaning "forty-nine dollars" would therefore configure FORTY-NINE CENTS,
  // and every check downstream would agree it was a perfectly valid integer.
  // `parseInt` is worse still: it reads "5usd" as 5.
  //
  // A decimal point in a MINOR-units value always means the operator is
  // thinking in major units, so the only safe response is to refuse and make
  // them say what they mean. Digits only — no sign, no exponent, no
  // separators.
  if (!/^\d+$/.test(rawAmount)) {
    return {
      mode: "unavailable",
      safeErrorCode: "PRODUCTION_UNLOCK_PRICE_INVALID",
      internalReason: `${PRODUCTION_UNLOCK_AMOUNT_MINOR_ENV} must be digits only — a whole number of MINOR units (e.g. 4900 for $49.00, never 49.00).`,
    };
  }

  const amountMinor = Number(rawAmount);
  if (!Number.isInteger(amountMinor)) {
    return {
      mode: "unavailable",
      safeErrorCode: "PRODUCTION_UNLOCK_PRICE_INVALID",
      internalReason: `${PRODUCTION_UNLOCK_AMOUNT_MINOR_ENV} must be a whole number of minor units (e.g. 4900 for $49.00).`,
    };
  }
  if (amountMinor < MIN_AMOUNT_MINOR || amountMinor > MAX_AMOUNT_MINOR) {
    return {
      mode: "unavailable",
      safeErrorCode: "PRODUCTION_UNLOCK_PRICE_INVALID",
      internalReason: `${PRODUCTION_UNLOCK_AMOUNT_MINOR_ENV} must be between ${MIN_AMOUNT_MINOR} and ${MAX_AMOUNT_MINOR} minor units.`,
    };
  }

  const providerPriceId =
    process.env[PRODUCTION_UNLOCK_PROVIDER_PRICE_ID_ENV]?.trim() || null;

  return {
    mode: "configured",
    productionProfile: APPAREL_RASTER_PRODUCTION_PROFILE,
    amountMinor,
    currency,
    providerPriceId,
  };
}
