/**
 * Sprint A5.3: the checkout boundary.
 *
 * WHAT THIS CAPABILITY OWNS
 *
 *   - deciding whether this project currently has something to sell
 *   - resolving the entire purchase from durable server state and server
 *     configuration
 *   - opening, resuming, and terminating one durable checkout attempt
 *   - hiding the payment provider from everything above it
 *
 * WHAT IT DELIBERATELY DOES NOT OWN
 *
 *   - THE ENTITLEMENT. It never creates, activates, reads-as-permission, or
 *     touches a `ProductionUnlock` in any way except to refuse selling one
 *     twice. Checkout is not payment and payment is not entitlement; only a
 *     verified webhook (A5.4) may ever grant one.
 *   - finalization or generation authority. `AcquisitionCapability` owns
 *     both, is completely untouched by this sprint, and does not know this
 *     capability exists.
 *   - webhook verification, refunds, receipts, or pricing policy.
 *
 * DEPENDENCY DIRECTION
 *
 *   PaymentCapability → ProjectRepository, PaymentProvider, offer config
 *
 * and nothing else. In particular it does NOT depend on
 * `AcquisitionCapability`: it resolves the project's acquisition session from
 * the repository directly, exactly as `AcquisitionCapability` itself does.
 * The dependency in the other direction is the one that must never exist —
 * `AcquisitionCapability` is the spend boundary and stays a leaf on the
 * repository (ARCHITECTURE.md §23b/§23c).
 *
 * THE AUTHORITY MODEL, stated once
 *
 * `createCheckout` takes a project id and NOTHING ELSE. Every other fact —
 * who is buying, which production profile, how much, in what currency, with
 * which provider, to which email — is resolved here from the project's own
 * durable state and from server-side configuration. There is no parameter a
 * browser could influence, which is what makes client-side price
 * manipulation structurally impossible rather than merely validated against.
 */

import {
  ProviderError,
  isPossiblyBilledProviderError,
} from "@/capabilities/providers/provider-error";
import type { ProjectRepository } from "@/lib/db/repository";
import {
  getProductionUnlockOfferConfig,
  type ProductionUnlockOfferConfig,
} from "@/lib/config/production-unlock-offer-config";
// The SAME shared pure rule the concept grid and the acquisition email gate
// use — "there is a design to buy" must never become a third definition of
// "delivered" (see `shared/concept-delivery.ts`).
import { hasDeliveredGeneratedConcept } from "@/capabilities/shared/concept-delivery";
import {
  APPAREL_RASTER_PRODUCTION_PROFILE,
  isOutstandingPaymentTransaction,
  isUnsupportedRequestedProductionOutput,
  isUsableCheckout,
  KNOWN_PAYMENT_PROVIDERS,
  normalizeProductionIntent,
  productionUnlockAuthorizes,
  type PaymentEventApplication,
  type PaymentProviderKey,
  type PaymentTransaction,
  type ProductionProfile,
} from "@/lib/domain/types";

import { buildCheckoutReturnUrls } from "./checkout-return-urls";
import type { CustomerPaymentView } from "./customer-payment-view";
import { formatOfferAmount } from "./format-offer-amount";
import {
  CHECKOUT_UNAVAILABLE_MESSAGE,
  PRODUCTION_UNLOCK_OFFER_DESCRIPTION,
  PRODUCTION_UNLOCK_OFFER_TITLE,
} from "./payment-copy";
import type { PaymentProvider } from "./provider";

/**
 * Why a checkout was refused. INTERNAL ONLY — logged, never returned.
 *
 * A customer learns nothing from these, and an attacker probing a project id
 * must not be able to tell "this project does not exist" from "this project
 * is already unlocked" from "this deployment sells nothing". Every refusal
 * carries the same sentence (`CHECKOUT_UNAVAILABLE_MESSAGE`), which is the
 * same discipline `ACQUISITION_UNAVAILABLE_MESSAGE` follows.
 */
