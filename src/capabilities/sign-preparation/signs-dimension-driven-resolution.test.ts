/**
 * Signs Dimension-Driven Artwork Preparation: exhaustive coverage of
 * `resolveSignResolutionPolicy`/`getSignResolutionPolicyById` — the pure,
 * dimension-driven formula that replaced the former two-policy (Rigid
 * Sign/Banner) product-category table. See `resolution-policy.ts`'s own
 * doc for the full derivation.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { BANNER_CATEGORY, RIGID_SIGN_CATEGORY } from "./contracts";
import {
  ABSOLUTE_MIN_USABLE_PPI,
  BANNER_RECT_UP_TO_36X96_V1,
  MIN_TARGET_PPI_RATIO,
  QUALITY_TARGET_PPI_CEILING,
  RIGID_RECT_UP_TO_24X36_V1,
  SAFE_CANVAS_PIXEL_BUDGET,
  SIGNS_DIMENSION_DRIVEN_POLICY_ID,
  getSignResolutionPolicyById,
  resolveSignResolutionPolicy,
} from "./resolution-policy";

describe("resolveSignResolutionPolicy: the dimension-driven formula", () => {
  it("THE REAL CUSTOMER CASE: 84x24in resolves to exactly 72 PPI target, 6048x1728px, maxCanvasPpi=72 — no product-type question, no size-envelope rejection", () => {
    const policy = resolveSignResolutionPolicy(84, 24);
    assert.ok(policy, "84x24in must be accepted — this is the real pending order");
    assert.equal(policy!.id, SIGNS_DIMENSION_DRIVEN_POLICY_ID);
    assert.equal(policy!.category, RIGID_SIGN_CATEGORY, "the single unified Signs category — never a product/substrate label");
    assert.equal(policy!.targetPpi, 72);
    assert.equal(policy!.maxCanvasPpi, 72);
    assert.equal(Math.round(84 * policy!.targetPpi), 6048);
    assert.equal(Math.round(24 * policy!.targetPpi), 1728);
    // Exactly the proven-safe canvas pixel budget, by construction.
    assert.equal(84 * policy!.targetPpi * (24 * policy!.targetPpi), SAFE_CANVAS_PIXEL_BUDGET);
  });

  it("84x24 also resolves identically in the other orientation (24x84) — order-independent, dimension-driven, never keyed to which axis is 'width'", () => {
    const a = resolveSignResolutionPolicy(84, 24);
    const b = resolveSignResolutionPolicy(24, 84);
    assert.deepEqual(a, b);
  });

  it("small signs keep their full historical quality ceiling: 18x24in still resolves 150 PPI target (the memory-safe bound at this size is well above it)", () => {
    const policy = resolveSignResolutionPolicy(18, 24);
    assert.ok(policy);
    assert.equal(policy!.targetPpi, QUALITY_TARGET_PPI_CEILING);
    assert.equal(policy!.targetPpi, 150);
    assert.equal(policy!.minPpi, 100);
    assert.equal(policy!.maxCanvasPpi, 150);
  });

  it("24x36in (the old rigid policy's own max envelope corner) now resolves BELOW the quality ceiling — 24x36in @ 150 PPI (19.44MP) was never actually memory-proven safe; the dimension-driven bound corrects it, honestly, for every order this size, not only large ones", () => {
    const policy = resolveSignResolutionPolicy(24, 36);
    assert.ok(policy);
    const expectedTarget = Math.round(Math.sqrt(SAFE_CANVAS_PIXEL_BUDGET / (24 * 36)));
    assert.equal(policy!.targetPpi, expectedTarget);
    assert.ok(policy!.targetPpi < QUALITY_TARGET_PPI_CEILING, "must be memory-bound here, not quality-bound");
    assert.equal(policy!.maxCanvasPpi, policy!.targetPpi);
  });

  it("minPpi is always target * 2/3, floored at ABSOLUTE_MIN_USABLE_PPI — the same ratio the original rigid policy's own 100/150 figures establish, applied consistently", () => {
    for (const [w, h] of [[18, 24], [24, 36], [84, 24], [36, 96]] as const) {
      const policy = resolveSignResolutionPolicy(w, h);
      assert.ok(policy, `${w}x${h} must resolve`);
      const expectedMin = Math.max(
        ABSOLUTE_MIN_USABLE_PPI,
        Math.round(policy!.targetPpi * MIN_TARGET_PPI_RATIO),
      );
      assert.equal(policy!.minPpi, expectedMin, `${w}x${h}`);
    }
  });

  it("a physical area so large that even the memory-safe target falls below the usable floor is refused — a genuine technical reason, never a product-label boundary", () => {
    // 200x100in = 20,000 sq in -> sqrt(10,450,944 / 20,000) ~= 22.9 PPI, below ABSOLUTE_MIN_USABLE_PPI (30).
    assert.equal(resolveSignResolutionPolicy(200, 100), null);
  });

  it("the boundary is continuous, not a discrete envelope: sizes that were never covered by either old policy (25x30, 18x40, 40x60) are now genuinely supported", () => {
    assert.notEqual(resolveSignResolutionPolicy(25, 30), null);
    assert.notEqual(resolveSignResolutionPolicy(18, 40), null);
    assert.notEqual(resolveSignResolutionPolicy(40, 60), null);
    // ...and the old banner max corner (36x96) is ALSO still supported, at its own dimension-driven figure — never the old fixed 72 PPI.
    const legacyBannerCorner = resolveSignResolutionPolicy(36, 96);
    assert.ok(legacyBannerCorner);
    assert.notEqual(legacyBannerCorner!.targetPpi, 72);
  });

  it("degenerate input fails closed: zero, negative, NaN, non-finite", () => {
    assert.equal(resolveSignResolutionPolicy(0, 24), null);
    assert.equal(resolveSignResolutionPolicy(24, 0), null);
    assert.equal(resolveSignResolutionPolicy(-5, 24), null);
    assert.equal(resolveSignResolutionPolicy(Number.NaN, 24), null);
    assert.equal(resolveSignResolutionPolicy(24, Number.POSITIVE_INFINITY), null);
  });

  it("never takes a category/product-type parameter — the function signature itself proves no substrate coupling exists", () => {
    // TypeScript enforces this at compile time; this test pins the runtime
    // contract too — calling with exactly two arguments is the whole API.
    assert.equal(resolveSignResolutionPolicy.length, 2);
  });
});

describe("getSignResolutionPolicyById: dimension-driven id + legacy backward compatibility", () => {
  it("the current dimension-driven id recomputes fresh from the supplied dimensions — never a stale cached number", () => {
    const viaId = getSignResolutionPolicyById(SIGNS_DIMENSION_DRIVEN_POLICY_ID, 84, 24);
    const direct = resolveSignResolutionPolicy(84, 24);
    assert.deepEqual(viaId, direct);
  });

  it("the dimension-driven id with DIFFERENT dimensions than were originally confirmed also recomputes fresh (proving it is a pure function of the arguments, never of stored state)", () => {
    const at84x24 = getSignResolutionPolicyById(SIGNS_DIMENSION_DRIVEN_POLICY_ID, 84, 24);
    const at18x24 = getSignResolutionPolicyById(SIGNS_DIMENSION_DRIVEN_POLICY_ID, 18, 24);
    assert.notEqual(at84x24!.targetPpi, at18x24!.targetPpi);
  });

  it("LEGACY: the old rigid-sign policy id always returns the UNCHANGED historical row, regardless of the supplied dimensions — an already-confirmed legacy spec's own envelope was validated once, at confirmation time", () => {
    const viaLegacyId = getSignResolutionPolicyById(RIGID_RECT_UP_TO_24X36_V1.id, 18, 24);
    assert.deepEqual(viaLegacyId, RIGID_RECT_UP_TO_24X36_V1);
    assert.equal(viaLegacyId!.targetPpi, 150);
    assert.equal(viaLegacyId!.minPpi, 100);
    assert.equal(viaLegacyId!.maxCanvasPpi, undefined, "the legacy rigid row was never canvas-capped — preserved byte-for-byte");
    assert.equal(viaLegacyId!.category, RIGID_SIGN_CATEGORY);
    // Even nonsensical dimensions for this id return the SAME fixed row —
    // it never re-validates an envelope against them.
    const withOddDimensions = getSignResolutionPolicyById(RIGID_RECT_UP_TO_24X36_V1.id, 84, 24);
    assert.deepEqual(withOddDimensions, RIGID_RECT_UP_TO_24X36_V1);
  });

  it("LEGACY: the old banner policy id always returns the UNCHANGED historical row — an already-existing banner_raster preparation continues to load and plan exactly as it always did", () => {
    const viaLegacyId = getSignResolutionPolicyById(BANNER_RECT_UP_TO_36X96_V1.id, 84, 24);
    assert.deepEqual(viaLegacyId, BANNER_RECT_UP_TO_36X96_V1);
    assert.equal(viaLegacyId!.targetPpi, 72);
    assert.equal(viaLegacyId!.minPpi, 50);
    assert.equal(viaLegacyId!.maxCanvasPpi, 72);
    assert.equal(viaLegacyId!.category, BANNER_CATEGORY);
  });

  it("an unrecognized/garbage id is an absence of knowledge, not a licence to substitute a different policy — fails closed", () => {
    assert.equal(getSignResolutionPolicyById("some_future_policy:v99", 84, 24), null);
    assert.equal(getSignResolutionPolicyById("", 84, 24), null);
    assert.equal(getSignResolutionPolicyById("rigid_rect_up_to_24x36", 84, 24), null, "near-miss id must not fuzzy-match");
  });

  it("a legacy id combined with degenerate dimensions still returns the fixed row (dimensions are irrelevant to a legacy lookup)", () => {
    const viaLegacyId = getSignResolutionPolicyById(RIGID_RECT_UP_TO_24X36_V1.id, Number.NaN, 24);
    assert.deepEqual(viaLegacyId, RIGID_RECT_UP_TO_24X36_V1);
  });
});
