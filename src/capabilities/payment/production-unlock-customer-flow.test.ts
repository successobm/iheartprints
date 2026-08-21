import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { PNG } from "pngjs";

import { createAcquisitionCapability } from "@/capabilities/acquisition";
import { DataUriAssetStorageProvider } from "@/capabilities/asset-storage";
import { createAssetCapability, PngThumbnailGenerator } from "@/capabilities/assets";
import { createConceptGenerationCapability } from "@/capabilities/concept-generation";
import { createConversationCapability } from "@/capabilities/conversation";
import { createFinalArtworkCapability } from "@/capabilities/final-artwork";
import { createGenerationWorkerCapability } from "@/capabilities/generation-worker";
import { createPaymentCapability } from "@/capabilities/payment";
import type { ConceptGenerationProvider } from "@/capabilities/providers";
import type {
  ConceptGenerationRequest,
  ConceptGenerationResult,
} from "@/capabilities/shared/contracts";
import type { ProductionUnlockOfferConfig } from "@/lib/config/production-unlock-offer-config";
import type { ProjectRepository } from "@/lib/db/repository";
import { APPAREL_RASTER_PRODUCTION_PROFILE } from "@/lib/domain/types";
import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";
import { runAdaptiveInterviewToSummary } from "@/test-support/run-adaptive-interview";

import { resolveProductionUnlockSurface } from "./customer-payment-view";
import { StripeCheckoutProvider } from "./stripe-checkout-provider";
import { buildStripeSignatureHeader } from "./stripe-webhook-signature";
import { confirmProductionSizeForTests } from "@/test-support/confirm-production-size";

/**
 * Sprint A5.5 — THE CUSTOMER JOURNEY, end to end.
 *
 * Walks the whole funnel a real person walks — free concept, email, choose a
 * design, unlock, come back, get confirmed, finalize — and asserts at every
 * step BOTH what the customer would see (the resolved surface) and what the
 * server would permit. A UI test that only checked pixels could pass while
 * the server refused; a server test alone could pass while the customer was
 * shown a dead end. The dead end is what this sprint exists to remove, so
 * both halves are asserted together.
 *
 * NO LIVE STRIPE. The checkout adapter's `fetchImpl` throws on any non-Stripe
 * URL, and webhook verification is pure computation over bytes supplied here.
 */

const WEBHOOK_SECRET = "whsec_test_0123456789abcdefghij";
const API_SECRET = "sk_test_0123456789abcdefghij";
const PUBLIC_BASE_URL = "https://iheartprints.example";
const NOW_SECONDS = 1_700_000_000;

const CONFIGURED_OFFER: ProductionUnlockOfferConfig = {
  mode: "configured",
  productionProfile: APPAREL_RASTER_PRODUCTION_PROFILE,
  amountMinor: 4900,
  currency: "usd",
  providerPriceId: null,
};

function tinyPng(): Buffer {
  const png = new PNG({ width: 4, height: 4 });
  png.data.fill(128);
  return PNG.sync.write(png);
}

class CountingConceptProvider implements ConceptGenerationProvider {
  readonly providerKey = "counting";
  readonly editsSourceArtwork = false;
  calls: ConceptGenerationRequest[] = [];
  async generate(r: ConceptGenerationRequest): Promise<ConceptGenerationResult> {
    this.calls.push(r);
    return {
      jobId: r.idempotencyKey,
      providerKey: this.providerKey,
      concepts: Array.from({ length: r.conceptCount }, (_, i) => ({
        versionNumber: i + 1,
        title: `Concept ${i + 1}`,
        summary: `Concept ${i + 1}`,
        placeholderLabel: `Concept ${String.fromCharCode(65 + i)}`,
        accentColor: "#123456",
        kind: "concept" as const,
        asset: {
          imageBytes: tinyPng(),
          contentType: "image/png",
          widthPx: 4,
          heightPx: 4,
          hasTransparency: true,
          providerMetadata: {},
        },
      })),
    };
  }
}

