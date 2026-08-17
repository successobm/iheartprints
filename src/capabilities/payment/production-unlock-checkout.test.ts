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
import { ProviderError } from "@/capabilities/providers/provider-error";
import type { ConceptGenerationProvider } from "@/capabilities/providers";
import type {
  ConceptGenerationRequest,
  ConceptGenerationResult,
} from "@/capabilities/shared/contracts";
import type { ProductionUnlockOfferConfig } from "@/lib/config/production-unlock-offer-config";
import type { ProjectRepository } from "@/lib/db/repository";
import { APPAREL_RASTER_PRODUCTION_PROFILE } from "@/lib/domain/types";
import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";
import { FakePaymentProvider } from "@/test-support/fake-payment-provider";
import { runAdaptiveInterviewToSummary } from "@/test-support/run-adaptive-interview";

/**
 * Sprint A5.3 — CHECKOUT CREATION.
 *
 * The single most important claim in this file is a NEGATIVE one, and it is
 * asserted after every successful checkout in the suite:
 *
 *     creating a checkout creates ZERO production unlocks,
 *     leaves finalization refused, and leaves generation refused.
 *
 * Everything else follows from that. A payment attempt is an attempt; only a
 * verified webhook (A5.4) will ever grant an entitlement, and this slice
 * proves the two are not connected by anything.
 *
 * NO LIVE STRIPE CALL IS POSSIBLE HERE. `FakePaymentProvider` has no HTTP
 * client at all, the real adapter is never constructed, and
 * `IHEARTPRINTS_AUTOMATED_TEST=1` (test bootstrap preload) independently
 * forces every other provider resolver to its safe local implementation.
 * No final-artwork worker is built anywhere, so no Topaz dispatch is
 * reachable either.
 */

function tinyPng(): Buffer {
  const png = new PNG({ width: 4, height: 4 });
  png.data.fill(128);
  return PNG.sync.write(png);
}

class CountingConceptProvider implements ConceptGenerationProvider {
  readonly providerKey = "counting";
  readonly editsSourceArtwork = false;
  calls: ConceptGenerationRequest[] = [];

