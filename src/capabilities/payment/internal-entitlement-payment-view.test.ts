import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { createAcquisitionCapability } from "@/capabilities/acquisition";
import { createFinalArtworkCapability } from "@/capabilities/final-artwork";
import { createPaymentCapability } from "@/capabilities/payment";
import type { ProductionUnlockOfferConfig } from "@/lib/config/production-unlock-offer-config";
import type { ProjectRepository } from "@/lib/db/repository";
import { APPAREL_RASTER_PRODUCTION_PROFILE } from "@/lib/domain/types";
import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";

import { resolveProductionUnlockSurface } from "./customer-payment-view";

/**
 * INTERNAL ENTITLEMENT vs THE COMMERCIAL SURFACE.
 *
 * The defect this file exists to prevent, in one sentence: an internal
 * operator was shown "Production unlock is temporarily unavailable" because
 * `describeForCustomer` READ A COMMERCIAL RECORD BEFORE IT ASKED WHO WAS
 * ASKING.
 *
 * `resolveEligibility` had always ranked `internal_project` above every
 * provider and price check, so an unset Stripe key was never the problem.
 * The problem was the two reads that ran BEFORE that ranking could matter —
 * on a deployment whose `production_unlocks` table did not exist yet, the
 * `getActiveProductionUnlock` catch returned `"unavailable"` and the
 * entitlement was never consulted at all.
 *
 * So the tests below deliberately assert against BOTH failure shapes:
 *
 *   NO COMMERCIAL CONFIG    provider/price unset — the "we chose not to sell"
 *                           deployment every internal environment is.
 *   NO COMMERCIAL TABLES    the reads themselves throw — the "A5.1/A5.6
 *                           migrations are not applied" deployment that
 *                           actually produced the incident.
 *
 * Internal authority must survive both. It is a separate tier precisely so
 * that it does not depend on the commercial subsystem being present,
 * reachable, or configured.
 *
 * NO LIVE NETWORK. No payment provider is constructed anywhere in this file.
 */

const CONFIGURED_OFFER: ProductionUnlockOfferConfig = {
  mode: "configured",
  productionProfile: APPAREL_RASTER_PRODUCTION_PROFILE,
  amountMinor: 4900,
  currency: "usd",
  providerPriceId: null,
};

const UNCONFIGURED_OFFER: ProductionUnlockOfferConfig = {
  mode: "unavailable",
  safeErrorCode: "PRODUCTION_UNLOCK_PRICE_NOT_CONFIGURED",
  internalReason: "unset",
};

/**
 * Reproduces the live incident exactly: the commercial tables are absent, so
 * every read against them rejects. Nothing else about the repository changes
 * — acquisition sessions and projects still work, which is precisely why the
 * operator saw a healthy `acquisition` block beside a broken `payment` one.
 */
function withMissingCommercialTables(repo: ProjectRepository): ProjectRepository {
  return new Proxy(repo, {
    get(target, property, receiver) {
      if (
        property === "getActiveProductionUnlock" ||
        property === "getOutstandingPaymentTransaction"
      ) {
        return async () => {
          throw new Error(
            "Could not find the table 'public.production_unlocks' in the schema cache",
          );
        };
      }
      return Reflect.get(target, property, receiver);
    },
  }) as ProjectRepository;
}

