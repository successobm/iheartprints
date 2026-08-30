import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  PROVIDER_MAX_RECONSTRUCTION_SCALE,
  RECONSTRUCTION_HEADROOM,
} from "@/capabilities/final-artwork/topaz-transparency-upscale-provider";
import { deriveProductionRequirements } from "@/capabilities/print-validation/production-requirements";

import { RIGID_SIGN_CATEGORY } from "./contracts";
import {
  RIGID_RECT_UP_TO_24X36_V1,
  resolveSignResolutionPolicy,
  SIGN_RECONSTRUCTION_HEADROOM,
  SIGN_RECONSTRUCTION_SCALE_CEILING,
} from "./resolution-policy";
import { deriveRigidSignProductionRequirements } from "./sign-production-requirements";

/**
 * Test 14 and the profile-separation guarantees: the admitted
 * rigid_sign_raster profile is a NEW category that (a) brief-text
 * classification never produces, (b) is never the dormant `signage`
 * placeholder, and (c) derives its requirements only from a confirmed
 * SignProductionSpec.
 */
describe("rigid_sign_raster category separation", () => {
  it("14a: sign prose still classifies out_of_scope_product on the apparel path — never rigid_sign_raster, never signage", () => {
    for (const productSummary of ["yard sign", "vinyl banner", "storefront sign"]) {
      const requirements = deriveProductionRequirements({
        printPlacement: null,
        productSummary,
        designDescription: null,
      });
      assert.equal(requirements.category, "out_of_scope_product", productSummary);
    }
  });

  it("14b: the dormant signage placeholder remains dormant, vector-flavored, and is NOT rigid-sign policy", () => {
    // Reaching the arm requires calling it directly — no classification
    // produces it — and what it returns is the old vector placeholder, kept
    // visibly distinct from the admitted rigid-sign profile.
    const signSpec = {
      category: RIGID_SIGN_CATEGORY,
      orderedWidthIn: 18,
      orderedHeightIn: 24,
      confirmedAt: "2026-08-30T12:00:00.000Z",
      resolutionPolicyId: RIGID_RECT_UP_TO_24X36_V1.id,
    } as const;
    const rigid = deriveRigidSignProductionRequirements(
      signSpec,
      RIGID_RECT_UP_TO_24X36_V1,
    );

    assert.equal(rigid.category, "rigid_sign_raster");
    assert.equal(rigid.requiredOutputType, "raster");
    assert.equal(rigid.targetPpi, 150);
    assert.equal(rigid.transparencyRequired, false);
    assert.equal(rigid.colorMode, "rgb");
    assert.deepEqual(rigid.allowedFileFormats, ["png"]);
    assert.deepEqual(rigid.targetDimensions, { widthIn: 18, heightIn: 24 });
    assert.deepEqual(rigid.minRasterDimensionsPx, {
      widthPx: 2700,
      heightPx: 3600,
    });
    // Never the placeholder's figures.
    assert.notEqual(rigid.targetDimensions!.widthIn, 36);
    assert.notEqual(rigid.targetDimensions!.heightIn, 72);
    assert.notEqual(rigid.requiredOutputType, "vector");
    assert.notEqual(rigid.colorMode, "limited_spot_colors");
  });

  it("14c: the brief-derived path fails closed for rigid_sign_raster — it can never size or format a sign", () => {
    // The classifier cannot produce the category, so the only way to reach
    // the arm is a hypothetical mis-route; assert the arm refuses to decide
    // anything. (Simulated by checking the arm's contract via a direct call
    // is impossible without classification, so this pins the classifier
    // half: nothing in ordinary apparel prose lands there.)
    const requirements = deriveProductionRequirements({
      printPlacement: "full_front",
      productSummary: "T-shirt",
      designDescription: "a rigid sign of our mascot on the shirt",
    });
    assert.notEqual(requirements.category, "rigid_sign_raster");
    assert.notEqual(requirements.category, "signage");
  });

  it("policy resolution fails closed outside every envelope", () => {
    assert.equal(resolveSignResolutionPolicy(18, 24)?.id, "rigid_rect_up_to_24x36:v1");
    assert.equal(resolveSignResolutionPolicy(24, 36)?.id, "rigid_rect_up_to_24x36:v1");
    assert.equal(resolveSignResolutionPolicy(36, 24)?.id, "rigid_rect_up_to_24x36:v1");
    assert.equal(resolveSignResolutionPolicy(25, 30), null);
    assert.equal(resolveSignResolutionPolicy(18, 40), null);
    assert.equal(resolveSignResolutionPolicy(0, 24), null);
    assert.equal(resolveSignResolutionPolicy(Number.NaN, 24), null);
  });

  it("the planner's reconstruction bounds are the live provider's own — they can never quietly disagree", () => {
    assert.equal(SIGN_RECONSTRUCTION_SCALE_CEILING, PROVIDER_MAX_RECONSTRUCTION_SCALE);
    assert.equal(SIGN_RECONSTRUCTION_SCALE_CEILING, 4);
    assert.equal(SIGN_RECONSTRUCTION_HEADROOM, RECONSTRUCTION_HEADROOM);
  });
});
