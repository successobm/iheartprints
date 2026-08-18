/**
 * Sprint A5.3: the first real `PaymentProvider` — Stripe Checkout.
 *
 * NO SDK, DELIBERATELY. Both existing paid-provider adapters in this
 * codebase (`OpenAIConceptGenerationProvider`, `TopazTransparencyUpscaleProvider`)
 * talk to their provider over raw `fetch` with an injectable `fetchImpl`, and
 * this one matches them exactly. That is not asceticism: it means the payment
 * path adds zero third-party dependencies to a repository whose whole
 * dependency list is nine packages, it stays testable with a plain fake
 * instead of module interception, and the request this process makes is
 * visible in this file rather than assembled somewhere in node_modules. The
 * surface used is three form fields and one response object.
 *
 * EVERY STRIPE-SPECIFIC FACT LIVES HERE — endpoint, form encoding, parameter
 * names, the `Idempotency-Key` header, status-code meanings, response field
 * names. Nothing above `PaymentProvider` knows Stripe exists.
 *
 * WHAT THIS ADAPTER NEVER DOES
 *   - decide who may buy (that is `PaymentCapability`'s authorization)
 *   - decide what something costs (server configuration, frozen on the row)
 *   - grant, activate, or touch a `ProductionUnlock`
 *   - persist anything
 *   - log, echo, or place the secret key anywhere but the Authorization header
 */

import { createHash } from "crypto";

import {
  ProviderError,
  classifyFetchRejectionDispatch,
  isRetryableProviderError,
} from "@/capabilities/providers/provider-error";
import { withRetry } from "@/capabilities/shared/retry";

import type {
  PaymentProvider,
  ProductionUnlockCheckoutRequest,
  ProductionUnlockCheckoutResult,
  VerifyWebhookInput,
  VerifyWebhookResult,
} from "./provider";
import { normalizeStripeEvent } from "./stripe-event-normalizer";
import { verifyStripeWebhookSignature } from "./stripe-webhook-signature";

const STRIPE_CHECKOUT_SESSIONS_ENDPOINT =
  "https://api.stripe.com/v1/checkout/sessions";

/**
 * The metadata key a verified A5.4 webhook will reconcile through.
 *
 * ONE opaque internal id, deliberately — not the project id, the acquisition
 * session id, the profile, and the amount all duplicated into metadata.
 * Duplicating authority values invites a future reader to trust metadata
 * directly, and metadata is caller-supplied data that happens to have made a
 * round trip through Stripe. It is a HANDLE: the webhook uses it to find the
 * durable row, and then reads every fact it needs from that row.
 */
export const STRIPE_PAYMENT_TRANSACTION_METADATA_KEY =
  "iheartprints_payment_transaction_id";

/**
 * Shown on the Stripe-hosted page. Deliberately generic and product-true:
 * the customer is buying the ability to have THIS design prepared for
 * production, not a file. No project id, no design name, no artwork
 * reference — nothing that would put customer content on a third-party page.
 */
const CHECKOUT_LINE_ITEM_NAME = "Production unlock";

/**
 * Only ever retried for failures that PROVABLY never reached Stripe
 * (`isRetryableProviderError` enforces `dispatch === "not_dispatched"`).
 * Nothing is billed at session creation, but a session that may exist must
 * still never be raced by a second creation attempt in the same call.
 */
const MAX_CHECKOUT_ATTEMPTS = 3;

export interface StripeCheckoutProviderConfig {
  secretKey: string;
  /**
   * Sprint A5.4: the webhook signing secret. Separate from `secretKey` — a
   * different credential with a different rotation schedule, and one that
   * grants nothing at Stripe (it only proves a payload came from them).
   */
  webhookSecret: string;
  /** Injectable for tests — defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Injectable for tests — defaults to the real clock, seconds since epoch. */
  nowSeconds?: () => number;
}

export class StripeCheckoutProvider implements PaymentProvider {
  readonly providerKey = "stripe";

  private readonly secretKey: string;
  private readonly webhookSecret: string;
  private readonly fetchImpl: typeof fetch;
  private readonly nowSeconds: () => number;

  constructor(config: StripeCheckoutProviderConfig) {
    this.secretKey = config.secretKey;
    this.webhookSecret = config.webhookSecret;
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.nowSeconds = config.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
  }

