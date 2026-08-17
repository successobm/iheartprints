import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ProviderError } from "@/capabilities/providers/provider-error";

import {
  StripeCheckoutProvider,
  STRIPE_PAYMENT_TRANSACTION_METADATA_KEY,
} from "./stripe-checkout-provider";
import type { ProductionUnlockCheckoutRequest } from "./provider";

/**
 * Sprint A5.3 — the Stripe adapter, against an INJECTED `fetch`.
 *
 * NO LIVE STRIPE CALL IS POSSIBLE HERE. Every test supplies its own
 * `fetchImpl`; the global `fetch` is never reached, and the secret below is a
 * syntactically-valid fake.
 *
 * The claims under test are the ones that would cost money or leak something
 * if they were wrong: what the request body actually contains, that the
 * idempotency key is sent, that the secret never appears anywhere but the
 * Authorization header, and — most importantly — that each HTTP failure is
 * classified with the correct DISPATCH state, because that is what decides
 * whether the caller may free the outstanding-attempt slot.
 */

const FAKE_SECRET = "sk_test_0123456789abcdefghij";

function request(
  overrides: Partial<ProductionUnlockCheckoutRequest> = {},
): ProductionUnlockCheckoutRequest {
  return {
    paymentTransactionId: "11111111-2222-3333-4444-555555555555",
    projectId: "99999999-8888-7777-6666-555555555555",
    productionProfile: "apparel_raster",
    amountMinor: 4900,
    currency: "usd",
    providerPriceId: null,
    customerEmail: "eric@example.com",
    successUrl: "https://example.test/?project=p&checkout=complete",
    cancelUrl: "https://example.test/?project=p&checkout=cancelled",
    ...overrides,
  };
}

interface Captured {
  url: string;
  init: RequestInit;
  form: URLSearchParams;
}

