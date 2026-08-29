import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import {
  bowlingStyleArtwork,
  solidBlackExteriorArtwork,
  toPngBytes,
} from "@/capabilities/artwork-preparation/artwork-fixtures";
import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";

/**
 * Phase 28K: the exact real-acceptance-run bug, reproduced and proven fixed.
 *
 * A real, top-to-bottom human acceptance run (an ordinary, non-internal
 * project owner -- no test-only entitlement of any kind) reached a state
 * where `approvePreparedArtwork` ("Use This Artwork") correctly refused
 * because the artwork genuinely had unresolved consequential separation
 * regions, but the review UI and every route capable of resolving them
 * returned 404 for that same ordinary owner -- an impossible gate. See
 * `isAuthorizedForArtworkCorrection`'s doc comment for the full audit and
 * `separation-routes-authorization.test.ts` / `correction-routes-
 * authorization.test.ts` for the route-level authorization proof this file
 * does not repeat. This file proves the CUSTOMER-FACING CONTRACT: the
 * review is visible, resolvable, and leads all the way to print-size
 * confirmation, with NO internal entitlement granted anywhere in it.
 */
describe("Phase 28K — the impossible separation-review gate, reproduced and fixed", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-impossible-gate-"));
    process.chdir(tempDir);
  });

  after(async () => {
    await cleanupTempWorkspace(tempDir, previousCwd);
  });

  async function ordinaryOwnerProject(fixture: () => ReturnType<typeof bowlingStyleArtwork>) {
    const { resetCapabilityGraphForTests, getCapabilityGraph } = await import("@/capabilities/composition");
    resetCapabilityGraphForTests();
    const graph = getCapabilityGraph();
    const { getProjectRepository } = await import("@/lib/db");
    const repo = getProjectRepository();

    // Deliberately NO grantInternalEntitlement call anywhere in this
    // function -- this is the exact ordinary customer session shape the
    // real acceptance run used.
    const session = await graph.acquisition.resolveOrCreateSession(null);
    const created = await repo.createProject(session.id);
    const projectId = created.project.id;

    await graph.artworkPreparation.uploadOriginal(projectId, {
      bytes: toPngBytes(fixture()),
      declaredContentType: "image/png",
      filename: "artwork.png",
    });
    await graph.artworkPreparation.setProductionContext(projectId, {
      productSummary: "T-shirts",
      productColor: "Black",
      printPlacement: "full_front",
    });
    await graph.artworkPreparation.prepareBackground(projectId);

    return { graph, repo, projectId };
  }

  type ReviewShape = {
    state?: string;
    regionMap: {
      consequentialRegions: Array<{ regionId: number }>;
      sourceAssetSha256: string;
      regionMapHash: string;
      inBoundsProposal: { proposalHash: string } | null;
    };
  };

  /**
   * `bowlingStyleArtwork()` carries BOTH consequential regions AND a
   * unified in-bounds removal proposal -- two independent axes
   * `isReadyForFinalApproval` requires resolved together (Phase 23).
   * Decides the proposal with `preserve_all`, matching the same
   * zero-pixel-change convention `separation-routes-authorization.test.ts`
   * already establishes, so tests that only care about the
   * consequential-region axis aren't blocked by the other one.
   */
  async function resolveProposalIfPresent(params: { params: Promise<{ projectId: string }> }, review: ReviewShape) {
    if (!review.regionMap.inBoundsProposal) return;
    const proposalRoute = await import(
      "../../app/api/projects/[projectId]/artwork-preparation/separation/decisions/proposal/route"
    );
    const res = await proposalRoute.POST(
      new Request("http://localhost/x", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceAssetSha256: review.regionMap.sourceAssetSha256,
          proposalHash: review.regionMap.inBoundsProposal.proposalHash,
          decision: "preserve_all",
        }),
      }),
      params,
    );
    assert.equal(res.status, 200, "resolving the in-bounds proposal must succeed for the owner");
  }

  it("1: THE EXACT REAL SEQUENCE — genuinely unresolved consequential regions: 'Use This Artwork' is correctly refused, the review IS visible, the owner resolves it, approval succeeds, and the project reaches print-size confirmation — with NO internal entitlement anywhere", async () => {
    const { graph, projectId } = await ordinaryOwnerProject(bowlingStyleArtwork);

    // The real bug's first half: the ordinary approve action correctly
    // refuses, because this fixture genuinely has consequential regions
    // (touching black-on-black artwork) with no decisions yet.
    await assert.rejects(
      () => graph.artworkPreparation.approvePreparedArtwork(projectId),
      /areas that need your confirmation|complete the separation review/i,
    );

    // The real bug's second half, now fixed: the review the error message
    // refers to is actually reachable and shows real, actionable content.
    const getRoute = await import("../../app/api/projects/[projectId]/artwork-preparation/separation/route");
    const params = { params: Promise.resolve({ projectId }) };
    const reviewRes = await getRoute.GET(new Request("http://localhost/x"), params);
    assert.equal(reviewRes.status, 200, "the review the error message points to must actually be visible to this owner");
    const review = (await reviewRes.json()) as ReviewShape;
    assert.notEqual(review.state, "review_not_required");
    assert.ok(review.regionMap.consequentialRegions.length > 0, "there must be actual, actionable regions to decide");

    // Two independent axes this fixture carries -- both need a decision.
    await resolveProposalIfPresent(params, review);

    // The owner resolves every region -- the actual "control to unblock",
    // reachable and usable, never fabricated by this test.
    const decisionsRoute = await import("../../app/api/projects/[projectId]/artwork-preparation/separation/decisions/route");
    const decisionsRes = await decisionsRoute.POST(
      new Request("http://localhost/x", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceAssetSha256: review.regionMap.sourceAssetSha256,
          regionMapHash: review.regionMap.regionMapHash,
          decisions: review.regionMap.consequentialRegions.map((r) => ({ regionId: r.regionId, intent: "ink" })),
        }),
      }),
      params,
    );
    assert.equal(decisionsRes.status, 200);

    // "Use This Artwork" for the review-required case: the panel's own
    // approve action.
    const approveRoute = await import("../../app/api/projects/[projectId]/artwork-preparation/separation/approve/route");
    const approveRes = await approveRoute.POST(new Request("http://localhost/x", { method: "POST" }), params);
    assert.equal(approveRes.status, 200, "approval must succeed once the owner has resolved every required decision");
    const approveBody = (await approveRes.json()) as { state: string; isProductionAuthoritative: boolean };
    assert.equal(approveBody.state, "review_complete");
    assert.equal(approveBody.isProductionAuthoritative, true);

    // The project can now proceed to print-size confirmation -- the real
    // next customer step, via the real (already ordinary-customer-facing,
    // never internal-gated) route.
    const confirmRoute = await import("../../app/api/projects/[projectId]/print-size/confirm/route");
    const confirmRes = await confirmRoute.POST(
      new Request("http://localhost/x", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ garmentSizeClass: "adult_standard", useRecommended: true }),
      }),
      params,
    );
    assert.equal(confirmRes.status, 200, "the owner must be able to proceed to print-size confirmation after approval");
  });

  it("2: RESOLVED CASE — once every required decision is made and approved, no false blocker remains, and re-requesting approval reports the already-complete state honestly", async () => {
    const { graph, projectId } = await ordinaryOwnerProject(bowlingStyleArtwork);
    const params = { params: Promise.resolve({ projectId }) };

    const getRoute = await import("../../app/api/projects/[projectId]/artwork-preparation/separation/route");
    const review = (await (await getRoute.GET(new Request("http://localhost/x"), params)).json()) as ReviewShape;
    await resolveProposalIfPresent(params, review);
    const decisionsRoute = await import("../../app/api/projects/[projectId]/artwork-preparation/separation/decisions/route");
    await decisionsRoute.POST(
      new Request("http://localhost/x", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceAssetSha256: review.regionMap.sourceAssetSha256,
          regionMapHash: review.regionMap.regionMapHash,
          decisions: review.regionMap.consequentialRegions.map((r) => ({ regionId: r.regionId, intent: "ink" })),
        }),
      }),
      params,
    );
    const approveRoute = await import("../../app/api/projects/[projectId]/artwork-preparation/separation/approve/route");
    const firstApproveRes = await approveRoute.POST(new Request("http://localhost/x", { method: "POST" }), params);
    assert.equal(firstApproveRes.status, 200);

    // Re-reading now: no false blocker, state is honestly "complete".
    const rereadRes = await getRoute.GET(new Request("http://localhost/x"), params);
    const reread = (await rereadRes.json()) as { state: string };
    assert.equal(reread.state, "review_complete");

    // The underlying capability agrees -- no impossible gate lurking.
    const view = await graph.artworkPreparation.getSeparationReview(projectId);
    assert.equal(view.state, "review_complete");
  });

  it("3: NO-REVIEW-NEEDED CASE — automatic preparation with no consequential region requires human confirmation at all: no redundant review, no blocker, 'Use This Artwork' works directly (Phase 28F preserved)", async () => {
    const { graph, projectId } = await ordinaryOwnerProject(solidBlackExteriorArtwork);
    const params = { params: Promise.resolve({ projectId }) };

    const getRoute = await import("../../app/api/projects/[projectId]/artwork-preparation/separation/route");
    const reviewRes = await getRoute.GET(new Request("http://localhost/x"), params);
    const review = (await reviewRes.json()) as { state: string };
    assert.equal(review.state, "review_not_required", "a genuinely clean automatic separation must never claim review is needed");

    // The ordinary approve action succeeds directly -- no separate review
    // step interposed, matching Phase 28F's "one consolidated review" goal.
    const view = await graph.artworkPreparation.approvePreparedArtwork(projectId);
    assert.equal(view.hasPreparedArtwork, true);
  });

  it("4: PARTIAL REVIEW — an unresolved in-bounds proposal blocks approval regardless of how many individual consequential regions are decided; deciding the proposal (the actual final required decision) lifts the block", async () => {
    // Phase 23 (`isReadyForFinalApproval`'s own doc comment) deliberately
    // does NOT gate approval on every consequential region having an
    // explicit decision -- an undecided region already retains its pixels
    // exactly as an explicit "ink"/"uncertain" decision would, so that was a
    // workflow gate with no pixel-safety justification. The UNIFIED
    // IN-BOUNDS PROPOSAL is the one thing that genuinely still gates: while
    // it exists and is "pending", approval is blocked no matter what
    // per-region decisions exist; deciding it is the "final required
    // decision" this test proves lifts the block.
    const { graph, projectId } = await ordinaryOwnerProject(bowlingStyleArtwork);
    const params = { params: Promise.resolve({ projectId }) };

    const getRoute = await import("../../app/api/projects/[projectId]/artwork-preparation/separation/route");
    const review = (await (await getRoute.GET(new Request("http://localhost/x"), params)).json()) as ReviewShape;
    assert.ok(review.regionMap.inBoundsProposal, "this test needs a fixture with a genuine in-bounds proposal to decide");

    // Decide every consequential region first -- and prove this ALONE is
    // still not enough; the proposal remains "pending".
    const decisionsRoute = await import("../../app/api/projects/[projectId]/artwork-preparation/separation/decisions/route");
    await decisionsRoute.POST(
      new Request("http://localhost/x", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceAssetSha256: review.regionMap.sourceAssetSha256,
          regionMapHash: review.regionMap.regionMapHash,
          decisions: review.regionMap.consequentialRegions.map((r) => ({ regionId: r.regionId, intent: "ink" })),
        }),
      }),
      params,
    );

    await assert.rejects(() => graph.artworkPreparation.approvePreparedArtwork(projectId));
    const midway = await graph.artworkPreparation.getSeparationReview(projectId);
    assert.notEqual(midway.state, "review_complete", "every region decided is still not enough while the proposal is pending");

    // Decide the proposal -- the actual remaining required decision -- and
    // the block lifts.
    await resolveProposalIfPresent(params, review);
    const approveRoute = await import("../../app/api/projects/[projectId]/artwork-preparation/separation/approve/route");
    const approveRes = await approveRoute.POST(new Request("http://localhost/x", { method: "POST" }), params);
    assert.equal(approveRes.status, 200, "deciding the proposal must lift the block");
  });

  it("5: RELOAD — decisions survive a completely fresh read (a new capability graph instance), never relying solely on client-side React state", async () => {
    const { graph, repo, projectId } = await ordinaryOwnerProject(bowlingStyleArtwork);
    const params = { params: Promise.resolve({ projectId }) };

    const getRoute = await import("../../app/api/projects/[projectId]/artwork-preparation/separation/route");
    const review = (await (await getRoute.GET(new Request("http://localhost/x"), params)).json()) as ReviewShape;
    await resolveProposalIfPresent(params, review);
    const decisionsRoute = await import("../../app/api/projects/[projectId]/artwork-preparation/separation/decisions/route");
    await decisionsRoute.POST(
      new Request("http://localhost/x", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceAssetSha256: review.regionMap.sourceAssetSha256,
          regionMapHash: review.regionMap.regionMapHash,
          decisions: review.regionMap.consequentialRegions.map((r) => ({ regionId: r.regionId, intent: "ink" })),
        }),
      }),
      params,
    );
    void graph;
    void repo;

    // Simulate a page reload: a BRAND NEW capability graph, reading from the
    // SAME underlying store -- proves persistence, not in-memory React state.
    const { resetCapabilityGraphForTests, getCapabilityGraph } = await import("@/capabilities/composition");
    resetCapabilityGraphForTests();
    const freshGraph = getCapabilityGraph();
    const afterReload = await freshGraph.artworkPreparation.getSeparationReview(projectId);
    assert.notEqual(afterReload.state, "review_required", "decisions must not appear to have vanished after a reload");
    assert.ok(afterReload.decisions.length > 0, "the decisions themselves must still be there after a reload");

    const approveRoute = await import("../../app/api/projects/[projectId]/artwork-preparation/separation/approve/route");
    const approveRes = await approveRoute.POST(new Request("http://localhost/x", { method: "POST" }), params);
    assert.equal(approveRes.status, 200, "'Use This Artwork' must remain available after a reload, not just within one session");
  });

  it("6: EDIT ARTWORK / STALENESS — a manual correction that supersedes automatic separation review is not undone by merely reopening the review; but the review honestly reports 'not required' once manual correction is the authority, matching Phase 27H's existing rule", async () => {
    const { graph, projectId } = await ordinaryOwnerProject(bowlingStyleArtwork);

    // The owner takes the OTHER path: Edit Artwork -> manual correction ->
    // finalize -- via the now-owner-accessible correction routes, never
    // touching the automatic separation review at all.
    const finalizeRoute = await import(
      "../../app/api/projects/[projectId]/artwork-preparation/correction/finalize/route"
    );
    const params = { params: Promise.resolve({ projectId }) };
    const finalizeRes = await finalizeRoute.POST(new Request("http://localhost/x", { method: "POST" }), params);
    assert.equal(finalizeRes.status, 200, "Edit Artwork's own finalize must be reachable by the owner");

    // Automatic separation review must now honestly report itself
    // superseded -- never re-offering a decision the manual correction
    // already resolved, and never silently letting the OLD automatic
    // review re-approve over the manually-finalized result (Phase 27H §3).
    const getRoute = await import("../../app/api/projects/[projectId]/artwork-preparation/separation/route");
    const reviewRes = await getRoute.GET(new Request("http://localhost/x"), params);
    const review = (await reviewRes.json()) as { state: string };
    assert.equal(review.state, "review_not_required", "manual correction supersedes automatic separation review");

    const approveRoute = await import("../../app/api/projects/[projectId]/artwork-preparation/separation/approve/route");
    await assert.rejects(
      () => graph.artworkPreparation.approveSeparationMaster(projectId),
      /already manually corrected/i,
    );
    // The route agrees -- surfaced as a normal 409, not a 200 that would
    // silently overwrite the manually-finalized authority.
    const approveRes = await approveRoute.POST(new Request("http://localhost/x", { method: "POST" }), params);
    assert.notEqual(approveRes.status, 200);
  });
});
