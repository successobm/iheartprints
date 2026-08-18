import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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

import { StripeCheckoutProvider } from "./stripe-checkout-provider";
import { buildStripeSignatureHeader } from "./stripe-webhook-signature";
import { CHECKOUT_RETURN_COMPLETE, CHECKOUT_RETURN_PARAM } from "./checkout-return-urls";

/**
 * Sprint A5.4 — THE VERIFIED WEBHOOK, END TO END.
 *
 * Deliberately NOT written against the domain function directly. Every test
 * here starts from a RAW HTTP BODY and a real `Stripe-Signature` header,
 * goes through the real `StripeCheckoutProvider.verifyWebhook` (real HMAC,
 * real tolerance, real normalizer), and lands in the real atomic
 * reconciliation. A suite that called `applyPaymentEvent` directly would
 * prove the database logic and skip the security boundary that protects it.
 *
 * NO LIVE STRIPE CALL IS POSSIBLE. The adapter's `fetchImpl` is a fake that
 * throws if anything ever tries to reach the network, and `verifyWebhook`
 * makes no request at all — it is pure computation over bytes we supply.
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

/**
 * Session ids are unique across every harness in the process, not per-fake.
 *
 * A real provider never reissues a checkout session id, and the store enforces
 * that with a UNIQUE constraint. A per-harness counter would make two tests in
 * this file both mint `cs_test_1`, which collides in the shared local store —
 * a fixture artefact that looks exactly like a real bug.
 */
let fakeSessionCounter = 0;

