/**
 * Constitution amendment 3.2 (§16A.2): governed background removal for the
 * rigid-sign REMOVE treatment.
 *
 * REUSES `artwork-preparation`'s neutral classification/removal engine —
 * `analyzeArtwork`, `classifyRepairability`, `isolateBackground` — rather
 * than building a second white-removal algorithm (§16A.2's own preservation
 * discipline: "a conservative refusal costs a conversation, while an
 * over-confident mask destroys work we cannot recreate", `repairability.ts`'s
 * own doc). This is the one narrow, explicitly-documented crossing of the
 * `sign-preparation` → `artwork-preparation` capability boundary
 * (`capability-boundaries.ts`'s own "SIGNS PHASE S1" block, extended by
 * amendment 3.2) — three PURE, deterministic, provider-free functions,
 * never `ArtworkPreparationCapability` itself, never a provider port.
 *
 * `analyzeArtwork` is called with `printPlacement: null` and
 * `intendedPrintWidthIn: null` — Signs has its OWN resolution/enhancement
 * policy (`resolution-policy.ts`'s 150-target/100-minimum PPI figures,
 * driven by the ordered physical size, never a pixel-sufficiency-against-
 * apparel-placement computation). Omitting both inputs makes
 * `classifyRepairability`'s `enhancementRequired` always `false` for this
 * call site by construction — apparel's `PrintPlacement`/
 * `intendedPrintWidthIn` sizing model never leaks into a sign decision,
 * exactly as `capability-boundaries.ts` forbids.
 *
 * THE SAFETY INVARIANT (inherited unchanged from `artwork-preparation`):
 * background removal may remove pixels only when the system has
 * affirmative evidence they belong to the background. Colour similarity
 * alone is insufficient; enclosure alone is insufficient. Ambiguous
 * artwork — ANY case `classifyRepairability` marks `manual_review` —
 * returns `review_required` here, never a destructive guess. There is no
 * generative fallback: Constitution §16A.6 excludes generative redesign/
 * outpainting/inpainting for signs outright, with no carve-out for
 * background removal, so an ambiguous case has exactly one honest outcome.
 */

import type { RgbaImage } from "@/capabilities/final-artwork/raster-transform";
import { analyzeArtwork, artworkHasTransparency } from "@/capabilities/artwork-preparation/image-analysis";
import { classifyRepairability } from "@/capabilities/artwork-preparation/repairability";
import { isolateBackground } from "@/capabilities/artwork-preparation/background-isolation";
import type { RepairabilityReasonCode } from "@/capabilities/artwork-preparation/contracts";

export const SIGN_BACKGROUND_REMOVAL_VERSION = "sign-background-removal:v1";

export type SignBackgroundRemovalStatus = "removed" | "already_transparent" | "no_visible_artwork" | "review_required";

/**
 * The governed, recomputable outcome — this is the shape persisted (as
 * plain JSON) on `SignPreparation.backgroundRemoval`. Embeds its own
 * `sourceAssetId`/`sourceSha256` so a stale record computed against a
 * since-replaced original is never trusted (the `edge_intent_
 * classifications`/`qr_resolutions` precedent).
 */
export interface SignBackgroundRemovalRecord {
  version: typeof SIGN_BACKGROUND_REMOVAL_VERSION;
  status: SignBackgroundRemovalStatus;
  sourceAssetId: string;
  sourceSha256: string;
  sourceWidthPx: number;
  sourceHeightPx: number;
  /** Non-null only when `status === "removed"` — the id of the derived, transparent prepared asset. */
  preparedAssetId: string | null;
  /** Internal rationale — `classifyRepairability`'s own reason codes. Never customer-facing copy. */
  reasons: RepairabilityReasonCode[];
  exteriorPixelsRemoved: number | null;
  computedAt: string;
}

export type SignBackgroundRemovalOutcome =
  | { status: "removed"; image: RgbaImage; exteriorPixelsRemoved: number; reasons: RepairabilityReasonCode[] }
  | { status: "already_transparent"; reasons: RepairabilityReasonCode[] }
  | { status: "no_visible_artwork"; reasons: RepairabilityReasonCode[] }
  | { status: "review_required"; reasons: RepairabilityReasonCode[] };

/**
 * Pure — reads the immutable source's pixels and returns a verdict. Never
 * touches the original, never calls a provider, never phrases anything for
 * a customer (mirrors `classifyRepairability`'s own "pure" discipline).
 */
export function prepareSignBackgroundRemoval(source: RgbaImage): SignBackgroundRemovalOutcome {
  const analysis = analyzeArtwork({
    image: source,
    format: "image/png",
    byteSize: source.data.length,
    declaresAlphaChannel: artworkHasTransparency(source),
    // Signs has its own resolution/enhancement policy — never apparel's
    // placement-driven pixel-sufficiency computation. See module doc.
    printPlacement: null,
    intendedPrintWidthIn: null,
  });
  const assessment = classifyRepairability(analysis);

  switch (assessment.backgroundTreatment) {
    case "already_transparent":
      return { status: "already_transparent", reasons: assessment.reasons };
    case "none":
      return { status: "no_visible_artwork", reasons: assessment.reasons };
    case "manual_review":
      return { status: "review_required", reasons: assessment.reasons };
    case "remove_exterior": {
      const result = isolateBackground(source, {
        backgroundColor: analysis.estimatedBackgroundColor,
        tolerance: analysis.backgroundTolerance,
      });
      return {
        status: "removed",
        image: result.image,
        exteriorPixelsRemoved: result.record.exteriorPixelsRemoved,
        reasons: assessment.reasons,
      };
    }
  }
}

/** Customer/operator-safe copy for a `SignBackgroundRemovalRecord.status` — never the technical reason codes. */
export function describeSignBackgroundRemovalStatus(status: SignBackgroundRemovalStatus): string {
  switch (status) {
    case "removed":
      return "The background has been removed.";
    case "already_transparent":
      return "This artwork already has a transparent background — nothing further to remove.";
    case "no_visible_artwork":
      return "We couldn't find visible artwork to isolate from the background.";
    case "review_required":
      return "We can't remove this background automatically. A designer needs to look at it first.";
  }
}
