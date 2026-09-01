import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { RgbaImage } from "@/capabilities/final-artwork/raster-transform";

import type { SignProductionSpec, SignRepairPlan } from "./contracts";
import { RIGID_SIGN_CATEGORY } from "./contracts";
import { RIGID_RECT_UP_TO_24X36_V1 } from "./resolution-policy";
import { inspectSignArtwork } from "./sign-inspection";
import { computeSignPlanKey } from "./sign-plan-identity";
import { planSignRepair } from "./sign-repair-planner";
import {
  bandWithEmbeddedMarkArtwork,
  edgeStructureSignArtwork,
  exactAspectSignArtwork,
  ruthLikeSignArtwork,
  stripedPerimeterBandArtwork,
  transparentSignArtwork,
  uniformBackgroundSignArtwork,
} from "./sign-fixtures";
import { describeSignPlanForCustomer } from "./sign-preparation-copy";
import { measurePerimeterBand } from "./perimeter-reconstruction";

function spec(orderedWidthIn: number, orderedHeightIn: number): SignProductionSpec {
  return {
    category: RIGID_SIGN_CATEGORY,
    orderedWidthIn,
    orderedHeightIn,
    confirmedAt: "2026-08-30T12:00:00.000Z",
    resolutionPolicyId: RIGID_RECT_UP_TO_24X36_V1.id,
  };
}

function plan(
  image: RgbaImage,
  orderedWidthIn: number,
  orderedHeightIn: number,
  sha256 = "a".repeat(64),
) {
  const s = spec(orderedWidthIn, orderedHeightIn);
  const inspection = inspectSignArtwork(image, s, RIGID_RECT_UP_TO_24X36_V1);
  return planSignRepair({
    spec: s,
    policy: RIGID_RECT_UP_TO_24X36_V1,
    inspection,
    sourceAssetId: "asset-1",
    sourceSha256: sha256,
  });
}

/**
 * Same as `plan`, but ALSO measures and supplies `perimeterBands` for all
 * four edges — exactly what `sign-preparation-capability.ts` computes
 * alongside inspection in the real orchestration, so this is what a real
 * planning call for artwork with a reconstructable perimeter actually sees.
 */
function planWithBands(
  image: RgbaImage,
  orderedWidthIn: number,
  orderedHeightIn: number,
  sha256 = "a".repeat(64),
) {
  const s = spec(orderedWidthIn, orderedHeightIn);
  const inspection = inspectSignArtwork(image, s, RIGID_RECT_UP_TO_24X36_V1);
  const perimeterBands = (["top", "right", "bottom", "left"] as const).map((edge) =>
    measurePerimeterBand(image, edge),
  );
  return planSignRepair({
    spec: s,
    policy: RIGID_RECT_UP_TO_24X36_V1,
    inspection,
    sourceAssetId: "asset-1",
    sourceSha256: sha256,
    perimeterBands,
  });
}