/** Counts checkout-session HTTP calls, and makes a real network call impossible. */
function fakeStripeFetch() {
  const calls: string[] = [];
  const fetchImpl = (async (url: string | URL | Request) => {
    const target = String(url);
    calls.push(target);
    if (!target.startsWith("https://api.stripe.com/")) {
      throw new Error(`unexpected network call to ${target}`);
    }
    const index = (fakeSessionCounter += 1);
    return new Response(
      JSON.stringify({
        id: `cs_test_${index}`,
        url: `https://checkout.stripe.test/c/${index}`,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

/**
 * Payment intents are unique per event by default, for the same reason
 * session ids are: a real provider never reuses one, and the database enforces
 * that with a UNIQUE constraint. A shared default made every test after the
 * first collide with it — the fence doing its job on a fixture mistake.
 *
 * A test that deliberately wants a REUSED intent (test L) passes one
 * explicitly, which is the only way that case should ever arise.
 */
let fakePaymentIntentCounter = 0;

/** A Stripe checkout.session.* event body. Serialized ONCE — the bytes are what get signed. */
function checkoutSessionEventBody(input: {
  eventId: string;
  eventType?: string;
  sessionId: string;
  transactionId: string | null;
  paymentStatus?: string;
  amountTotal?: number | null;
  currency?: string | null;
  paymentIntent?: string | null;
  omitMetadata?: boolean;
}): string {
  const session: Record<string, unknown> = {
    id: input.sessionId,
    object: "checkout.session",
    payment_status: input.paymentStatus ?? "paid",
    amount_total: input.amountTotal === undefined ? 4900 : input.amountTotal,
    currency: input.currency === undefined ? "usd" : input.currency,
    payment_intent:
      input.paymentIntent ?? `pi_test_${(fakePaymentIntentCounter += 1)}`,
    // Real Stripe sessions carry far more than this; the extra fields are
    // irrelevant to reconciliation and deliberately not modelled.
    customer_email: "eric@example.com",
  };
  if (!input.omitMetadata && input.transactionId) {
    session.metadata = { iheartprints_payment_transaction_id: input.transactionId };
    session.client_reference_id = input.transactionId;
  }

  return JSON.stringify({
    id: input.eventId,
    object: "event",
    type: input.eventType ?? "checkout.session.completed",
    data: { object: session },
  });
}

describe("Sprint A5.4 — verified webhook activates the production unlock", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-webhook-"));
    process.chdir(tempDir);
  });

  after(async () => {
    await cleanupTempWorkspace(tempDir, previousCwd);
  });

  async function buildHarness() {
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

    // THE REAL ADAPTER — real HMAC verification, real normalizer. Only the
    // HTTP transport is faked, and that fake throws on any non-Stripe URL.
    const stripeFetch = fakeStripeFetch();
    const paymentProvider = new StripeCheckoutProvider({
      secretKey: API_SECRET,
      webhookSecret: WEBHOOK_SECRET,
      fetchImpl: stripeFetch.fetchImpl,
      nowSeconds: () => NOW_SECONDS,
    });

    const payment = createPaymentCapability(
      repo,
      paymentProvider,
      PUBLIC_BASE_URL,
      () => CONFIGURED_OFFER,
    );

    return {
      repo,
      acquisition,
      conversation,
      finalArtwork,
      worker,
      payment,
      conceptProvider,
      stripeFetch,
    };
  }

  type Harness = Awaited<ReturnType<typeof buildHarness>>;

  let tokenCounter = 0;
  const newToken = () => `webhook-token-${(tokenCounter += 1)}`;

  /** Delivers a raw body with a REAL signature, exactly as the route would. */
  async function deliver(
    harness: Harness,
    rawBody: string,
    options: { timestamp?: number; secret?: string; header?: string | null } = {},
  ) {
    const header =
      options.header !== undefined
        ? options.header
        : buildStripeSignatureHeader({
            rawBody,
            secret: options.secret ?? WEBHOOK_SECRET,
            timestampSeconds: options.timestamp ?? NOW_SECONDS,
          });

    return harness.payment.handleWebhook({
      rawBody,
      signatureHeader: header,
      nowSeconds: NOW_SECONDS,
    });
  }

  /** Create New, driven to a live checkout. Returns the durable transaction. */
  async function createNewWithCheckout(harness: Harness) {
    const sessionId = (await harness.repo.createAcquisitionSession(newToken())).id;
    const { projectId } = await runAdaptiveInterviewToSummary(
      harness.conversation,
      {},
      sessionId,
    );
    await harness.conversation.submitDesignBriefDecision(projectId, "approve");
    await harness.worker.processNextJob();
    await harness.acquisition.captureEmail(projectId, "eric@example.com");

    const snapshot = await harness.conversation.get(projectId);
    const artworkVersionId = snapshot!.artworkVersions[0]!.id;
    await harness.conversation.selectConcept(projectId, artworkVersionId);

    const checkout = await harness.payment.createCheckout(projectId);
    assert.equal(checkout.ok, true);

    const transaction = await harness.repo.getOutstandingPaymentTransaction(
      projectId,
      APPAREL_RASTER_PRODUCTION_PROFILE,
    );
    assert.equal(transaction?.status, "created");
    return { sessionId, projectId, artworkVersionId, transaction: transaction! };
  }

  /** Existing Artwork, driven to a live checkout. */
  async function uploadWithCheckout(harness: Harness) {
    const sessionId = (await harness.repo.createAcquisitionSession(newToken())).id;
    const created = await harness.repo.createProject(sessionId);
    const projectId = created.project.id;

    await harness.repo.updateBrief(projectId, {
      productSummary: "T-shirts for our bowling team",
      shirtColor: "Black",
      printPlacement: "left_chest",
    });

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
    await harness.acquisition.captureEmail(projectId, "eric@example.com");

    assert.equal((await harness.payment.createCheckout(projectId)).ok, true);
    const transaction = await harness.repo.getOutstandingPaymentTransaction(
      projectId,
      APPAREL_RASTER_PRODUCTION_PROFILE,
    );
    return { sessionId, projectId, transaction: transaction! };
  }

  /** Nothing was granted: no unlock, transaction untouched, finalization refused. */
  async function assertStillLocked(
    harness: Harness,
    projectId: string,
    transactionId: string,
    expectedStatus = "created",
  ) {
    assert.equal(
      await harness.repo.getActiveProductionUnlock(
        projectId,
        APPAREL_RASTER_PRODUCTION_PROFILE,
      ),
      null,
      "no production unlock may exist",
    );
    assert.equal(
      (await harness.repo.getPaymentTransaction(transactionId))?.status,
      expectedStatus,
      "the payment transaction must be untouched",
    );
    assert.equal(
      (await harness.acquisition.authorizeFinalization(projectId)).allowed,
      false,
    );
  }

  /* ================================================================== */
  /* A — the happy path                                                  */
  /* ================================================================== */

  it("A: a verified paid checkout marks the transaction paid AND activates the unlock", async () => {
    const harness = await buildHarness();
    const { projectId, transaction } = await createNewWithCheckout(harness);

    await assertStillLocked(harness, projectId, transaction.id);

    const body = checkoutSessionEventBody({
      eventId: "evt_A1",
      sessionId: transaction.providerCheckoutSessionId!,
      transactionId: transaction.id,
      paymentIntent: "pi_A1",
    });
    const result = await deliver(harness, body);

    assert.deepEqual(result, { status: "acknowledged", outcome: "processed" });

    const paid = await harness.repo.getPaymentTransaction(transaction.id);
    assert.equal(paid?.status, "paid");
    assert.equal(paid?.providerPaymentIntentId, "pi_A1");

    const unlock = await harness.repo.getActiveProductionUnlock(
      projectId,
      APPAREL_RASTER_PRODUCTION_PROFILE,
    );
    assert.equal(unlock?.status, "active");
    // Derived from the TRANSACTION row — the webhook never named a project or
    // a session, and could not have.
    assert.equal(unlock?.projectId, projectId);
    assert.equal(unlock?.acquisitionSessionId, transaction.acquisitionSessionId);

    assert.equal(
      (await harness.acquisition.authorizeFinalization(projectId)).allowed,
      true,
    );
  });

  it("W: the stored event carries a DIGEST of the verified bytes, never the payload", async () => {
    const harness = await buildHarness();
    const { transaction } = await createNewWithCheckout(harness);

    const body = checkoutSessionEventBody({
      eventId: "evt_W1",
      sessionId: transaction.providerCheckoutSessionId!,
      transactionId: transaction.id,
    });
    await deliver(harness, body);

    const event = await harness.repo.getPaymentEventByProviderId("stripe", "evt_W1");
    assert.equal(event?.outcome, "processed");
    assert.equal(
      event?.payloadDigest,
      createHash("sha256").update(body, "utf8").digest("hex"),
      "the digest must describe the exact bytes that were verified",
    );

    // The customer's email is in the raw event body; none of it may have been
    // persisted. Asserted over the whole record rather than field by field so
    // a future added column cannot quietly reintroduce the payload.
    const serialized = JSON.stringify(event);
    assert.equal(serialized.includes("eric@example.com"), false);
    assert.equal(serialized.includes("checkout.session"), true, "event_type is kept");
    assert.equal(serialized.includes("amount_total"), false);
    assert.equal(serialized.includes("payment_status"), false);
  });

  /* ================================================================== */
  /* B + R — idempotency                                                 */
  /* ================================================================== */

  it("B: the SAME event delivered repeatedly produces one paid transaction and one unlock", async () => {
    const harness = await buildHarness();
    const { projectId, transaction } = await createNewWithCheckout(harness);
    const body = checkoutSessionEventBody({
      eventId: "evt_B1",
      sessionId: transaction.providerCheckoutSessionId!,
      transactionId: transaction.id,
    });

    const first = await deliver(harness, body);
    const second = await deliver(harness, body);
    const third = await deliver(harness, body);

    assert.equal(first.status === "acknowledged" && first.outcome, "processed");
    // A redelivery is answered successfully — a provider that never gets a 2xx
    // retries forever.
    assert.equal(second.status === "acknowledged" && second.outcome, "duplicate");
    assert.equal(third.status === "acknowledged" && third.outcome, "duplicate");

    assert.equal(
      (await harness.repo.getPaymentTransaction(transaction.id))?.status,
      "paid",
    );
    assert.equal(
      (await harness.repo.getActiveProductionUnlock(
        projectId,
        APPAREL_RASTER_PRODUCTION_PROFILE,
      ))?.status,
      "active",
    );
  });

  it("R: CONCURRENT duplicate deliveries converge on one paid transaction and one unlock", async () => {
    const harness = await buildHarness();
    const { projectId, transaction } = await createNewWithCheckout(harness);
    const body = checkoutSessionEventBody({
      eventId: "evt_R1",
      sessionId: transaction.providerCheckoutSessionId!,
      transactionId: transaction.id,
    });

    const results = await Promise.all([
      deliver(harness, body),
      deliver(harness, body),
      deliver(harness, body),
      deliver(harness, body),
    ]);

    const outcomes = results.map((r) =>
      r.status === "acknowledged" ? r.outcome : "rejected",
    );
    assert.equal(
      outcomes.filter((o) => o === "processed").length,
      1,
      "exactly one delivery may do the work",
    );
    assert.equal(
      outcomes.filter((o) => o === "duplicate").length,
      3,
      "the rest must be told the answer already stands",
    );
    assert.equal(
      (await harness.repo.getActiveProductionUnlock(
        projectId,
        APPAREL_RASTER_PRODUCTION_PROFILE,
      ))?.status,
      "active",
    );
  });

  it("B2: two DISTINCT events for the same payment record separately but unlock once", async () => {
    const harness = await buildHarness();
    const { projectId, transaction } = await createNewWithCheckout(harness);
    const session = transaction.providerCheckoutSessionId!;

    const completed = await deliver(
      harness,
      checkoutSessionEventBody({
        eventId: "evt_B2a",
        sessionId: session,
        transactionId: transaction.id,
        paymentIntent: "pi_B2",
      }),
    );
    const asyncSucceeded = await deliver(
      harness,
      checkoutSessionEventBody({
        eventId: "evt_B2b",
        eventType: "checkout.session.async_payment_succeeded",
        sessionId: session,
        transactionId: transaction.id,
        paymentIntent: "pi_B2",
      }),
    );

    assert.equal(completed.status === "acknowledged" && completed.outcome, "processed");
    assert.equal(
      asyncSucceeded.status === "acknowledged" && asyncSucceeded.outcome,
      "processed",
    );

    // Both recorded; ONE entitlement. The unlock's own partial unique index is
    // the independent second fence behind the event-id one.
    assert.ok(await harness.repo.getPaymentEventByProviderId("stripe", "evt_B2a"));
    assert.ok(await harness.repo.getPaymentEventByProviderId("stripe", "evt_B2b"));

    const unlocks = await Promise.all([
      harness.repo.getActiveProductionUnlock(projectId, APPAREL_RASTER_PRODUCTION_PROFILE),
    ]);
    assert.equal(unlocks[0]?.status, "active");
  });

  /* ================================================================== */
  /* C + D + E — the signature boundary, through the real adapter        */
  /* ================================================================== */

  it("C: a BAD signature changes nothing", async () => {
    const harness = await buildHarness();
    const { projectId, transaction } = await createNewWithCheckout(harness);
    const body = checkoutSessionEventBody({
      eventId: "evt_C1",
      sessionId: transaction.providerCheckoutSessionId!,
      transactionId: transaction.id,
    });

    const forged = await deliver(harness, body, {
      secret: "whsec_test_attackers_own_secret_xx",
    });
    const unsigned = await deliver(harness, body, { header: null });

    assert.deepEqual(forged, { status: "rejected" });
    assert.deepEqual(unsigned, { status: "rejected" });
    await assertStillLocked(harness, projectId, transaction.id);
    // Not even an event row: nothing about the body was interpreted.
    assert.equal(
      await harness.repo.getPaymentEventByProviderId("stripe", "evt_C1"),
      null,
    );
  });

  it("D: a STALE signature changes nothing", async () => {
    const harness = await buildHarness();
    const { projectId, transaction } = await createNewWithCheckout(harness);
    const body = checkoutSessionEventBody({
      eventId: "evt_D1",
      sessionId: transaction.providerCheckoutSessionId!,
      transactionId: transaction.id,
    });

    const result = await deliver(harness, body, { timestamp: NOW_SECONDS - 3600 });

    assert.deepEqual(result, { status: "rejected" });
    await assertStillLocked(harness, projectId, transaction.id);
    assert.equal(
      await harness.repo.getPaymentEventByProviderId("stripe", "evt_D1"),
      null,
    );
  });

  it("E: a body MUTATED after signing changes nothing", async () => {
    const harness = await buildHarness();
    const { projectId, transaction } = await createNewWithCheckout(harness);
    const original = checkoutSessionEventBody({
      eventId: "evt_E1",
      sessionId: transaction.providerCheckoutSessionId!,
      transactionId: transaction.id,
      amountTotal: 4900,
    });
    const header = buildStripeSignatureHeader({
      rawBody: original,
      secret: WEBHOOK_SECRET,
      timestampSeconds: NOW_SECONDS,
    });

    // The attack: keep the valid signature, change the amount to 1 cent.
    const tampered = original.replace('"amount_total":4900', '"amount_total":1');
    assert.notEqual(tampered, original);

    const result = await harness.payment.handleWebhook({
      rawBody: tampered,
      signatureHeader: header,
      nowSeconds: NOW_SECONDS,
    });

    assert.deepEqual(result, { status: "rejected" });
    await assertStillLocked(harness, projectId, transaction.id);
  });

  /* ================================================================== */
  /* F + G — reconciliation refusals                                     */
  /* ================================================================== */

  it("G: a valid signed event naming an UNKNOWN transaction unlocks nothing", async () => {
    const harness = await buildHarness();
    const { projectId, transaction } = await createNewWithCheckout(harness);

    const result = await deliver(
      harness,
      checkoutSessionEventBody({
        eventId: "evt_G1",
        sessionId: "cs_someone_elses",
        transactionId: "00000000-0000-4000-8000-000000000000",
      }),
    );

    assert.equal(result.status === "acknowledged" && result.outcome, "unmatched");
    await assertStillLocked(harness, projectId, transaction.id);
    // Provider metadata must never bootstrap a purchase.
    assert.equal(
      (await harness.repo.getPaymentEventByProviderId("stripe", "evt_G1"))?.outcome,
      "unmatched",
    );
  });

  it("F+G2: an event with NO transaction handle at all is ignored", async () => {
    const harness = await buildHarness();
    const { projectId, transaction } = await createNewWithCheckout(harness);

    const result = await deliver(
      harness,
      checkoutSessionEventBody({
        eventId: "evt_G2",
        sessionId: transaction.providerCheckoutSessionId!,
        transactionId: null,
        omitMetadata: true,
      }),
    );

    assert.equal(result.status === "acknowledged" && result.outcome, "unmatched");
    await assertStillLocked(harness, projectId, transaction.id);
  });

  it("H: a CHECKOUT SESSION mismatch unlocks nothing, even with a correct transaction handle", async () => {
    const harness = await buildHarness();
    const { projectId, transaction } = await createNewWithCheckout(harness);

    // The metadata names the right transaction; the session id does not match.
    // Trusting the handle alone would let one mislabelled value pay off the
    // wrong purchase.
    const result = await deliver(
      harness,
      checkoutSessionEventBody({
        eventId: "evt_H1",
        sessionId: "cs_a_different_session",
        transactionId: transaction.id,
      }),
    );

    assert.equal(
      result.status === "acknowledged" && result.outcome,
      "rejected_mismatch",
    );
    await assertStillLocked(harness, projectId, transaction.id);
  });

  it("I+J: an AMOUNT or CURRENCY mismatch unlocks nothing — no tolerance, no conversion", async () => {
    for (const [label, overrides] of [
      ["amount one cent low", { amountTotal: 4899 }],
      ["amount one cent high", { amountTotal: 4901 }],
      ["amount absurdly low", { amountTotal: 1 }],
      ["different currency", { currency: "eur" }],
      ["missing amount", { amountTotal: null }],
      ["missing currency", { currency: null }],
    ] as const) {
      const harness = await buildHarness();
      const { projectId, transaction } = await createNewWithCheckout(harness);

      const result = await deliver(
        harness,
        checkoutSessionEventBody({
          eventId: `evt_IJ_${label.replace(/\s+/g, "_")}`,
          sessionId: transaction.providerCheckoutSessionId!,
          transactionId: transaction.id,
          ...overrides,
        }),
      );

      assert.equal(
        result.status === "acknowledged" && result.outcome,
        "rejected_mismatch",
        `${label} must be refused`,
      );
      await assertStillLocked(harness, projectId, transaction.id);
    }
  });

  it("K: completion WITHOUT settled payment unlocks nothing", async () => {
    // The single most important refusal in this file: `checkout.session.completed`
    // is not proof that money arrived.
    for (const paymentStatus of ["unpaid", "no_payment_required", "", "PAID"]) {
      const harness = await buildHarness();
      const { projectId, transaction } = await createNewWithCheckout(harness);

      const result = await deliver(
        harness,
        checkoutSessionEventBody({
          eventId: `evt_K_${paymentStatus || "empty"}`,
          sessionId: transaction.providerCheckoutSessionId!,
          transactionId: transaction.id,
          paymentStatus,
        }),
      );

      assert.equal(
        result.status === "acknowledged" && result.outcome,
        "ignored",
        `payment_status "${paymentStatus}" must not grant an entitlement`,
      );
      await assertStillLocked(harness, projectId, transaction.id);
    }
  });

  it("L: one provider PAYMENT INTENT can never pay off two transactions", async () => {
    const harness = await buildHarness();
    const first = await createNewWithCheckout(harness);
    const second = await createNewWithCheckout(harness);

    const paid = await deliver(
      harness,
      checkoutSessionEventBody({
        eventId: "evt_L1",
        sessionId: first.transaction.providerCheckoutSessionId!,
        transactionId: first.transaction.id,
        paymentIntent: "pi_shared",
      }),
    );
    assert.equal(paid.status === "acknowledged" && paid.outcome, "processed");

    // A different, genuinely signed event reusing the same payment intent.
    const reused = await deliver(
      harness,
      checkoutSessionEventBody({
        eventId: "evt_L2",
        sessionId: second.transaction.providerCheckoutSessionId!,
        transactionId: second.transaction.id,
        paymentIntent: "pi_shared",
      }),
    );

    assert.equal(
      reused.status === "acknowledged" && reused.outcome,
      "rejected_mismatch",
    );
    await assertStillLocked(harness, second.projectId, second.transaction.id);
    assert.equal(
      (await harness.acquisition.authorizeFinalization(second.projectId)).allowed,
      false,
    );
  });

  /* ================================================================== */
  /* T + U — unknown and out-of-order events                             */
  /* ================================================================== */

  it("T: a validly signed event type this build does not implement is safely ignored", async () => {
    const harness = await buildHarness();
    const { projectId, transaction } = await createNewWithCheckout(harness);

    for (const eventType of [
      "charge.refunded",
      "payment_intent.succeeded",
      "invoice.paid",
      "customer.subscription.created",
    ]) {
      const result = await deliver(
        harness,
        checkoutSessionEventBody({
          eventId: `evt_T_${eventType}`,
          eventType,
          sessionId: transaction.providerCheckoutSessionId!,
          transactionId: transaction.id,
        }),
      );
      assert.equal(
        result.status === "acknowledged" && result.outcome,
        "ignored",
        `${eventType} must be acknowledged and ignored`,
      );
    }

    await assertStillLocked(harness, projectId, transaction.id);
  });

  it("U: an EXPIRED event can never downgrade a paid transaction or revoke an unlock", async () => {
    const harness = await buildHarness();
    const { projectId, transaction } = await createNewWithCheckout(harness);
    const session = transaction.providerCheckoutSessionId!;

    await deliver(
      harness,
      checkoutSessionEventBody({
        eventId: "evt_U1",
        sessionId: session,
        transactionId: transaction.id,
      }),
    );
    assert.equal(
      (await harness.repo.getPaymentTransaction(transaction.id))?.status,
      "paid",
    );

    // Out of order: a lapse notification arrives after the payment.
    const expired = await deliver(
      harness,
      checkoutSessionEventBody({
        eventId: "evt_U2",
        eventType: "checkout.session.expired",
        sessionId: session,
        transactionId: transaction.id,
      }),
    );

    assert.equal(expired.status === "acknowledged" && expired.outcome, "ignored");
    assert.equal(
      (await harness.repo.getPaymentTransaction(transaction.id))?.status,
      "paid",
      "money that arrived does not un-arrive because a session object expired",
    );
    assert.equal(
      (await harness.repo.getActiveProductionUnlock(
        projectId,
        APPAREL_RASTER_PRODUCTION_PROFILE,
      ))?.status,
      "active",
    );
    assert.equal(
      (await harness.acquisition.authorizeFinalization(projectId)).allowed,
      true,
    );
  });

  it("U2: an expiry on an UNPAID attempt frees the slot, and a later completion still pays", async () => {
    const harness = await buildHarness();
    const { projectId, transaction } = await createNewWithCheckout(harness);
    const session = transaction.providerCheckoutSessionId!;

    const expired = await deliver(
      harness,
      checkoutSessionEventBody({
        eventId: "evt_U3",
        eventType: "checkout.session.expired",
        sessionId: session,
        transactionId: transaction.id,
      }),
    );
    assert.equal(expired.status === "acknowledged" && expired.outcome, "processed");
    assert.equal(
      (await harness.repo.getPaymentTransaction(transaction.id))?.status,
      "expired",
    );
    // The outstanding slot is free, so the customer can start again.
    assert.equal(
      await harness.repo.getOutstandingPaymentTransaction(
        projectId,
        APPAREL_RASTER_PRODUCTION_PROFILE,
      ),
      null,
    );
    // …and it granted nothing.
    assert.equal(
      (await harness.acquisition.authorizeFinalization(projectId)).allowed,
      false,
    );

    // Out-of-order recovery: the completion arrives after the expiry. The
    // money is real; our bookkeeping was merely early.
    const completed = await deliver(
      harness,
      checkoutSessionEventBody({
        eventId: "evt_U4",
        sessionId: session,
        transactionId: transaction.id,
      }),
    );
    assert.equal(completed.status === "acknowledged" && completed.outcome, "processed");
    assert.equal(
      (await harness.acquisition.authorizeFinalization(projectId)).allowed,
      true,
    );
  });

  /* ================================================================== */
  /* M + N — the redirect is not authority                               */
  /* ================================================================== */

  it("N: the browser returning with ?checkout=complete grants NOTHING without a webhook", async () => {
    const harness = await buildHarness();
    const { projectId, transaction } = await createNewWithCheckout(harness);

    // What the customer's browser actually lands on. It is a URL. Reading it
    // is not an operation this system has.
    const successUrl = new URL(`${PUBLIC_BASE_URL}/`);
    successUrl.searchParams.set("project", projectId);
    successUrl.searchParams.set(CHECKOUT_RETURN_PARAM, CHECKOUT_RETURN_COMPLETE);
    assert.equal(successUrl.searchParams.get("checkout"), "complete");
    assert.equal(successUrl.searchParams.has("paid"), false);

    // Re-reading every customer-facing surface after the "successful" return.
    await harness.conversation.get(projectId);
    await harness.acquisition.describeForCustomer(projectId, { generating: false });

    await assertStillLocked(harness, projectId, transaction.id);

    // Now the only thing that is authority.
    const result = await deliver(
      harness,
      checkoutSessionEventBody({
        eventId: "evt_N1",
        sessionId: transaction.providerCheckoutSessionId!,
        transactionId: transaction.id,
      }),
    );
    assert.equal(result.status === "acknowledged" && result.outcome, "processed");
    assert.equal(
      (await harness.acquisition.authorizeFinalization(projectId)).allowed,
      true,
    );
  });

  it("M: a webhook arriving BEFORE the customer returns works identically", async () => {
    const harness = await buildHarness();
    const { projectId, transaction } = await createNewWithCheckout(harness);

    const result = await deliver(
      harness,
      checkoutSessionEventBody({
        eventId: "evt_M1",
        sessionId: transaction.providerCheckoutSessionId!,
        transactionId: transaction.id,
      }),
    );
    assert.equal(result.status === "acknowledged" && result.outcome, "processed");

    // The redirect happens afterwards and changes nothing — it never did.
    await harness.conversation.get(projectId);
    assert.equal(
      (await harness.acquisition.authorizeFinalization(projectId)).allowed,
      true,
    );
  });

  /* ================================================================== */
  /* O + P + Q — what the entitlement actually unlocks                   */
  /* ================================================================== */

  it("O: Create New finalization is allowed after the webhook, and creates ONE job", async () => {
    const harness = await buildHarness();
    const { projectId, artworkVersionId, transaction } =
      await createNewWithCheckout(harness);
    await harness.conversation.confirmSelectedDirection(projectId, artworkVersionId);

    await deliver(
      harness,
      checkoutSessionEventBody({
        eventId: "evt_O1",
        sessionId: transaction.providerCheckoutSessionId!,
        transactionId: transaction.id,
      }),
    );

    const first = await harness.finalArtwork.requestFinalArtwork(
      projectId,
      artworkVersionId,
    );
    assert.equal(first.job.status, "queued");
    assert.equal(first.job.sourceKind, "generated_concept");

    // No final-artwork worker exists in this suite, so nothing can dispatch to
    // Topaz. The claim is about what a worker WOULD be able to claim.
    const again = await harness.finalArtwork.requestFinalArtwork(
      projectId,
      artworkVersionId,
    );
    assert.equal(again.job.id, first.job.id);
    assert.equal(
      (await harness.repo.listFinalArtworkJobsForApproval(projectId, first.approval.id))
        .length,
      1,
    );
  });

  it("P: Existing Artwork finalization is allowed by the SAME project-level unlock", async () => {
    const harness = await buildHarness();
    const { projectId, transaction } = await uploadWithCheckout(harness);

    await assert.rejects(() =>
      harness.finalArtwork.requestPreparedUploadFinalArtwork(projectId),
    );

    await deliver(
      harness,
      checkoutSessionEventBody({
        eventId: "evt_P1",
        sessionId: transaction.providerCheckoutSessionId!,
        transactionId: transaction.id,
      }),
    );

    const result =
      await harness.finalArtwork.requestPreparedUploadFinalArtwork(projectId);
    assert.equal(result.job.sourceKind, "prepared_upload");
    assert.equal(result.job.status, "queued");
    // No workflow-specific payment type: one project unlock, either workflow.
  });

  it("Q: generation stays locked after payment — A5.4 is finalization entitlement only", async () => {
    const harness = await buildHarness();
    const { projectId, transaction } = await createNewWithCheckout(harness);

    const jobsBefore = (await harness.repo.listGenerationJobs(projectId)).length;
    const callsBefore = harness.conceptProvider.calls.length;

    await deliver(
      harness,
      checkoutSessionEventBody({
        eventId: "evt_Q1",
        sessionId: transaction.providerCheckoutSessionId!,
        transactionId: transaction.id,
      }),
    );
    assert.equal(
      (await harness.acquisition.authorizeFinalization(projectId)).allowed,
      true,
    );

    assert.equal(
      (await harness.acquisition.authorizeConceptGeneration(projectId)).allowed,
      false,
      "a paid production unlock must not unlock image generation",
    );

    await harness.conversation.exploreNewConceptBatch(projectId);
    await harness.conversation.regenerateConcepts(projectId);
    await harness.conversation.handleUserMessage(
      projectId,
      "Make the bear red instead of brown.",
    );

    assert.equal(
      (await harness.repo.listGenerationJobs(projectId)).length,
      jobsBefore,
    );
    await harness.worker.processNextJob();
    assert.equal(harness.conceptProvider.calls.length, callsBefore);
  });

  /* ================================================================== */
  /* Wrong project / session / profile                                   */
  /* ================================================================== */

  it("X: a transaction for project A can never activate project B", async () => {
    const harness = await buildHarness();
    const a = await createNewWithCheckout(harness);
    const b = await uploadWithCheckout(harness);

    await deliver(
      harness,
      checkoutSessionEventBody({
        eventId: "evt_X1",
        sessionId: a.transaction.providerCheckoutSessionId!,
        transactionId: a.transaction.id,
      }),
    );

    assert.equal(
      (await harness.acquisition.authorizeFinalization(a.projectId)).allowed,
      true,
    );
    // B is untouched: project, session, and profile all come from A's
    // transaction row, and the webhook could not have named B's.
    assert.equal(
      await harness.repo.getActiveProductionUnlock(
        b.projectId,
        APPAREL_RASTER_PRODUCTION_PROFILE,
      ),
      null,
    );
    assert.equal(
      (await harness.acquisition.authorizeFinalization(b.projectId)).allowed,
      false,
    );
  });

  it("V: refund automation is NOT implemented — a refund event is recorded and ignored", async () => {
    // Pinned as an explicit test rather than a comment, so "we deferred this"
    // is a fact the suite enforces rather than a claim in a document. The
    // schema and `revokeProductionUnlock` are future-safe and separately
    // tested; nothing drives them from an event yet.
    const harness = await buildHarness();
    const { projectId, transaction } = await createNewWithCheckout(harness);

    await deliver(
      harness,
      checkoutSessionEventBody({
        eventId: "evt_V1",
        sessionId: transaction.providerCheckoutSessionId!,
        transactionId: transaction.id,
      }),
    );

    const refund = await deliver(
      harness,
      checkoutSessionEventBody({
        eventId: "evt_V2",
        eventType: "charge.refunded",
        sessionId: transaction.providerCheckoutSessionId!,
        transactionId: transaction.id,
      }),
    );

    assert.equal(refund.status === "acknowledged" && refund.outcome, "ignored");
    // The entitlement is UNCHANGED — a refund must be actioned by an operator
    // through `revokeProductionUnlock` until A5.x implements it properly.
    assert.equal(
      (await harness.repo.getActiveProductionUnlock(
        projectId,
        APPAREL_RASTER_PRODUCTION_PROFILE,
      ))?.status,
      "active",
    );
    assert.equal(
      (await harness.repo.getPaymentTransaction(transaction.id))?.status,
      "paid",
    );
  });

  it("Y: no webhook path ever reaches the network", async () => {
    const harness = await buildHarness();
    const { transaction } = await createNewWithCheckout(harness);
    const callsAfterCheckout = harness.stripeFetch.calls.length;

    await deliver(
      harness,
      checkoutSessionEventBody({
        eventId: "evt_Y1",
        sessionId: transaction.providerCheckoutSessionId!,
        transactionId: transaction.id,
      }),
    );

    assert.equal(
      harness.stripeFetch.calls.length,
      callsAfterCheckout,
      "verification is pure computation over bytes we already hold",
    );
  });
});