function capturingFetch(
  respond: () => Response,
): { fetchImpl: typeof fetch; calls: Captured[] } {
  const calls: Captured[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      init: init ?? {},
      form: new URLSearchParams(String(init?.body ?? "")),
    });
    return respond();
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("Sprint A5.3 — Stripe checkout adapter", () => {
  it("A: sends a one-time payment session with a server-built inline price", async () => {
    const { fetchImpl, calls } = capturingFetch(() =>
      jsonResponse({ id: "cs_test_1", url: "https://checkout.stripe.test/c/1" }),
    );
    const provider = new StripeCheckoutProvider({ secretKey: FAKE_SECRET, fetchImpl });

    const result = await provider.createProductionUnlockCheckout(request());

    assert.equal(result.providerKey, "stripe");
    assert.equal(result.providerCheckoutSessionId, "cs_test_1");
    assert.equal(result.checkoutUrl, "https://checkout.stripe.test/c/1");
    assert.equal(result.providerPaymentIntentId, null);

    const { form } = calls[0]!;
    // `mode=payment` is the single parameter standing between this product
    // and a recurring subscription charge.
    assert.equal(form.get("mode"), "payment");
    assert.equal(form.get("line_items[0][quantity]"), "1");
    assert.equal(form.get("line_items[0][price_data][currency]"), "usd");
    assert.equal(form.get("line_items[0][price_data][unit_amount]"), "4900");
    assert.equal(form.get("line_items[0][price]"), null);
  });

  it("B: sends the transaction id as the idempotency key and as the reconciliation handle", async () => {
    const { fetchImpl, calls } = capturingFetch(() =>
      jsonResponse({ id: "cs_test_1", url: "https://checkout.stripe.test/c/1" }),
    );
    const provider = new StripeCheckoutProvider({ secretKey: FAKE_SECRET, fetchImpl });

    await provider.createProductionUnlockCheckout(request());

    const { init, form } = calls[0]!;
    const headers = init.headers as Record<string, string>;
    assert.equal(
      headers["idempotency-key"],
      "11111111-2222-3333-4444-555555555555",
      "without this, a replayed attempt creates a SECOND checkout session",
    );
    assert.equal(
      form.get(`metadata[${STRIPE_PAYMENT_TRANSACTION_METADATA_KEY}]`),
      "11111111-2222-3333-4444-555555555555",
    );
    assert.equal(form.get("client_reference_id"), "11111111-2222-3333-4444-555555555555");
  });

  it("C: puts the email in Stripe's own field and never in metadata", async () => {
    const { fetchImpl, calls } = capturingFetch(() =>
      jsonResponse({ id: "cs_test_1", url: "https://checkout.stripe.test/c/1" }),
    );
    const provider = new StripeCheckoutProvider({ secretKey: FAKE_SECRET, fetchImpl });

    await provider.createProductionUnlockCheckout(request());

    const { form } = calls[0]!;
    assert.equal(form.get("customer_email"), "eric@example.com");
    for (const [key, value] of form.entries()) {
      if (key.startsWith("metadata[")) {
        assert.equal(
          value.includes("@"),
          false,
          "an address must never be duplicated into the metadata bag",
        );
      }
    }
  });

  it("D: never places the secret anywhere but the Authorization header", async () => {
    const { fetchImpl, calls } = capturingFetch(() =>
      jsonResponse({ id: "cs_test_1", url: "https://checkout.stripe.test/c/1" }),
    );
    const provider = new StripeCheckoutProvider({ secretKey: FAKE_SECRET, fetchImpl });

    await provider.createProductionUnlockCheckout(request());

    const { url, init, form } = calls[0]!;
    assert.equal(url.includes(FAKE_SECRET), false);
    assert.equal(String(init.body).includes(FAKE_SECRET), false);
    assert.equal([...form.values()].some((v) => v.includes(FAKE_SECRET)), false);
    assert.equal(
      (init.headers as Record<string, string>).authorization,
      `Bearer ${FAKE_SECRET}`,
    );
  });

  it("E: uses a provider Price object when one is configured, and then sends no inline amount", async () => {
    const { fetchImpl, calls } = capturingFetch(() =>
      jsonResponse({ id: "cs_test_1", url: "https://checkout.stripe.test/c/1" }),
    );
    const provider = new StripeCheckoutProvider({ secretKey: FAKE_SECRET, fetchImpl });

    await provider.createProductionUnlockCheckout(
      request({ providerPriceId: "price_abc" }),
    );

    const { form } = calls[0]!;
    assert.equal(form.get("line_items[0][price]"), "price_abc");
    assert.equal(form.get("line_items[0][price_data][unit_amount]"), null);
  });

  it("F: reads an expanded payment intent, and tolerates its absence", async () => {
    const expanded = capturingFetch(() =>
      jsonResponse({
        id: "cs_test_1",
        url: "https://checkout.stripe.test/c/1",
        payment_intent: { id: "pi_test_9" },
      }),
    );
    const provider = new StripeCheckoutProvider({
      secretKey: FAKE_SECRET,
      fetchImpl: expanded.fetchImpl,
    });
    const result = await provider.createProductionUnlockCheckout(request());
    assert.equal(result.providerPaymentIntentId, "pi_test_9");

    const asString = capturingFetch(() =>
      jsonResponse({
        id: "cs_test_2",
        url: "https://checkout.stripe.test/c/2",
        payment_intent: "pi_test_10",
      }),
    );
    const provider2 = new StripeCheckoutProvider({
      secretKey: FAKE_SECRET,
      fetchImpl: asString.fetchImpl,
    });
    assert.equal(
      (await provider2.createProductionUnlockCheckout(request()))
        .providerPaymentIntentId,
      "pi_test_10",
    );
  });

  /* ================================================================== */
  /* Failure classification — the DISPATCH state is the load-bearing     */
  /* half, because it decides whether the outstanding slot may be freed. */
  /* ================================================================== */

  it("G: 401/403 is auth and provably not dispatched, and never names the key", async () => {
    for (const status of [401, 403]) {
      const { fetchImpl } = capturingFetch(() =>
        jsonResponse({ error: { message: `bad key ${FAKE_SECRET}` } }, status),
      );
      const provider = new StripeCheckoutProvider({ secretKey: FAKE_SECRET, fetchImpl });

      await assert.rejects(
        () => provider.createProductionUnlockCheckout(request()),
        (error: unknown) => {
          assert.ok(error instanceof ProviderError);
          assert.equal(error.classification, "auth");
          assert.equal(error.dispatch, "not_dispatched");
          // The provider's own error text is never forwarded — it can carry
          // the credential straight back out.
          assert.equal(error.message.includes(FAKE_SECRET), false);
          return true;
        },
      );
    }
  });

  it("H: other 4xx is an invalid request and provably not dispatched — the slot may be freed", async () => {
    const { fetchImpl } = capturingFetch(() =>
      jsonResponse({ error: { message: "No such price" } }, 400),
    );
    const provider = new StripeCheckoutProvider({ secretKey: FAKE_SECRET, fetchImpl });

    await assert.rejects(
      () => provider.createProductionUnlockCheckout(request()),
      (error: unknown) => {
        assert.ok(error instanceof ProviderError);
        assert.equal(error.classification, "invalid_request");
        assert.equal(error.dispatch, "not_dispatched");
        return true;
      },
    );
  });

  it("I: 5xx is AMBIGUOUS — a session may exist, so the attempt must stay resumable", async () => {
    const { fetchImpl, calls } = capturingFetch(() => jsonResponse({}, 503));
    const provider = new StripeCheckoutProvider({ secretKey: FAKE_SECRET, fetchImpl });

    await assert.rejects(
      () => provider.createProductionUnlockCheckout(request()),
      (error: unknown) => {
        assert.ok(error instanceof ProviderError);
        assert.equal(error.classification, "unavailable");
        assert.equal(
          error.dispatch,
          "dispatched_ambiguous",
          "freeing the slot here is how a customer ends up with two payment pages",
        );
        return true;
      },
    );
    // Never retried locally: an ambiguous outcome is not this layer's to
    // re-attempt. Resumption happens on the customer's next request, under
    // the same idempotency key.
    assert.equal(calls.length, 1);
  });

  it("J: a 2xx whose body is unusable is ambiguous, not a clean failure", async () => {
    for (const body of [{ id: "cs_1" }, { url: "https://x.test" }, {}]) {
      const { fetchImpl } = capturingFetch(() => jsonResponse(body));
      const provider = new StripeCheckoutProvider({ secretKey: FAKE_SECRET, fetchImpl });

      await assert.rejects(
        () => provider.createProductionUnlockCheckout(request()),
        (error: unknown) => {
          assert.ok(error instanceof ProviderError);
          assert.equal(error.classification, "malformed_response");
          assert.equal(error.dispatch, "dispatched_ambiguous");
          return true;
        },
      );
    }
  });

  it("K: a DNS/connect rejection is provably pre-dispatch and IS retried locally", async () => {
    let attempts = 0;
    const fetchImpl = (async () => {
      attempts += 1;
      const error = new Error("getaddrinfo ENOTFOUND api.stripe.com") as Error & {
        code?: string;
      };
      error.code = "ENOTFOUND";
      throw error;
    }) as unknown as typeof fetch;
    const provider = new StripeCheckoutProvider({ secretKey: FAKE_SECRET, fetchImpl });

    await assert.rejects(
      () => provider.createProductionUnlockCheckout(request()),
      (error: unknown) => {
        assert.ok(error instanceof ProviderError);
        assert.equal(error.classification, "network");
        assert.equal(error.dispatch, "not_dispatched");
        return true;
      },
    );
    // Bounded retry is safe precisely because nothing was ever sent.
    assert.equal(attempts, 3);
  });

  it("L: a mid-flight socket failure is ambiguous and is NOT retried locally", async () => {
    let attempts = 0;
    const fetchImpl = (async () => {
      attempts += 1;
      throw new Error("socket hang up");
    }) as unknown as typeof fetch;
    const provider = new StripeCheckoutProvider({ secretKey: FAKE_SECRET, fetchImpl });

    await assert.rejects(() => provider.createProductionUnlockCheckout(request()));
    assert.equal(
      attempts,
      1,
      "a request that may have reached the provider must not be blindly repeated",
    );
  });
});