  /**
   * Sprint A5.4: verify, THEN parse. The ordering is the security property.
   *
   * Nothing about the body is interpreted — not its JSON, not its event type,
   * not the transaction it names — until the signature has been checked
   * against the exact bytes received. A verifier that parsed first would be
   * executing attacker-supplied structure before establishing that an attacker
   * did not supply it.
   *
   * Returns rather than throws for an unverified request: unsigned and
   * badly-signed traffic is ordinary background noise on a public endpoint,
   * and turning it into exceptions would put attacker-controlled frequency in
   * charge of this process's error paths.
   */
  verifyWebhook(input: VerifyWebhookInput): VerifyWebhookResult {
    const verification = verifyStripeWebhookSignature({
      rawBody: input.rawBody,
      signatureHeader: input.signatureHeader,
      secret: this.webhookSecret,
      nowSeconds: input.nowSeconds ?? this.nowSeconds(),
    });

    if (!verification.verified) {
      // The reason is internal and log-only. The caller answers a bare 400 —
      // telling a prober which part of their forgery failed would help them
      // fix it.
      return { verified: false, internalReason: verification.reason };
    }

    const normalized = normalizeStripeEvent(verification.payload);
    if (!normalized.ok) {
      // Correctly signed, but not a usable event envelope — no id to key
      // idempotency on, or no type to decide from. Genuinely from Stripe and
      // genuinely unusable, so it is refused rather than recorded as
      // `ignored` under an identity it does not have.
      return { verified: false, internalReason: "unusable_event_envelope" };
    }

    return {
      verified: true,
      event: normalized.event,
      // A digest of the VERIFIED bytes — never the bytes themselves. See
      // `PaymentEvent.payloadDigest`: a Stripe event body carries the
      // customer's email, billing address, and card metadata, none of which
      // this product needs after reconciliation.
      payloadDigest: createHash("sha256").update(verification.payload, "utf8").digest("hex"),
    };
  }

  async createProductionUnlockCheckout(
    request: ProductionUnlockCheckoutRequest,
  ): Promise<ProductionUnlockCheckoutResult> {
    const body = this.buildForm(request);

    return withRetry(
      () => this.postCheckoutSession(body, request.paymentTransactionId),
      {
        attempts: MAX_CHECKOUT_ATTEMPTS,
        isRetryable: isRetryableProviderError,
      },
    );
  }

  /**
   * Stripe's API is form-encoded with bracket notation for nested values.
   * Built here rather than by a helper so the exact request this process
   * makes is readable in one place.
   */
  private buildForm(request: ProductionUnlockCheckoutRequest): URLSearchParams {
    const form = new URLSearchParams();
    // One-time payment. Never `subscription` — the product does not sell one,
    // and this is the single parameter that would make it a recurring charge.
    form.set("mode", "payment");
    form.set("success_url", request.successUrl);
    form.set("cancel_url", request.cancelUrl);
    form.set("line_items[0][quantity]", "1");

    if (request.providerPriceId) {
      // The operator has chosen provider-side price management. Stripe's Price
      // object decides what is charged; our durable record keeps
      // amountMinor/currency and reconciling them is an operator
      // responsibility (see `production-unlock-offer-config.ts`).
      form.set("line_items[0][price]", request.providerPriceId);
    } else {
      // The default and the safer one: ONE source of truth for the price, so
      // our durable transaction and the customer's charge cannot drift.
      form.set("line_items[0][price_data][currency]", request.currency);
      form.set(
        "line_items[0][price_data][unit_amount]",
        String(request.amountMinor),
      );
      form.set(
        "line_items[0][price_data][product_data][name]",
        CHECKOUT_LINE_ITEM_NAME,
      );
    }

    if (request.customerEmail) {
      // Stripe has a first-class field for this, so the address goes there and
      // NOT into metadata — duplicating a customer's email into a free-form
      // bag is gratuitous exposure with no reconciliation benefit.
      form.set("customer_email", request.customerEmail);
    }

    form.set(
      `metadata[${STRIPE_PAYMENT_TRANSACTION_METADATA_KEY}]`,
      request.paymentTransactionId,
    );
    // The same handle in Stripe's own first-class field, so it is visible in
    // the dashboard and on the event without expanding metadata. Same value,
    // no additional exposure — it is an opaque internal id, not a secret.
    form.set("client_reference_id", request.paymentTransactionId);

    return form;
  }