export type CheckoutRefusalReason =
  | "project_not_found"
  | "authority_unavailable"
  | "legacy_project"
  | "internal_project"
  | "email_required"
  | "already_unlocked"
  | "nothing_to_purchase"
  | "revision_pending"
  | "unsupported_production_output"
  | "offer_unavailable"
  | "provider_unavailable"
  | "provider_mismatch"
  | "frozen_offer_unreadable"
  | "provider_failed";

export type CreateCheckoutResult =
  | {
      ok: true;
      /** Provider-issued, short-lived. The ONLY provider value a browser receives. */
      checkoutUrl: string;
      /**
       * True when this call reused or resumed an attempt that already
       * existed — a second tab, a double click, a reload, or a retry after a
       * failure. Internal/diagnostic; the customer's experience is identical.
       */
      reused: boolean;
    }
  | { ok: false; customerMessage: string };

/**
 * Sprint A5.4: what the webhook route should answer.
 *
 * Two outcomes only, because a payment provider treats the response as a
 * retry instruction and nothing else:
 *
 *   "acknowledged" — 200. The event was verified and decided. That decision
 *                    may have been "processed", but equally "ignored",
 *                    "unmatched", or "rejected_mismatch": all four are FINAL,
 *                    and re-delivering them would never produce a different
 *                    answer. Acknowledging is how a permanent refusal avoids
 *                    becoming an infinite retry loop.
 *   "rejected"     — 400. The request was not verifiably from the provider,
 *                    so nothing about it was interpreted at all.
 *
 * Deliberately NOT a mirror of `PaymentEventOutcome`. The provider does not
 * need to know what we decided, and telling it would leak whether a given
 * transaction id exists.
 */
export type HandleWebhookResult =
  | { status: "acknowledged"; outcome: PaymentEventApplication }
  | { status: "rejected" };

export interface HandleWebhookInput {
  /** The EXACT raw body bytes, read once by the route. */
  rawBody: string;
  signatureHeader: string | null;
  /** Injected only by tests, to exercise signature tolerance. */
  nowSeconds?: number;
}

export interface PaymentCapability {
  /**
   * THE CHECKOUT GATE.
   *
   * Takes a project id and nothing else. Never creates or activates a
   * `ProductionUnlock` under any circumstance — that invariant is asserted
   * directly by the A5.3 test suite, because it is the one thing that would
   * turn "the customer opened a payment page" into "the customer is
   * entitled".
   */
  createCheckout(projectId: string): Promise<CreateCheckoutResult>;
  /**
   * Sprint A5.4 — THE ONLY PATH FROM MONEY TO ENTITLEMENT.
   *
   * Verifies the provider's signature against the RAW bytes, normalizes the
   * event behind the provider boundary, and hands the result to the single
   * atomic database authority. Nothing here decides anything about a project;
   * it establishes that the provider really said this, and then lets the
   * durable transaction row supply every fact.
   *
   * This method is unreachable from a browser redirect. `?checkout=complete`
   * is a query parameter on a page; it reaches no code that writes to a
   * payment or entitlement table.
   */
  handleWebhook(input: HandleWebhookInput): Promise<HandleWebhookResult>;
  /**
   * Sprint A5.5 — THE ONE CUSTOMER-FACING COMMERCIAL VIEW.
   *
   * Derived from the SAME eligibility rule `createCheckout` uses, so the UI
   * can never offer a button the server would refuse, nor hide one it would
   * honour. That agreement is structural rather than maintained: both call
   * `resolveEligibility`.
   *
   * Never returns the captured email, a provider price id, a checkout session
   * id, a payment intent id, an internal transaction id, or any configuration
   * detail. The only monetary value that crosses is a server-formatted
   * display string.
   */
  describeForCustomer(projectId: string): Promise<CustomerPaymentView>;
}

/**
 * The offer, frozen. Either freshly resolved from configuration (a new
 * attempt) or read back off a durable row (a resumed one) — never a mix, so
 * a price change mid-window can neither rewrite what somebody was already
 * quoted nor produce a body that conflicts with a replayed idempotency key.
 */
interface FrozenOffer {
  productionProfile: ProductionProfile;
  provider: PaymentProviderKey;
  amountMinor: number;
  currency: string;
}

