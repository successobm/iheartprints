import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  resolveProductionUnlockSurface,
  type CustomerPaymentState,
  type CustomerPaymentView,
} from "./customer-payment-view";
import { formatOfferAmount } from "./format-offer-amount";
import {
  PRODUCTION_UNLOCK_ACTION_LABEL,
  PRODUCTION_UNLOCK_OFFER_DESCRIPTION,
  PRODUCTION_UNLOCK_OFFER_TITLE,
} from "./payment-copy";

/**
 * Sprint A5.5 — THE PAYMENT UI CANNOT LIE.
 *
 * The load-bearing test in this file is `A`, and it is written as an
 * exhaustive sweep rather than a set of examples: every combination of server
 * state and navigation hint is enumerated, and `production_unlocked` is
 * asserted to appear if and only if the SERVER said so. That is the one
 * property the whole sprint rests on — a query parameter must not be able to
 * tell a customer they are unlocked.
 */

function view(
  state: CustomerPaymentState,
  checkoutPending = false,
): CustomerPaymentView {
  return {
    state,
    offer:
      state === "payment_required"
        ? {
            title: PRODUCTION_UNLOCK_OFFER_TITLE,
            description: PRODUCTION_UNLOCK_OFFER_DESCRIPTION,
            displayAmount: "$49.00",
          }
        : null,
    checkoutPending,
  };
}

const ALL_STATES: CustomerPaymentState[] = [
  "not_applicable",
  "payment_required",
  "production_unlocked",
  "unavailable",
];

describe("Sprint A5.5 — the production unlock surface", () => {
  it("A: `production_unlocked` appears if and ONLY if the server said so", () => {
    // Exhaustive: 4 states x 2 hints x 2 pending flags = 16 combinations.
    for (const state of ALL_STATES) {
      for (const returnedFromCheckout of [false, true]) {
        for (const checkoutPending of [false, true]) {
          const surface = resolveProductionUnlockSurface({
            payment: view(state, checkoutPending),
            returnedFromCheckout,
          });

          assert.equal(
            surface === "production_unlocked",
            state === "production_unlocked",
            `state=${state} returned=${returnedFromCheckout} pending=${checkoutPending} ` +
              "— only the server's own entitlement state may produce production_unlocked",
          );
        }
      }
    }
  });

  it("B: the redirect hint alone never confirms anything", () => {
    // Somebody types the success URL, or reaches it with Back-then-Forward
    // after abandoning payment. There is no durable attempt behind it.
    assert.equal(
      resolveProductionUnlockSurface({
        payment: view("payment_required", false),
        returnedFromCheckout: true,
      }),
      "payment_required",
      "a hint with no outstanding attempt must still ask for payment",
    );
  });

  it("C: an outstanding attempt alone never spins", () => {
    // The customer opened checkout and closed the tab. Without the return
    // hint they must see the offer again, not a confirmation spinner that
    // would never resolve.
    assert.equal(
      resolveProductionUnlockSurface({
        payment: view("payment_required", true),
        returnedFromCheckout: false,
      }),
      "payment_required",
    );
  });

  it("D: BOTH together is the only route to the confirmation surface", () => {
    assert.equal(
      resolveProductionUnlockSurface({
        payment: view("payment_required", true),
        returnedFromCheckout: true,
      }),
      "payment_processing",
    );
  });

  it("E: an already-unlocked project never flashes the confirmation surface", () => {
    // Webhook-before-redirect: the entitlement is already active when the
    // browser comes back. The customer must land straight on unlocked.
    for (const checkoutPending of [false, true]) {
      assert.equal(
        resolveProductionUnlockSurface({
          payment: view("production_unlocked", checkoutPending),
          returnedFromCheckout: true,
        }),
        "production_unlocked",
      );
    }
  });

  it("F: `not_applicable` renders nothing and `unavailable` renders a neutral note", () => {
    for (const returnedFromCheckout of [false, true]) {
      assert.equal(
        resolveProductionUnlockSurface({
          payment: view("not_applicable"),
          returnedFromCheckout,
        }),
        "none",
      );
      assert.equal(
        resolveProductionUnlockSurface({
          payment: view("unavailable"),
          returnedFromCheckout,
        }),
        "unavailable",
        "a deployment that cannot sell must never show a checkout button",
      );
    }
  });
});

describe("Sprint A5.5 — offer amount formatting", () => {
  it("G: formats a two-decimal currency from minor units", () => {
    assert.equal(formatOfferAmount(4900, "usd"), "$49.00");
    assert.equal(formatOfferAmount(4900, "USD"), "$49.00");
    assert.equal(formatOfferAmount(1, "usd"), "$0.01");
  });

  it("H: respects currencies whose minor unit is NOT one hundredth", () => {
    // The reason `Intl` supplies the exponent instead of a hard-coded /100:
    // a yen amount divided by 100 would be off by two orders of magnitude.
    assert.equal(formatOfferAmount(4900, "jpy").replace(/ /g, " "), "¥4,900");
    // Three-decimal currencies exist too (BHD, KWD, TND).
    assert.match(formatOfferAmount(4900, "kwd"), /4\.900/);
  });

  it("I: is the only formatter — the view carries a finished string", () => {
    // Guards the single-authority claim structurally: `CustomerOfferView` has
    // no raw amount or currency code for a client to re-format, so there is
    // nothing to disagree about.
    const offer = view("payment_required").offer!;
    assert.deepEqual(Object.keys(offer).sort(), [
      "description",
      "displayAmount",
      "title",
    ]);
  });
});

describe("Sprint A5.5 — offer copy", () => {
  it("J: sells a design outcome, never a file, credits, or a subscription", () => {
    const copy = [
      PRODUCTION_UNLOCK_OFFER_TITLE,
      PRODUCTION_UNLOCK_OFFER_DESCRIPTION,
      PRODUCTION_UNLOCK_ACTION_LABEL,
    ]
      .join(" ")
      .toLowerCase();

    assert.match(copy, /unlock this design for production/);

    for (const forbidden of [
      "png",
      "credit",
      "subscription",
      "unlimited",
      "vector",
      "embroider",
      "buy png",
      "license",
      "licence",
      "copyright",
      "trademark",
      "cleared",
      "we print",
      "shipping",
    ]) {
      assert.equal(
        copy.includes(forbidden),
        false,
        `offer copy must not contain "${forbidden}" — it is either a promise V1 cannot keep or a rights claim the product never makes`,
      );
    }
  });
});
