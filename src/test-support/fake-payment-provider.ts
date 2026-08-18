/**
 * Sprint A5.3: a scriptable `PaymentProvider` for tests.
 *
 * NO LIVE STRIPE CALL IS POSSIBLE THROUGH THIS OBJECT — it has no HTTP client
 * at all. `StripeCheckoutProvider` is exercised separately against an
 * injected `fetchImpl`, so no automated test in this repository ever reaches
 * api.stripe.com.
 *
 * The fake captures every request it receives, which is what lets the suite
 * assert the property that actually matters: that the amount, currency,
 * profile, project, and email crossing the provider boundary were resolved by
 * the server and not by anything a browser sent.
 */

import { createHash } from "node:crypto";

import type {
  NormalizedPaymentEvent,
  PaymentProvider,
  ProductionUnlockCheckoutRequest,
  ProductionUnlockCheckoutResult,
  VerifyWebhookInput,
  VerifyWebhookResult,
} from "@/capabilities/payment";

/**
 * How the fake should behave on the NEXT call. Modelled as a queue so a test
 * can script a failure followed by a success — the crash/ambiguity recovery
 * path is exactly a sequence, not a single outcome.
 */
export type FakePaymentProviderBehavior =
  | { kind: "succeed"; sessionId?: string; url?: string; paymentIntentId?: string | null }
  /** Throws the supplied error verbatim, so a test controls `dispatch` precisely. */
  | { kind: "throw"; error: unknown };

/**
 * Session ids are unique across every instance in a process, not per-fake.
 *
 * A real provider never reissues a checkout session id, and the durable store
 * enforces that with a UNIQUE constraint. A per-instance counter would make
 * two harnesses in the same test file both issue `cs_test_fake_1`, which
 * collides in the shared local store — a fixture artefact that looks exactly
 * like a real bug and would otherwise be "fixed" by weakening the constraint.
 */
let fakeSessionCounter = 0;

export class FakePaymentProvider implements PaymentProvider {
  readonly providerKey = "stripe";

  /** Every request this provider was handed, in order. */
  readonly requests: ProductionUnlockCheckoutRequest[] = [];

  private readonly behaviors: FakePaymentProviderBehavior[] = [];
  private fallback: FakePaymentProviderBehavior = { kind: "succeed" };

  /**
   * Idempotency, modelled the way Stripe actually behaves: a repeated
   * idempotency key replays the ORIGINAL response rather than creating a
   * second session.
   *
   * This is what makes the crash-window test meaningful. Without it, a test
   * could "prove" recovery while the fake quietly handed out a second
   * session — which is the precise bug the real key exists to prevent.
   */
  private readonly byIdempotencyKey = new Map<string, ProductionUnlockCheckoutResult>();

  /** Queue one behavior for the next call. Chainable. */
  script(behavior: FakePaymentProviderBehavior): this {
    this.behaviors.push(behavior);
    return this;
  }

  /** Behavior for every call once the queue is empty. */
  always(behavior: FakePaymentProviderBehavior): this {
    this.fallback = behavior;
    return this;
  }

  /** How many times the provider was actually invoked. */
  get callCount(): number {
    return this.requests.length;
  }

  /** Distinct checkout sessions this fake ever issued. */
  get issuedSessionIds(): string[] {
    return [...new Set([...this.byIdempotencyKey.values()].map((r) => r.providerCheckoutSessionId))];
  }

  /**
   * Scripted webhook verification, for tests about what the CAPABILITY does
   * with a verified event.
   *
   * Deliberately not a second signature implementation. The real one
   * (`stripe-webhook-signature.ts`) is exercised end-to-end through the real
   * adapter and the real route by `stripe-webhook-signature.test.ts` and
   * `route.test.ts`; a fake that re-implemented HMAC could drift from it and
   * make a broken verifier look tested.
   *
   * Default: refuse everything. A test that wants a verified event must say
   * so, so no test can accidentally pass because the fake was lenient.
   */
  private webhookBehavior:
    | { kind: "reject" }
    | { kind: "verify"; event: NormalizedPaymentEvent } = { kind: "reject" };

  /** Every webhook input this provider was handed, in order. */
  readonly webhookInputs: VerifyWebhookInput[] = [];

  verifiesWebhookAs(event: NormalizedPaymentEvent): this {
    this.webhookBehavior = { kind: "verify", event };
    return this;
  }

  rejectsWebhooks(): this {
    this.webhookBehavior = { kind: "reject" };
    return this;
  }

  verifyWebhook(input: VerifyWebhookInput): VerifyWebhookResult {
    this.webhookInputs.push(input);
    if (this.webhookBehavior.kind === "reject") {
      return { verified: false, internalReason: "fake_rejected" };
    }
    return {
      verified: true,
      event: this.webhookBehavior.event,
      // Digest of the real raw body, so a test can assert the stored digest
      // genuinely describes the bytes that arrived.
      payloadDigest: createHash("sha256").update(input.rawBody, "utf8").digest("hex"),
    };
  }

  async createProductionUnlockCheckout(
    request: ProductionUnlockCheckoutRequest,
  ): Promise<ProductionUnlockCheckoutResult> {
    this.requests.push(request);

    const behavior = this.behaviors.shift() ?? this.fallback;
    if (behavior.kind === "throw") throw behavior.error;

    // Replay, exactly as a real provider would for a repeated key.
    const replayed = this.byIdempotencyKey.get(request.paymentTransactionId);
    if (replayed) return replayed;

    const index = (fakeSessionCounter += 1);
    const result: ProductionUnlockCheckoutResult = {
      providerKey: this.providerKey,
      providerCheckoutSessionId: behavior.sessionId ?? `cs_test_fake_${index}`,
      checkoutUrl: behavior.url ?? `https://checkout.example.test/pay/${index}`,
      providerPaymentIntentId: behavior.paymentIntentId ?? null,
    };
    this.byIdempotencyKey.set(request.paymentTransactionId, result);
    return result;
  }
}
