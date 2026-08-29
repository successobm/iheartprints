import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { bowlingStyleArtwork, enclosedBlackRegionArtwork, toPngBytes } from "@/capabilities/artwork-preparation/artwork-fixtures";
import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";

/**
 * Intelligent Separation Phase 10, Goal 12 / Phase 28K CORRECTION.
 *
 * This file originally proved these routes were internal-staff-only,
 * denying every "public" (non-internal) caller. A real, top-to-bottom
 * human acceptance run (Phase 28K) found that this made the flow
 * IMPOSSIBLE for an ordinary project owner: `approvePreparedArtwork`
 * (the real "Use This Artwork" handler) has no internal-only gate and
 * correctly refuses approval until genuine consequential-region decisions
 * are resolved, but every route capable of showing an ordinary owner that
 * review or letting them resolve it was denied to them by the internal-only
 * gate this file used to require. That combination is a real product bug,
 * not a security feature — see `isAuthorizedForArtworkCorrection`'s doc
 * comment for the full audit.
 *
 * Phase 28K widened the gate from "internal staff only" to "internal staff
 * OR this exact project's own owner" — this file now proves BOTH halves of
 * that: an ordinary owner succeeds on their OWN project (the fix), while a
 * request naming a project id that resolves to nothing real is still
 * denied (the boundary that remains). Proven through actual route
 * invocation, not inferred from source reading, exactly as before.
 */
