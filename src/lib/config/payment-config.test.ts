import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import {
  getPaymentProviderConfig,
  PAYMENT_PROVIDER_ENV,
  PUBLIC_BASE_URL_ENV,
  STRIPE_SECRET_KEY_ENV,
} from "./payment-provider-config";
import {
  getProductionUnlockOfferConfig,
  PRODUCTION_UNLOCK_AMOUNT_MINOR_ENV,
  PRODUCTION_UNLOCK_CURRENCY_ENV,
  PRODUCTION_UNLOCK_PROVIDER_PRICE_ID_ENV,
} from "./production-unlock-offer-config";

/**
 * Sprint A5.3 — payment configuration, which is where a mistake is a BILLING
 * incident rather than a degraded experience.
 *
 * The property every test here defends is the same one: there is no silent
 * fallback. A missing price does not become a default price, a missing
 * credential does not become a test-mode credential, and a typo in
 * `PAYMENT_PROVIDER` does not select a provider.
 */

const TOUCHED_ENV = [
  PAYMENT_PROVIDER_ENV,
  STRIPE_SECRET_KEY_ENV,
  PUBLIC_BASE_URL_ENV,
  PRODUCTION_UNLOCK_AMOUNT_MINOR_ENV,
  PRODUCTION_UNLOCK_CURRENCY_ENV,
  PRODUCTION_UNLOCK_PROVIDER_PRICE_ID_ENV,
] as const;

/** A syntactically valid TEST key. Never a real credential, never live. */
const VALID_TEST_SECRET = "sk_test_0123456789abcdefghij";

function setEnv(values: Partial<Record<(typeof TOUCHED_ENV)[number], string>>) {
  for (const key of TOUCHED_ENV) delete process.env[key];
  for (const [key, value] of Object.entries(values)) {
    process.env[key] = value;
  }
}

afterEach(() => {
  for (const key of TOUCHED_ENV) delete process.env[key];
});

describe("Sprint A5.3 — production unlock offer configuration", () => {
  it("is unavailable when nothing is configured, and never invents a default price", () => {
    setEnv({});
    const config = getProductionUnlockOfferConfig();
    assert.equal(config.mode, "unavailable");
    assert.equal(
      config.mode === "unavailable" && config.safeErrorCode,
      "PRODUCTION_UNLOCK_PRICE_NOT_CONFIGURED",
    );
  });

  it("distinguishes 'nobody has chosen a price' from 'somebody chose a bad one'", () => {
    // An operator reading a log needs to know which of the two happened; the
    // remedies are completely different.
    setEnv({ [PRODUCTION_UNLOCK_AMOUNT_MINOR_ENV]: "4900" });
    const missingCurrency = getProductionUnlockOfferConfig();
    assert.equal(
      missingCurrency.mode === "unavailable" && missingCurrency.safeErrorCode,
      "PRODUCTION_UNLOCK_PRICE_NOT_CONFIGURED",
    );

    setEnv({
      [PRODUCTION_UNLOCK_AMOUNT_MINOR_ENV]: "4900",
      [PRODUCTION_UNLOCK_CURRENCY_ENV]: "dollars",
    });
    const badCurrency = getProductionUnlockOfferConfig();
    assert.equal(
      badCurrency.mode === "unavailable" && badCurrency.safeErrorCode,
      "PRODUCTION_UNLOCK_PRICE_INVALID",
    );
  });

  /**
   * The `"49.00"` case is the one that matters and is the reason the raw
   * string is validated rather than only its numeric value:
   * `Number.isInteger(Number("49.00"))` is TRUE, so an operator who meant
   * forty-nine DOLLARS would have configured forty-nine CENTS and every
   * downstream check would have agreed it was valid.
   */
  it("refuses every non-integer, non-positive, or out-of-range amount", () => {
    for (const amount of [
      "0",
      "-100",
      "49.5",
      "49.00",
      "4900.0",
      "4.9e3",
      "+4900",
      "4,900",
      "abc",
      "5usd",
      "",
      " ",
      "99999999",
    ]) {
      setEnv({
        [PRODUCTION_UNLOCK_AMOUNT_MINOR_ENV]: amount,
        [PRODUCTION_UNLOCK_CURRENCY_ENV]: "usd",
      });
      const config = getProductionUnlockOfferConfig();
      assert.equal(
        config.mode,
        "unavailable",
        `amount "${amount}" must not resolve to a configured offer`,
      );
    }
  });

  it("refuses a currency that is not a 3-letter ISO 4217 code", () => {
    for (const currency of ["us", "usdd", "US1", "$", "united states dollar"]) {
      setEnv({
        [PRODUCTION_UNLOCK_AMOUNT_MINOR_ENV]: "4900",
        [PRODUCTION_UNLOCK_CURRENCY_ENV]: currency,
      });
      assert.equal(
        getProductionUnlockOfferConfig().mode,
        "unavailable",
        `currency "${currency}" must not resolve to a configured offer`,
      );
    }
  });

  it("resolves a valid configuration, normalizing currency case and pinning the profile", () => {
    setEnv({
      [PRODUCTION_UNLOCK_AMOUNT_MINOR_ENV]: "4900",
      [PRODUCTION_UNLOCK_CURRENCY_ENV]: "USD",
    });
    const config = getProductionUnlockOfferConfig();
    assert.equal(config.mode, "configured");
    if (config.mode !== "configured") return;
    assert.equal(config.amountMinor, 4900);
    assert.equal(config.currency, "usd");
    // NOT configurable — V1 sells exactly one production path, and reading it
    // from an env var would let a typo sell a profile that does not exist.
    assert.equal(config.productionProfile, "apparel_raster");
    assert.equal(config.providerPriceId, null);
  });

  it("carries an optional provider price id when one is supplied", () => {
    setEnv({
      [PRODUCTION_UNLOCK_AMOUNT_MINOR_ENV]: "4900",
      [PRODUCTION_UNLOCK_CURRENCY_ENV]: "usd",
      [PRODUCTION_UNLOCK_PROVIDER_PRICE_ID_ENV]: "price_123",
    });
    const config = getProductionUnlockOfferConfig();
    assert.equal(config.mode === "configured" && config.providerPriceId, "price_123");
  });
});