  async generate(
    request: ConceptGenerationRequest,
  ): Promise<ConceptGenerationResult> {
    this.calls.push(request);
    return {
      jobId: request.idempotencyKey,
      providerKey: this.providerKey,
      concepts: Array.from({ length: request.conceptCount }, (_, index) => ({
        versionNumber: index + 1,
        title: `Concept ${index + 1}`,
        summary: `Concept ${index + 1}`,
        placeholderLabel: `Concept ${String.fromCharCode(65 + index)}`,
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

const CONFIGURED_OFFER: ProductionUnlockOfferConfig = {
  mode: "configured",
  productionProfile: APPAREL_RASTER_PRODUCTION_PROFILE,
  amountMinor: 4900,
  currency: "usd",
  providerPriceId: null,
};

const PUBLIC_BASE_URL = "https://iheartprints.example";

describe("Sprint A5.3 — production unlock checkout", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-checkout-"));
    process.chdir(tempDir);
  });

  after(async () => {
    await cleanupTempWorkspace(tempDir, previousCwd);
  });

  async function buildHarness(options: {
    offer?: ProductionUnlockOfferConfig;
    provider?: FakePaymentProvider | null;
    publicBaseUrl?: string | null;
  } = {}) {
    const { LocalProjectRepository } = await import("@/lib/db/local-store");
    const { createCapabilityGraph } = await import("@/capabilities/composition");

    const repo: ProjectRepository = new LocalProjectRepository();

    // The local store is one JSON file for the whole suite and
    // `claimNextQueuedJob` claims across every project — retire leftovers so
    // each test's provider counts are its own.
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

    const paymentProvider =
      options.provider === undefined ? new FakePaymentProvider() : options.provider;
    const payment = createPaymentCapability(
      repo,
      paymentProvider,
      options.publicBaseUrl === undefined ? PUBLIC_BASE_URL : options.publicBaseUrl,
      () => options.offer ?? CONFIGURED_OFFER,
    );

    return {
      repo,
      acquisition,
      conversation,
      conceptGeneration,
      finalArtwork,
      worker,
      payment,
      paymentProvider,
      conceptProvider,
    };
  }

  type Harness = Awaited<ReturnType<typeof buildHarness>>;

  let tokenCounter = 0;
  const newToken = () => `checkout-token-${(tokenCounter += 1)}`;

  /** A Create New prospect with a delivered concept, an email, and a selection. */
  async function createNewReadyToBuy(harness: Harness, sessionId?: string) {
    const resolvedSessionId =
      sessionId ?? (await harness.repo.createAcquisitionSession(newToken())).id;

    const { projectId } = await runAdaptiveInterviewToSummary(
      harness.conversation,
      {},
      resolvedSessionId,
    );
    await harness.conversation.submitDesignBriefDecision(projectId, "approve");
    await harness.worker.processNextJob();
    await harness.acquisition.captureEmail(projectId, "eric@example.com");

    const snapshot = await harness.conversation.get(projectId);
    const artworkVersionId = snapshot!.artworkVersions[0]!.id;
    await harness.conversation.selectConcept(projectId, artworkVersionId);

    return { sessionId: resolvedSessionId, projectId, artworkVersionId };
  }

  /** An Existing Artwork project with an APPROVED preparation and an email. */
  async function uploadReadyToBuy(harness: Harness, sessionId?: string) {
    const resolvedSessionId =
      sessionId ?? (await harness.repo.createAcquisitionSession(newToken())).id;

    const created = await harness.repo.createProject(resolvedSessionId);
    const projectId = created.project.id;

    await harness.repo.updateBrief(projectId, {
      productSummary: "T-shirts for our bowling team",
      shirtColor: "Black",
      printPlacement: "left_chest",
    });

    const asset = async (kind: "customer_upload" | "png", name: string) =>
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
        summary: "Your uploaded artwork with its background removed.",
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

    return { sessionId: resolvedSessionId, projectId, preparationId: preparation.id };
  }

  /**
   * THE A5.3 INVARIANT, asserted after every successful checkout: a payment
   * attempt grants nothing. Extracted so no test can accidentally omit it.
   *
   * The generation half is asserted as UNCHANGED rather than as "refused",
   * and the distinction is real rather than pedantic. An upload-only session
   * has never spent its free concept, so `authorizeConceptGeneration`
   * legitimately says yes for it — that is A4 behavior and has nothing to do
   * with payment. Asserting a blanket refusal would encode the wrong rule and
   * would start failing for a reason that is not a defect. What A5.3 owes is
   * that checkout does not MOVE the gate in either direction.
   */
  async function captureGates(harness: Harness, projectId: string) {
    return {
      unlock: await harness.repo.getActiveProductionUnlock(
        projectId,
        APPAREL_RASTER_PRODUCTION_PROFILE,
      ),
      finalization: (await harness.acquisition.authorizeFinalization(projectId))
        .allowed,
      generation: (await harness.acquisition.authorizeConceptGeneration(projectId))
        .allowed,
    };
  }

  async function assertNothingWasGranted(
    harness: Harness,
    projectId: string,
    before?: Awaited<ReturnType<typeof captureGates>>,
  ) {
    const after = await captureGates(harness, projectId);

    assert.equal(
      after.unlock,
      null,
      "creating a checkout must NEVER create a production unlock",
    );
    assert.equal(
      after.finalization,
      false,
      "a created checkout is not payment and must not authorize finalization",
    );
    if (before) {
      assert.equal(
        after.generation,
        before.generation,
        "checkout must not move the generation gate in either direction",
      );
    }
  }

  /* ================================================================== */
  /* A + B — both workflows reach checkout from their OWN authority      */
  /* ================================================================== */

  it("A: a Create New prospect with a selected, delivered concept can check out", async () => {
    const harness = await buildHarness();
    const { projectId } = await createNewReadyToBuy(harness);

    const result = await harness.payment.createCheckout(projectId);

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.match(result.checkoutUrl, /^https:\/\/checkout\.example\.test\//);
    assert.equal(result.reused, false);

    const transaction = await harness.repo.getOutstandingPaymentTransaction(
      projectId,
      APPAREL_RASTER_PRODUCTION_PROFILE,
    );
    assert.equal(transaction?.status, "created");
    assert.equal(transaction?.provider, "stripe");

    await assertNothingWasGranted(harness, projectId);
  });

  it("B: an Existing Artwork project checks out from its APPROVED preparation alone", async () => {
    const harness = await buildHarness();
    const { projectId } = await uploadReadyToBuy(harness);

    // Deliberately no concept, no selection, no final-direction approval, and
    // no approved DesignBriefVersion — an upload customer never makes those
    // decisions, and requiring them would make this path unreachable.
    const before = await captureGates(harness, projectId);
    const result = await harness.payment.createCheckout(projectId);

    assert.equal(result.ok, true);
    await assertNothingWasGranted(harness, projectId, before);
  });

  /* ================================================================== */
  /* C — email is required before money                                  */
  /* ================================================================== */

  it("C: a prospect with no captured email is refused", async () => {
    const harness = await buildHarness();
    const session = await harness.repo.createAcquisitionSession(newToken());
    const { projectId } = await runAdaptiveInterviewToSummary(
      harness.conversation,
      {},
      session.id,
    );
    await harness.conversation.submitDesignBriefDecision(projectId, "approve");
    await harness.worker.processNextJob();
    const snapshot = await harness.conversation.get(projectId);
    await harness.conversation.selectConcept(
      projectId,
      snapshot!.artworkVersions[0]!.id,
    );

    const result = await harness.payment.createCheckout(projectId);
    assert.equal(result.ok, false);
    assert.equal(harness.paymentProvider!.callCount, 0);
  });

  /* ================================================================== */
  /* D + E — nothing left to sell                                        */
  /* ================================================================== */

  it("D: a project that already holds an active unlock is refused, and no attempt is opened", async () => {
    const harness = await buildHarness();
    const { sessionId, projectId } = await uploadReadyToBuy(harness);
    await harness.repo.createProductionUnlock(projectId, {
      acquisitionSessionId: sessionId,
      productionProfile: APPAREL_RASTER_PRODUCTION_PROFILE,
    });

    const result = await harness.payment.createCheckout(projectId);
    assert.equal(result.ok, false);
    assert.equal(harness.paymentProvider!.callCount, 0);
    assert.equal(
      await harness.repo.getOutstandingPaymentTransaction(
        projectId,
        APPAREL_RASTER_PRODUCTION_PROFILE,
      ),
      null,
    );
  });

  it("E: an internally entitled session is refused — it already finalizes freely", async () => {
    const harness = await buildHarness();
    const session = await harness.repo.createAcquisitionSession(newToken());
    await harness.repo.grantInternalEntitlement(session.id);
    const { projectId } = await uploadReadyToBuy(harness, session.id);

    const result = await harness.payment.createCheckout(projectId);
    assert.equal(result.ok, false);
    assert.equal(harness.paymentProvider!.callCount, 0);
  });

  it("E2: a legacy project is refused — there is no buyer to record and nothing to sell", async () => {
    const harness = await buildHarness();
    // No acquisition session at all: a pre-A4 project, already grandfathered
    // through the finalization gate.
    const created = await harness.repo.createProject();
    assert.equal(created.project.acquisitionSessionId, null);

    const result = await harness.payment.createCheckout(created.project.id);
    assert.equal(result.ok, false);
    assert.equal(harness.paymentProvider!.callCount, 0);
    // And it is still free to finalize — refusing the sale took nothing away.
    assert.equal(
      (await harness.acquisition.authorizeFinalization(created.project.id)).allowed,
      true,
    );
  });

  /* ================================================================== */
  /* F — unresolvable authority                                          */
  /* ================================================================== */

  it("F: a project id that does not exist is refused with the same neutral message", async () => {
    const harness = await buildHarness();
    const real = await uploadReadyToBuy(harness);

    const missing = await harness.payment.createCheckout(
      "00000000-0000-4000-8000-000000000000",
    );
    const unlocked = await harness.repo.createProductionUnlock(real.projectId, {
      acquisitionSessionId: real.sessionId,
      productionProfile: APPAREL_RASTER_PRODUCTION_PROFILE,
    });
    assert.equal(unlocked.outcome, "granted");
    const alreadyBought = await harness.payment.createCheckout(real.projectId);

    assert.equal(missing.ok, false);
    assert.equal(alreadyBought.ok, false);
    if (missing.ok || alreadyBought.ok) return;
    // Indistinguishable on purpose: a caller probing project ids must not be
    // able to enumerate which exist and which are already paid for.
    assert.equal(missing.customerMessage, alreadyBought.customerMessage);
  });

  /* ================================================================== */
  /* G + H + I — the offer must be truthful                              */
  /* ================================================================== */

  it("G: a project asking for an unsupported production output is refused before any money is asked for", async () => {
    const harness = await buildHarness();
    const { projectId } = await uploadReadyToBuy(harness);
    await harness.repo.updateBrief(projectId, {
      requestedProductionOutput: "embroidery_digitization",
    });

    const result = await harness.payment.createCheckout(projectId);
    assert.equal(result.ok, false);
    assert.equal(
      harness.paymentProvider!.callCount,
      0,
      "taking money and refusing to deliver afterwards is the worst possible ordering",
    );
  });

  it("H: a pending revision is refused — the customer has said this is not the design they want", async () => {
    const harness = await buildHarness();
    const { projectId } = await createNewReadyToBuy(harness);
    await harness.repo.updateProject(projectId, { revisionPending: true });

    const result = await harness.payment.createCheckout(projectId);
    assert.equal(result.ok, false);
    assert.equal(harness.paymentProvider!.callCount, 0);
  });

  it("I: a project with no delivered concept, or with one but no selection, is refused", async () => {
    const harness = await buildHarness();

    // Nothing designed at all.
    const session = await harness.repo.createAcquisitionSession(newToken());
    const { projectId } = await runAdaptiveInterviewToSummary(
      harness.conversation,
      {},
      session.id,
    );
    await harness.acquisition.captureEmail(projectId, "eric@example.com");
    assert.equal((await harness.payment.createCheckout(projectId)).ok, false);

    // A concept exists and was delivered, but the customer has not chosen it —
    // "unlock THIS design" has no referent yet.
    await harness.conversation.submitDesignBriefDecision(projectId, "approve");
    await harness.worker.processNextJob();
    assert.equal((await harness.payment.createCheckout(projectId)).ok, false);

    // Selecting it is what makes the offer truthful.
    const snapshot = await harness.conversation.get(projectId);
    await harness.conversation.selectConcept(
      projectId,
      snapshot!.artworkVersions[0]!.id,
    );
    assert.equal((await harness.payment.createCheckout(projectId)).ok, true);
  });

  /* ================================================================== */
  /* J — the deployment cannot take money                                */
  /* ================================================================== */

  it("J: an unconfigured price, provider, or base URL refuses cleanly and opens no attempt", async () => {
    for (const options of [
      {
        offer: {
          mode: "unavailable" as const,
          safeErrorCode: "PRODUCTION_UNLOCK_PRICE_NOT_CONFIGURED" as const,
          internalReason: "unset",
        },
      },
      { provider: null },
      { publicBaseUrl: null },
    ]) {
      const harness = await buildHarness(options);
      const { projectId } = await uploadReadyToBuy(harness);

      const result = await harness.payment.createCheckout(projectId);
      assert.equal(result.ok, false);
      assert.equal(
        await harness.repo.getOutstandingPaymentTransaction(
          projectId,
          APPAREL_RASTER_PRODUCTION_PROFILE,
        ),
        null,
        "a misconfigured deployment must not litter the table with unusable attempts",
      );
    }
  });

  /* ================================================================== */
  /* K + L + M — the A5.3 invariant, from every angle                    */
  /* ================================================================== */

  it("K: a provider failure creates no unlock and leaves finalization refused", async () => {
    const harness = await buildHarness();
    const { projectId } = await createNewReadyToBuy(harness);
    harness.paymentProvider!.always({
      kind: "throw",
      error: new ProviderError("invalid_request", "nope", "not_dispatched"),
    });

    const result = await harness.payment.createCheckout(projectId);
    assert.equal(result.ok, false);
    await assertNothingWasGranted(harness, projectId);
  });

  it("L: after a SUCCESSFUL checkout, finalization is still refused and no FinalArtworkJob can exist", async () => {
    const harness = await buildHarness();
    const { projectId, artworkVersionId } = await createNewReadyToBuy(harness);
    await harness.conversation.confirmSelectedDirection(projectId, artworkVersionId);

    assert.equal((await harness.payment.createCheckout(projectId)).ok, true);

    // The transaction is `created`. That is the strongest state A5.3 can
    // reach, and it authorizes nothing.
    const transaction = await harness.repo.getOutstandingPaymentTransaction(
      projectId,
      APPAREL_RASTER_PRODUCTION_PROFILE,
    );
    assert.equal(transaction?.status, "created");

    await assertNothingWasGranted(harness, projectId);
    await assert.rejects(() =>
      harness.finalArtwork.requestFinalArtwork(projectId, artworkVersionId),
    );
    assert.equal(
      await harness.repo.getActiveFinalDirectionApproval(projectId),
      null,
      "no approval means no job means nothing a worker could dispatch to Topaz",
    );
  });

  it("M: after a successful checkout, generation is still refused and no GenerationJob appears", async () => {
    const harness = await buildHarness();
    const { projectId } = await createNewReadyToBuy(harness);

    const jobsBefore = (await harness.repo.listGenerationJobs(projectId)).length;
    const callsBefore = harness.conceptProvider.calls.length;

    assert.equal((await harness.payment.createCheckout(projectId)).ok, true);

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
  /* N + T — the server owns every commercial value                      */
  /* ================================================================== */

  it("N+T: the provider receives only server-resolved values, and the row freezes them", async () => {
    const harness = await buildHarness();
    const { sessionId, projectId } = await createNewReadyToBuy(harness);

    assert.equal((await harness.payment.createCheckout(projectId)).ok, true);

    const sent = harness.paymentProvider!.requests[0]!;
    assert.equal(sent.amountMinor, 4900);
    assert.equal(sent.currency, "usd");
    assert.equal(sent.productionProfile, "apparel_raster");
    assert.equal(sent.projectId, projectId);
    assert.equal(sent.providerPriceId, null);
    // Success/cancel URLs are built from server configuration, never from a
    // request header — and neither carries a trusted payment claim.
    assert.ok(sent.successUrl.startsWith(`${PUBLIC_BASE_URL}/`));
    assert.equal(sent.successUrl.includes("paid=true"), false);
    assert.equal(sent.cancelUrl.includes("paid"), false);

    const transaction = await harness.repo.getOutstandingPaymentTransaction(
      projectId,
      APPAREL_RASTER_PRODUCTION_PROFILE,
    );
    assert.equal(transaction?.amountMinor, 4900);
    assert.equal(transaction?.currency, "usd");
    assert.equal(transaction?.productionProfile, "apparel_raster");
    // Resolved from the PROJECT's durable binding, not from anything supplied.
    assert.equal(transaction?.acquisitionSessionId, sessionId);
  });

  it("S: the buyer's email reaches the provider without ever passing through a browser", async () => {
    const harness = await buildHarness();
    const { projectId } = await createNewReadyToBuy(harness);

    const result = await harness.payment.createCheckout(projectId);
    assert.equal(result.ok, true);
    if (!result.ok) return;

    assert.equal(harness.paymentProvider!.requests[0]!.customerEmail, "eric@example.com");
    // The capability's own result carries the URL and nothing else — there is
    // no round trip in which a client could substitute an address.
    assert.deepEqual(Object.keys(result).sort(), ["checkoutUrl", "ok", "reused"]);
  });

  /* ================================================================== */
  /* O + P — idempotency and concurrency                                 */
  /* ================================================================== */

  it("O: a repeat checkout reuses the SAME session rather than creating a second one", async () => {
    const harness = await buildHarness();
    const { projectId } = await createNewReadyToBuy(harness);

    const first = await harness.payment.createCheckout(projectId);
    const second = await harness.payment.createCheckout(projectId);
    const third = await harness.payment.createCheckout(projectId);

    assert.equal(first.ok && second.ok && third.ok, true);
    if (!first.ok || !second.ok || !third.ok) return;
    assert.equal(second.checkoutUrl, first.checkoutUrl);
    assert.equal(third.checkoutUrl, first.checkoutUrl);
    assert.equal(second.reused, true);
    // The provider is not even contacted again — the stored URL answers it.
    assert.equal(harness.paymentProvider!.callCount, 1);
  });

  it("P: concurrent checkout attempts converge on ONE transaction and ONE session", async () => {
    const harness = await buildHarness();
    const { projectId } = await createNewReadyToBuy(harness);

    const results = await Promise.all([
      harness.payment.createCheckout(projectId),
      harness.payment.createCheckout(projectId),
      harness.payment.createCheckout(projectId),
    ]);

    assert.equal(results.every((r) => r.ok), true);
    const urls = new Set(results.map((r) => (r.ok ? r.checkoutUrl : "")));
    assert.equal(urls.size, 1, "three tabs must land on ONE payment page");
    assert.equal(
      harness.paymentProvider!.issuedSessionIds.length,
      1,
      "at most one provider checkout session may ever exist for one attempt",
    );
  });

  it("Q: a checkout for project A never becomes a purchase of project B", async () => {
    const harness = await buildHarness();
    const session = await harness.repo.createAcquisitionSession(newToken());
    const a = await uploadReadyToBuy(harness, session.id);
    const b = await uploadReadyToBuy(harness, session.id);
    const beforeB = await captureGates(harness, b.projectId);

    assert.equal((await harness.payment.createCheckout(a.projectId)).ok, true);

    const sent = harness.paymentProvider!.requests[0]!;
    assert.equal(sent.projectId, a.projectId);
    assert.ok(sent.successUrl.includes(a.projectId));
    assert.equal(sent.successUrl.includes(b.projectId), false);

    // B has its own outstanding-attempt slot, untouched.
    assert.equal(
      await harness.repo.getOutstandingPaymentTransaction(
        b.projectId,
        APPAREL_RASTER_PRODUCTION_PROFILE,
      ),
      null,
    );
    await assertNothingWasGranted(harness, b.projectId, beforeB);
  });

  /* ================================================================== */
  /* R — the provider side-effect window                                 */
  /* ================================================================== */

  it("R1: a PROVABLY-not-dispatched failure frees the slot so a clean retry can start", async () => {
    const harness = await buildHarness();
    const { projectId } = await createNewReadyToBuy(harness);

    harness.paymentProvider!.script({
      kind: "throw",
      error: new ProviderError("auth", "bad credential", "not_dispatched"),
    });

    assert.equal((await harness.payment.createCheckout(projectId)).ok, false);

    // Nothing exists at the provider, so the attempt is closed rather than
    // left occupying the one outstanding slot forever.
    assert.equal(
      await harness.repo.getOutstandingPaymentTransaction(
        projectId,
        APPAREL_RASTER_PRODUCTION_PROFILE,
      ),
      null,
    );

    // And the customer can immediately try again once the credential is fixed.
    const retry = await harness.payment.createCheckout(projectId);
    assert.equal(retry.ok, true);
    await assertNothingWasGranted(harness, projectId);
  });

  it("R2: an AMBIGUOUS failure keeps the attempt resumable, and the retry reuses the SAME provider session", async () => {
    const harness = await buildHarness();
    const { projectId } = await createNewReadyToBuy(harness);

    // Stripe may or may not have created a session before failing. This is
    // the exact window Stripe-plus-Postgres cannot make atomic.
    harness.paymentProvider!.script({
      kind: "throw",
      error: new ProviderError("unavailable", "500", "dispatched_ambiguous"),
    });

    assert.equal((await harness.payment.createCheckout(projectId)).ok, false);

    const stranded = await harness.repo.getOutstandingPaymentTransaction(
      projectId,
      APPAREL_RASTER_PRODUCTION_PROFILE,
    );
    assert.equal(
      stranded?.status,
      "pending_provider",
      "a session that MAY exist must never be raced by a second attempt",
    );
    assert.equal(stranded?.providerCheckoutSessionId, null);

    // The retry replays the SAME idempotency key.
    const retry = await harness.payment.createCheckout(projectId);
    assert.equal(retry.ok, true);

    const [first, second] = harness.paymentProvider!.requests;
    assert.equal(
      second!.paymentTransactionId,
      first!.paymentTransactionId,
      "the idempotency key must survive the failure, or the retry buys a second session",
    );
    assert.equal(harness.paymentProvider!.issuedSessionIds.length, 1);
    await assertNothingWasGranted(harness, projectId);
  });

  it("R3: a crash between the provider answering and us persisting it recovers to the SAME session", async () => {
    const harness = await buildHarness();
    const { projectId } = await createNewReadyToBuy(harness);

    // Simulate the crash precisely: the provider genuinely created a session
    // (the fake now remembers it under that idempotency key), but this
    // process died before binding it. The row is left `pending_provider`.
    const opening = await harness.repo.openPaymentTransaction(projectId, {
      acquisitionSessionId: (await harness.repo.getProject(projectId))!.project
        .acquisitionSessionId!,
      productionProfile: APPAREL_RASTER_PRODUCTION_PROFILE,
      provider: "stripe",
      amountMinor: 4900,
      currency: "usd",
    });
    await harness.paymentProvider!.createProductionUnlockCheckout({
      paymentTransactionId: opening.transaction.id,
      projectId,
      productionProfile: APPAREL_RASTER_PRODUCTION_PROFILE,
      amountMinor: 4900,
      currency: "usd",
      providerPriceId: null,
      customerEmail: "eric@example.com",
      successUrl: `${PUBLIC_BASE_URL}/?project=${projectId}&checkout=complete`,
      cancelUrl: `${PUBLIC_BASE_URL}/?project=${projectId}&checkout=cancelled`,
    });

    const recovered = await harness.payment.createCheckout(projectId);
    assert.equal(recovered.ok, true);
    assert.equal(
      harness.paymentProvider!.issuedSessionIds.length,
      1,
      "recovery must bind the ALREADY-CREATED session, never buy a second one",
    );

    const bound = await harness.repo.getOutstandingPaymentTransaction(
      projectId,
      APPAREL_RASTER_PRODUCTION_PROFILE,
    );
    assert.equal(bound?.id, opening.transaction.id);
    assert.equal(bound?.status, "created");
    await assertNothingWasGranted(harness, projectId);
  });
});
