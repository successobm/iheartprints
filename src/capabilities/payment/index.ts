/**
 * Sprint A5.3: the payment boundary.
 *
 * Note what is NOT exported: `StripeCheckoutProvider` is reachable only
 * through `resolvePaymentProvider`, so no capability, route, or test can wire
 * a live Stripe adapter by importing this barrel. Provider dialect stays
 * inside its adapter, exactly as it does for concept generation and final
 * artwork.
 */

export {
  createPaymentCapability,
  type PaymentCapability,
  type CreateCheckoutResult,
  type CheckoutRefusalReason,
} from "./payment-capability";
export { CHECKOUT_UNAVAILABLE_MESSAGE } from "./payment-copy";
export {
  buildCheckoutReturnUrls,
  CHECKOUT_RETURN_PARAM,
  CHECKOUT_RETURN_CANCELLED,
  CHECKOUT_RETURN_COMPLETE,
  type CheckoutReturnUrls,
} from "./checkout-return-urls";
export {
  resolvePaymentProvider,
  type ResolvedPaymentProvider,
} from "./resolve-payment-provider";
export type {
  PaymentProvider,
  ProductionUnlockCheckoutRequest,
  ProductionUnlockCheckoutResult,
} from "./provider";
