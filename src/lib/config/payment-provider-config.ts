/**
 * Sprint A5.3: payment provider selection and credentials.
 *
 * Mirrors `final-artwork-provider-config.ts` exactly — its own independent
 * provider boundary, its own credential, its own explicit opt-in, coupled to
 * no other provider in the codebase. `PAYMENT_PROVIDER=none | stripe`,
 * defaulting to `none`.
 *
 * FAILS CLOSED EVERYWHERE, including outside production. Concept generation
 * has a lenient "outside production, silently fall back to placeholder" mode
 * because a placeholder concept is a harmless local-dev convenience. There is
 * no harmless fallback for money: a "placeholder checkout" would either be a
 * fake payment page or a real charge nobody intended, and the failure mode of
 * getting that wrong is somebody's card.
 *
 * `none` is not an error state — it is the correct configuration for every
 * environment that is not selling anything, which today is all of them. It
 * simply means checkout cannot be created.
 *
 * Pure and side-effect-free so it stays trivially testable without mutating
 * `process.env` at module scope.
 *
 * SERVER-ONLY. The secret must never be imported by a client component, and
 * nothing in this module is ever returned to a browser.
 */

import type { PaymentProviderKey } from "@/lib/domain/types";

export const PAYMENT_PROVIDER_ENV = "PAYMENT_PROVIDER";
export const STRIPE_SECRET_KEY_ENV = "STRIPE_SECRET_KEY";
export const PUBLIC_BASE_URL_ENV = "IHEARTPRINTS_PUBLIC_BASE_URL";
export const STRIPE_WEBHOOK_SECRET_ENV = "STRIPE_WEBHOOK_SECRET";

/**
 * A shape floor, not a strength policy — the same role
 * `MIN_INTERNAL_ACCESS_KEY_LENGTH` plays in `internal-access-config.ts`.
 *
 * Stripe secret keys are `sk_test_…`, `sk_live_…`, or restricted `rk_…`. A
 * value that is none of those is far more likely to be a PUBLISHABLE key
 * (`pk_…`) pasted into the wrong variable than a valid credential — and a
 * publishable key in a server secret is worth catching at config time rather
 * than as a confusing 401 mid-checkout.
 *
 * Deliberately a prefix check and nothing more: this must never try to
 * validate a credential it cannot verify without a network call, and must
 * never log or echo the value.
 */
const STRIPE_SECRET_KEY_PREFIXES = ["sk_test_", "sk_live_", "rk_test_", "rk_live_"];
const MIN_STRIPE_SECRET_KEY_LENGTH = 20;

/**
 * Sprint A5.4: the webhook signing secret. Stripe issues these as `whsec_…`.
 *
 * Shape-checked for the same reason the API key is: the overwhelmingly likely
 * mistake is pasting the API key here (or this here), and catching it at
 * config time is far better than discovering it as a flood of rejected
 * webhooks after a customer has already paid.
 */
const STRIPE_WEBHOOK_SECRET_PREFIX = "whsec_";
const MIN_STRIPE_WEBHOOK_SECRET_LENGTH = 20;

export type PaymentProviderUnavailableCode =
  | "PAYMENT_PROVIDER_DISABLED"
  | "PAYMENT_PROVIDER_NOT_CONFIGURED"
  | "PAYMENT_PROVIDER_CREDENTIAL_INVALID"
  | "PAYMENT_WEBHOOK_SECRET_NOT_CONFIGURED"
  | "PAYMENT_WEBHOOK_SECRET_INVALID"
  | "PAYMENT_PUBLIC_BASE_URL_NOT_CONFIGURED"
  | "PAYMENT_PUBLIC_BASE_URL_INVALID";

export type PaymentProviderConfig =
  | {
      mode: "stripe";
      provider: PaymentProviderKey;
      /** Never logged, never returned, never placed in a URL or metadata. */
      secretKey: string;
      /**
       * Sprint A5.4: the webhook signing secret.
       *
       * REQUIRED WHENEVER CHECKOUT IS ENABLED, which is a deliberate coupling
       * rather than an oversight. A5.3 shipped with a documented hazard: a
       * deployment could take payments while nothing consumed the result, so
       * customers would be charged and receive nothing. Making this secret a
       * precondition of `mode: "stripe"` removes that state from the
       * configuration space entirely — you cannot turn on charging without
       * also being able to hear that the charge succeeded.
       *
       * Never logged, never returned, never placed in a URL or metadata.
       */
      webhookSecret: string;
      /**
       * Origin the customer is returned to after checkout. Server-resolved
       * rather than taken from the request's `Host`/`Origin` header, which an
       * attacker controls — a redirect target derived from an attacker's
       * header is an open redirect with a payment page in front of it.
       *
       * Normalized with no trailing slash.
       */
      publicBaseUrl: string;
    }
  | {
      mode: "unavailable";
      safeErrorCode: PaymentProviderUnavailableCode;
      /** Non-secret, server-log-only. Never customer-facing, never the key. */
      internalReason: string;
    };