export function createPaymentCapability(
  repo: ProjectRepository,
  /**
   * `null` when this deployment has no payment provider configured, which is
   * the default and the correct state for every environment that is not
   * selling anything. Checkout simply refuses.
   */
  provider: PaymentProvider | null,
  /** The customer-facing origin, from server config. `null` when unconfigured. */
  publicBaseUrl: string | null,
  readOffer: () => ProductionUnlockOfferConfig = getProductionUnlockOfferConfig,
): PaymentCapability {
  /**
   * One place a refusal becomes a result. The reason is logged with the
   * project id (an internal identifier, never customer content, never an
   * email or a session token) and never returned.
   */
  function refuse(
    projectId: string,
    reason: CheckoutRefusalReason,
  ): CreateCheckoutResult {
    console.info("Production unlock checkout refused", { projectId, reason });
    return { ok: false, customerMessage: CHECKOUT_UNAVAILABLE_MESSAGE };
  }

  /**
   * Re-reads the offer off a durable row rather than from configuration.
   *
   * Both halves matter. A resumed attempt must be quoted at the price it was
   * opened at — a customer does not get re-priced because an operator changed
   * an env var while their tab was open. And the provider request body must
   * be byte-identical to the original, or replaying the same idempotency key
   * is a conflict rather than a replay.
   *
   * Returns `null` for any value this build cannot interpret (an unrecognized
   * provider or profile written by a newer deploy, a corrupt amount or
   * currency). Fails closed: an attempt we cannot describe is one we must not
   * send to a payment provider.
   */
  function readFrozenOffer(transaction: PaymentTransaction): FrozenOffer | null {
    if (transaction.productionProfile !== APPAREL_RASTER_PRODUCTION_PROFILE) {
      return null;
    }
    if (
      !(KNOWN_PAYMENT_PROVIDERS as readonly string[]).includes(transaction.provider)
    ) {
      return null;
    }
    if (!Number.isInteger(transaction.amountMinor) || transaction.amountMinor <= 0) {
      return null;
    }
    if (!/^[a-z]{3}$/.test(transaction.currency)) return null;

    return {
      productionProfile: transaction.productionProfile,
      provider: transaction.provider as PaymentProviderKey,
      amountMinor: transaction.amountMinor,
      currency: transaction.currency,
    };
  }

  /**
   * Sprint A5.5 — THE ONE ELIGIBILITY RULE, extracted so that "may this
   * customer buy?" has exactly one answer.
   *
   * `createCheckout` and `describeForCustomer` are the two things that ask
   * it, and they MUST agree: a UI that offers a button the server refuses,
   * or hides one the server would honour, is the C/C2 defect wearing a
   * commercial hat. Before this extraction the checks lived inline in
   * `createCheckout`, and the customer view would have had to restate them.
   *
   * Ordering is preserved exactly as A5.3 wrote it, including that the
   * deployment's ability to take money is checked LAST — a misconfigured
   * deployment must never litter the table with attempts it cannot use, and
   * the customer view distinguishes "nothing to sell you" from "we cannot
   * sell right now" on the same boundary.
   */
  async function resolveEligibility(projectId: string): Promise<
    | { eligible: false; reason: CheckoutRefusalReason }
    | {
        eligible: true;
        snapshot: NonNullable<Awaited<ReturnType<ProjectRepository["getProject"]>>>;
        acquisitionSessionId: string;
        email: string;
        productionProfile: ProductionProfile;
        providerKey: PaymentProviderKey;
        offer: Extract<ProductionUnlockOfferConfig, { mode: "configured" }>;
        publicBaseUrl: string;
        provider: PaymentProvider;
      }
  > {
    // 1. Is there a buyer, and may they buy?
    const snapshot = await repo.getProject(projectId);
    if (!snapshot) return { eligible: false, reason: "project_not_found" };

    const acquisitionSessionId = snapshot.project.acquisitionSessionId;
    if (!acquisitionSessionId) {
      // A LEGACY project (created before acquisition sessions existed) has no
      // buyer to record, and `payment_transactions.acquisition_session_id` is
      // NOT NULL precisely so one cannot be fabricated.
      //
      // It is also the right product answer, not merely the convenient one: a
      // legacy project is already grandfathered through the finalization gate
      // (§23b), so it has nothing to purchase. Selling an unlock to somebody
      // who is already unlocked would take money for nothing.
      return { eligible: false, reason: "legacy_project" };
    }

    let session;
    try {
      session = await repo.getAcquisitionSession(acquisitionSessionId);
    } catch {
      return { eligible: false, reason: "authority_unavailable" };
    }
    // Same fail-closed rule as `AcquisitionCapability.resolveAuthority`: a
    // project bound to a session that cannot be loaded is never treated as
    // legacy, and never given the benefit of the doubt.
    if (!session) return { eligible: false, reason: "authority_unavailable" };

    if (session.entitlement === "internal") {
      // Nothing to sell. An internal session already finalizes freely, so a
      // checkout here would charge for access that is already granted.
      return { eligible: false, reason: "internal_project" };
    }

    if (!session.email) {
      // The funnel is: free concept → email → unlock. Taking money from
      // somebody we have no way to send a receipt or a recovery link to would
      // be selling a product we cannot deliver support for. The address is
      // already captured server-side by A4; this only checks that it happened.
      return { eligible: false, reason: "email_required" };
    }

    // 2. Is there anything left to sell?
    const productionProfile = APPAREL_RASTER_PRODUCTION_PROFILE;

    let existingUnlock;
    try {
      existingUnlock = await repo.getActiveProductionUnlock(
        projectId,
        productionProfile,
      );
    } catch {
      return { eligible: false, reason: "authority_unavailable" };
    }
    if (productionUnlockAuthorizes(existingUnlock, { projectId, productionProfile })) {
      // Already bought. Refusing here is the cheap, obvious guard; the durable
      // one is the partial unique index on `production_unlocks`, which makes a
      // second active unlock impossible regardless.
      return { eligible: false, reason: "already_unlocked" };
    }

    // 3. Is "unlock this design for production" a TRUTHFUL offer?
    if (snapshot.project.revisionPending) {
      // The customer has said the current artwork is not what they want.
      // Selling them production preparation at that moment would be selling
      // preparation of a design they have already rejected.
      return { eligible: false, reason: "revision_pending" };
    }

    const requestedOutput = normalizeProductionIntent(
      snapshot.brief.requestedProductionOutput,
    );
    if (isUnsupportedRequestedProductionOutput(requestedOutput)) {
      // They have asked for an artifact V1 does not produce. Commercial
      // permission never manufactures technical capability (§23c) — and taking
      // money first and refusing to deliver afterwards is the worst possible
      // ordering of those two facts.
      return { eligible: false, reason: "unsupported_production_output" };
    }

    if (!(await hasSomethingToPurchase(repo, projectId, snapshot))) {
      return { eligible: false, reason: "nothing_to_purchase" };
    }

    // 4. Can this deployment actually take money?
    if (!provider) return { eligible: false, reason: "provider_unavailable" };
    if (!publicBaseUrl) return { eligible: false, reason: "provider_unavailable" };
    if (!(KNOWN_PAYMENT_PROVIDERS as readonly string[]).includes(provider.providerKey)) {
      return { eligible: false, reason: "provider_unavailable" };
    }

    const offer = readOffer();
    if (offer.mode !== "configured") {
      console.info("Production unlock offer unavailable", {
        projectId,
        safeErrorCode: offer.safeErrorCode,
        internalReason: offer.internalReason,
      });
      return { eligible: false, reason: "offer_unavailable" };
    }
    if (offer.productionProfile !== productionProfile) {
      // The configured offer is for a profile this checkout is not selling.
      // Unreachable today (both are the single V1 constant) and checked
      // anyway, because the day a second profile exists this is the line that
      // stops one being sold under the other's price.
      return { eligible: false, reason: "offer_unavailable" };
    }

    return {
      eligible: true,
      snapshot,
      acquisitionSessionId,
      email: session.email,
      productionProfile,
      providerKey: provider.providerKey as PaymentProviderKey,
      offer,
      publicBaseUrl,
      provider,
    };
  }

  return {
    async createCheckout(projectId) {
      const eligibility = await resolveEligibility(projectId);
      if (!eligibility.eligible) {
        return refuse(projectId, eligibility.reason);
      }
      const {
        acquisitionSessionId,
        email,
        productionProfile,
        providerKey,
        offer,
      } = eligibility;

      // ---------------------------------------------------------------
      // 5. Open or resume exactly ONE outstanding attempt.
      // ---------------------------------------------------------------

      let transaction: PaymentTransaction;
      let reused: boolean;

      const outstanding = await repo.getOutstandingPaymentTransaction(
        projectId,
        productionProfile,
      );

      if (outstanding && isUsableCheckout(outstanding)) {
        // A live checkout session already exists. Hand back the SAME URL: a
        // second tab must land on the same payment page, not a second one.
        return {
          ok: true,
          checkoutUrl: outstanding.providerCheckoutUrl,
          reused: true,
        };
      }

      if (outstanding) {
        // `pending_provider` — a previous attempt never recorded a session.
        // Either the provider call failed ambiguously, or the process died
        // between Stripe answering and us persisting the answer. RESUME it:
        // replaying the same transaction id as the idempotency key returns
        // the original session if one exists, and creates one if it does not.
        transaction = outstanding;
        reused = true;
      } else {
        const opening = await repo.openPaymentTransaction(projectId, {
          acquisitionSessionId,
          productionProfile,
          provider: providerKey,
          amountMinor: offer.amountMinor,
          currency: offer.currency,
        });
        // The loser of a genuine race gets the winner. If the winner is
        // already usable we are done; otherwise both callers converge on
        // resuming the same pre-provider row under the same idempotency key,
        // so only one provider session can ever result.
        if (opening.outcome === "existing" && isUsableCheckout(opening.transaction)) {
          return {
            ok: true,
            checkoutUrl: opening.transaction.providerCheckoutUrl,
            reused: true,
          };
        }
        transaction = opening.transaction;
        reused = opening.outcome === "existing";
      }

      // The offer is read off the ROW from here on — frozen at open time.
      const frozen = readFrozenOffer(transaction);
      if (!frozen) {
        console.error(
          "Payment transaction carries values this build cannot interpret; refusing to contact the provider",
          { projectId, paymentTransactionId: transaction.id },
        );
        return refuse(projectId, "frozen_offer_unreadable");
      }
      if (frozen.provider !== providerKey) {
        // The deployment's provider changed while an attempt was outstanding.
        // A session created at one provider cannot be resumed at another, and
        // guessing would either strand the customer or double-charge them.
        return refuse(projectId, "provider_mismatch");
      }

      // ---------------------------------------------------------------
      // 6. The external side-effect window.
      //
      //    Stripe and PostgreSQL are not atomic and this code does not
      //    pretend they are. The durable row already exists and already
      //    holds the idempotency key, so every outcome converges:
      //
      //      success              → bound to `created`
      //      provably not sent    → `failed`, slot freed, retry is clean
      //      ambiguous / crash    → stays `pending_provider`; the next
      //                             attempt replays the SAME key and the
      //                             provider returns the SAME session
      // ---------------------------------------------------------------

      const returnUrls = buildCheckoutReturnUrls(
        eligibility.publicBaseUrl,
        projectId,
      );

      let created;
      try {
        created = await eligibility.provider.createProductionUnlockCheckout({
          paymentTransactionId: transaction.id,
          projectId,
          productionProfile: frozen.productionProfile,
          amountMinor: frozen.amountMinor,
          currency: frozen.currency,
          providerPriceId: offer.providerPriceId,
          // Server-side, from the session the PROJECT is bound to. Never
          // returned to a browser, so there is no round trip in which a
          // client could substitute one.
          customerEmail: email,
          successUrl: returnUrls.successUrl,
          cancelUrl: returnUrls.cancelUrl,
        });
      } catch (error) {
        return await handleProviderFailure(repo, projectId, transaction, error, refuse);
      }

      const bound = await repo.bindProviderCheckoutSession(transaction.id, {
        providerCheckoutSessionId: created.providerCheckoutSessionId,
        providerCheckoutUrl: created.checkoutUrl,
        providerPaymentIntentId: created.providerPaymentIntentId,
      });

      // A concurrent caller may have bound first. Whatever the row says now is
      // the truth, and it is what the customer is sent to — never the local
      // variable, which could describe a session that lost the race.
      if (isUsableCheckout(bound)) {
        return { ok: true, checkoutUrl: bound.providerCheckoutUrl, reused };
      }

      // The provider gave us a session but persistence did not take. The
      // session genuinely exists, so the customer is still sent to it and the
      // row stays resumable — the next attempt replays the same key and binds
      // the same session rather than creating a second one.
      console.error(
        "Provider checkout session was created but could not be bound to its transaction",
        { projectId, paymentTransactionId: transaction.id },
      );
      return { ok: true, checkoutUrl: created.checkoutUrl, reused };
    },

    async handleWebhook(input) {
      // A deployment with no provider configured has no signing secret and
      // therefore no way to verify anything. Rejected rather than
      // acknowledged: acknowledging would tell a caller that an unverifiable
      // request was accepted.
      if (!provider) {
        console.warn("Payment webhook received while no provider is configured");
        return { status: "rejected" };
      }

      // (1) VERIFY FIRST. Nothing below this line has looked at the body.
      const verification = provider.verifyWebhook({
        rawBody: input.rawBody,
        signatureHeader: input.signatureHeader,
        nowSeconds: input.nowSeconds,
      });

      if (!verification.verified) {
        // Logged with the internal reason, answered with nothing. An attacker
        // probing this endpoint must not learn which part of their forgery
        // failed, and a legitimate misconfiguration is diagnosable from the
        // server's own logs.
        console.warn("Payment webhook signature rejected", {
          internalReason: verification.internalReason,
        });
        return { status: "rejected" };
      }

      const event = verification.event;

      // (2) Guard the provider vocabulary at the boundary. The adapter is
      // ours, so this is unreachable today; it exists because the day a second
      // provider is added, this is the line that stops one provider's event
      // being recorded under another's name.
      if (
        !(KNOWN_PAYMENT_PROVIDERS as readonly string[]).includes(
          provider.providerKey,
        )
      ) {
        console.error("Payment webhook from an unrecognized provider adapter");
        return { status: "rejected" };
      }

      // (3) ONE atomic call. Recording the event, reconciling it, marking the
      // transaction paid, and activating the unlock happen together or not at
      // all — see `ProjectRepository.applyPaymentEvent`.
      //
      // Everything below is a LOOKUP HANDLE or a value to be COMPARED. There
      // is deliberately no project id, acquisition session id, or production
      // profile in this call: the transaction row owns them, and a webhook
      // able to supply them could unlock a different customer's project.
      let outcome: PaymentEventApplication;
      try {
        outcome = await repo.applyPaymentEvent({
          provider: provider.providerKey as PaymentProviderKey,
          providerEventId: event.providerEventId,
          eventType: event.eventType,
          payloadDigest: verification.payloadDigest,
          action: event.action,
          paymentTransactionId: event.paymentTransactionId,
          providerCheckoutSessionId: event.providerCheckoutSessionId,
          providerPaymentIntentId: event.providerPaymentIntentId,
          amountMinor: event.amountMinor,
          currency: event.currency,
        });
      } catch (error) {
        // A genuine infrastructure fault, not a business refusal. Rethrown so
        // the route answers 5xx and the provider RETRIES — which is correct
        // here and only here: the event was real and may still be applicable
        // once the database is reachable again.
        console.error("Payment webhook reconciliation failed", {
          providerEventId: event.providerEventId,
          eventType: event.eventType,
        });
        throw error;
      }

      // Logged at info with no customer content: an event id, a provider event
      // type, and what we did. No email, no amount, no project, no payload.
      console.info("Payment webhook processed", {
        providerEventId: event.providerEventId,
        eventType: event.eventType,
        outcome,
      });

      // Every decided outcome is acknowledged, including the refusals. They
      // are FINAL — redelivery would reach the same conclusion — and answering
      // anything else would make a permanent refusal an infinite retry loop.
      return { status: "acknowledged", outcome };
    },

    async describeForCustomer(projectId) {
      const productionProfile = APPAREL_RASTER_PRODUCTION_PROFILE;

      // THE ENTITLEMENT IS CHECKED FIRST, and it is the only thing that can
      // produce `production_unlocked`. Deliberately not routed through
      // `resolveEligibility`, which reports an active unlock as a REFUSAL
      // ("already_unlocked") because its question is "may they buy?". Asking
      // the entitlement directly here keeps the paid state sourced from the
      // entitlement record rather than inferred from a refusal reason.
      let unlock;
      try {
        unlock = await repo.getActiveProductionUnlock(projectId, productionProfile);
      } catch {
        return { state: "unavailable", offer: null, checkoutPending: false };
      }
      if (productionUnlockAuthorizes(unlock, { projectId, productionProfile })) {
        return { state: "production_unlocked", offer: null, checkoutPending: false };
      }

      const eligibility = await resolveEligibility(projectId);

      if (!eligibility.eligible) {
        // The two genuinely different kinds of "no offer", distinguished
        // because the customer sees different things:
        //
        //   nothing to sell     → no payment surface at all. Not an error, not
        //                         a promise, just not the moment.
        //   cannot sell now     → a neutral unavailable note. Never a checkout
        //                         button that is certain to fail.
        //
        // `already_unlocked` cannot appear here — the entitlement check above
        // has already returned for that case.
        const cannotSellRightNow =
          eligibility.reason === "authority_unavailable" ||
          eligibility.reason === "offer_unavailable" ||
          eligibility.reason === "provider_unavailable";

        return {
          state: cannotSellRightNow ? "unavailable" : "not_applicable",
          offer: null,
          checkoutPending: false,
        };
      }

      // An outstanding attempt means a payment page was opened. It is NOT
      // evidence anybody paid — see `CustomerPaymentView.checkoutPending`.
      let checkoutPending = false;
      try {
        const outstanding = await repo.getOutstandingPaymentTransaction(
          projectId,
          productionProfile,
        );
        checkoutPending = isOutstandingPaymentTransaction(outstanding);
      } catch {
        // Unreadable is not "pending". The consequence of guessing wrong here
        // is a confirmation spinner shown to somebody who never paid, so the
        // safe direction is the one that keeps offering the purchase.
        checkoutPending = false;
      }

      return {
        state: "payment_required",
        offer: {
          title: PRODUCTION_UNLOCK_OFFER_TITLE,
          description: PRODUCTION_UNLOCK_OFFER_DESCRIPTION,
          displayAmount: formatOfferAmount(
            eligibility.offer.amountMinor,
            eligibility.offer.currency,
          ),
        },
        checkoutPending,
      };
    },
  };
}