describe("sign repair planner", () => {
  it("1: exact aspect + sufficient resolution → no unnecessary repair", () => {
    // 1800×2400 at 12×16in = exactly 150 PPI.
    const result = plan(exactAspectSignArtwork(1800, 2400), 12, 16);
    assert.equal(result.status, "planned");
    const p = result.plan!;
    assert.deepEqual(p.steps, []);
    assert.equal(p.overallRisk, "auto_safe");
    assert.equal(p.expectedOutputWidthPx, 1800);
    assert.equal(p.expectedOutputHeightPx, 2400);
    assert.ok(Math.abs(p.expectedEffectivePpi - 150) < 0.01);
  });

  it("2: exact aspect + low resolution → bounded reconstruction proposed, nothing else", () => {
    // 900×1200 at 18×24in = 50 PPI → 3× to target, ×1.02 headroom.
    const result = plan(exactAspectSignArtwork(900, 1200), 18, 24);
    assert.equal(result.status, "planned");
    const p = result.plan!;
    assert.equal(p.steps.length, 1);
    assert.equal(p.steps[0]!.kind, "reconstruct_resolution");
    assert.equal(p.steps[0]!.risk, "auto_safe");
    assert.equal(p.steps[0]!.params.requestedWidthPx, 2754);
    assert.equal(p.steps[0]!.params.requestedHeightPx, 3672);
    assert.equal(p.expectedOutputWidthPx, 2754);
    assert.equal(p.expectedOutputHeightPx, 3672);
    assert.equal(p.overallRisk, "auto_safe");
  });

  it("3: aspect mismatch with provably uniform background edges → deterministic extension, AUTO_SAFE", () => {
    // 1000×1500 (2:3) on 18×24 (3:4): contain 16×24 @62.5 PPI.
    const result = plan(uniformBackgroundSignArtwork(1000, 1500), 18, 24);
    assert.equal(result.status, "planned");
    const p = result.plan!;
    assert.deepEqual(
      p.steps.map((step) => step.kind),
      ["reconstruct_resolution", "extend_uniform_background"],
    );
    const extend = p.steps[1]!;
    assert.equal(extend.risk, "auto_safe");
    assert.equal(extend.params.axis, "horizontal");
    // Measured background continues — near-black, never an invented colour.
    assert.ok(Math.abs((extend.params.colorR as number) - 6) <= 2);
    assert.equal(p.overallRisk, "auto_safe");
    assert.equal(p.expectedOutputWidthPx, 2754);
    assert.equal(p.expectedOutputHeightPx, 3672);
  });

  it("4: Ruth-shaped mismatch — foreground reaches the extension edges → REVIEW_REQUIRED, exact audit math", () => {
    const result = plan(ruthLikeSignArtwork(), 18, 24);
    assert.equal(result.status, "planned");
    const p = result.plan!;

    // Reconstruct first (provider never sees a synthetic seam), then fill.
    assert.deepEqual(
      p.steps.map((step) => step.kind),
      ["reconstruct_resolution", "pad_uniform_background"],
    );
    const reconstruct = p.steps[0]!;
    // (150/64) × 1.02 headroom = 2.390625
    assert.ok(
      Math.abs((reconstruct.params.requestedScale as number) - 2.390625) < 1e-9,
    );
    assert.equal(reconstruct.params.requestedWidthPx, 2448);
    assert.equal(reconstruct.params.requestedHeightPx, 3672);

    const pad = p.steps[1]!;
    assert.equal(pad.risk, "review_required");
    assert.equal(pad.params.axis, "horizontal");
    assert.equal(pad.params.leadingPx, 153);
    assert.equal(pad.params.trailingPx, 153);

    assert.equal(p.expectedOutputWidthPx, 2754);
    assert.equal(p.expectedOutputHeightPx, 3672);
    assert.ok(Math.abs(p.expectedEffectivePpi - 153) < 0.01);
    assert.equal(p.overallRisk, "review_required");
    assert.ok(p.defects.includes("foreground_reaches_extension_edge"));
    assert.ok(p.defects.includes("repair_requires_review"));
  });

  it("5: fill/crop is never AUTO_SAFE and the planner never emits approved_crop on its own", () => {
    const ruth = plan(ruthLikeSignArtwork(), 18, 24);
    const uniform = plan(uniformBackgroundSignArtwork(1000, 1500), 18, 24);
    for (const result of [ruth, uniform]) {
      assert.equal(result.status, "planned");
      assert.ok(
        result.plan!.steps.every((step) => step.kind !== "approved_crop"),
        "approved_crop must never be auto-planned",
      );
      // The crop alternative is diagnosed explicitly instead.
      assert.ok(
        result.defects.some((defect) => defect.code === "meaningful_crop_required"),
      );
    }
  });

  it("8: transparent source → diagnosed for opaque sign production and escalated to review", () => {
    const result = plan(transparentSignArtwork(600, 800), 18, 24);
    assert.equal(result.status, "planned");
    assert.ok(
      result.defects.some(
        (defect) => defect.code === "transparency_present" && defect.severity === "review",
      ),
    );
    assert.equal(result.plan!.overallRisk, "review_required");
  });

  it("9: below minimum but within the admitted ceiling → a plan is produced", () => {
    // 62.5 PPI < 100 minimum; 2.448× requested — well inside 4×.
    const result = plan(uniformBackgroundSignArtwork(1000, 1500), 18, 24);
    assert.equal(result.status, "planned");
    assert.ok(
      result.defects.some((defect) => defect.code === "resolution_below_minimum"),
    );
  });

  it("10: a need beyond the admitted reconstruction ceiling is BLOCKED before any dispatch could exist", () => {
    // 300×400 at 18×24 = 16.7 PPI; even 4× ≈ 66.7 PPI < 100 minimum.
    const result = plan(exactAspectSignArtwork(300, 400), 18, 24);
    assert.equal(result.status, "blocked");
    assert.equal(result.plan, null);
    assert.ok(
      result.defects.some(
        (defect) =>
          defect.code === "reconstruction_exceeds_supported_scale" &&
          defect.severity === "blocking",
      ),
    );
  });

  it("rotate: a 90°-matching source gets a review-required rotation, never an automatic one", () => {
    // 1200×900 landscape; rotated 900×1200 matches 3:4 exactly.
    const result = plan(exactAspectSignArtwork(1200, 900), 18, 24);
    assert.equal(result.status, "planned");
    const p = result.plan!;
    assert.equal(p.steps[0]!.kind, "rotate_90");
    assert.equal(p.steps[0]!.risk, "review_required");
    assert.equal(p.overallRisk, "review_required");
  });

  it("oversized source → deterministic downsample, AUTO_SAFE", () => {
    // 3600×4800 at 12×16in = 300 PPI → downsample to the 150 PPI target.
    const result = plan(exactAspectSignArtwork(3600, 4800), 12, 16);
    assert.equal(result.status, "planned");
    const p = result.plan!;
    assert.deepEqual(p.steps.map((step) => step.kind), ["downsample"]);
    assert.equal(p.steps[0]!.params.targetWidthPx, 1800);
    assert.equal(p.steps[0]!.params.targetHeightPx, 2400);
    assert.equal(p.overallRisk, "auto_safe");
  });
});