export function getPaymentProviderConfig(): PaymentProviderConfig {
  const requested = (process.env[PAYMENT_PROVIDER_ENV] ?? "none")
    .trim()
    .toLowerCase();

  if (requested !== "stripe") {
    // Any unrecognized value resolves to disabled rather than throwing —
    // mirroring `final-artwork-provider-config.ts`: never silently SELECT a
    // paid provider from a typo. The direction of the mistake matters, and
    // "a typo disabled checkout" is recoverable in a way that "a typo started
    // charging cards" is not.
    return {
      mode: "unavailable",
      safeErrorCode: "PAYMENT_PROVIDER_DISABLED",
      internalReason: `${PAYMENT_PROVIDER_ENV} is not "stripe"; checkout is disabled.`,
    };
  }

  const secretKey = process.env[STRIPE_SECRET_KEY_ENV]?.trim() || "";
  if (!secretKey) {
    return {
      mode: "unavailable",
      safeErrorCode: "PAYMENT_PROVIDER_NOT_CONFIGURED",
      internalReason: `${PAYMENT_PROVIDER_ENV}=stripe but ${STRIPE_SECRET_KEY_ENV} is not set.`,
    };
  }
  if (
    secretKey.length < MIN_STRIPE_SECRET_KEY_LENGTH ||
    !STRIPE_SECRET_KEY_PREFIXES.some((prefix) => secretKey.startsWith(prefix))
  ) {
    return {
      mode: "unavailable",
      safeErrorCode: "PAYMENT_PROVIDER_CREDENTIAL_INVALID",
      // Names the variable, never the value — not even a prefix or a length.
      internalReason: `${STRIPE_SECRET_KEY_ENV} does not look like a Stripe secret or restricted key.`,
    };
  }

  const webhookSecret = process.env[STRIPE_WEBHOOK_SECRET_ENV]?.trim() || "";
  if (!webhookSecret) {
    return {
      mode: "unavailable",
      safeErrorCode: "PAYMENT_WEBHOOK_SECRET_NOT_CONFIGURED",
      internalReason: `${PAYMENT_PROVIDER_ENV}=stripe but ${STRIPE_WEBHOOK_SECRET_ENV} is not set; enabling checkout without it would charge customers whose payment nothing could confirm.`,
    };
  }
  if (
    webhookSecret.length < MIN_STRIPE_WEBHOOK_SECRET_LENGTH ||
    !webhookSecret.startsWith(STRIPE_WEBHOOK_SECRET_PREFIX)
  ) {
    return {
      mode: "unavailable",
      safeErrorCode: "PAYMENT_WEBHOOK_SECRET_INVALID",
      // Names the variable, never the value.
      internalReason: `${STRIPE_WEBHOOK_SECRET_ENV} does not look like a Stripe webhook signing secret.`,
    };
  }

  const rawBaseUrl = process.env[PUBLIC_BASE_URL_ENV]?.trim() || "";
  if (!rawBaseUrl) {
    return {
      mode: "unavailable",
      safeErrorCode: "PAYMENT_PUBLIC_BASE_URL_NOT_CONFIGURED",
      internalReason: `${PAYMENT_PROVIDER_ENV}=stripe but ${PUBLIC_BASE_URL_ENV} is not set; success/cancel URLs cannot be built safely.`,
    };
  }

  const publicBaseUrl = normalizeBaseUrl(rawBaseUrl);
  if (!publicBaseUrl) {
    return {
      mode: "unavailable",
      safeErrorCode: "PAYMENT_PUBLIC_BASE_URL_INVALID",
      internalReason: `${PUBLIC_BASE_URL_ENV} must be an absolute http(s) origin.`,
    };
  }

  return {
    mode: "stripe",
    provider: "stripe",
    secretKey,
    webhookSecret,
    publicBaseUrl,
  };
}

/**
 * Accepts only an absolute `http`/`https` URL and returns it without a
 * trailing slash.
 *
 * The scheme allowlist is load-bearing: a `javascript:` or `data:` value
 * reaching a redirect target is a scripting vector, and Stripe would happily
 * accept whatever string it was given. `http` is permitted because local
 * development serves plain HTTP, exactly as the acquisition cookie's `secure`
 * flag is relaxed there for the same reason.
 */
function normalizeBaseUrl(raw: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, "") || parsed.origin;
}