describe("Internal entitlement — the commercial surface", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-internal-payment-"));
    process.chdir(tempDir);
  });

  after(async () => {
    await cleanupTempWorkspace(tempDir, previousCwd);
  });

  async function buildHarness(options: {
    offer?: ProductionUnlockOfferConfig;
    /** A provider is never constructed; this only decides whether one is wired. */
    canSell?: boolean;
    missingCommercialTables?: boolean;
  } = {}) {
    const { LocalProjectRepository } = await import("@/lib/db/local-store");

    const base: ProjectRepository = new LocalProjectRepository();
    const repo = options.missingCommercialTables
      ? withMissingCommercialTables(base)
      : base;

    const acquisition = createAcquisitionCapability(repo);
    const finalArtwork = createFinalArtworkCapability(repo, acquisition);
    const payment = createPaymentCapability(
      repo,
      // A deployment that "can sell" still needs no real adapter here: every
      // assertion below stops at or before the provider check.
      options.canSell ? ({ providerKey: "stripe" } as never) : null,
      options.canSell ? "https://iheartprints.example" : null,
      () => options.offer ?? UNCONFIGURED_OFFER,
    );

    // The real repository, never the proxy — assertions about what was
    // written must not be answered by the fault injector.
    return { repo, base, acquisition, finalArtwork, payment };
  }

  type Harness = Awaited<ReturnType<typeof buildHarness>>;

  let tokenCounter = 0;
  const newToken = () => `internal-token-${(tokenCounter += 1)}`;

  async function internalSession(harness: Harness) {
    const session = await harness.base.createAcquisitionSession(newToken());
    const granted = await harness.base.grantInternalEntitlement(session.id);
    assert.equal(granted?.entitlement, "internal");
    assert.ok(granted?.internalGrantedAt, "the grant is audited with a timestamp");
    return granted!;
  }

  async function surfaceFor(harness: Harness, projectId: string) {
    const payment = await harness.payment.describeForCustomer(projectId);
    return {
      payment,
      surface: resolveProductionUnlockSurface({
        payment,
        returnedFromCheckout: false,
      }),
    };
  }

  /**
   * A project with something genuinely purchasable on it — an approved
   * prepared upload. Needed for every PROSPECT assertion below: without it
   * `resolveEligibility` stops at `nothing_to_purchase` and returns
   * `not_applicable`, which would make "prospect sees unavailable" pass for a
   * reason that has nothing to do with the deployment's ability to sell.
   *
   * Written straight to the repository (the same shape the A5.5 journey suite
   * uses) rather than driven through the upload UI — the subject here is the
   * commercial view, not the preparation pipeline.
   */
  async function purchasableProject(harness: Harness, sessionId: string | null) {
    const created = await harness.base.createProject(sessionId);
    const projectId = created.project.id;

    await harness.base.updateBrief(projectId, {
      productSummary: "T-shirts for our bowling team",
      shirtColor: "Black",
      printPlacement: "left_chest",
    });

    const asset = (kind: "customer_upload" | "png", name: string) =>
      harness.base.createAsset(projectId, {
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
    const preparation = await harness.base.createArtworkPreparation(projectId, {
      originalAssetId: original.id,
      originalFilename: "split disturbers.png",
      analysis: { widthPx: 1200, heightPx: 1200 },
    });
    const [artwork] = await harness.base.addArtworkVersions(projectId, [
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
    await harness.base.updateArtworkPreparation(preparation.id, {
      status: "approved",
      preparedAssetId: prepared.id,
      preparedArtworkVersionId: artwork!.id,
      approvedAt: new Date().toISOString(),
    });
    await harness.base.setProjectStatus(projectId, "approved");
    return projectId;
  }

  /** Nothing commercial may be written for an internal operator, ever. */
  async function assertNoCommercialRecords(harness: Harness, projectId: string) {
    assert.equal(
      await harness.base.getActiveProductionUnlock(
        projectId,
        APPAREL_RASTER_PRODUCTION_PROFILE,
      ),
      null,
      "an internal session must never have a ProductionUnlock fabricated for it",
    );
    assert.equal(
      await harness.base.getOutstandingPaymentTransaction(
        projectId,
        APPAREL_RASTER_PRODUCTION_PROFILE,
      ),
      null,
      "an internal session must never have a PaymentTransaction created for it",
    );
  }

  /* ================================================================== */
  /* A / B — the same deployment, two entitlements                       */
  /* ================================================================== */

  it("A: a prospect on a deployment that cannot sell sees the neutral unavailable note", async () => {
    const harness = await buildHarness();
    const session = await harness.base.createAcquisitionSession(newToken());
    const projectId = await purchasableProject(harness, session.id);

    // An address is what moves a prospect PAST `email_required` and into the
    // provider/price checks — without it this would be `not_applicable` for a
    // reason that has nothing to do with configuration.
    await harness.base.captureAcquisitionEmail(session.id, {
      email: "eric@example.com",
    });

    const view = await surfaceFor(harness, projectId);
    assert.equal(view.payment.state, "unavailable");
    assert.equal(view.surface, "unavailable");
    assert.equal(view.payment.offer, null, "no price when none is configured");
  });

  it("B: an internal session on that SAME deployment has no commercial surface at all", async () => {
    const harness = await buildHarness();
    const session = await internalSession(harness);
    const created = await harness.base.createProject(session.id);

    const view = await surfaceFor(harness, created.project.id);
    assert.equal(
      view.payment.state,
      "not_applicable",
      "internal is not 'we cannot sell right now' — there is nothing to sell",
    );
    assert.equal(view.surface, "none");
    assert.equal(view.payment.offer, null);
    assert.equal(view.payment.checkoutPending, false);
  });

  /* ================================================================== */
  /* THE REGRESSION ITSELF — commercial tables absent                    */
  /* ================================================================== */

  it("B2: internal survives the commercial tables not existing — the live incident", async () => {
    const harness = await buildHarness({ missingCommercialTables: true });
    const session = await internalSession(harness);
    const created = await harness.base.createProject(session.id);

    const view = await surfaceFor(harness, created.project.id);
    assert.equal(
      view.payment.state,
      "not_applicable",
      "internal authority must not depend on the commercial subsystem existing",
    );
    assert.equal(view.surface, "none");
  });

  it("B3: a prospect still degrades honestly when the commercial tables are absent", async () => {
    const harness = await buildHarness({ missingCommercialTables: true });
    const session = await harness.base.createAcquisitionSession(newToken());
    const projectId = await purchasableProject(harness, session.id);
    await harness.base.captureAcquisitionEmail(session.id, {
      email: "eric@example.com",
    });

    const view = await surfaceFor(harness, projectId);
    assert.equal(
      view.payment.state,
      "unavailable",
      "an unreadable commercial subsystem is still 'we cannot sell right now' for a real buyer",
    );
    assert.equal(view.surface, "unavailable");
  });

  /* ================================================================== */
  /* C / D — fresh project, and Start Over                               */
  /* ================================================================== */

  it("C: a fresh project on an internal session is not_applicable immediately", async () => {
    const harness = await buildHarness();
    const session = await internalSession(harness);
    const created = await harness.base.createProject(session.id);

    assert.equal(
      created.project.acquisitionSessionId,
      session.id,
      "project creation binds to the granted session, never a rotated one",
    );
    assert.equal((await surfaceFor(harness, created.project.id)).surface, "none");
  });

  it("D: Start Over — every later project on the same session stays not_applicable", async () => {
    const harness = await buildHarness();
    const session = await internalSession(harness);

    // The operator must not have to re-present the internal key per project.
    const first = await harness.base.createProject(session.id);
    const second = await harness.base.createProject(session.id);
    const third = await harness.base.createProject(session.id);

    for (const created of [first, second, third]) {
      assert.equal(created.project.acquisitionSessionId, session.id);
      const view = await surfaceFor(harness, created.project.id);
      assert.equal(view.payment.state, "not_applicable");
      assert.equal(view.surface, "none");
    }

    // And the grant itself is still on the row, unrotated and still audited.
    const reread = await harness.base.getAcquisitionSession(session.id);
    assert.equal(reread?.entitlement, "internal");
    assert.ok(reread?.internalGrantedAt);
  });

  /* ================================================================== */
  /* E / F — the two workflows                                           */
  /* ================================================================== */

  it("E: internal Create New — no email gate, no free-concept ceiling", async () => {
    const harness = await buildHarness();
    const session = await internalSession(harness);
    const created = await harness.base.createProject(session.id);
    const projectId = created.project.id;

    const first = await harness.acquisition.authorizeConceptGeneration(projectId);
    assert.equal(first.allowed, true);
    assert.equal(
      first.allowed && first.grant,
      "entitled",
      "internal is not spending the one free acquisition concept",
    );

    // The ceiling is what a prospect hits on the SECOND ask. Internal must
    // not, and must not have consumed anything to prove it.
    const second = await harness.acquisition.authorizeConceptGeneration(projectId);
    assert.equal(second.allowed, true);
    assert.equal(second.allowed && second.grant, "entitled");
    assert.equal(
      second.allowed && second.sessionId,
      null,
      "an entitled grant binds no free-concept session",
    );

    const continuation =
      await harness.acquisition.authorizeSessionContinuation(projectId);
    assert.equal(
      continuation.allowed,
      true,
      "internal is never asked for an email to keep working",
    );

    const view = await harness.acquisition.describeForCustomer(projectId, {
      generating: false,
    });
    assert.equal(view.state, "open");
    assert.equal(
      JSON.stringify(view).includes("internal"),
      false,
      "the customer surface must never reveal that an internal tier exists",
    );
  });

  it("F: internal Existing Artwork — the upload path's only gate is open too", async () => {
    const harness = await buildHarness();
    const session = await internalSession(harness);
    const created = await harness.base.createProject(session.id);
    const projectId = created.project.id;

    // An upload never consumes a free concept, so `authorizeFinalization` is
    // the ONLY acquisition gate between an upload and paid reconstruction.
    assert.equal(
      (await harness.acquisition.authorizeFinalization(projectId)).allowed,
      true,
    );
    assert.equal((await surfaceFor(harness, projectId)).surface, "none");
    await assertNoCommercialRecords(harness, projectId);
  });

  /* ================================================================== */
  /* G / H — finalization, both tiers                                    */
  /* ================================================================== */

  it("G: internal finalization is allowed with no ProductionUnlock in existence", async () => {
    const harness = await buildHarness();
    const session = await internalSession(harness);
    const created = await harness.base.createProject(session.id);

    assert.equal(
      (await harness.acquisition.authorizeFinalization(created.project.id)).allowed,
      true,
    );
    await assertNoCommercialRecords(harness, created.project.id);
  });

  it("H: a prospect is still locked out of finalization without an unlock", async () => {
    const harness = await buildHarness();
    const session = await harness.base.createAcquisitionSession(newToken());
    const created = await harness.base.createProject(session.id);

    const authorization = await harness.acquisition.authorizeFinalization(
      created.project.id,
    );
    assert.equal(
      authorization.allowed,
      false,
      "the commercial gate must be exactly as closed as it was before this fix",
    );
  });

  /* ================================================================== */
  /* I / J — nothing commercial is ever fabricated                       */
  /* ================================================================== */

  it("I/J: reading the internal customer view creates no unlock and no transaction", async () => {
    const harness = await buildHarness();
    const session = await internalSession(harness);
    const created = await harness.base.createProject(session.id);
    const projectId = created.project.id;

    // Read it repeatedly: a view that fabricated state would show it here.
    for (let i = 0; i < 3; i += 1) {
      assert.equal((await surfaceFor(harness, projectId)).surface, "none");
    }

    await assertNoCommercialRecords(harness, projectId);
    assert.equal(
      (await harness.acquisition.authorizeFinalization(projectId)).allowed,
      true,
      "the entitlement itself is the authority — not a synthesized record",
    );
    await assertNoCommercialRecords(harness, projectId);
  });

  it("J2: an internal session is refused checkout rather than sold anything", async () => {
    const harness = await buildHarness({
      offer: CONFIGURED_OFFER,
      canSell: true,
    });
    const session = await internalSession(harness);
    const created = await harness.base.createProject(session.id);

    const result = await harness.payment.createCheckout(created.project.id);
    assert.equal(
      result.ok,
      false,
      "charging an internal operator would take money for access already granted",
    );
    await assertNoCommercialRecords(harness, created.project.id);
  });

  /* ================================================================== */
  /* K — the public flow is untouched                                    */
  /* ================================================================== */

  it("K: a configured deployment still offers the unlock to a real prospect", async () => {
    const harness = await buildHarness({
      offer: CONFIGURED_OFFER,
      canSell: true,
    });
    const session = await harness.base.createAcquisitionSession(newToken());
    const created = await harness.base.createProject(session.id);
    await harness.base.captureAcquisitionEmail(session.id, {
      email: "eric@example.com",
    });

    // A prospect with nothing designed yet has nothing to buy — the honest
    // `not_applicable`, and the same answer as before this change.
    const beforeAnything = await surfaceFor(harness, created.project.id);
    assert.equal(beforeAnything.payment.state, "not_applicable");

    // The offer itself still reaches a real buyer. This is the assertion that
    // would catch an over-broad short-circuit swallowing the whole funnel.
    const purchasable = await purchasableProject(harness, session.id);
    const offered = await surfaceFor(harness, purchasable);
    assert.equal(offered.payment.state, "payment_required");
    assert.equal(offered.surface, "payment_required");
    assert.match(offered.payment.offer!.title, /Unlock this design for production/);
    assert.equal(offered.payment.offer!.displayAmount, "$49.00");

    // A legacy project (no session at all) is grandfathered, exactly as the
    // finalization gate grandfathers it.
    const legacy = await harness.base.createProject(null);
    const legacyView = await surfaceFor(harness, legacy.project.id);
    assert.equal(legacyView.payment.state, "not_applicable");
    assert.equal(legacyView.surface, "none");
    assert.equal(
      (await harness.acquisition.authorizeFinalization(legacy.project.id)).allowed,
      true,
      "legacy stays grandfathered — this fix must not narrow that",
    );
  });
});