/**
 * The pre-provider failure policy, in one place because getting it wrong in
 * either direction is expensive.
 *
 *   PROVABLY NOT DISPATCHED → mark the attempt `failed`, freeing the
 *     outstanding slot. Nothing exists at the provider, so a fresh attempt is
 *     clean, and leaving the slot occupied would lock the customer out of
 *     checkout over a transient credential or configuration error.
 *
 *   ANYTHING ELSE → leave it `pending_provider`. A session may really exist.
 *     Freeing the slot would let a second checkout start alongside it, which
 *     is precisely how a customer ends up looking at two payment pages — and
 *     potentially paying twice — for one purchase. The attempt stays
 *     resumable on the same idempotency key instead.
 *
 * Reuses `isPossiblyBilledProviderError`, the same helper the paid-image and
 * final-artwork paths use, rather than inventing a second reading of the same
 * `ProviderError.dispatch` axis.
 */
async function handleProviderFailure(
  repo: ProjectRepository,
  projectId: string,
  transaction: PaymentTransaction,
  error: unknown,
  refuse: (projectId: string, reason: CheckoutRefusalReason) => CreateCheckoutResult,
): Promise<CreateCheckoutResult> {
  const classification =
    error instanceof ProviderError ? error.classification : "unknown";
  const dispatch = error instanceof ProviderError ? error.dispatch : "dispatched_ambiguous";

  // Never the provider's raw error text — it can name endpoints, parameters,
  // and account state. Classification and dispatch only.
  console.error("Production unlock checkout provider call failed", {
    projectId,
    paymentTransactionId: transaction.id,
    classification,
    dispatch,
  });

  if (!isPossiblyBilledProviderError(error) && dispatch === "not_dispatched") {
    try {
      await repo.failPendingPaymentTransaction(transaction.id, classification);
    } catch {
      // The attempt simply stays `pending_provider` and is resumed next time.
      // Failing to close a row must never turn into a customer-visible error
      // on top of the one that already happened.
    }
  }

  return refuse(projectId, "provider_failed");
}