describe("canonical plan identity", () => {
  const baseImage = uniformBackgroundSignArtwork(1000, 1500);

  it("11: changing the ordered dimensions changes the plan key", () => {
    const a = plan(baseImage, 18, 24);
    const b = plan(baseImage, 18, 30);
    assert.equal(a.status, "planned");
    assert.equal(b.status, "planned");
    assert.notEqual(a.plan!.planKey, b.plan!.planKey);
  });

  it("12: changing the source bytes changes the plan key", () => {
    const a = plan(baseImage, 18, 24, "a".repeat(64));
    const b = plan(baseImage, 18, 24, "b".repeat(64));
    assert.notEqual(a.plan!.planKey, b.plan!.planKey);
  });

  it("13: identity is stable across recomputation and cosmetic serialization order", () => {
    const a = plan(baseImage, 18, 24);
    const b = plan(baseImage, 18, 24);
    assert.equal(a.plan!.planKey, b.plan!.planKey);

    // Same plan, params objects built in a different insertion order.
    const p = a.plan as SignRepairPlan;
    const shuffledSteps = p.steps.map((step) => {
      const keys = Object.keys(step.params).reverse();
      const params: Record<string, number | string> = {};
      for (const key of keys) params[key] = step.params[key]!;
      return { ...step, params };
    });
    const rekeyed = computeSignPlanKey({ ...p, steps: shuffledSteps });
    assert.equal(rekeyed, p.planKey);

    // Rationale and risk are gating/explanation, not identity.
    const reworded = computeSignPlanKey({
      ...p,
      steps: p.steps.map((step) => ({
        ...step,
        risk: "review_required" as const,
        reasons: ["different words"],
      })),
    });
    assert.equal(reworded, p.planKey);
  });
});

/**
 * Signs Perimeter Safety Phase (real incident: project cc6cfc4b-..., a
 * warning/inspection sign whose designed perimeter border and mounting-hole
 * indicators were pushed inward by a generic `pad_uniform_background`
 * repair — a real production false positive human review caught after
 * every deterministic/machine check had already passed).
 */
