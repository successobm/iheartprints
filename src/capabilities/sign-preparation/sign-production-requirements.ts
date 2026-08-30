/**
 * Signs Phase S1: builds provider-neutral `ProductionRequirements` for the
 * admitted rigid_sign_raster profile from a CONFIRMED `SignProductionSpec`
 * — never from brief text, keywords, or the dormant `signage` placeholder
 * (whose 36×72in / `targetPpi: null` / vector assumptions are explicitly
 * not rigid-sign policy; Constitution §16A, Phase S0 audit).
 *
 * This is the profile's requirements seam for S2's worker routing and
 * validation profile. S1 itself produces and validates nothing.
 */

import type { ProductionRequirements } from "@/capabilities/print-validation/contracts";
import { minimumRasterDimensionsFor } from "@/capabilities/print-validation/effective-resolution";

import type { SignProductionSpec } from "./contracts";
import type { SignResolutionPolicy } from "./resolution-policy";

export function deriveRigidSignProductionRequirements(
  spec: SignProductionSpec,
  policy: SignResolutionPolicy,
): ProductionRequirements {
  const targetDimensions = {
    widthIn: spec.orderedWidthIn,
    heightIn: spec.orderedHeightIn,
  };
  return {
    category: "rigid_sign_raster",
    // Decoration context vocabulary only — it selects nothing (Sprint A2).
    printMethod: "signage",
    printMethodConfidence: "confirmed",
    requestedUnsupportedOutput: null,
    // Apparel garment placement has no meaning for a substrate-defined sign.
    printLocation: null,
    // For a sign the ordered rectangle IS the deliverable's exact shape —
    // not an envelope, and not the apparel width-constrained sizing model.
    targetDimensions,
    sizing: null,
    requiredOutputType: "raster",
    targetPpi: policy.targetPpi,
    minRasterDimensionsPx: minimumRasterDimensionsFor(
      targetDimensions,
      policy.targetPpi,
    ),
    // Opaque production intent (Constitution §16A.2) — the inverse of the
    // apparel raster profile's transparency requirement.
    transparencyRequired: false,
    colorMode: "rgb",
    allowedFileFormats: ["png"],
    artworkBoundaryMarginPercent: 0,
    // The customer's pixels are authoritative; no wording contract exists.
    requiredWordingVerificationRequired: false,
    notes: [
      `Rigid-sign requirements derived from confirmed SignProductionSpec (${spec.orderedWidthIn}x${spec.orderedHeightIn}in, confirmed ${spec.confirmedAt}) under policy ${policy.id} (target ${policy.targetPpi} PPI, minimum ${policy.minPpi} PPI). Exact-size opaque plate; never brief-derived; never the dormant signage placeholder.`,
    ],
  };
}