/**
 * "Is `unlock this design for production` a truthful thing to say about this
 * project right now?"
 *
 * BOTH WORKFLOWS REACH CHECKOUT FROM THEIR OWN EXISTING DURABLE AUTHORITY.
 * This deliberately does not invent a new approval requirement, and in
 * particular does not require a `FinalDirectionApproval` — that record is
 * created BY finalization, which is the thing being purchased, so requiring
 * it would make checkout unreachable for everyone.
 *
 *   Create New        a generated concept has actually been DELIVERED
 *                     (`hasDeliveredGeneratedConcept` — the same shared rule
 *                     the concept grid and the acquisition email gate use, so
 *                     "there is a design" cannot mean three different things)
 *                     AND the customer has selected one. "This design" needs
 *                     a referent, and selection is what supplies it.
 *
 *   Existing Artwork  an `ArtworkPreparation` the customer has APPROVED —
 *                     exactly the authority `requestPreparedUploadFinalArtwork`
 *                     already requires, and the only design decision an
 *                     upload customer ever makes.
 *
 * Deliberately NOT requiring `finalDirectionConfirmed` on the Create New
 * path. That flag means "no more changes, produce this" and is the
 * FINALIZATION gate, where it stays; it is also reset by re-selecting a
 * concept. Demanding it before payment would ask a customer to promise they
 * are done revising in order to buy — and would import a resettable flag into
 * the commerce path, which is the same class of mistake as binding the
 * entitlement to a supersedable approval. Selection is the honest, sufficient
 * referent for "this design"; confirmation remains where it belongs.
 */