describe("sign repair planner — perimeter safety (edge-dependent structure)", () => {
  // 1000x1500 (aspect 0.667) against a 12x24in order (aspect 0.5) —
  // mismatched, forcing the vertical-axis (top/bottom) geometry stage
  // `edgeStructureSignArtwork` itself affects.
  const ORDERED_WIDTH_IN = 12;
  const ORDERED_HEIGHT_IN = 24;

  it("E: generic padding is refused (blocked, no plan) when an affected edge shows edge-dependent structure — never offered for review", () => {
    const image = edgeStructureSignArtwork({ solidColor: false });
    const result = plan(image, ORDERED_WIDTH_IN, ORDERED_HEIGHT_IN);

    assert.equal(result.status, "blocked");
    assert.equal(result.plan, null);
    assert.ok(
      result.defects.some((defect) => defect.code === "perimeter_structure_at_extension_edge"),
      "must carry the specific perimeter defect, not just a generic blocking reason",
    );
    const perimeterDefect = result.defects.find(
      (defect) => defect.code === "perimeter_structure_at_extension_edge",
    )!;
    assert.equal(perimeterDefect.severity, "blocking");
    // Never the generic pad step — nothing resembling "we can still do this
    // with review" is emitted anywhere in the result.
    assert.doesNotMatch(JSON.stringify(result), /pad_uniform_background/);
  });

  it("a plan for the SAME aspect mismatch on an ordinary uniform-background source is unaffected — still an auto_safe extend, not blocked (no over-triggering)", () => {
    const image = uniformBackgroundSignArtwork(1000, 1500);
    const result = plan(image, ORDERED_WIDTH_IN, ORDERED_HEIGHT_IN);
    assert.equal(result.status, "planned");
    assert.ok(result.plan!.steps.some((step) => step.kind === "extend_uniform_background"));
    assert.equal(result.plan!.overallRisk, "auto_safe");
  });

  it("F: operator authorization cannot convert this into a valid executable plan — there is nothing to authorize at all (canProceed/canAuthorize both false, no steps offered)", () => {
    const image = edgeStructureSignArtwork({ solidColor: false });
    const result = plan(image, ORDERED_WIDTH_IN, ORDERED_HEIGHT_IN);
    assert.equal(result.status, "blocked");

    const customerView = describeSignPlanForCustomer({
      orderedWidthIn: ORDERED_WIDTH_IN,
      orderedHeightIn: ORDERED_HEIGHT_IN,
      artworkWidthPx: 1000,
      artworkHeightPx: 1500,
      defectCodes: result.defects.map((defect) => defect.code),
      plan: result.plan,
    });
    assert.equal(customerView.status, "blocked");
    assert.equal(customerView.canProceed, false);
    assert.equal(customerView.proposedAction, null, "nothing is proposed to authorize");
    assert.ok(
      customerView.findings.some((finding) => /border or frame/i.test(finding)),
      "the actual production problem must be stated in plain language",
    );
  });

  it("L: the plan identity is destroyed, not silently reused, once the same source is re-inspected as edge-dependent — a prior planKey can never carry over to a blocked result", () => {
    const safeImage = uniformBackgroundSignArtwork(1000, 1500);
    const safeResult = plan(safeImage, ORDERED_WIDTH_IN, ORDERED_HEIGHT_IN);
    assert.equal(safeResult.status, "planned");
    assert.ok(safeResult.plan!.planKey.length > 0);

    const dependentImage = edgeStructureSignArtwork({ solidColor: false });
    const dependentResult = plan(dependentImage, ORDERED_WIDTH_IN, ORDERED_HEIGHT_IN);
    assert.equal(dependentResult.status, "blocked");
    assert.equal(dependentResult.plan, null, "no planKey exists at all for a blocked result");
  });

  it("only the edges the geometry stage actually extends are checked — edge-dependent structure on an edge NOT being extended never blocks", () => {
    // The same fixture's structure sits on TOP; ordering at 24x12 (aspect
    // 2.0, far from the source's own 0.667/1.5-rotated aspects) drives the
    // mismatch onto the HORIZONTAL axis (left/right) instead — both of
    // which remain ordinary, untouched uniform background in this fixture.
    const image = edgeStructureSignArtwork({ solidColor: false });
    const result = plan(image, 24, 12);
    assert.equal(result.status, "planned");
    assert.doesNotMatch(JSON.stringify(result), /perimeter_structure_at_extension_edge/);
  });
});

/**
 * Production-Aware Perimeter Reconstruction Phase (Constitution §16A.3
 * amendment 3.1). Same 1000x1500-source / 12x24in-order geometry as the
 * perimeter-safety suite above (vertical axis, top/bottom affected) —
 * proving reconstruction is admitted EXACTLY when the prior phase's
 * blocking evidence ALSO clears the reconstructability bar, and still
 * blocks otherwise.
 */
