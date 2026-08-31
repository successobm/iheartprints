import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import {
  exactAspectSignArtwork,
  ruthLikeSignArtwork,
  toPngBytes,
} from "@/capabilities/sign-preparation/sign-fixtures";
import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";

/**
 * LIVE PRODUCT BLOCKER #3: "Check my artwork", end to end through the real
 * route handlers — upload → sign type/size → plan. Every fixture here
 * reproduces an outcome `sign-repair-planner.test.ts` already proves
 * (auto_safe / review_required / blocked); this file proves the ROUTE
 * reaches the real capability and translates its REAL result, never a
 * synthetic one of this file's own invention.
 *
 * Local persistence only (temp dir, no Supabase env) — never touches the
 * configured live project, per the explicit "use fixtures, not the real
 * customer" instruction for this phase.
 */
describe("POST /api/projects/[projectId]/sign-artwork/plan", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-sign-plan-route-"));
    process.chdir(tempDir);
  });

  after(async () => {
    await cleanupTempWorkspace(tempDir, previousCwd);
  });

  async function freshProject() {
    const { resetCapabilityGraphForTests } = await import("@/capabilities/composition");
    resetCapabilityGraphForTests();
    const { getProjectRepository } = await import("@/lib/db");
    const created = await getProjectRepository().createProject();
    return created.project.id;
  }

  async function uploadExistingArtwork(
    projectId: string,
    bytes: Buffer,
    filename = "sign-art.png",
  ) {
    const { POST: uploadRoute } = await import("../../artwork-upload/route");
    const form = new FormData();
    form.append("file", new File([new Uint8Array(bytes)], filename, { type: "image/png" }));
    const response = await uploadRoute(
      new Request("http://localhost/upload", { method: "POST", body: form }),
      { params: Promise.resolve({ projectId }) },
    );
    assert.equal(response.status, 200);
  }

  async function confirmSize(
    projectId: string,
    orderedWidthIn: number,
    orderedHeightIn: number,
  ) {
    const { POST: sizeRoute } = await import("../route");
    const response = await sizeRoute(
      new Request("http://localhost/sign-artwork", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderedWidthIn, orderedHeightIn }),
      }),
      { params: Promise.resolve({ projectId }) },
    );
    assert.equal(response.status, 200);
  }

  async function plan(projectId: string) {
    const { POST } = await import("./route");
    return POST(new Request("http://localhost/sign-artwork/plan", { method: "POST" }), {
      params: Promise.resolve({ projectId }),
    });
  }

  async function getSnapshot(projectId: string) {
    const { GET } = await import("../../route");
    const response = await GET(new Request("http://localhost/projects"), {
      params: Promise.resolve({ projectId }),
    });
    assert.equal(response.status, 200);
    return response.json();
  }

  const NEVER_LEAK = [
    "rigid_sign_raster",
    "SignRepairPlan",
    "resolutionPolicyId",
    "resolution_below_minimum",
    "aspect_ratio_mismatch",
    "reconstruct_resolution",
    "extend_uniform_background",
    "plan_key",
    "planKey",
  ];

  function assertNoLeaks(body: unknown) {
    const serialized = JSON.stringify(body);
    for (const term of NEVER_LEAK) {
      assert.doesNotMatch(serialized, new RegExp(term, "i"), `leaked: ${term}`);
    }
  }

  it("ready: calls the real capability and translates its real safe plan", async () => {
    const projectId = await freshProject();
    // sign-repair-planner.test.ts case 1: exact aspect + sufficient resolution.
    await uploadExistingArtwork(projectId, toPngBytes(exactAspectSignArtwork(1800, 2400)));
    await confirmSize(projectId, 12, 16);

    const response = await plan(projectId);
    assert.equal(response.status, 200);
    const body = await response.json();

    assert.equal(body.signArtwork.plan.status, "ready");
    assert.equal(body.signArtwork.plan.canProceed, true);
    assert.equal(body.signArtwork.plan.reviewRequired, false);
    assert.equal(body.signArtwork.plan.artworkWidthPx, 1800);
    assert.equal(body.signArtwork.plan.artworkHeightPx, 2400);
    assert.equal(body.signArtwork.plan.orderedWidthIn, 12);
    assert.equal(body.signArtwork.plan.orderedHeightIn, 16);
    assertNoLeaks(body);
  });

  it("needs_review: the real Ruth-shaped case is honestly rendered as review-required, not silently downgraded to ready", async () => {
    const projectId = await freshProject();
    // sign-repair-planner.test.ts case 4: Ruth-shaped, foreground reaches the extension edge.
    await uploadExistingArtwork(projectId, toPngBytes(ruthLikeSignArtwork()));
    await confirmSize(projectId, 18, 24);

    const response = await plan(projectId);
    assert.equal(response.status, 200);
    const body = await response.json();

    assert.equal(body.signArtwork.plan.status, "needs_review");
    assert.equal(body.signArtwork.plan.reviewRequired, true);
    assert.equal(body.signArtwork.plan.canProceed, true);
    assert.ok(body.signArtwork.plan.findings.length > 0);
    assert.notEqual(body.signArtwork.plan.proposedAction, null);
    // LIVE PRODUCT BLOCKER #3A: the real defects here include the
    // review-meta code, but it must not surface as its own finding
    // sentence — the client renders exactly one review explanation from
    // `reviewRequired` alone.
    assert.ok(
      !body.signArtwork.plan.findings.some((f: string) =>
        /before we make any changes/i.test(f),
      ),
      "the review-meta finding must not duplicate the client's own review section",
    );
    // LIVE PRODUCT BLOCKER #3A: canvas/background extension is never a "border".
    assert.doesNotMatch(body.signArtwork.plan.proposedAction, /border/i);
    assert.match(body.signArtwork.plan.proposedAction, /space around the design/i);
    assertNoLeaks(body);
  });

  it("blocked: a real out-of-ceiling case renders as a valid blocked result, never a generic server error", async () => {
    const projectId = await freshProject();
    // sign-repair-planner.test.ts case 10: beyond the supported reconstruction ceiling.
    await uploadExistingArtwork(projectId, toPngBytes(exactAspectSignArtwork(300, 400)));
    await confirmSize(projectId, 18, 24);

    const response = await plan(projectId);
    assert.equal(response.status, 200, "a blocked planning outcome is a valid 200, not an error");
    const body = await response.json();

    assert.equal(body.signArtwork.plan.status, "blocked");
    assert.equal(body.signArtwork.plan.canProceed, false);
    assert.equal(body.signArtwork.plan.proposedAction, null);
    assert.ok(body.signArtwork.plan.findings.length > 0);
    assertNoLeaks(body);
  });

  it("reload resumes at the durable plan without re-planning: a plain GET after a safe plan shows the same view", async () => {
    const projectId = await freshProject();
    await uploadExistingArtwork(projectId, toPngBytes(exactAspectSignArtwork(1800, 2400)));
    await confirmSize(projectId, 12, 16);
    await plan(projectId);

    // Simulates a page reload: fetches the snapshot through the ordinary
    // project route, never calling /plan again.
    const reloaded = await getSnapshot(projectId);
    assert.equal(reloaded.signArtwork.plan.status, "ready");
    assert.equal(reloaded.signArtwork.plan.artworkWidthPx, 1800);
    assert.equal(reloaded.signArtwork.plan.orderedWidthIn, 12);
    assertNoLeaks(reloaded);
  });

  it("LIVE PRODUCT BLOCKER #3A.1: a plan persisted WITHOUT ever calling the planning route/capability in this test still renders current copy on a plain GET", async () => {
    // This is the strongest possible proof that the reload path derives
    // copy from CURRENT code rather than depending on when/how the plan
    // was originally computed: the ONLY calls in this test are upload,
    // confirm-size, a DIRECT repository write (bypassing
    // SignPreparationCapability.planSignRepair and the /plan route
    // entirely), and a plain GET. If stale copy could ever appear here, it
    // would be a genuine code-path defect in the reload/reconstruction
    // path — not a stale server process, which no in-process test can ever
    // observe (see the report's "why tests passed" explanation).
    const projectId = await freshProject();
    await uploadExistingArtwork(projectId, toPngBytes(ruthLikeSignArtwork()));
    await confirmSize(projectId, 18, 24);

    // Compute REAL planner output directly (the same pure function/fixture
    // sign-repair-planner.test.ts case 4 already proves) — never through
    // this project's SignPreparationCapability instance.
    const { inspectSignArtwork } = await import(
      "@/capabilities/sign-preparation/sign-inspection"
    );
    const { planSignRepair: formulatePlan } = await import(
      "@/capabilities/sign-preparation/sign-repair-planner"
    );
    const { RIGID_SIGN_CATEGORY } = await import(
      "@/capabilities/sign-preparation/contracts"
    );
    const { RIGID_RECT_UP_TO_24X36_V1 } = await import(
      "@/capabilities/sign-preparation/resolution-policy"
    );

    const spec = {
      category: RIGID_SIGN_CATEGORY,
      orderedWidthIn: 18,
      orderedHeightIn: 24,
      confirmedAt: "2026-08-30T12:00:00.000Z",
      resolutionPolicyId: RIGID_RECT_UP_TO_24X36_V1.id,
    };
    const inspection = inspectSignArtwork(
      ruthLikeSignArtwork(),
      spec,
      RIGID_RECT_UP_TO_24X36_V1,
    );
    const result = formulatePlan({
      spec,
      policy: RIGID_RECT_UP_TO_24X36_V1,
      inspection,
      sourceAssetId: "irrelevant-for-this-test",
      sourceSha256: "b".repeat(64),
    });
    assert.equal(result.status, "planned");
    assert.equal(result.plan!.overallRisk, "review_required");

    // Persist it directly via the repository — the SAME shape
    // planSignRepair itself would write, but written here by hand so this
    // test process never invokes the capability at all.
    const { getProjectRepository } = await import("@/lib/db");
    const repo = getProjectRepository();
    const preparation = await repo.getSignPreparation(projectId);
    assert.ok(preparation);
    await repo.updateSignPreparation(preparation!.id, {
      status: "planned",
      inspection: inspection as unknown as Record<string, unknown>,
      plan: result.plan as unknown as Record<string, unknown>,
      planKey: result.plan!.planKey,
    });

    // ONLY a plain GET from here on — never POST /sign-artwork/plan.
    const snapshot = await getSnapshot(projectId);
    const planView = snapshot.signArtwork.plan;
    const serialized = JSON.stringify(planView);

    assert.equal(planView.status, "needs_review");
    assert.equal(planView.reviewRequired, true);
    assert.doesNotMatch(serialized, /uniform border/i);
    assert.doesNotMatch(
      serialized,
      /closer look from our team before we make any changes/i,
    );
    assert.match(serialized, /space around the design/i);
    assert.match(serialized, /without stretching or trimming/i);
    assertNoLeaks(snapshot);
  });

  it("idempotent: repeated planning does not create a competing authority", async () => {
    const projectId = await freshProject();
    await uploadExistingArtwork(projectId, toPngBytes(exactAspectSignArtwork(1800, 2400)));
    await confirmSize(projectId, 12, 16);

    await plan(projectId);
    const { getProjectRepository } = await import("@/lib/db");
    const repo = getProjectRepository();
    const first = await repo.getSignPreparation(projectId);
    assert.ok(first);
    const firstPlanKey = first!.planKey;

    const second = await plan(projectId);
    assert.equal(second.status, 200);

    const after = await repo.getSignPreparation(projectId);
    assert.equal(after!.id, first!.id, "same SignPreparation row — never a second one");
    assert.equal(after!.planKey, firstPlanKey, "the SAME plan, recomputed identically, not a competing one");
  });

  it("scopes to the addressed project and nothing else", async () => {
    const projectA = await freshProject();
    const projectB = await freshProject();
    await uploadExistingArtwork(projectA, toPngBytes(exactAspectSignArtwork(1800, 2400)));
    await confirmSize(projectA, 12, 16);

    await plan(projectA);

    const { getProjectRepository } = await import("@/lib/db");
    const repo = getProjectRepository();
    assert.equal((await repo.getSignPreparation(projectA))!.status, "planned");
    assert.equal(await repo.getSignPreparation(projectB), null);
  });

  it("refuses to plan before a sign size has ever been confirmed", async () => {
    const projectId = await freshProject();
    await uploadExistingArtwork(projectId, toPngBytes(exactAspectSignArtwork(1800, 2400)));
    // No confirmSize call.

    const response = await plan(projectId);
    assert.equal(response.status, 409);
  });

  it("returns 404 for a project that does not exist", async () => {
    const response = await plan("00000000-0000-0000-0000-000000000000");
    assert.equal(response.status, 404);
  });

  it("the DTF flow is completely unaffected: a garment upload never gets a signArtwork.plan", async () => {
    const projectId = await freshProject();
    await uploadExistingArtwork(projectId, toPngBytes(exactAspectSignArtwork(1800, 2400)), "shirt-art.png");
    const snapshot = await getSnapshot(projectId);
    assert.equal(snapshot.signArtwork, null);
  });
});
