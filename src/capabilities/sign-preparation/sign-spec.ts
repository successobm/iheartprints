/**
 * Signs Phase S1: fail-closed resolution of the ordered-size authority
 * (Constitution §16A.2).
 *
 * Width AND height are authoritative and human-confirmed. Nothing here
 * defaults a missing dimension, and nothing anywhere may infer one from
 * aspect ratio, artwork pixels, filename, prose, product-name keywords, or
 * the dormant `signage` placeholder. The `productionSizeConfirmedAt`
 * precedent applies verbatim: a default is not a decision.
 */

import type { SignPreparation } from "@/lib/domain/types";

import type { SignSpecMissing, SignSpecResolution } from "./contracts";
import { getSignResolutionPolicyById } from "./resolution-policy";

/** Sanity ceiling far above any V1 policy envelope — rejects garbage, decides nothing. */
const MAX_SANE_ORDERED_IN = 240;

export function isValidOrderedDimensionIn(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value > 0 &&
    value <= MAX_SANE_ORDERED_IN
  );
}

/**
 * Resolves a preparation's persisted spec fields into a confirmed
 * `SignProductionSpec`, or an explicit list of what is missing. Planning
 * MUST refuse on anything but `confirmed`.
 */
export function resolveSignProductionSpec(
  preparation: Pick<
    SignPreparation,
    "orderedWidthIn" | "orderedHeightIn" | "specConfirmedAt" | "resolutionPolicyId"
  >,
): SignSpecResolution {
  const missing: SignSpecMissing[] = [];

  if (!isValidOrderedDimensionIn(preparation.orderedWidthIn)) {
    missing.push("ordered_width");
  }
  if (!isValidOrderedDimensionIn(preparation.orderedHeightIn)) {
    missing.push("ordered_height");
  }
  if (
    typeof preparation.specConfirmedAt !== "string" ||
    preparation.specConfirmedAt.length === 0
  ) {
    missing.push("confirmation");
  }
  // Dimension-Driven Signs Refactor: a resolution policy is a pure function
  // of (width, height) — never a product/substrate category any more, and
  // never "looked up" by id alone (`getSignResolutionPolicyById` recomputes
  // it fresh for the current dimension-driven id, or returns the unchanged
  // legacy row for either former rigid/banner id). A policy id this build
  // cannot read is an absence of knowledge, not a licence to substitute a
  // different policy: fails closed.
  const policy =
    typeof preparation.resolutionPolicyId === "string" &&
    isValidOrderedDimensionIn(preparation.orderedWidthIn) &&
    isValidOrderedDimensionIn(preparation.orderedHeightIn)
      ? getSignResolutionPolicyById(
          preparation.resolutionPolicyId,
          preparation.orderedWidthIn,
          preparation.orderedHeightIn,
        )
      : null;
  if (policy === null) {
    missing.push("resolution_policy");
  }

  if (missing.length > 0) {
    return { status: "unconfirmed", missing };
  }

  return {
    status: "confirmed",
    spec: {
      // Derived from the resolved policy, never from a customer-facing
      // production-type answer any more — see `resolution-policy.ts`'s own
      // doc. Always `RIGID_SIGN_CATEGORY` (the unified Signs category) for
      // any spec confirmed under the current dimension-driven policy;
      // reflects the former category honestly for an already-existing
      // legacy spec.
      category: policy!.category,
      orderedWidthIn: preparation.orderedWidthIn as number,
      orderedHeightIn: preparation.orderedHeightIn as number,
      confirmedAt: preparation.specConfirmedAt as string,
      resolutionPolicyId: preparation.resolutionPolicyId as string,
    },
  };
}
