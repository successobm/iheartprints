import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import {
  ruthLikeSignArtwork,
  toPngBytes,
} from "@/capabilities/sign-preparation/sign-fixtures";
import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";

/**
 * Internal Replan Action Phase: the operator-facing counterpart of
 * `POST /api/projects/[projectId]/sign-artwork/plan`. Mirrors
 * `sign-artwork/authorize/route.test.ts`'s own security proof structure
 * exactly — this route gates on the REQUESTER'S OWN session being verified
 * internal, not on the project.
 */
describe("POST /api/internal/projects/[projectId]/sign-artwork/plan", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-sign-check-artwork-operator-"));
    process.chdir(tempDir);
  });

  after(async () => {
    await cleanupTempWorkspace(tempDir, previousCwd);
  });

  async function freshGraph() {
    const { resetCapabilityGraphForTests, getCapabilityGraph } = await import(
      "@/capabilities/composition"
    );
    resetCapabilityGraphForTests();
    const graph = getCapabilityGraph();
    const { getProjectRepository } = await import("@/lib/db");
    return { graph, repo: getProjectRepository() };
  }

  /** Uploaded and sized, but never planned — the exact `no_plan` shape this action exists for. */
  async function unplannedSignProject(
    graph: Awaited<ReturnType<typeof freshGraph>>["graph"],
    repo: Awaited<ReturnType<typeof freshGraph>>["repo"],
  ) {
    const created = await repo.createProject();
    const projectId = created.project.id;
    await graph.signPreparation.uploadSignArtwork(projectId, {
      bytes: toPngBytes(ruthLikeSignArtwork()),
      declaredContentType: "image/png",
      filename: "sign.png",
    });
    await graph.signPreparation.confirmSignProductionSpec(projectId, 18, 24);
    return { projectId };
  }

  function cookieHeaderFor(sessionToken: string): { cookie: string } {
    return { cookie: `ihp_as=${sessionToken}` };
  }

  async function post(projectId: string, headers?: Record<string, string>) {
    const route = await import("./route");
    return route.POST(
      new Request("http://localhost/x", { method: "POST", headers: headers ?? {} }),
      { params: Promise.resolve({ projectId }) },
    );
  }

  async function internalSessionCookie(graph: Awaited<ReturnType<typeof freshGraph>>["graph"], repo: Awaited<ReturnType<typeof freshGraph>>["repo"]) {
    const session = await graph.acquisition.resolveOrCreateSession(null);
    await repo.grantInternalEntitlement(session.id);
    return cookieHeaderFor(session.sessionToken);
  }

  it("no cookie at all — knowing a real project id is insufficient", async () => {
    const { graph, repo } = await freshGraph();
    const { projectId } = await unplannedSignProject(graph, repo);

    const res = await post(projectId);
    assert.equal(res.status, 403);

    const preparation = await repo.getSignPreparation(projectId);
    assert.equal(preparation!.planKey, null, "an unauthenticated attempt must never plan anything");
  });

  it("an unrecognized/forged session token is refused identically", async () => {
    const { graph, repo } = await freshGraph();
    const { projectId } = await unplannedSignProject(graph, repo);

    const res = await post(projectId, cookieHeaderFor("not-a-real-token"));
    assert.equal(res.status, 403);
  });

  it("an ordinary customer session cannot plan through this route", async () => {
    const { graph, repo } = await freshGraph();
    const { projectId } = await unplannedSignProject(graph, repo);
    const ordinarySession = await graph.acquisition.resolveOrCreateSession(null);

    const res = await post(projectId, cookieHeaderFor(ordinarySession.sessionToken));
    assert.equal(res.status, 403);

    const preparation = await repo.getSignPreparation(projectId);
    assert.equal(preparation!.planKey, null);
  });

  it("a valid internal session plans an unplanned project — same shared capability, same plan shape as customer planning", async () => {
    const { graph, repo } = await freshGraph();
    const { projectId } = await unplannedSignProject(graph, repo);
    const cookie = await internalSessionCookie(graph, repo);

    const res = await post(projectId, cookie);
    assert.equal(res.status, 200);

    const preparation = await repo.getSignPreparation(projectId);
    assert.ok(preparation!.planKey, "the route must actually persist a real plan");
    assert.equal(preparation!.status, "planned");
    const plan = preparation!.plan as { overallRisk: string; steps: Array<{ kind: string }> };
    assert.equal(plan.overallRisk, "review_required", "the real Ruth-shaped fixture plans review_required, exactly like the customer route would produce");

    // Cross-check against what the pure/customer-facing capability call
    // itself would produce for byte-identical input — proving this route
    // never runs a second, divergent planner.
    const directOutcome = await graph.signPreparation.planSignRepair(projectId);
    assert.equal(directOutcome.result.status, "planned");
    assert.deepEqual(
      directOutcome.result.plan!.steps.map((s) => s.kind),
      plan.steps.map((s) => s.kind),
    );
  });

  it("a genuine planning failure (no sign artwork ever uploaded for this project) is surfaced as a real error response, never a fabricated 200", async () => {
    const { graph, repo } = await freshGraph();
    const created = await repo.createProject();
    const cookie = await internalSessionCookie(graph, repo);

    const res = await post(created.project.id, cookie);
    assert.notEqual(res.status, 200, "no SignPreparation exists yet — this must never silently report success");
    const body = (await res.json()) as { error?: string };
    assert.ok(body.error && body.error.length > 0, "the failure must be surfaced with a real error message, never swallowed");
  });

  it("an internal session cannot reach another project's data by forging the id — a garbage id is 404, not a leak", async () => {
    const { graph, repo } = await freshGraph();
    await unplannedSignProject(graph, repo);
    const cookie = await internalSessionCookie(graph, repo);

    const res = await post("00000000-0000-0000-0000-000000000000", cookie);
    assert.equal(res.status, 404);
  });

  it("repeated invocation is safe/idempotent — a double click never creates a conflicting plan", async () => {
    const { graph, repo } = await freshGraph();
    const { projectId } = await unplannedSignProject(graph, repo);
    const cookie = await internalSessionCookie(graph, repo);

    const first = await post(projectId, cookie);
    assert.equal(first.status, 200);
    const afterFirst = await repo.getSignPreparation(projectId);

    const second = await post(projectId, cookie);
    assert.equal(second.status, 200);
    const afterSecond = await repo.getSignPreparation(projectId);

    assert.equal(afterSecond!.planKey, afterFirst!.planKey, "the same immutable source + confirmed spec must always recompute the SAME plan key");
  });

  it("a historical, superseded authorizedPlanKey never suppresses planning when the current planKey is null — the exact real-project shape", async () => {
    const { graph, repo } = await freshGraph();
    const { projectId } = await unplannedSignProject(graph, repo);
    const cookie = await internalSessionCookie(graph, repo);

    // Plan once, authorize it (durable authorizedPlanKey/authorizedBy),
    // then simulate the historical invalidation this real incident actually
    // went through: the CURRENT plan/planKey is cleared back to null while
    // the OLD authorization fact is left exactly as it was — never re-set,
    // never cleared, purely historical.
    const outcome = await graph.signPreparation.planSignRepair(projectId);
    assert.equal(outcome.result.status, "planned");
    await graph.signPreparation.authorizeSignRepairPlan(projectId, { authorizedBy: "operator" });
    const authorized = await repo.getSignPreparation(projectId);
    const staleAuthorizedPlanKey = authorized!.authorizedPlanKey;
    assert.ok(staleAuthorizedPlanKey);

    await repo.updateSignPreparation(authorized!.id, { plan: null, planKey: null });
    const invalidated = await repo.getSignPreparation(projectId);
    assert.equal(invalidated!.planKey, null);
    assert.equal(invalidated!.authorizedPlanKey, staleAuthorizedPlanKey, "the historical authorization itself must remain untouched by the invalidation");

    const res = await post(projectId, cookie);
    assert.equal(res.status, 200, "planning must succeed despite the stale historical authorization sitting on the row");

    const replanned = await repo.getSignPreparation(projectId);
    assert.ok(replanned!.planKey, "a fresh current plan now exists");
    assert.equal(
      replanned!.authorizedPlanKey,
      staleAuthorizedPlanKey,
      "planning alone must never itself authorize anything — the stale historical authorization stays exactly as it was, never silently applied to the new plan",
    );
    // NOTE: for this fixture, replanning the SAME immutable source under the
    // SAME confirmed spec and the SAME planner deterministically reproduces
    // the IDENTICAL plan key — which is correct-by-design (content-addressed
    // plan identity: a truly unchanged plan legitimately keeps its existing
    // authorization eligible, exactly matching `matchesCurrentPlan`'s own
    // intent in `sign-plan-operator-review.ts`). The real incident this
    // route exists for produced a DIFFERENT key because the PLANNER itself
    // changed between the original plan and the replan (the old
    // `pad_uniform_background` contract vs. the new
    // `reconstruct_parametric_frame` one) — not something a same-commit unit
    // test can reproduce by calling the same planner twice. What matters,
    // and is proven above, is that `authorizedPlanKey` is never silently
    // rewritten by planning itself; the UI's own `matchesCurrentPlan` check
    // is what correctly requires fresh authorization whenever the two keys
    // genuinely differ.
  });
});