async function hasSomethingToPurchase(
  repo: ProjectRepository,
  projectId: string,
  snapshot: Awaited<ReturnType<ProjectRepository["getProject"]>>,
): Promise<boolean> {
  if (!snapshot) return false;

  // Existing Artwork first: an upload project has no generated concepts at
  // all, and checking it first keeps the two workflows' conditions
  // independent rather than nested.
  try {
    const preparation = await repo.getArtworkPreparation(projectId);
    if (
      preparation &&
      preparation.projectId === projectId &&
      preparation.status === "approved" &&
      preparation.preparedArtworkVersionId &&
      preparation.preparedAssetId
    ) {
      return true;
    }
  } catch {
    // An unreadable preparation is not evidence of one. Fall through to the
    // Create New condition, which will also fail closed if nothing is there.
  }

  const delivered = hasDeliveredGeneratedConcept({
    status: snapshot.project.status,
    artworkVersions: snapshot.artworkVersions,
    messages: snapshot.messages,
  });
  if (!delivered) return false;

  return snapshot.project.selectedArtworkVersionId !== null;
}

/**
 * Re-exported for the A5.3 test suite's outstanding-attempt assertions —
 * keeps the domain predicate and the capability's reading of it provably the
 * same function rather than two that happen to agree today.
 */
export { isOutstandingPaymentTransaction };
