import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToString } from "react-dom/server";
import { createElement } from "react";

import type {
  CustomerOfferView,
  ProductionUnlockSurface,
} from "@/capabilities/payment";

import { ProductionUnlockCard } from "./ProductionUnlockCard";

/**
 * Sprint A5.5 — the commercial card.
 *
 * The tests that matter are the negative ones. A payment surface that
 * overstates what happened is worse than no surface at all: "Paid" shown to
 * somebody whose webhook never arrived, or "Unlocked" shown from a query
 * parameter, would be the product lying about money. So the sweep in `F`
 * checks every surface for words the product may only ever say from an
 * entitlement record.
 */

const OFFER: CustomerOfferView = {
  title: "Unlock this design for production",
  description:
    "You've chosen your design. Unlock it to prepare the production-ready artwork and download the finished file.",
  displayAmount: "$49.00",
};

const ALL_SURFACES: ProductionUnlockSurface[] = [
  "none",
  "payment_required",
  "payment_processing",
  "production_unlocked",
  "unavailable",
];

function render(
  surface: ProductionUnlockSurface,
  overrides: {
    offer?: CustomerOfferView | null;
    busy?: boolean;
    confirmationTimedOut?: boolean;
    errorMessage?: string | null;
  } = {},
): string {
  return renderToString(
    createElement(ProductionUnlockCard, {
      surface,
      offer: overrides.offer === undefined ? OFFER : overrides.offer,
      busy: overrides.busy ?? false,
      confirmationTimedOut: overrides.confirmationTimedOut ?? false,
      errorMessage: overrides.errorMessage ?? null,
      onUnlock: () => {},
    }),
  );
}

describe("Sprint A5.5 — ProductionUnlockCard", () => {
  it("A: renders nothing when there is nothing commercial to show", () => {
    assert.equal(render("none"), "");
  });

  it("B: offers the design, the price, and the action when payment is required", () => {
    const html = render("payment_required");
    assert.match(html, /Unlock this design for production/);
    assert.match(html, /\$49\.00/);
    assert.match(html, /Unlock This Design/);
    // Never framed as buying a file.
    assert.equal(/Buy/i.test(html), false);
    assert.equal(/PNG/i.test(html), false);
  });

  it("C: disables the action while a request is in flight", () => {
    const html = render("payment_required", { busy: true });
    assert.match(html, /disabled=""/);
    assert.match(html, /aria-busy="true"/);
  });

  it("D: confirms nothing while a payment is being checked", () => {
    const html = render("payment_processing");
    assert.match(html, /Confirming your payment/);
    // No action at all: offering "Unlock This Design" here would invite a
    // second payment while the first may already have succeeded.
    assert.equal(/Unlock This Design/.test(html), false);
    assert.match(html, /aria-live="polite"/);
  });

  it("E: on confirmation timeout, asks the customer to wait — never to pay again", () => {
    const html = render("payment_processing", { confirmationTimedOut: true });
    assert.match(html, /still being confirmed/);
    assert.match(html, /refresh this page/);
    assert.equal(
      /try again|pay again|Unlock This Design/i.test(html),
      false,
      "inviting another attempt is how somebody gets charged twice for one unlock",
    );
  });

  it("F: the words 'paid' and 'unlocked' appear ONLY on the entitlement surface", () => {
    for (const surface of ALL_SURFACES) {
      const html = render(surface);
      const claimsUnlocked = /unlocked/i.test(html);
      const claimsPaid = /payment successful|payment complete|\bpaid\b/i.test(html);

      if (surface === "production_unlocked") {
        assert.match(html, /unlocked for production/i);
      } else {
        assert.equal(
          claimsUnlocked,
          false,
          `surface "${surface}" must not say "unlocked"`,
        );
      }
      assert.equal(
        claimsPaid,
        false,
        `surface "${surface}" must never claim a payment succeeded`,
      );
    }
  });

  it("G: the unlocked surface confirms and stops — it starts no production work", () => {
    const html = render("production_unlocked");
    assert.match(html, /Your design is unlocked for production/);
    // The finalization control is a separate, existing component the customer
    // still chooses to press. Payment must never auto-start a FinalArtworkJob.
    assert.equal(/Create Print-Ready Artwork/.test(html), false);
    assert.equal(/<button/.test(html), false);
  });

  it("H: the unavailable surface is neutral and offers no button", () => {
    const html = render("unavailable", { offer: null });
    assert.match(html, /temporarily unavailable/);
    assert.equal(/<button/.test(html), false, "never a button certain to fail");
    // Never reveals why.
    for (const leak of ["Stripe", "config", "environment", "PAYMENT_PROVIDER", "price"]) {
      assert.equal(
        new RegExp(leak, "i").test(html),
        false,
        `unavailable copy must not mention ${leak}`,
      );
    }
  });

  it("I: a checkout error says a payment was never STARTED, not that one failed", () => {
    const html = render("payment_required", {
      errorMessage: "We couldn't start the payment just now. Please try again.",
    });
    assert.match(html, /couldn&#x27;t start the payment|couldn't start the payment/);
    assert.equal(
      /payment failed/i.test(html),
      false,
      "nothing was charged, so nothing failed",
    );
    // The offer stays available so the customer can retry.
    assert.match(html, /Unlock This Design/);
    assert.match(html, /role="alert"/);
  });
});