  private async postCheckoutSession(
    body: URLSearchParams,
    idempotencyKey: string,
  ): Promise<ProductionUnlockCheckoutResult> {
    let response: Response;
    try {
      response = await this.fetchImpl(STRIPE_CHECKOUT_SESSIONS_ENDPOINT, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.secretKey}`,
          "content-type": "application/x-www-form-urlencoded",
          // THE CRASH-WINDOW GUARANTEE. Stripe replays the original response
          // for a repeated key, so retrying an attempt whose outcome we never
          // recorded returns the SAME session instead of creating a second
          // one. Our internal transaction id is the natural key: durable,
          // stable across process restarts, and already the metadata handle.
          "idempotency-key": idempotencyKey,
        },
        body,
      });
    } catch (error) {
      // A `fetch` rejection is not uniformly "nothing was sent" — DNS/connect
      // failures provably never dispatched, a mid-flight socket error may
      // have. Reused verbatim from the concept/final-artwork adapters.
      throw new ProviderError(
        "network",
        "The payment provider could not be reached.",
        classifyFetchRejectionDispatch(error),
      );
    }

    if (!response.ok) {
      throw this.classifyHttpFailure(response.status);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      // A 2xx we cannot read means a session may genuinely exist that we
      // failed to record. Ambiguous, not billed — no money moves at session
      // creation — and the attempt stays resumable on the same idempotency
      // key, which is exactly the right outcome.
      throw new ProviderError(
        "malformed_response",
        "The payment provider returned an unreadable response.",
        "dispatched_ambiguous",
      );
    }

    return this.readCheckoutSession(payload);
  }

  /**
   * Status → classification. The `dispatch` state is the load-bearing half:
   * it decides whether the caller may free the outstanding-attempt slot
   * (`not_dispatched`) or must leave the attempt resumable.
   */
  private classifyHttpFailure(status: number): ProviderError {
    if (status === 401 || status === 403) {
      // Stripe rejected the credential before doing anything. Never retried,
      // and the message never mentions the key.
      return new ProviderError(
        "auth",
        "The payment provider rejected this deployment's credentials.",
        "not_dispatched",
      );
    }
    if (status === 429) {
      return new ProviderError(
        "rate_limited",
        "The payment provider is rate limiting requests.",
        "not_dispatched",
      );
    }
    if (status >= 400 && status < 500) {
      // Stripe refused to create the session — a malformed parameter, an
      // unknown price id, an idempotency-key conflict. No session exists, so
      // the slot may be freed and a corrected attempt started.
      return new ProviderError(
        "invalid_request",
        "The payment provider rejected this checkout request.",
        "not_dispatched",
      );
    }
    // 5xx: Stripe may or may not have created a session before failing. Never
    // freed, never raced — the attempt stays resumable on the same key.
    return new ProviderError(
      "unavailable",
      "The payment provider is temporarily unavailable.",
      "dispatched_ambiguous",
    );
  }

  /**
   * Reads only the three fields the domain needs. A response missing `id` or
   * `url` is unusable — there is nowhere to send the customer — and is
   * reported ambiguous rather than as a clean failure, because a session may
   * genuinely have been created.
   */
  private readCheckoutSession(payload: unknown): ProductionUnlockCheckoutResult {
    const record =
      payload && typeof payload === "object"
        ? (payload as Record<string, unknown>)
        : null;

    const id = typeof record?.id === "string" ? record.id : null;
    const url = typeof record?.url === "string" ? record.url : null;

    if (!id || !url) {
      throw new ProviderError(
        "malformed_response",
        "The payment provider returned an unusable checkout session.",
        "dispatched_ambiguous",
      );
    }

    // `payment_intent` is normally null at session creation and is expanded to
    // an object only when requested. Both shapes are read; anything else is
    // simply absent, which is not an error.
    const rawIntent = record?.payment_intent;
    const providerPaymentIntentId =
      typeof rawIntent === "string" && rawIntent.length > 0
        ? rawIntent
        : rawIntent && typeof rawIntent === "object" &&
            typeof (rawIntent as Record<string, unknown>).id === "string"
          ? ((rawIntent as Record<string, unknown>).id as string)
          : null;

    return {
      providerKey: this.providerKey,
      providerCheckoutSessionId: id,
      checkoutUrl: url,
      providerPaymentIntentId,
    };
  }
}
