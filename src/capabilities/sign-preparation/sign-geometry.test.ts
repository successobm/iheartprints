import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { deriveUniformBackgroundExtension } from "./sign-geometry";
import { adaptGeometryStepsToActualReconstruction } from "./sign-transform-executor";
import type { SignRepairStep } from "./contracts";

/**
 * Signs Phase S3C: direct, isolated coverage of the pure geometry math and
 * the adaptive-execution decision it feeds — deliberately separate from
 * `final-artwork-worker/sign-reconstruction.test.ts`'s integration suite,
 * since some of these branches (axis mismatch, an unapproved geometry step)
 * are structurally unreachable through the full pipeline once
 * `validateReconstructedGeometry`'s own proportionality tolerance already
 * filtered the input — proving them here is the honest way to prove they
 * exist and behave correctly at all.
 */
describe("deriveUniformBackgroundExtension (Signs Phase S3C)", () => {
  it("1: requested provider result exactly returned — no adaptation needed, matches the planner's own Ruth math", () => {
    // The planner's own inline formula, reproduced here as a sanity check:
    // 1024x1536 source -> 2.390625x -> 2448x3672 (the REQUESTED size, not
    // the real Ruth run's actual 4096x6144) -> pad to 18x24 ordered aspect.
    const geometry = deriveUniformBackgroundExtension(2448, 3672, 18, 24);
    assert.equal(geometry.needsExtension, true);
    assert.equal(geometry.axis, "horizontal");
    assert.equal(geometry.plateWidthPx, 2754);
    assert.equal(geometry.plateHeightPx, 3672);
    assert.equal(geometry.leadingPx, 153);
    assert.equal(geometry.trailingPx, 153);
  });

  it("2: the REAL S3B Ruth acceptance geometry — 4096x6144 actual reconstruction -> 4608x6144, 256px each side, 256 PPI", () => {
    const geometry = deriveUniformBackgroundExtension(4096, 6144, 18, 24);
    assert.equal(geometry.needsExtension, true);
    assert.equal(geometry.axis, "horizontal");
    assert.equal(geometry.plateWidthPx, 4608);
    assert.equal(geometry.plateHeightPx, 6144);
    assert.equal(geometry.leadingPx, 256);
    assert.equal(geometry.trailingPx, 256);
    // Achieved PPI, independently — matches the phase's own audited math.
    assert.equal(geometry.plateWidthPx / 18, 256);
    assert.equal(geometry.plateHeightPx / 24, 256);
  });

  it("3: another proportional oversized reconstruction — 3072x4608 (exactly 3x source) still derives correctly", () => {
    const geometry = deriveUniformBackgroundExtension(3072, 4608, 18, 24);
    assert.equal(geometry.axis, "horizontal");
    // Required width at height 4608, ordered aspect 0.75: round(4608*0.75) = 3456.
    assert.equal(geometry.plateWidthPx, 3456);
    assert.equal(geometry.plateHeightPx, 4608);
    const totalPad = 3456 - 3072;
    assert.equal(geometry.leadingPx, Math.floor(totalPad / 2));
    assert.equal(geometry.trailingPx, totalPad - Math.floor(totalPad / 2));
    assert.equal(geometry.leadingPx + geometry.trailingPx, totalPad, "no pixels invented or lost");
  });

  it("6: vertical-axis extension case — content wider than the ordered aspect extends top/bottom, not left/right", () => {
    // Ordered 24x18 (landscape, aspect 1.333); content 4096x2048 (aspect 2.0,
    // WIDER than ordered) must extend height, never width.
    const geometry = deriveUniformBackgroundExtension(4096, 2048, 24, 18);
    assert.equal(geometry.axis, "vertical");
    assert.equal(geometry.plateWidthPx, 4096, "the unconstrained axis is never touched");
  });

  it("7: no crop is ever introduced — the plate dimension on the extended axis is always >= the content dimension", () => {
    const cases: [number, number, number, number][] = [
      [4096, 6144, 18, 24],
      [2448, 3672, 18, 24],
      [1000, 1000, 18, 24],
      [3000, 1000, 24, 18],
    ];
    for (const [w, h, orderedW, orderedH] of cases) {
      const geometry = deriveUniformBackgroundExtension(w, h, orderedW, orderedH);
      assert.ok(geometry.plateWidthPx >= w, `plate width ${geometry.plateWidthPx} must never be less than content width ${w}`);
      assert.ok(geometry.plateHeightPx >= h, `plate height ${geometry.plateHeightPx} must never be less than content height ${h}`);
      assert.ok(geometry.leadingPx >= 0 && geometry.trailingPx >= 0, "pad amounts are never negative");
    }
  });

  it("13a: integer rounding — an odd total pad splits floor/remainder, never fractional pixels", () => {
    // Choose dims that force an ODD total pad: content 4095x6144 (one pixel
    // narrower than the real Ruth case) against the same 18x24 ordered size.
    const geometry = deriveUniformBackgroundExtension(4095, 6144, 18, 24);
    const totalPad = geometry.plateWidthPx - 4095;
    assert.equal(Number.isInteger(geometry.leadingPx), true);
    assert.equal(Number.isInteger(geometry.trailingPx), true);
    assert.equal(geometry.leadingPx, Math.floor(totalPad / 2));
    assert.equal(geometry.trailingPx, totalPad - Math.floor(totalPad / 2));
    assert.equal(geometry.leadingPx + geometry.trailingPx, totalPad);
  });

  it("13b: already exact-aspect content needs no extension at all", () => {
    // 1350x1800 is exactly 3:4, matching an 18x24 (3:4) order exactly.
    const geometry = deriveUniformBackgroundExtension(1350, 1800, 18, 24);
    assert.equal(geometry.needsExtension, false);
    assert.equal(geometry.axis, null);
    assert.equal(geometry.plateWidthPx, 1350);
    assert.equal(geometry.plateHeightPx, 1800);
    assert.equal(geometry.leadingPx, 0);
    assert.equal(geometry.trailingPx, 0);
  });

  it("13c: within-tolerance near-exact-aspect content is treated as needing no extension (matches SIGN_ASPECT_TOLERANCE)", () => {
    // 1350x1800 is exact 3:4; nudge width by 0.5% (well under the 1% tolerance).
    const geometry = deriveUniformBackgroundExtension(1357, 1800, 18, 24);
    assert.equal(geometry.needsExtension, false);
  });
});

