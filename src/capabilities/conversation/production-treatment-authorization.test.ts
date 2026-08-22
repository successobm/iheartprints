import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";
import { confirmProductionSizeForTests } from "@/test-support/confirm-production-size";
import { createAcquisitionCapability } from "@/capabilities/acquisition";
import { PRODUCTION_TREATMENT_NOT_AVAILABLE_MESSAGE } from "@/capabilities/conversation";
import { createCapabilityGraph } from "@/capabilities/composition";
import {
  MAX_HALFTONE_LPI,
  MIN_HALFTONE_LPI,
} from "@/capabilities/shared/production-treatment";
import type { ProjectRepository } from "@/lib/db/repository";

/**
 * Print'em All Phase 2 (Goal 24; test matrix T, U) — WHO MAY CHOOSE A
 * PRODUCTION TREATMENT.
 *
 * Phase 2 restricts treatment selection to internal Print'em All operators,
 * and the whole question this file exists to settle is WHERE that restriction
 * lives. A hidden UI toggle, a query string, or a browser flag can decide what
 * a page SHOWS; only a server-side check on the WRITE can decide what the
 * system DOES. These scenarios go straight at the capability, bypassing every
 * surface, which is exactly what a forged request would do.
 */

describe("Production treatment authorization (Print'em All Phase 2)", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-treatment-auth-"));
    process.chdir(tempDir);
  });

  after(async () => {
    await cleanupTempWorkspace(tempDir, previousCwd);
  });

  async function freshRepo() {
    const { LocalProjectRepository } = await import("@/lib/db/local-store");
    return new LocalProjectRepository();
  }

  /**
   * The REAL capability graph over a test repository — not a hand-assembled
   * subset. The gate under test lives at a capability boundary, so a stubbed
   * graph could easily prove that a stub refuses rather than that the system
   * does.
   */
  function buildConversation(repo: ProjectRepository) {
    return createCapabilityGraph(repo).conversation;
  }

  /**
   * A project with everything the treatment needs EXCEPT the entitlement:
   * a confirmed size, an approved prepared source, and a resolvable garment
   * colour. So when a scenario is refused, the only thing that can have
   * refused it is the authorization gate.
   */
  async function setupEligibleProject(
    repo: ProjectRepository,
    options: { internal?: boolean } = {},
  ) {
    const acquisition = createAcquisitionCapability(repo);
    const session = await acquisition.resolveOrCreateSession(null);
    if (options.internal) {
      await repo.grantInternalEntitlement(session.id);
    }

    const created = await repo.createProject(session.id);
    const projectId = created.project.id;

    await repo.updateBrief(projectId, {
      productSummary: "T-shirts for our bowling team",
      shirtColor: "Black",
      printPlacement: "full_back",
    });

    // Asset ROWS only. These scenarios are about who may make a decision, so
    // no bytes are stored and no raster is ever produced — which is also what
    // keeps the gate the only thing that can refuse them.
    const asset = (kind: "customer_upload" | "png", hasTransparency: boolean) => ({
      kind,
      storageKey: `${kind}.png`,
      contentType: "image/png",
      isThumbnail: false,
      widthPx: 584,
      heightPx: 640,
      hasTransparency,
      providerKey: null,
      generationJobId: null,
      metadata: {},
      vectorAssetId: null,
      printAssetId: null,
      finalArtworkJobId: null,
      productionRole: null,
    });
    const original = await repo.createAsset(
      projectId,
      asset("customer_upload", false) as never,
    );
    const prepared = await repo.createAsset(projectId, asset("png", true) as never);

    const preparation = await repo.createArtworkPreparation(projectId, {
      originalAssetId: original.id,
      originalFilename: "team artwork.png",
      analysis: { widthPx: 584, heightPx: 640 },
    });
    const [artwork] = await repo.addArtworkVersions(projectId, [
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
    await repo.updateArtworkPreparation(preparation.id, {
      status: "approved",
      preparedAssetId: prepared.id,
      preparedArtworkVersionId: artwork!.id,
      preparation: { backgroundRemoved: true },
      approvedAt: new Date().toISOString(),
    });
    await repo.setProjectStatus(projectId, "approved");
    await confirmProductionSizeForTests(repo, projectId, { widthIn: 10.5 });

    return { projectId, sessionId: session.id };
  }

  it("T: an internal operator may select the halftone treatment, and it persists", async () => {
    const repo = await freshRepo();
    const { projectId } = await setupEligibleProject(repo, { internal: true });
    const conversation = buildConversation(repo);

    const snapshot = await conversation.selectProductionTreatment(projectId, {
      treatment: "halftone_dtf",
      halftone: { lpi: 40, angleDeg: 22.5 },
    });

    assert.equal(snapshot.brief.productionTreatment, "halftone_dtf");
    assert.equal(snapshot.brief.halftoneSettings?.lpi, 40);
    assert.equal(snapshot.brief.halftoneSettings?.angleDeg, 22.5);
    assert.equal(snapshot.brief.halftoneSettings?.garment.hex, "#000000");
    // The audit fact that separates a chosen treatment from a defaulted one.
    assert.ok(snapshot.brief.productionTreatmentSelectedAt);
  });

  it("U: a PUBLIC customer is refused, even calling the capability directly", async () => {
    // No surface involved. This is what a forged request, a stale tab, or a
    // curious customer hitting the endpoint by hand actually does.
    const repo = await freshRepo();
    const { projectId } = await setupEligibleProject(repo, { internal: false });
    const conversation = buildConversation(repo);

    await assert.rejects(
      () =>
        conversation.selectProductionTreatment(projectId, {
          treatment: "halftone_dtf",
        }),
      (error: Error) => {
        // Deliberately uninformative: a public customer has no use for the
        // fact that an internal production tier exists, and a probe must not
        // be able to map the entitlement model from the message.
        assert.equal(error.message, PRODUCTION_TREATMENT_NOT_AVAILABLE_MESSAGE);
        assert.doesNotMatch(error.message, /internal|entitle|permission|forbidden/i);
        return true;
      },
    );

    // And nothing was written. A refusal that had already persisted half a
    // decision would be worse than no gate at all.
    const brief = (await repo.getProject(projectId))!.brief;
    assert.equal(brief.productionTreatment, "standard_raster");
    assert.equal(brief.halftoneSettings, null);
    assert.equal(brief.productionTreatmentSelectedAt, null);
  });

  it("U: a public customer is refused even for the DEFAULT treatment", async () => {
    // Selecting standard raster changes nothing about the plate, so it would
    // be tempting to let it through. It is still refused, because the endpoint
    // existing and responding differently for different callers is itself the
    // signal a probe is looking for.
    const repo = await freshRepo();
    const { projectId } = await setupEligibleProject(repo, { internal: false });
    const conversation = buildConversation(repo);

    await assert.rejects(
      () =>
        conversation.selectProductionTreatment(projectId, {
          treatment: "standard_raster",
        }),
      (error: Error) => error.message === PRODUCTION_TREATMENT_NOT_AVAILABLE_MESSAGE,
    );
  });

  it("a LEGACY project is not internal — grandfathering is commercial, never an authorization", async () => {
    const repo = await freshRepo();
    const created = await repo.createProject(null);
    const acquisition = createAcquisitionCapability(repo);
    assert.equal(await acquisition.isInternalProject(created.project.id), false);
  });

  it("an unknown project is not internal — the gate fails closed", async () => {
    const repo = await freshRepo();
    const acquisition = createAcquisitionCapability(repo);
    assert.equal(
      await acquisition.isInternalProject("00000000-0000-4000-8000-000000000000"),
      false,
    );
  });

  it("refuses settings outside the supported band rather than clamping them", async () => {
    const repo = await freshRepo();
    const { projectId } = await setupEligibleProject(repo, { internal: true });
    const conversation = buildConversation(repo);

    await assert.rejects(
      () =>
        conversation.selectProductionTreatment(projectId, {
          treatment: "halftone_dtf",
          halftone: { lpi: MAX_HALFTONE_LPI + 20 },
        }),
      (error: Error) => {
        // The operator is told the band. They are not quietly given 55 and
        // left to wonder why the print does not match what they asked for.
        assert.match(error.message, new RegExp(`${MIN_HALFTONE_LPI}-${MAX_HALFTONE_LPI} LPI`));
        return true;
      },
    );

    const brief = (await repo.getProject(projectId))!.brief;
    assert.equal(brief.productionTreatment, "standard_raster");
  });

  it("refuses the halftone treatment before a size is confirmed, with an actionable reason", async () => {
    const repo = await freshRepo();
    const { projectId } = await setupEligibleProject(repo, { internal: true });
    await repo.updateBrief(projectId, {
      productionSizeConfirmedAt: null,
      productionSizeConfirmedWidthIn: null,
      productionSizeConfirmedMaxHeightIn: null,
    });
    const conversation = buildConversation(repo);

    await assert.rejects(
      () =>
        conversation.selectProductionTreatment(projectId, {
          treatment: "halftone_dtf",
        }),
      (error: Error) => {
        assert.match(error.message, /Confirm the print size/);
        return true;
      },
    );
  });

  it("refuses when the garment colour cannot be resolved — the screen has no reference point", async () => {
    const repo = await freshRepo();
    const { projectId } = await setupEligibleProject(repo, { internal: true });
    await repo.updateBrief(projectId, { shirtColor: "heathered oatmeal marle" });
    const conversation = buildConversation(repo);

    await assert.rejects(
      () =>
        conversation.selectProductionTreatment(projectId, {
          treatment: "halftone_dtf",
        }),
      (error: Error) => {
        assert.match(error.message, /garment colour/i);
        return true;
      },
    );
  });

  it("refuses while a plate is being prepared — the treatment decides what is in the oven", async () => {
    const repo = await freshRepo();
    const { projectId } = await setupEligibleProject(repo, { internal: true });
    await repo.setProjectStatus(projectId, "finalizing");
    const conversation = buildConversation(repo);

    await assert.rejects(
      () =>
        conversation.selectProductionTreatment(projectId, {
          treatment: "halftone_dtf",
        }),
      (error: Error) => {
        assert.match(error.message, /being prepared right now/);
        return true;
      },
    );
  });

  it("an internal operator can retract back to standard raster in one call", async () => {
    const repo = await freshRepo();
    const { projectId } = await setupEligibleProject(repo, { internal: true });
    const conversation = buildConversation(repo);

    await conversation.selectProductionTreatment(projectId, {
      treatment: "halftone_dtf",
    });
    const retracted = await conversation.selectProductionTreatment(projectId, {
      treatment: "standard_raster",
    });

    assert.equal(retracted.brief.productionTreatment, "standard_raster");
    // Settings are CLEARED, never left behind: settings that outlive the
    // treatment they belong to are settings a future reader can mistake for
    // the current screen.
    assert.equal(retracted.brief.halftoneSettings, null);
    assert.equal(retracted.brief.productionTreatmentSelectedAt, null);
  });
});