let fakeSessionCounter = 0;
let fakeIntentCounter = 0;

function fakeStripeFetch() {
  const fetchImpl = (async (url: string | URL | Request) => {
    const target = String(url);
    if (!target.startsWith("https://api.stripe.com/")) {
      throw new Error(`unexpected network call to ${target}`);
    }
    const index = (fakeSessionCounter += 1);
    return new Response(
      JSON.stringify({
        id: `cs_flow_${index}`,
        url: `https://checkout.stripe.test/c/${index}`,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  return fetchImpl;
}

function paidEventBody(input: {
  eventId: string;
  sessionId: string;
  transactionId: string;
}): string {
  return JSON.stringify({
    id: input.eventId,
    object: "event",
    type: "checkout.session.completed",
    data: {
      object: {
        id: input.sessionId,
        object: "checkout.session",
        payment_status: "paid",
        amount_total: 4900,
        currency: "usd",
        payment_intent: `pi_flow_${(fakeIntentCounter += 1)}`,
        customer_email: "eric@example.com",
        metadata: { iheartprints_payment_transaction_id: input.transactionId },
        client_reference_id: input.transactionId,
      },
    },
  });
}

describe("Sprint A5.5 — the customer production-unlock journey", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-unlock-ui-"));
    process.chdir(tempDir);
  });

  after(async () => {
    await cleanupTempWorkspace(tempDir, previousCwd);
  });

  async function buildHarness(
    offer: ProductionUnlockOfferConfig = CONFIGURED_OFFER,
    providerEnabled = true,
  ) {
    const { LocalProjectRepository } = await import("@/lib/db/local-store");
    const { createCapabilityGraph } = await import("@/capabilities/composition");

    const repo: ProjectRepository = new LocalProjectRepository();
    for (;;) {
      const stale = await repo.claimNextQueuedJob();
      if (!stale) break;
      await repo.updateGenerationJob(stale.id, { status: "cancelled" });
    }

    const graph = createCapabilityGraph(repo);
    const conceptProvider = new CountingConceptProvider();
    const assets = createAssetCapability(
      repo,
      new DataUriAssetStorageProvider(),
      new PngThumbnailGenerator(),
    );

    const acquisition = createAcquisitionCapability(repo);
    const conceptGeneration = createConceptGenerationCapability(
      repo,
      conceptProvider.providerKey,
      graph.ipSafety,
      acquisition,
    );
    const finalArtwork = createFinalArtworkCapability(repo, acquisition);
    const worker = createGenerationWorkerCapability(
      repo,
      conceptProvider,
      graph.promptTranslation,
      assets,
      graph.conceptEvaluation,
      graph.revisionIntelligence,
      graph.printValidation,
      graph.ipSafety,
    );
    const conversation = createConversationCapability({
      repo,
      intentExtraction: graph.intentExtraction,
      conversationUnderstanding: graph.conversationUnderstanding,
      designBrief: graph.designBrief,
      briefEvaluation: graph.briefEvaluation,
      designIntelligence: graph.designIntelligence,
      interviewIntelligence: graph.interviewIntelligence,
      revisionIntelligence: graph.revisionIntelligence,
      designSummary: graph.designSummary,
      conceptGeneration,
      finalArtwork,
      ipSafety: graph.ipSafety,
      acquisition,
    });

    const paymentProvider = providerEnabled
      ? new StripeCheckoutProvider({
          secretKey: API_SECRET,
          webhookSecret: WEBHOOK_SECRET,
          fetchImpl: fakeStripeFetch(),
          nowSeconds: () => NOW_SECONDS,
        })
      : null;

    const payment = createPaymentCapability(
      repo,
      paymentProvider,
      providerEnabled ? PUBLIC_BASE_URL : null,
      () => offer,
    );

    return {
      repo,
      acquisition,
      conversation,
      finalArtwork,
      worker,
      payment,
      conceptProvider,
    };
  }

  type Harness = Awaited<ReturnType<typeof buildHarness>>;

  let tokenCounter = 0;
  const newToken = () => `flow-token-${(tokenCounter += 1)}`;

  /** What the customer would actually see right now. */
  async function surfaceFor(
    harness: Harness,
    projectId: string,
    returnedFromCheckout = false,
  ) {
    const payment = await harness.payment.describeForCustomer(projectId);
    return {
      payment,
      surface: resolveProductionUnlockSurface({ payment, returnedFromCheckout }),
    };
  }

  async function deliverWebhook(harness: Harness, rawBody: string) {
    return harness.payment.handleWebhook({
      rawBody,
      signatureHeader: buildStripeSignatureHeader({
        rawBody,
        secret: WEBHOOK_SECRET,
        timestampSeconds: NOW_SECONDS,
      }),
      nowSeconds: NOW_SECONDS,
    });
  }

  /** No assistant message may ever mention money. */
  async function assertTranscriptHasNoCommercialCopy(
    harness: Harness,
    projectId: string,
  ) {
    const snapshot = await harness.conversation.get(projectId);
    const assistantText = (snapshot?.messages ?? [])
      .filter((m) => m.role === "assistant")
      .map((m) => m.content)
      .join("\n")
      .toLowerCase();

    for (const forbidden of [
      "unlock this design",
      "pay now",
      "payment",
      "checkout",
      "$",
      "price",
      "purchase",
      "card",
    ]) {
      assert.equal(
        assistantText.includes(forbidden),
        false,
        `the transcript must not carry commercial copy ("${forbidden}") — payment state belongs in the card`,
      );
    }
  }

  /* ================================================================== */
  /* THE CREATE NEW JOURNEY, step by step                                */
  /* ================================================================== */

  it("A: free concept → email → select → unlock → confirm → finalize", async () => {
    const harness = await buildHarness();
    const sessionId = (await harness.repo.createAcquisitionSession(newToken())).id;

    // 1. One free concept.
    const { projectId } = await runAdaptiveInterviewToSummary(
      harness.conversation,
      // Print'em All Phase 1: the print location is answered during the
      // interview, so the project has a placement to recommend and confirm a
      // production size against.
      { printLocation: "Full front" },
      sessionId,
    );
    await harness.conversation.submitDesignBriefDecision(projectId, "approve");
    await harness.worker.processNextJob();

    // 2. The email gate. Nothing commercial yet — there is no address to
    //    send a receipt to, so there is nothing to sell.
    let view = await surfaceFor(harness, projectId);
    assert.equal(
      (await harness.acquisition.describeForCustomer(projectId, { generating: false }))
        .state,
      "email_required",
    );
    assert.equal(view.surface, "none", "never ask for money before an address");

    // 3. Email captured. Still nothing to buy — no design has been chosen, so
    //    "unlock THIS design" would have no referent.
    await harness.acquisition.captureEmail(projectId, "eric@example.com");
    view = await surfaceFor(harness, projectId);
    assert.equal(view.surface, "none");

    // 4. The customer chooses a design. SELECTION IS FREE — the thing they
    //    are about to be asked to buy must be selectable first.
    const snapshot = await harness.conversation.get(projectId);
    const artworkVersionId = snapshot!.artworkVersions[0]!.id;
    await harness.conversation.selectConcept(projectId, artworkVersionId);

    // 5. NOW the offer appears.
    view = await surfaceFor(harness, projectId);
    assert.equal(view.surface, "payment_required");
    assert.equal(view.payment.offer?.displayAmount, "$49.00");
    assert.match(view.payment.offer!.title, /Unlock this design for production/);
    assert.equal(view.payment.checkoutPending, false);
    // Still locked, server-side.
    assert.equal(
      (await harness.acquisition.authorizeFinalization(projectId)).allowed,
      false,
    );

    // 6. Checkout.
    const checkout = await harness.payment.createCheckout(projectId);
    assert.equal(checkout.ok, true);
    if (!checkout.ok) return;
    assert.match(checkout.checkoutUrl, /^https:\/\/checkout\.stripe\.test\//);

    const transaction = await harness.repo.getOutstandingPaymentTransaction(
      projectId,
      APPAREL_RASTER_PRODUCTION_PROFILE,
    );
    assert.equal(transaction?.status, "created");

    // 7. The browser comes back BEFORE the webhook.
    view = await surfaceFor(harness, projectId, true);
    assert.equal(view.payment.state, "payment_required", "still not paid");
    assert.equal(view.surface, "payment_processing");
    assert.equal(
      (await harness.acquisition.authorizeFinalization(projectId)).allowed,
      false,
      "the redirect must not unlock finalization",
    );

    // 8. The verified webhook lands.
    const applied = await deliverWebhook(
      harness,
      paidEventBody({
        eventId: "evt_flow_A",
        sessionId: transaction!.providerCheckoutSessionId!,
        transactionId: transaction!.id,
      }),
    );
    assert.equal(applied.status === "acknowledged" && applied.outcome, "processed");

    // 9. The next poll/refresh shows unlocked — with or without the hint.
    for (const returned of [true, false]) {
      const after = await surfaceFor(harness, projectId, returned);
      assert.equal(after.surface, "production_unlocked");
      assert.equal(after.payment.offer, null, "no price is shown once bought");
    }

    // 10. Finalization is now genuinely available, and the customer starts it.
    assert.equal(
      (await harness.acquisition.authorizeFinalization(projectId)).allowed,
      true,
    );
    await harness.conversation.confirmSelectedDirection(projectId, artworkVersionId);
    // Print'em All Phase 1: the commercial gate and the PRODUCTION SIZE
    // gate are independent dimensions. These scenarios are about the first
    // one, so the second is satisfied here — an unlock buys the right to
    // finalize, never the right to skip confirming how large the print is.
    await confirmProductionSizeForTests(harness.repo, projectId);
    const finalized = await harness.finalArtwork.requestFinalArtwork(
      projectId,
      artworkVersionId,
    );
    assert.equal(finalized.job.status, "queued");

    // 11. Generation is STILL locked. Paid does not mean unlimited AI.
    assert.equal(
      (await harness.acquisition.authorizeConceptGeneration(projectId)).allowed,
      false,
    );

    // 12. And no assistant message ever mentioned money.
    await assertTranscriptHasNoCommercialCopy(harness, projectId);
  });

  /* ================================================================== */
  /* THE EXISTING ARTWORK JOURNEY                                        */
  /* ================================================================== */

  async function uploadReady(harness: Harness) {
    const sessionId = (await harness.repo.createAcquisitionSession(newToken())).id;
    const created = await harness.repo.createProject(sessionId);
    const projectId = created.project.id;

    await harness.repo.updateBrief(projectId, {
      productSummary: "T-shirts for our bowling team",
      shirtColor: "Black",
      printPlacement: "left_chest",
    });
    // Print'em All Phase 1: a resolvable width is no longer enough — the
    // upload finalization path requires an explicit CONFIRMED size, which
    // is a production-safety gate and not a commercial one.
    await confirmProductionSizeForTests(harness.repo, projectId);

    const asset = (kind: "customer_upload" | "png", name: string) =>
      harness.repo.createAsset(projectId, {
        kind,
        storageKey: `local/${projectId}/${name}.png`,
        contentType: "image/png",
        isThumbnail: false,
        widthPx: 1200,
        heightPx: 1200,
        hasTransparency: kind === "png",
        providerKey: null,
        generationJobId: null,
        metadata: {},
        vectorAssetId: null,
        printAssetId: null,
        finalArtworkJobId: null,
        productionRole: null,
      });

    const original = await asset("customer_upload", "original");
    const prepared = await asset("png", "prepared");
    const preparation = await harness.repo.createArtworkPreparation(projectId, {
      originalAssetId: original.id,
      originalFilename: "split disturbers.png",
      analysis: { widthPx: 1200, heightPx: 1200 },
    });
    const [artwork] = await harness.repo.addArtworkVersions(projectId, [
      {
        versionNumber: 1,
        kind: "prepared_upload",
        title: "Your artwork, prepared",
        summary: "Prepared upload.",
        placeholderLabel: "Your artwork",
        accentColor: "#173F35",
        designBriefVersionId: null,
        generationJobId: null,
        providerKey: null,
        primaryAssetId: prepared.id,
        thumbnailAssetId: null,
        sourceArtworkVersionId: null,
        conceptDirectionKey: null,
      },
    ]);
    await harness.repo.updateArtworkPreparation(preparation.id, {
      status: "approved",
      preparedAssetId: prepared.id,
      preparedArtworkVersionId: artwork!.id,
      approvedAt: new Date().toISOString(),
    });
    await harness.repo.setProjectStatus(projectId, "approved");
    return { sessionId, projectId, preparationId: preparation.id };
  }

  it("B: Existing Artwork gets the same offer from its OWN authority", async () => {
    const harness = await buildHarness();
    const { projectId } = await uploadReady(harness);

    // Before an email: nothing commercial, same rule as Create New.
    assert.equal((await surfaceFor(harness, projectId)).surface, "none");

    await harness.acquisition.captureEmail(projectId, "eric@example.com");

    // No concept, no selection, no final-direction approval — an upload
    // customer never makes those decisions, and the offer appears anyway.
    const view = await surfaceFor(harness, projectId);
    assert.equal(view.surface, "payment_required");
    assert.match(view.payment.offer!.title, /Unlock this design for production/);

    const checkout = await harness.payment.createCheckout(projectId);
    assert.equal(checkout.ok, true);
    const transaction = await harness.repo.getOutstandingPaymentTransaction(
      projectId,
      APPAREL_RASTER_PRODUCTION_PROFILE,
    );

    await assert.rejects(() =>
      harness.finalArtwork.requestPreparedUploadFinalArtwork(projectId),
    );

    await deliverWebhook(
      harness,
      paidEventBody({
        eventId: "evt_flow_B",
        sessionId: transaction!.providerCheckoutSessionId!,
        transactionId: transaction!.id,
      }),
    );

    assert.equal(
      (await surfaceFor(harness, projectId)).surface,
      "production_unlocked",
    );
    const result =
      await harness.finalArtwork.requestPreparedUploadFinalArtwork(projectId);
    assert.equal(result.job.sourceKind, "prepared_upload");

    await assertTranscriptHasNoCommercialCopy(harness, projectId);
  });

  /* ================================================================== */
  /* Ordering, reload, and the states in between                         */
  /* ================================================================== */

  it("C: webhook BEFORE redirect lands straight on unlocked — no confirmation flash", async () => {
    const harness = await buildHarness();
    const { projectId } = await uploadReady(harness);
    await harness.acquisition.captureEmail(projectId, "eric@example.com");
    await harness.payment.createCheckout(projectId);
    const transaction = await harness.repo.getOutstandingPaymentTransaction(
      projectId,
      APPAREL_RASTER_PRODUCTION_PROFILE,
    );

    await deliverWebhook(
      harness,
      paidEventBody({
        eventId: "evt_flow_C",
        sessionId: transaction!.providerCheckoutSessionId!,
        transactionId: transaction!.id,
      }),
    );

    // The browser arrives afterwards, carrying the hint. It must NOT show a
    // spinner for a payment that is already confirmed.
    assert.equal(
      (await surfaceFor(harness, projectId, true)).surface,
      "production_unlocked",
    );
  });

  it("D: cancelling returns the customer to the offer, with nothing granted", async () => {
    const harness = await buildHarness();
    const { projectId } = await uploadReady(harness);
    await harness.acquisition.captureEmail(projectId, "eric@example.com");
    await harness.payment.createCheckout(projectId);

    // `?checkout=cancelled` is not the completion hint, so the surface is
    // whatever the server says — the offer, unchanged.
    const view = await surfaceFor(harness, projectId, false);
    assert.equal(view.surface, "payment_required");
    assert.equal(view.payment.checkoutPending, true, "the attempt is still open");
    assert.equal(
      await harness.repo.getActiveProductionUnlock(
        projectId,
        APPAREL_RASTER_PRODUCTION_PROFILE,
      ),
      null,
    );

    // And clicking again reuses the SAME payment page rather than opening a
    // second one (A5.3's outstanding-attempt authority).
    const again = await harness.payment.createCheckout(projectId);
    assert.equal(again.ok && again.reused, true);
  });

  it("E: every state survives a reload, because none of it is client-side", async () => {
    const harness = await buildHarness();
    const { projectId } = await uploadReady(harness);
    await harness.acquisition.captureEmail(projectId, "eric@example.com");

    // A reload is exactly "ask the server again" — asserted by reading the
    // view twice at each stage and requiring identical answers.
    const stable = async (returned = false) => {
      const first = await surfaceFor(harness, projectId, returned);
      const second = await surfaceFor(harness, projectId, returned);
      assert.deepEqual(second.payment, first.payment);
      assert.equal(second.surface, first.surface);
      return first.surface;
    };

    assert.equal(await stable(), "payment_required");

    await harness.payment.createCheckout(projectId);
    assert.equal(await stable(), "payment_required");
    assert.equal(await stable(true), "payment_processing");

    const transaction = await harness.repo.getOutstandingPaymentTransaction(
      projectId,
      APPAREL_RASTER_PRODUCTION_PROFILE,
    );
    await deliverWebhook(
      harness,
      paidEventBody({
        eventId: "evt_flow_E",
        sessionId: transaction!.providerCheckoutSessionId!,
        transactionId: transaction!.id,
      }),
    );
    assert.equal(await stable(), "production_unlocked");
    assert.equal(await stable(true), "production_unlocked");
  });

  it("F: a deployment that cannot sell shows a neutral note, never a doomed button", async () => {
    for (const harness of [
      await buildHarness({
        mode: "unavailable",
        safeErrorCode: "PRODUCTION_UNLOCK_PRICE_NOT_CONFIGURED",
        internalReason: "unset",
      }),
      await buildHarness(CONFIGURED_OFFER, false),
    ]) {
      const { projectId } = await uploadReady(harness);
      await harness.acquisition.captureEmail(projectId, "eric@example.com");

      const view = await surfaceFor(harness, projectId);
      assert.equal(view.surface, "unavailable");
      assert.equal(view.payment.offer, null, "no price when none is configured");
    }
  });

  it("G: an internal session is never shown an offer — it is already entitled", async () => {
    const harness = await buildHarness();
    const session = await harness.repo.createAcquisitionSession(newToken());
    await harness.repo.grantInternalEntitlement(session.id);

    const created = await harness.repo.createProject(session.id);
    const view = await surfaceFor(harness, created.project.id);
    assert.equal(view.surface, "none");
    assert.equal(
      (await harness.acquisition.authorizeFinalization(created.project.id)).allowed,
      true,
      "internal finalizes freely, so charging would take money for nothing",
    );
  });

  it("H: the customer view never leaks an email, a provider id, or a raw amount", async () => {
    const harness = await buildHarness();
    const { projectId } = await uploadReady(harness);
    await harness.acquisition.captureEmail(projectId, "eric@example.com");
    await harness.payment.createCheckout(projectId);

    const view = await harness.payment.describeForCustomer(projectId);
    const serialized = JSON.stringify(view);

    for (const leak of [
      "eric@example.com",
      "cs_flow_",
      "pi_flow_",
      "sk_test_",
      "whsec_",
      "price_",
      "4900",
      "usd",
    ]) {
      assert.equal(
        serialized.includes(leak),
        false,
        `the customer payment view must not contain "${leak}"`,
      );
    }
    // Only the finished display string crosses.
    assert.deepEqual(Object.keys(view).sort(), [
      "checkoutPending",
      "offer",
      "state",
    ]);
  });
});
