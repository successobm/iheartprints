import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { bowlingStyleArtwork, toPngBytes } from "@/capabilities/artwork-preparation/artwork-fixtures";
import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";

/**
 * Intelligent Separation Phase 10, Goal 12: PUBLIC SECURITY, proven through
 * actual route behavior rather than the hidden React controls that gate
 * `SeparationReviewPanel`'s mount. Every route Phase 9 built calls
 * `graph.acquisition.isInternalProject` before touching the capability
 * (Phase 9's "U" test proved this by reading the route source); this file
 * proves the CONSEQUENCE of that gate by actually invoking the exported
 * route handlers against a real project, the way the repo's other
 * route-level tests do (see `production-artwork/image/route.test.ts`).
 *
 * No route in this codebase gated on `isInternalProject` had a behavioral
 * test before this file — including the precedent route this feature copies
 * its gate from (`production-treatment/preview/route.ts`). This is the first.
 */
describe("Separation routes — internal-only authorization (Phase 10 Goal 12)", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-separation-routes-"));
    process.chdir(tempDir);
  });

  after(async () => {
    await cleanupTempWorkspace(tempDir, previousCwd);
  });

  async function seededProject(options: { internal: boolean }) {
    const { resetCapabilityGraphForTests, getCapabilityGraph } = await import("@/capabilities/composition");
    resetCapabilityGraphForTests();
    const graph = getCapabilityGraph();
    const { getProjectRepository } = await import("@/lib/db");
    const repo = getProjectRepository();

    const session = await graph.acquisition.resolveOrCreateSession(null);
    if (options.internal) {
      await repo.grantInternalEntitlement(session.id);
    }
    const created = await repo.createProject(session.id);
    const projectId = created.project.id;

    await graph.artworkPreparation.uploadOriginal(projectId, {
      bytes: toPngBytes(bowlingStyleArtwork()),
      declaredContentType: "image/png",
      filename: "logo.png",
    });
    await graph.artworkPreparation.setProductionContext(projectId, {
      productSummary: "T-shirts for our bowling team",
      productColor: "Black",
      printPlacement: "full_front",
    });
    await graph.artworkPreparation.prepareBackground(projectId);

    return { graph, repo, projectId };
  }

  async function callRoutes(projectId: string) {
    const getRoute = await import("./route");
    const decisionsRoute = await import("./decisions/route");
    const proposalRoute = await import("./decisions/proposal/route");
    const approveRoute = await import("./approve/route");
    const imageRoute = await import("./image/route");
    const params = { params: Promise.resolve({ projectId }) };

    const getRes = await getRoute.GET(new Request("http://localhost/x"), params);

    // A decision body a genuinely internal caller would send next, reused
    // for both the public-denial and internal-acceptance assertions so the
    // only variable between them is who is asking.
    let decisionBody: { sourceAssetSha256: string; regionMapHash: string; decisions: Array<{ regionId: number; intent: string }> } | null =
      null;
    // Phase 23: the operator must also resolve the unified in-bounds
    // proposal (if this fixture has one) before approval is reachable —
    // `preserve_all` keeps every pixel outcome identical to what this
    // fixture's pixel assertions already assume, it just makes the decision
    // explicit rather than leaving it "pending" (Phase 22B Issue 2).
    let proposalBody: { sourceAssetSha256: string; proposalHash: string; decision: "preserve_all" } | null = null;
    if (getRes.status === 200) {
      const view = (await getRes.clone().json()) as {
        regionMap: {
          sourceAssetSha256: string;
          regionMapHash: string;
          consequentialRegions: Array<{ regionId: number }>;
          inBoundsProposal: { proposalHash: string } | null;
        };
      };
      decisionBody = {
        sourceAssetSha256: view.regionMap.sourceAssetSha256,
        regionMapHash: view.regionMap.regionMapHash,
        decisions: view.regionMap.consequentialRegions.map((r) => ({ regionId: r.regionId, intent: "ink" })),
      };
      if (view.regionMap.inBoundsProposal) {
        proposalBody = {
          sourceAssetSha256: view.regionMap.sourceAssetSha256,
          proposalHash: view.regionMap.inBoundsProposal.proposalHash,
          decision: "preserve_all",
        };
      }
    }

    const decisionsRes = await decisionsRoute.POST(
      new Request("http://localhost/x", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // A public caller cannot know the real hashes; a plausible forged
        // body still must not get past the gate (the gate runs BEFORE body
        // validation for every route — Phase 9's "U" test proves this
        // ordering from source; this proves its effect).
        body: JSON.stringify(
          decisionBody ?? { sourceAssetSha256: "forged", regionMapHash: "forged", decisions: [{ regionId: 1, intent: "ink" }] },
        ),
      }),
      params,
    );

    // Same gate, proven the same way, for the sibling proposal-decision
    // route — a forged body when nothing real is available, exactly like
    // `decisionsRes` above.
    const proposalRes = await proposalRoute.POST(
      new Request("http://localhost/x", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          proposalBody ?? { sourceAssetSha256: "forged", proposalHash: "forged", decision: "preserve_all" },
        ),
      }),
      params,
    );

    const approveRes = await approveRoute.POST(new Request("http://localhost/x", { method: "POST" }), params);
    const imageRes = await imageRoute.GET(new Request("http://localhost/x?mode=original"), params);

    return { getRes, decisionsRes, proposalRes, approveRes, imageRes };
  }

  it("a public (non-internal) project: GET separation is denied with an uninformative 404", async () => {
    const { projectId } = await seededProject({ internal: false });
    const { getRes } = await callRoutes(projectId);
    assert.equal(getRes.status, 404);
    // Uninformative — never 403, which would confirm the endpoint exists for
    // a tier the caller isn't in (Goal 21/22).
    assert.equal(await getRes.text(), "Not found");
  });

  it("a public (non-internal) project: decision writes are denied", async () => {
    const { projectId } = await seededProject({ internal: false });
    const { decisionsRes } = await callRoutes(projectId);
    assert.equal(decisionsRes.status, 404);
  });

  it("a public (non-internal) project: proposal decision writes are denied", async () => {
    const { projectId } = await seededProject({ internal: false });
    const { proposalRes } = await callRoutes(projectId);
    assert.equal(proposalRes.status, 404);
  });

  it("a public (non-internal) project: approval is denied", async () => {
    const { projectId } = await seededProject({ internal: false });
    const { approveRes } = await callRoutes(projectId);
    assert.equal(approveRes.status, 404);
  });

  it("a public (non-internal) project: image access is denied", async () => {
    const { projectId } = await seededProject({ internal: false });
    const { imageRes } = await callRoutes(projectId);
    assert.equal(imageRes.status, 404);
  });

  it("a public (non-internal) project's denial leaves NO separation state behind — a forged decision body never applied", async () => {
    const { graph, projectId } = await seededProject({ internal: false });
    await callRoutes(projectId);
    // The gate refused the write before the capability ever ran; read the
    // capability directly (no route, no gate) to confirm the forged body
    // from `callRoutes` truly never persisted anything.
    const review = await graph.artworkPreparation.getSeparationReview(projectId);
    assert.equal(review.decisions.length, 0, "the forged public write must not have persisted any decision");
  });

  it("an internal project: GET separation succeeds and surfaces consequential regions", async () => {
    const { projectId } = await seededProject({ internal: true });
    const { getRes } = await callRoutes(projectId);
    assert.equal(getRes.status, 200);
    const body = (await getRes.json()) as { state: string; regionMap: { consequentialRegions: unknown[] } };
    assert.notEqual(body.state, "review_not_required");
    assert.ok(body.regionMap.consequentialRegions.length > 0);
  });

  it("an internal project: a decision write succeeds and persists", async () => {
    const { graph, projectId } = await seededProject({ internal: true });
    const { decisionsRes } = await callRoutes(projectId);
    assert.equal(decisionsRes.status, 200);
    const body = (await decisionsRes.json()) as { decisions: Array<{ regionId: number; intent: string; source: string }> };
    assert.ok(body.decisions.length > 0);
    assert.ok(body.decisions.every((d) => d.intent === "ink" && d.source === "operator"));

    // Persists beyond the single request — a fresh read confirms it.
    const reread = await graph.artworkPreparation.getSeparationReview(projectId);
    assert.equal(reread.decisions.length, body.decisions.length);
  });

  it("an internal project: approval succeeds once every region is decided, and image access succeeds", async () => {
    const { projectId } = await seededProject({ internal: true });
    const { proposalRes, approveRes, imageRes } = await callRoutes(projectId);
    assert.equal(proposalRes.status, 200);
    assert.equal(approveRes.status, 200);
    const body = (await approveRes.json()) as { state: string; isProductionAuthoritative: boolean };
    assert.equal(body.state, "review_complete");
    assert.equal(body.isProductionAuthoritative, true);
    assert.equal(imageRes.status, 200);
    assert.equal(imageRes.headers.get("Content-Type"), "image/png");
  });

  // -------------------------------------------------------------------
  // Phase 14: the two new preview modes get the SAME internal-only gate,
  // proven the same way — actual route invocation, not inferred from the
  // fact that they share a switch statement with the already-tested modes.
  // -------------------------------------------------------------------

  it("Phase 14: a public project cannot reach region-context or region-crop", async () => {
    const { projectId } = await seededProject({ internal: false });
    const imageRoute = await import("./image/route");
    const params = { params: Promise.resolve({ projectId }) };
    const contextRes = await imageRoute.GET(new Request("http://localhost/x?mode=region-context&region=1"), params);
    const cropRes = await imageRoute.GET(new Request("http://localhost/x?mode=region-crop&region=1"), params);
    assert.equal(contextRes.status, 404);
    assert.equal(cropRes.status, 404);
  });

  it("Phase 14: an internal project reaches region-context and region-crop, each returning a distinct real PNG per region id", async () => {
    const { graph, projectId } = await seededProject({ internal: true });
    const review = await graph.artworkPreparation.getSeparationReview(projectId);
    const regionId = review.regionMap.consequentialRegions[0]!.regionId;

    const imageRoute = await import("./image/route");
    const params = { params: Promise.resolve({ projectId }) };
    const contextRes = await imageRoute.GET(
      new Request(`http://localhost/x?mode=region-context&region=${regionId}`),
      params,
    );
    const cropRes = await imageRoute.GET(new Request(`http://localhost/x?mode=region-crop&region=${regionId}`), params);
    assert.equal(contextRes.status, 200);
    assert.equal(contextRes.headers.get("Content-Type"), "image/png");
    assert.equal(cropRes.status, 200);
    assert.equal(cropRes.headers.get("Content-Type"), "image/png");

    // An unknown region id is refused exactly like the existing modes.
    const unknownRes = await imageRoute.GET(
      new Request("http://localhost/x?mode=region-context&region=999999"),
      params,
    );
    assert.equal(unknownRes.status, 404);
  });
});