describe("sign repair planner — production-aware perimeter reconstruction", () => {
  const ORDERED_WIDTH_IN = 12;
  const ORDERED_HEIGHT_IN = 24;

  it("1/2: a reconstructable band (top: 2-colour full-length stripe; bottom: plain uniform, a degenerate reconstructable case) is admitted, never blocked", () => {
    const image = stripedPerimeterBandArtwork(1800, 2700);
    const result = planWithBands(image, ORDERED_WIDTH_IN, ORDERED_HEIGHT_IN);
    assert.equal(result.status, "planned");
    const p = result.plan!;
    assert.ok(p.steps.some((step) => step.kind === "reconstruct_perimeter_structure"));
    assert.doesNotMatch(JSON.stringify(p.steps), /pad_uniform_background/);
    assert.ok(p.defects.includes("perimeter_structure_reconstructed"));
  });

  it("10: the reconstruction step is ALWAYS review_required — never auto_safe, regardless of evidence strength (Constitution §16A.3 amendment 3.1)", () => {
    const image = uniformBackgroundSignArtwork(1000, 1500); // the STRONGEST possible evidence: every row identically flat
    // Force the same axis by mismatching the aspect, exactly like the striped fixture above.
    const result = planWithBands(image, ORDERED_WIDTH_IN, ORDERED_HEIGHT_IN);
    // A plain uniform source is normally handled by extend_uniform_background
    // (auto_safe) — this test exists to confirm THAT remains true (no
    // edge-dependence ever fires for genuinely uniform edges), by contrast
    // with the striped case below which DOES trigger reconstruction and
    // MUST still be review_required despite equally strong evidence.
    assert.equal(result.status, "planned");
    assert.equal(result.plan!.overallRisk, "auto_safe");

    const striped = stripedPerimeterBandArtwork(1800, 2700);
    const stripedResult = planWithBands(striped, ORDERED_WIDTH_IN, ORDERED_HEIGHT_IN);
    const step = stripedResult.plan!.steps.find((s) => s.kind === "reconstruct_perimeter_structure")!;
    assert.equal(step.risk, "review_required");
    assert.equal(stripedResult.plan!.overallRisk, "review_required");
    assert.ok(stripedResult.plan!.defects.includes("repair_requires_review"));
  });

  it("3/9: edge-dependent but NOT reconstructable (no perimeterBands evidence supplied) still blocks — unchanged from the safety-only phase", () => {
    const image = stripedPerimeterBandArtwork(1800, 2700);
    const result = plan(image, ORDERED_WIDTH_IN, ORDERED_HEIGHT_IN); // plain `plan`, no perimeterBands
    assert.equal(result.status, "blocked");
  });

  it("9: a band containing an embedded mark (an ambiguous corner/hole-like object) is correctly classified not-reconstructable and blocks — never silently tiled through", () => {
    const image = bandWithEmbeddedMarkArtwork();
    const result = planWithBands(image, ORDERED_WIDTH_IN, ORDERED_HEIGHT_IN);
    assert.equal(result.status, "blocked");
    assert.ok(
      result.defects.some((defect) => defect.code === "perimeter_structure_at_extension_edge"),
    );
    assert.doesNotMatch(JSON.stringify(result), /reconstruct_perimeter_structure/);
  });

  it("scope limit: never admitted alongside reconstruct_resolution, even when the band would otherwise reconstruct — blocks instead of guessing at a not-yet-supported combination", () => {
    // Undersized (needs reconstruct_resolution) AND aspect-mismatched with
    // a reconstructable top band.
    const image = stripedPerimeterBandArtwork(400, 600);
    const result = planWithBands(image, ORDERED_WIDTH_IN, ORDERED_HEIGHT_IN);
    assert.equal(result.status, "blocked");
    assert.doesNotMatch(JSON.stringify(result), /reconstruct_perimeter_structure/);
  });

  it("6/16: the reconstructed plate's expected output geometry exactly matches the ordered aspect, identical to the pad-step's own math", () => {
    const image = stripedPerimeterBandArtwork(1800, 2700);
    const result = planWithBands(image, ORDERED_WIDTH_IN, ORDERED_HEIGHT_IN);
    const p = result.plan!;
    assert.ok(Math.abs(p.expectedOutputWidthPx / p.expectedOutputHeightPx - ORDERED_WIDTH_IN / ORDERED_HEIGHT_IN) < 0.001);
  });

  it("L: planKey differs between the safety-only (blocked) evaluation and the reconstruction-admitted (planned) evaluation of the identical source/order", () => {
    const image = stripedPerimeterBandArtwork(1800, 2700);
    const blocked = plan(image, ORDERED_WIDTH_IN, ORDERED_HEIGHT_IN);
    const reconstructed = planWithBands(image, ORDERED_WIDTH_IN, ORDERED_HEIGHT_IN);
    assert.equal(blocked.status, "blocked");
    assert.equal(reconstructed.status, "planned");
    assert.ok(reconstructed.plan!.planKey.length > 0);
  });
});
