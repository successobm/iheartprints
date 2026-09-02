/**
 * Structural Layout Reflow Phase 2B (Planning Orchestration Wiring). Proves
 * `reflow_structural_layout` reaches a REAL planning result through the
 * actual `SignPreparationCapability` orchestration boundary — upload,
 * confirm spec, plan — not only direct unit calls to `sign-repair-
 * planner.ts` (already covered by `sign-repair-planner-structural-
 * reflow.test.ts`, kept untouched).
 *
 * `SignPreparationCapability` depends on `ProjectRepository` + `AssetCapability`
 * and NO provider port of any kind (see that module's own header doc) — there
 * is structurally nothing here that could ever call Topaz or OpenAI; every
 * test in this file exercises zero provider calls by construction, not by
 * assertion.
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { DataUriAssetStorageProvider } from "@/capabilities/asset-storage";
import {
  createAssetCapability,
  PngThumbnailGenerator,
} from "@/capabilities/assets";
import type { ProjectRepository } from "@/lib/db/repository";
import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";

import { createSignPreparationCapability, SignPreparationStateError } from "./sign-preparation-capability";
import { planContainsOnlyAdmittedSteps } from "./sign-transform-executor";
import {
  acceptanceBannerSignArtwork,
  ambiguousAdjacentFillArtwork,
  bannerSignEdgeContentArtwork,
  framedSignArtwork,
  ruthLikeSignArtwork,
  toPngBytes,
} from "./sign-fixtures";

describe("SignPreparationCapability — structural layout reflow (real orchestration path)", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-sign-prep-reflow-"));
    process.chdir(tempDir);
  });

  after(async () => {
    await cleanupTempWorkspace(tempDir, previousCwd);
  });

  async function build() {
    const { LocalProjectRepository } = await import("@/lib/db/local-store");
    const repo: ProjectRepository = new LocalProjectRepository();
    const assets = createAssetCapability(
      repo,
      new DataUriAssetStorageProvider(),
      new PngThumbnailGenerator(),
    );
    const capability = createSignPreparationCapability(repo, assets);
    const project = await repo.createProject();
    return { repo, assets, capability, projectId: project.project.id };
  }

  /**
   * 1/2/3/4/5/6/7/8/9/10: the primary happy-path proof. `acceptanceBannerSignArtwork`
   * mirrors the real cc6cfc4b-... sign's own SOURCE pixel dimensions
   * (1086×1448) at its own ordered size (24×36in) — a generic banner
   * layout, never the real customer's wording or file — uploaded and
   * planned through the REAL capability, never a direct unit call.
   */
  it("1-10: a structured banner-style source reaches segmentStructuralLayout through the real preparation path and proposes an eligible, deterministic reflow_structural_layout plan", async () => {
    const { repo, capability, projectId } = await build();
    await capability.uploadSignArtwork(projectId, {
      bytes: toPngBytes(acceptanceBannerSignArtwork()),
      declaredContentType: "image/png",
      filename: "sign.png",
    });
    await capability.confirmSignProductionSpec(projectId, 24, 36);

    const outcome = await capability.planSignRepair(projectId);
    assert.equal(outcome.result.status, "planned"); // 3: proposed, never blocked.
    const plan = outcome.result.plan!;

    const step = plan.steps.find((s) => s.kind === "reflow_structural_layout");
    assert.ok(step, "expected reflow_structural_layout to reach the real plan"); // 1/2: segmentation reached the planner.

    assert.equal(plan.overallRisk, "review_required"); // 4.
    assert.equal(step!.risk, "review_required");
    assert.equal(step!.params.templateShape, "straight_rectangle"); // 5.
    assert.equal(step!.params.templateWidthIn, 24);
    assert.equal(step!.params.templateHeightIn, 36);
    assert.equal(step!.params.templateMinimumSafeInsetIn, 0.125); // 6.

    const regionCount = step!.params.regionCount as number;
    assert.ok(regionCount >= 2);
    assert.equal(step!.params.region0Role, "top_anchor"); // 7.
    assert.equal(step!.params[`region${regionCount - 1}Role`], "bottom_anchor"); // 8.
    if (regionCount > 2) {
      // 9: ordered middle regions preserved — every region strictly between
      // the anchors is "middle", in the SAME order segmentation measured.
      for (let i = 1; i < regionCount - 1; i++) {
        assert.equal(step!.params[`region${i}Role`], "middle");
      }
    }
    assert.ok((step!.params.gapCount as number) > 0);
    for (let i = 0; i < (step!.params.gapCount as number); i++) {
      assert.equal(typeof step!.params[`gap${i}SourceHeightPx`], "number");
      assert.ok((step!.params[`gap${i}SourceHeightPx`] as number) > 0);
    }

    // Persisted, with the canonical key, plan reflects the real capability's own decision.
    const persisted = await repo.getSignPreparation(projectId);
    assert.equal(persisted!.status, "planned");
    assert.equal(persisted!.planKey, plan.planKey);

    // 10/15: repeated identical orchestration — a fresh plan call against
    // the SAME immutable original and confirmed spec — produces IDENTICAL
    // params and an IDENTICAL planKey (deterministic, not merely "close").
    const again = await capability.planSignRepair(projectId);
    assert.equal(again.result.status, "planned");
    const stepAgain = again.result.plan!.steps.find((s) => s.kind === "reflow_structural_layout")!;
    assert.deepEqual(step!.params, stepAgain.params);
    assert.equal(again.result.plan!.planKey, plan.planKey);
  });

  /**
   * 11 (regression guard for the fix this phase made): a genuinely
   * rounded, concentric-frame sign's segmentation comes back `"ambiguous"`
   * (its outer stroke/gap boundary looks, to a row scanner, exactly like
   * two adjacent differently-coloured fill runs) — through the REAL
   * orchestration path, where `frameStructuralModel` is ALSO computed
   * unconditionally alongside it, the plan must still reach
   * `reconstruct_parametric_frame` rather than blocking on the ambiguous
   * segmentation evidence alone. This is also the direct proof that
   * rounded source decoration never becomes `SignProductionTemplate.shape`
   * via a DIFFERENT path either: `reconstruct_parametric_frame`'s own
   * params carry no `templateShape` field at all — corner rounding stays
   * an ARTWORK fact (`cornerRadiusPx`), never a substrate-shape claim.
   */
  it("11: a genuinely rounded/framed sign (ambiguous segmentation, valid frame evidence) still reaches reconstruct_parametric_frame through the real path — never blocked, never reflow", async () => {
    const { capability, projectId } = await build();
    await capability.uploadSignArtwork(projectId, {
      bytes: toPngBytes(framedSignArtwork({ width: 4000, height: 5333, rounded: true, withHoles: true })),
      declaredContentType: "image/png",
      filename: "sign.png",
    });
    await capability.confirmSignProductionSpec(projectId, 24, 36);

    const outcome = await capability.planSignRepair(projectId);
    assert.equal(outcome.result.status, "planned");
    const plan = outcome.result.plan!;
    assert.ok(plan.steps.some((step) => step.kind === "reconstruct_parametric_frame"));
    assert.doesNotMatch(JSON.stringify(plan.steps), /"kind":"reflow_structural_layout"/);
    assert.equal(plan.overallRisk, "review_required");
  });

  it("12: ambiguous segmentation with no frame/edge-dependence fallback blocks — never silently ignored, never falls back to an ordinary background extension", async () => {
    const { capability, projectId } = await build();
    await capability.uploadSignArtwork(projectId, {
      bytes: toPngBytes(ambiguousAdjacentFillArtwork()),
      declaredContentType: "image/png",
      filename: "sign.png",
    });
    await capability.confirmSignProductionSpec(projectId, 18, 36);

    const outcome = await capability.planSignRepair(projectId);
    assert.equal(outcome.result.status, "blocked");
    assert.equal(outcome.result.plan, null);
    assert.ok(
      outcome.result.defects.some((d) => d.code === "perimeter_structure_at_extension_edge" && d.severity === "blocking"),
    );
    assert.doesNotMatch(JSON.stringify(outcome.result), /reflow_structural_layout/);
  });

  it("13: insufficient fill evidence (no edge-reaching fill to extend) blocks through the real path", async () => {
    const { capability, projectId } = await build();
    await capability.uploadSignArtwork(projectId, {
      bytes: toPngBytes(bannerSignEdgeContentArtwork()),
      declaredContentType: "image/png",
      filename: "sign.png",
    });
    await capability.confirmSignProductionSpec(projectId, 12, 24);

    const outcome = await capability.planSignRepair(projectId);
    assert.equal(outcome.result.status, "blocked");
    assert.equal(outcome.result.plan, null);
    assert.ok(
      outcome.result.defects.some(
        (d) => d.code === "perimeter_structure_at_extension_edge" && /edge-reaching fill/.test(d.detail),
      ),
    );
  });

  it("14: unrelated Signs planning behaviour is unaffected — an ordinary foreground-bleed source still plans reconstruct_resolution + pad_uniform_background, exactly as before this phase", async () => {
    const { capability, projectId } = await build();
    await capability.uploadSignArtwork(projectId, {
      bytes: toPngBytes(ruthLikeSignArtwork()),
      declaredContentType: "image/png",
      filename: "sign.png",
    });
    await capability.confirmSignProductionSpec(projectId, 18, 24);

    const outcome = await capability.planSignRepair(projectId);
    assert.equal(outcome.result.status, "planned");
    assert.deepEqual(
      outcome.result.plan!.steps.map((step) => step.kind),
      ["reconstruct_resolution", "pad_uniform_background"],
    );
  });

  /**
   * 16: an authorization for an earlier, safe (auto_safe, exact-aspect)
   * plan can never authorize a superseding reflow plan for the same
   * preparation — the exact planKey binding remains authoritative, and a
   * customer authorization is never sufficient for the new review_required
   * plan (Signs Perimeter Safety Phase's own "M" test, reproduced for the
   * new step kind).
   */
  it("16: a prior auto_safe authorization does not authorize a superseding reflow_structural_layout plan for the same preparation", async () => {
    const { repo, capability, projectId } = await build();
    await capability.uploadSignArtwork(projectId, {
      bytes: toPngBytes(acceptanceBannerSignArtwork()),
      declaredContentType: "image/png",
      filename: "sign.png",
    });

    // First confirmation: 24x32in exactly matches the fixture's own
    // 1086:1448 (0.75) aspect — no geometry-extension step at all, so
    // structural reflow evidence is never even evaluated. Plans cleanly
    // (reconstruct_resolution only, always auto_safe), authorizable by a
    // customer.
    await capability.confirmSignProductionSpec(projectId, 24, 32);
    const safeOutcome = await capability.planSignRepair(projectId);
    assert.equal(safeOutcome.result.status, "planned");
    const safePlan = safeOutcome.result.plan!;
    assert.equal(safePlan.overallRisk, "auto_safe");
    assert.doesNotMatch(JSON.stringify(safePlan.steps), /reflow_structural_layout/);

    const authorized = await capability.authorizeSignRepairPlan(projectId, { authorizedBy: "customer" });
    assert.equal(authorized.authorizedPlanKey, safePlan.planKey);

    // Re-confirming a DIFFERENT, mismatched ordered size (24x36, aspect
    // 0.667) against the SAME immutable original forces the vertical-axis
    // geometry stage — which this fixture's own measured banner structure
    // now proposes reflow_structural_layout for.
    await capability.confirmSignProductionSpec(projectId, 24, 36);
    const reflowOutcome = await capability.planSignRepair(projectId);
    assert.equal(reflowOutcome.result.status, "planned");
    const reflowPlan = reflowOutcome.result.plan!;
    assert.ok(reflowPlan.steps.some((step) => step.kind === "reflow_structural_layout"));
    assert.equal(reflowPlan.overallRisk, "review_required");
    assert.notEqual(reflowPlan.planKey, safePlan.planKey);

    // The stale authorization is durably left in place (never silently
    // cleared or migrated) — but it does not match the NEW plan's own key.
    const persisted = await repo.getSignPreparation(projectId);
    assert.equal(persisted!.planKey, reflowPlan.planKey);
    assert.equal(persisted!.authorizedPlanKey, safePlan.planKey, "the old authorization record itself is untouched");
    assert.notEqual(persisted!.authorizedPlanKey, persisted!.planKey);

    // A customer authorization is never sufficient for a review_required
    // plan — the SAME rule the safe plan's own customer authorization was
    // allowed under does not extend to this one.
    await assert.rejects(
      capability.authorizeSignRepairPlan(projectId, { authorizedBy: "customer" }),
      SignPreparationStateError,
    );

    // An operator MAY authorize it — a fresh, distinct authorization for
    // the NEW plan's own key, never a reuse of the old one.
    const operatorAuthorized = await capability.authorizeSignRepairPlan(projectId, { authorizedBy: "operator" });
    assert.equal(operatorAuthorized.authorizedPlanKey, reflowPlan.planKey);
    assert.notEqual(operatorAuthorized.authorizedPlanKey, safePlan.planKey);
  });

  it("17: a reflow plan produced through the real path is never admitted for execution", async () => {
    const { capability, projectId } = await build();
    await capability.uploadSignArtwork(projectId, {
      bytes: toPngBytes(acceptanceBannerSignArtwork()),
      declaredContentType: "image/png",
      filename: "sign.png",
    });
    await capability.confirmSignProductionSpec(projectId, 24, 36);

    const outcome = await capability.planSignRepair(projectId);
    assert.equal(outcome.result.status, "planned");
    assert.ok(outcome.result.plan!.steps.some((step) => step.kind === "reflow_structural_layout"));
    assert.equal(planContainsOnlyAdmittedSteps(outcome.result.plan!), false);
  });

  // 18/19: zero Topaz / zero OpenAI calls — structural, not merely
  // observed: `createSignPreparationCapability` takes only a
  // `ProjectRepository` and an `AssetCapability`, both provider-free by
  // this module's own construction (see its header doc) — every test
  // above is therefore already zero-provider-call by construction, with
  // no provider object even available to have been called.
});