describe("adaptGeometryStepsToActualReconstruction (Signs Phase S3C)", () => {
  const padStep: SignRepairStep = {
    kind: "pad_uniform_background",
    params: { axis: "horizontal", leadingPx: 153, trailingPx: 153, colorR: 3, colorG: 3, colorB: 3 },
    risk: "review_required",
    reasons: ["test fixture"],
  };

  it("1/unchanged: exact match to the requested reconstruction size leaves the plan's own steps and expected dims untouched", () => {
    const outcome = adaptGeometryStepsToActualReconstruction(
      [padStep],
      2448,
      3672,
      2448,
      3672,
      18,
      24,
      2754,
      3672,
    );
    assert.equal(outcome.status, "unchanged");
    if (outcome.status !== "unchanged") throw new Error("unreachable");
    assert.deepEqual(outcome.steps, [padStep], "byte-identical to the persisted plan step — zero mutation");
    assert.equal(outcome.expectedOutputWidthPx, 2754);
    assert.equal(outcome.expectedOutputHeightPx, 3672);
  });

  it("2: the real Ruth divergence adapts leadingPx/trailingPx only — axis, colour, risk, kind all preserved", () => {
    const outcome = adaptGeometryStepsToActualReconstruction(
      [padStep],
      4096,
      6144,
      2448,
      3672,
      18,
      24,
      2754,
      3672,
    );
    assert.equal(outcome.status, "adapted");
    if (outcome.status !== "adapted") throw new Error("unreachable");
    assert.equal(outcome.steps.length, 1);
    const adapted = outcome.steps[0]!;
    assert.equal(adapted.kind, "pad_uniform_background", "step kind never changes");
    assert.equal(adapted.params.axis, "horizontal", "axis never changes");
    assert.equal(adapted.params.colorR, 3, "approved fill colour never changes");
    assert.equal(adapted.params.colorG, 3);
    assert.equal(adapted.params.colorB, 3);
    assert.equal(adapted.risk, "review_required", "risk classification is untouched by adaptation");
    assert.equal(adapted.params.leadingPx, 256, "only the pixel amounts are recomputed");
    assert.equal(adapted.params.trailingPx, 256);
    assert.equal(outcome.expectedOutputWidthPx, 4608);
    assert.equal(outcome.expectedOutputHeightPx, 6144);
  });

  it("6: preserves centered-alignment convention and the approved RGB/review_required exactly (explicit multi-field check)", () => {
    const outcome = adaptGeometryStepsToActualReconstruction(
      [padStep],
      4095,
      6144,
      2448,
      3672,
      18,
      24,
      2754,
      3672,
    );
    assert.equal(outcome.status, "adapted");
    if (outcome.status !== "adapted") throw new Error("unreachable");
    const adapted = outcome.steps[0]!;
    // Centered: leading/trailing differ by at most 1px (floor/remainder split).
    const leading = adapted.params.leadingPx as number;
    const trailing = adapted.params.trailingPx as number;
    assert.ok(Math.abs(leading - trailing) <= 1, "extension remains centered within one pixel");
    assert.equal(adapted.params.colorR, 3);
    assert.equal(adapted.risk, "review_required");
  });

  it("unconfirmed fill colour is preserved verbatim — adaptation never invents a colour", () => {
    const unconfirmedStep: SignRepairStep = {
      kind: "pad_uniform_background",
      params: { axis: "horizontal", leadingPx: 153, trailingPx: 153, color: "unconfirmed" },
      risk: "review_required",
      reasons: ["no dominant colour"],
    };
    const outcome = adaptGeometryStepsToActualReconstruction(
      [unconfirmedStep],
      4096,
      6144,
      2448,
      3672,
      18,
      24,
      2754,
      3672,
    );
    assert.equal(outcome.status, "adapted");
    if (outcome.status !== "adapted") throw new Error("unreachable");
    assert.equal(outcome.steps[0]!.params.color, "unconfirmed", "still unconfirmed — the downstream executor still refuses this, unaffected by S3C");
  });

  it("axis mismatch refuses rather than silently reinterpreting the approved plan", () => {
    // The plan approved a HORIZONTAL extension; feed dimensions that would
    // require a VERTICAL one instead (impossible for a genuinely
    // proportional reconstruction, but the function must still refuse
    // defensively rather than ever act on it).
    const outcome = adaptGeometryStepsToActualReconstruction(
      [padStep], // approved axis: horizontal
      2000, // wide content — would need a VERTICAL extension to reach 18x24
      1000,
      2448,
      3672,
      18,
      24,
      2754,
      3672,
    );
    assert.equal(outcome.status, "refused");
    if (outcome.status !== "refused") throw new Error("unreachable");
    assert.match(outcome.detail, /axis/i);
  });

  it("an unapproved geometry step required (plan expected reconstruction alone to reach the ordered aspect) refuses rather than inventing one", () => {
    const outcome = adaptGeometryStepsToActualReconstruction(
      [], // plan had NO geometry step — it expected reconstruction alone to be exact-aspect
      4096,
      6144, // actual is NOT exact 18:24 aspect — would need an extension the plan never approved
      2448,
      3672,
      18,
      24,
      2754,
      3672,
    );
    assert.equal(outcome.status, "refused");
    if (outcome.status !== "refused") throw new Error("unreachable");
    assert.match(outcome.detail, /never included|unapproved/i);
  });

  it("no geometry step needed AND none present — actual dims (already exact-aspect) become the expected output", () => {
    const outcome = adaptGeometryStepsToActualReconstruction(
      [],
      1350,
      1800, // exact 3:4, matches an 18x24 order exactly — larger than requested but still exact-aspect
      1024,
      1365,
      18,
      24,
      1150,
      1533,
    );
    assert.equal(outcome.status, "adapted");
    if (outcome.status !== "adapted") throw new Error("unreachable");
    assert.equal(outcome.steps.length, 0);
    assert.equal(outcome.expectedOutputWidthPx, 1350);
    assert.equal(outcome.expectedOutputHeightPx, 1800);
  });
});
