/**
 * Sprint A5.3: composition-time payment provider selection.
 *
 * Mirrors `resolveFinalArtworkProvider` / `resolveConceptGenerationProvider`:
 * the composition root asks for a provider, this module reads configuration
 * and returns one — or `null`. Capabilities and routes never inspect env
 * vars.
 *
 * RETURNS `null` RATHER THAN AN "UNAVAILABLE" STUB, which is a deliberate
 * difference from `resolveFinalArtworkProvider`.
 *
 * That boundary returns an `UnavailableFinalArtworkProvider` whose method
 * throws, because its caller is a background worker that must fail a job
 * loudly. Here the caller is a customer request, and the correct behavior for
 * "this deployment does not sell anything" is a clean refusal, not an
 * exception thrown from inside a provider adapter. A stub would also be a
 * thing that LOOKS like a payment provider sitting in the composition graph,
 * which is precisely the sort of object somebody later wires up by accident.
 *
 * `null` is the default and the correct state for every environment today.
 */

import {
  getPaymentProviderConfig,
  type PaymentProviderConfig,
} from "@/lib/config/payment-provider-config";

import type { PaymentProvider } from "./provider";
import { StripeCheckoutProvider } from "./stripe-checkout-provider";

export interface ResolvedPaymentProvider {
  /** `null` when no provider is configured — checkout refuses cleanly. */
  provider: PaymentProvider | null;
  /** `null` unless a provider is configured. Used to build return URLs. */
  publicBaseUrl: string | null;
  /** The resolved configuration, for a one-time composition-root log line. */
  config: PaymentProviderConfig;
}

export function resolvePaymentProvider(
  readConfig: () => PaymentProviderConfig = getPaymentProviderConfig,
): ResolvedPaymentProvider {
  const config = readConfig();

  if (config.mode !== "stripe") {
    return { provider: null, publicBaseUrl: null, config };
  }

  return {
    provider: new StripeCheckoutProvider({ secretKey: config.secretKey }),
    publicBaseUrl: config.publicBaseUrl,
    config,
  };
}