describe("Separation routes — internal-staff-or-owner authorization (Phase 10 Goal 12 / Phase 28K)", () => {
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

  async function seededProject(options: { internal: boolean; fixture?: () => ReturnType<typeof bowlingStyleArtwork> }) {
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
      bytes: toPngBytes((options.fixture ?? bowlingStyleArtwork)()),
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

  it("Phase 28K FIX: an ordinary (non-internal) project's own owner reaches GET separation and sees real consequential regions", async () => {
    const { projectId } = await seededProject({ internal: false });
    const { getRes } = await callRoutes(projectId);
    assert.equal(getRes.status, 200, "the impossible gate: an owner must be able to see WHY approval is blocked");
    const body = (await getRes.json()) as { state: string; regionMap: { consequentialRegions: unknown[] } };
    assert.notEqual(body.state, "review_not_required");
    assert.ok(body.regionMap.consequentialRegions.length > 0);
  });

  it("Phase 28K FIX: an ordinary owner's decision write succeeds and persists", async () => {
    const { graph, projectId } = await seededProject({ internal: false });
    const { decisionsRes } = await callRoutes(projectId);
    assert.equal(decisionsRes.status, 200);
    const body = (await decisionsRes.json()) as { decisions: Array<{ regionId: number; intent: string; source: string }> };
    assert.ok(body.decisions.length > 0);
    assert.ok(body.decisions.every((d) => d.intent === "ink" && d.source === "operator"));

    const reread = await graph.artworkPreparation.getSeparationReview(projectId);
    assert.equal(reread.decisions.length, body.decisions.length);
  });

  it("Phase 28K FIX: an ordinary owner's proposal decision succeeds, approval succeeds once every region is decided, and image access succeeds -- THE EXACT IMPOSSIBLE-GATE SEQUENCE, now possible", async () => {
    const { projectId } = await seededProject({ internal: false });
    const { proposalRes, approveRes, imageRes } = await callRoutes(projectId);
    assert.equal(proposalRes.status, 200);
    assert.equal(approveRes.status, 200, "'Use This Artwork' for a genuinely-required review must succeed for the owner");
    const body = (await approveRes.json()) as { state: string; isProductionAuthoritative: boolean };
    assert.equal(body.state, "review_complete");
    assert.equal(body.isProductionAuthoritative, true);
    assert.equal(imageRes.status, 200);
    assert.equal(imageRes.headers.get("Content-Type"), "image/png");
  });

  it("a project id that resolves to nothing real is still denied with an uninformative 404 -- the boundary that remains", async () => {
    const nonexistentProjectId = "00000000-0000-0000-0000-000000000000";
    const { getRes, decisionsRes, proposalRes, approveRes, imageRes } = await callRoutes(nonexistentProjectId);
    for (const [name, res] of [
      ["getRes", getRes],
      ["decisionsRes", decisionsRes],
      ["proposalRes", proposalRes],
      ["approveRes", approveRes],
      ["imageRes", imageRes],
    ] as const) {
      assert.equal(res.status, 404, `${name} must still deny a project id naming nothing real`);
    }
    // Uninformative — never 403 (Goal 21/22), preserved for this boundary too.
    assert.equal(await getRes.text(), "Not found");
  });

  it("two ordinary owners' projects never cross-contaminate: each sees only its own consequential regions and decisions", async () => {
    const { graph: graphA, projectId: projectA } = await seededProject({ internal: false });
    const { projectId: projectB } = await seededProject({ internal: false });

    const { decisionsRes: decisionsA } = await callRoutes(projectA);
    assert.equal(decisionsA.status, 200);

    // Project B's own state is untouched by A's decision write -- reading B
    // through its OWN id never surfaces A's decisions or vice versa.
    const reviewB = await graphA.artworkPreparation.getSeparationReview(projectB);
    assert.equal(reviewB.decisions.length, 0, "project B must never see project A's decisions");

    const getRouteRecheck = await import("./route");
    const paramsA = { params: Promise.resolve({ projectId: projectA }) };
    const recheckA = await getRouteRecheck.GET(new Request("http://localhost/x"), paramsA);
    const bodyA = (await recheckA.json()) as { decisions: unknown[] };
    assert.ok(bodyA.decisions.length > 0, "project A must still see its own decisions after B was created/read");
  });

  it("a forged decision body naming a DIFFERENT project's real hashes is rejected by fresh server-side validation, never silently applied", async () => {
    // Deliberately different source artwork for B, so its region map and
    // hashes genuinely differ from A's -- identical fixtures would make a
    // "forged" cross-project body indistinguishable from a legitimate
    // same-content resubmission (a test-design pitfall, not a real one:
    // decisions still only ever get applied to the CALLING project's own
    // data regardless).
    const { graph: graphA, projectId: projectA } = await seededProject({ internal: false });
    const { projectId: projectB } = await seededProject({ internal: false, fixture: enclosedBlackRegionArtwork });

    const decisionsRouteA = await import("./decisions/route");
    const getRouteB = await import("./route");
    const paramsA = { params: Promise.resolve({ projectId: projectA }) };
    const paramsB = { params: Promise.resolve({ projectId: projectB }) };

    // Real hashes, but they belong to project B, not A.
    const viewB = (await (await getRouteB.GET(new Request("http://localhost/x"), paramsB)).json()) as {
      regionMap: { sourceAssetSha256: string; regionMapHash: string; consequentialRegions: Array<{ regionId: number }> };
    };
    const forgedBody = JSON.stringify({
      sourceAssetSha256: viewB.regionMap.sourceAssetSha256,
      regionMapHash: viewB.regionMap.regionMapHash,
      decisions: viewB.regionMap.consequentialRegions.map((r) => ({ regionId: r.regionId, intent: "ink" })),
    });

    const res = await decisionsRouteA.POST(
      new Request("http://localhost/x", { method: "POST", headers: { "Content-Type": "application/json" }, body: forgedBody }),
      paramsA,
    );
    // The route is reachable (owner authorization passed); the capability's
    // OWN fresh-region-map validation is what refuses a hash that does not
    // match project A's actual current state -- authorization and pixel
    // safety are two different, both-enforced layers.
    assert.notEqual(res.status, 200, "project B's real hashes must not validate against project A's own region map");

    const reviewA = await graphA.artworkPreparation.getSeparationReview(projectA);
    assert.equal(reviewA.decisions.length, 0, "the forged cross-project body must not have persisted any decision on A");
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
  // Phase 14: the two zoom preview modes get the SAME internal-staff-or-owner
  // gate as every other mode on this route, proven the same way — actual
  // route invocation. `SeparationReviewPanel` fetches both of these directly
  // for its own customer-facing region detail view (Phase 28K), so an owner
  // reaching them is the fix, not a widening.
  // -------------------------------------------------------------------

  it("Phase 14 / Phase 28K FIX: an ordinary owner reaches region-context and region-crop too", async () => {
    const { graph, projectId } = await seededProject({ internal: false });
    const review = await graph.artworkPreparation.getSeparationReview(projectId);
    const regionId = review.regionMap.consequentialRegions[0]!.regionId;
    const imageRoute = await import("./image/route");
    const params = { params: Promise.resolve({ projectId }) };
    const contextRes = await imageRoute.GET(new Request(`http://localhost/x?mode=region-context&region=${regionId}`), params);
    const cropRes = await imageRoute.GET(new Request(`http://localhost/x?mode=region-crop&region=${regionId}`), params);
    assert.equal(contextRes.status, 200);
    assert.equal(cropRes.status, 200);
  });

  it("a project id naming nothing real cannot reach region-context or region-crop either", async () => {
    const nonexistentProjectId = "00000000-0000-0000-0000-000000000000";
    const imageRoute = await import("./image/route");
    const params = { params: Promise.resolve({ projectId: nonexistentProjectId }) };
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