describe("Sprint A5.3 — payment provider configuration", () => {
  it("is disabled by default, in every environment", () => {
    setEnv({});
    const config = getPaymentProviderConfig();
    assert.equal(config.mode, "unavailable");
    assert.equal(
      config.mode === "unavailable" && config.safeErrorCode,
      "PAYMENT_PROVIDER_DISABLED",
    );
  });

  it("never selects a paid provider from a typo", () => {
    for (const requested of ["strip", "Stripe ", "stripee", "true", "1"]) {
      setEnv({
        [PAYMENT_PROVIDER_ENV]: requested,
        [STRIPE_SECRET_KEY_ENV]: VALID_TEST_SECRET,
        [PUBLIC_BASE_URL_ENV]: "https://example.test",
      });
      const config = getPaymentProviderConfig();
      // "Stripe " with whitespace/case IS normalized and accepted; the others
      // must not be. Asserting the direction rather than a blanket rule.
      if (requested.trim().toLowerCase() === "stripe") {
        assert.equal(config.mode, "stripe");
      } else {
        assert.equal(
          config.mode,
          "unavailable",
          `"${requested}" must not select a payment provider`,
        );
      }
    }
  });

  it("refuses a missing secret", () => {
    setEnv({
      [PAYMENT_PROVIDER_ENV]: "stripe",
      [PUBLIC_BASE_URL_ENV]: "https://example.test",
    });
    const config = getPaymentProviderConfig();
    assert.equal(
      config.mode === "unavailable" && config.safeErrorCode,
      "PAYMENT_PROVIDER_NOT_CONFIGURED",
    );
  });

  it("refuses a malformed secret, including a publishable key in the secret slot", () => {
    for (const secret of [
      "pk_test_0123456789abcdefghij", // the mistake this check exists for
      "whsec_0123456789abcdefghij",
      "sk_test_short",
      "not-a-key-at-all-but-long-enough",
    ]) {
      setEnv({
        [PAYMENT_PROVIDER_ENV]: "stripe",
        [STRIPE_SECRET_KEY_ENV]: secret,
        [PUBLIC_BASE_URL_ENV]: "https://example.test",
      });
      const config = getPaymentProviderConfig();
      assert.equal(
        config.mode === "unavailable" && config.safeErrorCode,
        "PAYMENT_PROVIDER_CREDENTIAL_INVALID",
        `secret shaped "${secret.slice(0, 6)}…" must be refused`,
      );
    }
  });

  it("never echoes the credential in its internal reason", () => {
    setEnv({
      [PAYMENT_PROVIDER_ENV]: "stripe",
      [STRIPE_SECRET_KEY_ENV]: "pk_test_SUPERSECRETVALUE12345",
      [PUBLIC_BASE_URL_ENV]: "https://example.test",
    });
    const config = getPaymentProviderConfig();
    assert.equal(config.mode, "unavailable");
    if (config.mode !== "unavailable") return;
    assert.equal(config.internalReason.includes("SUPERSECRETVALUE"), false);
    assert.equal(config.internalReason.includes("pk_test_"), false);
  });

  it("refuses a missing or non-http(s) public base URL", () => {
    setEnv({
      [PAYMENT_PROVIDER_ENV]: "stripe",
      [STRIPE_SECRET_KEY_ENV]: VALID_TEST_SECRET,
    });
    assert.equal(
      getPaymentProviderConfig().mode === "unavailable" &&
        (getPaymentProviderConfig() as { safeErrorCode: string }).safeErrorCode,
      "PAYMENT_PUBLIC_BASE_URL_NOT_CONFIGURED",
    );

    // A `javascript:`/`data:` redirect target would be a scripting vector the
    // provider would happily accept as a string.
    for (const base of ["javascript:alert(1)", "data:text/html,x", "example.test", "//example.test"]) {
      setEnv({
        [PAYMENT_PROVIDER_ENV]: "stripe",
        [STRIPE_SECRET_KEY_ENV]: VALID_TEST_SECRET,
        [PUBLIC_BASE_URL_ENV]: base,
      });
      assert.equal(
        getPaymentProviderConfig().mode,
        "unavailable",
        `base URL "${base}" must be refused`,
      );
    }
  });

  it("resolves a valid configuration and strips a trailing slash", () => {
    setEnv({
      [PAYMENT_PROVIDER_ENV]: "stripe",
      [STRIPE_SECRET_KEY_ENV]: VALID_TEST_SECRET,
      [PUBLIC_BASE_URL_ENV]: "https://iheartprints.example/",
    });
    const config = getPaymentProviderConfig();
    assert.equal(config.mode, "stripe");
    if (config.mode !== "stripe") return;
    assert.equal(config.provider, "stripe");
    assert.equal(config.publicBaseUrl, "https://iheartprints.example");
    assert.equal(config.secretKey, VALID_TEST_SECRET);
  });
});
