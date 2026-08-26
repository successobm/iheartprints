import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { DataUriAssetStorageProvider } from "@/capabilities/asset-storage";
import { createAssetCapability, PngThumbnailGenerator } from "@/capabilities/assets";
import { createDesignBriefCapability } from "@/capabilities/design-brief";
import { createArtworkPreparationCapability } from "@/capabilities/artwork-preparation/artwork-preparation-capability";
import { solidBlackExteriorArtwork, toPngBytes } from "@/capabilities/artwork-preparation/artwork-fixtures";
import { describePrintReadySize } from "@/capabilities/shared/print-ready-size";
import {
  DEFAULT_PRODUCTION_TREATMENT,
  type GarmentSizeClass,
} from "@/lib/domain/types";
import { assessHalftoneEligibility } from "@/capabilities/shared/production-treatment";
import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";
import { approvePreparedArtworkForTests } from "@/test-support/approve-prepared-artwork-for-tests";

/**
 * Phase 27L — PRINT SIZE CONFIRMATION + FINAL PREPARATION STATE UX.
 *
 * Human acceptance of Phase 27K reached the print-preparation screen and
 * found a contradiction: "Standard Adult" and "Standard Raster" rendered
 * selected/active while the project still said "Confirm the print size
 * before preparation" and DTF Halftone stayed disabled for "no size
 * confirmed".
 *
 * ROOT CAUSE (proven in test 1 below): choosing a garment size class
 * (`chooseGarmentSize` in ChatApp.tsx, calling `POST /print-size/confirm`)
 * only ever sent `{ garmentSizeClass }` -- never `{ useRecommended: true }`
 * -- so it updated the RECOMMENDATION and genuinely, correctly rendered
 * that choice as selected, while the separate CONFIRMATION fact
 * (`productionSizeConfirmedAt`/`Width`) stayed untouched. This was an
 * inconsistency, not a deliberate safeguard: the sibling control
 * (`choosePrintWidth` / `applyProductionPrintWidth`) already confirms on
 * an explicit width choice (see that function's own doc comment) -- the
 * garment picker was the one outlier.
 *
 * THE FIX (ChatApp.tsx's `chooseGarmentSize`): when the chosen garment
 * class has an authoritative recommendation box for the project's
 * placement, the SAME request now also sends `useRecommended: true` --
 * exercising the server's ALREADY-EXISTING support for combining both
 * (see `print-size/confirm/route.ts`: "A garment size class, when
 * present, is applied FIRST... if useRecommended, confirms afterward").
 * Zero server/schema changes were needed or made.
 */
