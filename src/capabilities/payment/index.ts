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
  type HandleWebhookInput,
  type HandleWebhookResult,
} from "./payment-capability";
export {
  CHECKOUT_UNAVAILABLE_MESSAGE,
  CHECKOUT_START_FAILED_MESSAGE,
  PAYMENT_CONFIRMATION_TIMEOUT_MESSAGE,
  PAYMENT_CONFIRMING_MESSAGE,
  PRODUCTION_UNLOCK_ACTION_LABEL,
  PRODUCTION_UNLOCK_OFFER_DESCRIPTION,
  PRODUCTION_UNLOCK_OFFER_TITLE,
  PRODUCTION_UNLOCK_UNAVAILABLE_MESSAGE,
  PRODUCTION_UNLOCKED_MESSAGE,
} from "./payment-copy";
export {
  resolveProductionUnlockSurface,
  type CustomerOfferView,
  type CustomerPaymentState,
  type CustomerPaymentView,
  type ProductionUnlockSurface,
  type ProductionUnlockSurfaceInput,
} from "./customer-payment-view";
export { formatOfferAmount } from "./format-offer-amount";
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
  VerifyWebhookInput,
  VerifyWebhookResult,
} from "./provider";
export type {
  NormalizedPaymentEvent,
  WebhookAction,
} from "./webhook-contract";
export { STRIPE_SIGNATURE_HEADER } from "./stripe-webhook-signature";