describe("Phase 27L: garment-class selection and print-size confirmation", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-print-size-garment-"));
    process.chdir(tempDir);
  });

  after(async () => {
    await cleanupTempWorkspace(tempDir, previousCwd);
  });

  async function seededProject(acquisitionSessionId?: string) {
    const { resetCapabilityGraphForTests, getCapabilityGraph } = await import("@/capabilities/composition");
    resetCapabilityGraphForTests();
    const graph = getCapabilityGraph();
    const { LocalProjectRepository } = await import("@/lib/db/local-store");
    const repo = new LocalProjectRepository();
    const assets = createAssetCapability(repo, new DataUriAssetStorageProvider(), new PngThumbnailGenerator());
    const artworkPreparation = createArtworkPreparationCapability(repo, assets, createDesignBriefCapability(repo));

    // `acquisitionSessionId` binds only at creation (Sprint A4) -- it is
    // deliberately not part of `updateProject`'s patch type, so a caller
    // that needs a real (non-legacy) session bound must supply it here.
    const projectId = (await repo.createProject(acquisitionSessionId)).project.id;
    await artworkPreparation.uploadOriginal(projectId, {
      bytes: toPngBytes(solidBlackExteriorArtwork()),
      declaredContentType: "image/png",
      filename: "artwork.png",
    });
    await artworkPreparation.setProductionContext(projectId, {
      productSummary: "T-shirts",
      productColor: "Black",
      printPlacement: "full_front",
    });
    return { graph, repo, projectId };
  }

  async function printReadySizeFor(repo: Awaited<ReturnType<typeof seededProject>>["repo"], projectId: string) {
    const snapshot = await repo.getProject(projectId);
    return describePrintReadySize({
      printPlacement: snapshot!.brief.printPlacement,
      intendedPrintWidthIn: snapshot!.brief.intendedPrintWidthIn,
      artworkWidthPx: null,
      artworkHeightPx: null,
      garmentSizeClass: snapshot!.brief.garmentSizeClass,
      productionSizeConfirmedAt: snapshot!.brief.productionSizeConfirmedAt,
      productionSizeConfirmedWidthIn: snapshot!.brief.productionSizeConfirmedWidthIn,
      productionSizeConfirmedMaxHeightIn: snapshot!.brief.productionSizeConfirmedMaxHeightIn,
    });
  }

  it("1: REPRODUCED -- the old behavior (garment class set alone, never confirming) is exactly the human-observed contradiction", async () => {
    const { graph, repo, projectId } = await seededProject();

    // The OLD `chooseGarmentSize` request shape: garment class only.
    await graph.conversation.setGarmentSizeClass(projectId, "adult_standard");

    const size = await printReadySizeFor(repo, projectId);
    assert.ok(size);
    assert.equal(size!.garmentSizeOptions.find((o) => o.value === "adult_standard")!.isSelected, true, "Standard Adult genuinely IS selected -- this part was always honest");
    assert.equal(size!.confirmed, false, "yet the physical size is genuinely still unconfirmed");
    assert.match(size!.blockingMessage ?? "", /Confirm the print size before preparation/);
  });

  it("2: FIXED -- selecting a garment class WITH a recommendation box (via the real route, combined body) confirms it in the same action", async () => {
    const { repo, projectId } = await seededProject();

    const selectRoute = await import("@/app/api/projects/[projectId]/print-size/confirm/route");
    const res = await selectRoute.POST(
      new Request("http://localhost/x", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ garmentSizeClass: "adult_standard", useRecommended: true }),
      }),
      { params: Promise.resolve({ projectId }) },
    );
    assert.equal(res.status, 200, await res.clone().text());

    const size = await printReadySizeFor(repo, projectId);
    assert.ok(size);
    assert.equal(size!.garmentSizeOptions.find((o) => o.value === "adult_standard")!.isSelected, true);
    assert.equal(size!.confirmed, true, "the recommended box must now be genuinely confirmed");
    assert.equal(size!.widthIn, 10.5);
    assert.equal(size!.recommendation!.isConfirmed, true);
    assert.equal(size!.blockingMessage, null, "the contradictory warning must be gone");
  });

  it("3: switching garment category updates dimensions deterministically -- no stale confirmed dimensions survive", async () => {
    const { repo, projectId } = await seededProject();

    async function chooseAndConfirm(garmentSizeClass: GarmentSizeClass) {
      // Mirrors the fixed ChatApp.tsx behavior exactly: combined request for
      // any class with a box.
      const route = await import("@/app/api/projects/[projectId]/print-size/confirm/route");
      const res = await route.POST(
        new Request("http://localhost/x", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ garmentSizeClass, useRecommended: true }),
        }),
        { params: Promise.resolve({ projectId }) },
      );
      assert.equal(res.status, 200, await res.clone().text());
    }
    await chooseAndConfirm("adult_standard");
    let size = await printReadySizeFor(repo, projectId);
    assert.equal(size!.widthIn, 10.5);
    assert.equal(size!.confirmed, true);

    await chooseAndConfirm("adult_plus");
    size = await printReadySizeFor(repo, projectId);
    assert.equal(size!.widthIn, 12, "dimensions must update to the NEW class's box, not the stale 10.5");
    assert.equal(size!.confirmed, true, "the new class's box is confirmed in the same action -- never a moment of falling back to unconfirmed");
    assert.equal(size!.garmentSizeOptions.find((o) => o.value === "adult_plus")!.isSelected, true);
    assert.equal(size!.garmentSizeOptions.find((o) => o.value === "adult_standard")!.isSelected, false, "styling must move with the actual state, not linger on the old choice");
  });

  it("4: Custom Size does not auto-confirm (no box exists), but an explicit width still confirms exactly as before", async () => {
    const { graph, repo, projectId } = await seededProject();

    // Mirrors the fixed client: `custom` has no recommendation box, so no
    // `useRecommended` is sent.
    const route = await import("@/app/api/projects/[projectId]/print-size/confirm/route");
    const res = await route.POST(
      new Request("http://localhost/x", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ garmentSizeClass: "custom" }),
      }),
      { params: Promise.resolve({ projectId }) },
    );
    assert.equal(res.status, 200, await res.clone().text());

    let size = await printReadySizeFor(repo, projectId);
    assert.equal(size!.confirmed, false, "custom must never be auto-confirmed -- there is no box to confirm");
    assert.equal(size!.requiresExplicitWidth, true);
    assert.equal(size!.recommendation, null);

    // The operator states an explicit width -- the existing, unmodified path.
    await graph.conversation.setProductionPrintWidth(projectId, 11);
    size = await printReadySizeFor(repo, projectId);
    assert.equal(size!.confirmed, true, "an explicit width still confirms, exactly as before this phase");
    assert.equal(size!.widthIn, 11);
  });

  it("5: invalid/out-of-band custom width fails closed -- stays unconfirmed rather than clamping", async () => {
    const { graph, repo, projectId } = await seededProject();
    await graph.conversation.setGarmentSizeClass(projectId, "custom");
    // full_front technical band tops out well below 100in.
    await graph.conversation.setProductionPrintWidth(projectId, 100);
    const size = await printReadySizeFor(repo, projectId);
    assert.equal(size!.confirmed, false, "a clamped/out-of-band request must not manufacture consent for the clamped value");
  });

  it("6: DTF Halftone eligibility -- ineligible with the exact real message before confirmation, eligible once confirmed (all other prerequisites met)", async () => {
    const before = assessHalftoneEligibility({
      productionCategory: "apparel_raster",
      productionSizeConfirmed: false,
      preparedSourceAvailable: true,
      garment: { hex: "#000000", label: "Black", tone: "dark" } as never,
      tone: { visiblePixelCount: 1, midtoneFraction: 1 },
    });
    assert.equal(before.eligible, false);
    assert.equal(before.reason, "production_size_unconfirmed");
    assert.match(before.rationale, /no size has been confirmed for this project/);

    const after = assessHalftoneEligibility({
      productionCategory: "apparel_raster",
      productionSizeConfirmed: true,
      preparedSourceAvailable: true,
      garment: { hex: "#000000", label: "Black", tone: "dark" } as never,
      tone: { visiblePixelCount: 1, midtoneFraction: 1 },
    });
    assert.equal(after.eligible, true, "DTF Halftone must become selectable once size is confirmed and no other prerequisite blocks it");
  });

  it("7: Standard Raster is the genuine default persisted treatment, not merely styled -- productionTreatment === 'standard_raster' before any explicit selection", async () => {
    const { repo, projectId } = await seededProject();
    const snapshot = await repo.getProject(projectId);
    assert.equal(snapshot!.brief.productionTreatment, DEFAULT_PRODUCTION_TREATMENT);
    assert.equal(DEFAULT_PRODUCTION_TREATMENT, "standard_raster");
  });

  it("8: Prepare Print-Ready Artwork's enablement predicate is exactly !printReadySize.confirmed -- confirming a garment class satisfies it", async () => {
    const { repo, projectId } = await seededProject();
    let size = await printReadySizeFor(repo, projectId);
    assert.equal(!size!.confirmed, true, "before: button must be disabled");

    const route = await import("@/app/api/projects/[projectId]/print-size/confirm/route");
    await route.POST(
      new Request("http://localhost/x", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ garmentSizeClass: "adult_standard", useRecommended: true }),
      }),
      { params: Promise.resolve({ projectId }) },
    );

    size = await printReadySizeFor(repo, projectId);
    assert.equal(!size!.confirmed, false, "after: button must be enabled");
  });

  it("9: end-to-end -- once approved artwork exists and size is confirmed, DTF Halftone can genuinely be selected, and switching back to Standard Raster genuinely restores it", async () => {
    // Internal entitlement -- `selectProductionTreatment`'s own gate -- must
    // be bound at project CREATION (Sprint A4: not part of `updateProject`'s
    // patch type, and not reassignable after the fact), so the session is
    // resolved/granted before `seededProject` creates the project.
    const { getCapabilityGraph: getGraphForSession } = await import("@/capabilities/composition");
    const sessionGraph = getGraphForSession();
    const session = await sessionGraph.acquisition.resolveOrCreateSession(null);
    const { LocalProjectRepository: RepoForGrant } = await import("@/lib/db/local-store");
    await new RepoForGrant().grantInternalEntitlement(session.id);

    const { graph, repo, projectId } = await seededProject(session.id);

    // Approved, background-prepared source (a real halftone prerequisite).
    await graph.artworkPreparation.prepareBackground(projectId);
    await approvePreparedArtworkForTests(graph.artworkPreparation, projectId);

    // Confirm size via the fixed garment-class path.
    const route = await import("@/app/api/projects/[projectId]/print-size/confirm/route");
    await route.POST(
      new Request("http://localhost/x", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ garmentSizeClass: "adult_standard", useRecommended: true }),
      }),
      { params: Promise.resolve({ projectId }) },
    );

    // Select DTF Halftone -- must actually change the persisted treatment.
    await graph.conversation.selectProductionTreatment(projectId, {
      treatment: "halftone_dtf",
      halftone: {},
    });
    let snapshot = await repo.getProject(projectId);
    assert.equal(snapshot!.brief.productionTreatment, "halftone_dtf", "selecting DTF Halftone must genuinely change production-treatment state");

    // Switch back to Standard Raster -- must genuinely restore it.
    await graph.conversation.selectProductionTreatment(projectId, { treatment: "standard_raster" });
    snapshot = await repo.getProject(projectId);
    assert.equal(snapshot!.brief.productionTreatment, "standard_raster", "switching back must genuinely restore Standard Raster, not just LOOK restored");
  });
});
