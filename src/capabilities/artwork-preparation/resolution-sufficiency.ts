/**
 * Resolution Sufficiency / Reconstruction Scale Eligibility Phase (advisory).
 *
 * Before iHeartPrints removes a background, spends money on a provider, or
 * eventually performs true reconstruction, it needs an honest answer to a
 * DIFFERENT question than `repairability.ts` already answers:
 *
 *   REPAIRABILITY            — "what preparation operation does this
 *                                artwork need?"
 *   RESOLUTION SUFFICIENCY   — "does the source have enough native pixels
 *                                for the size the customer actually wants,
 *                                and if not, is the required enlargement
 *                                within the governed provider scale
 *                                ceiling?"
 *
 * This module answers ONLY that question. It is deliberately named to make
 * a narrower claim than "recoverable": it measures resolution/coverage
 * arithmetic against a governed reconstruction-provider scale ceiling, not
 * whether the source contains trustworthy visual evidence to reconstruct
 * FAITHFULLY. Those are different facts. A source can be
 * `reconstruction_scale_eligible` — its required enlargement fits within
 * the ceiling a real provider will accept — while the actual reconstructed
 * result is visually poor, because eligibility says nothing about source
 * cleanliness, compression damage, ambiguous marks, or content complexity.
 * `reconstruction_scale_eligible` is a claim about SCALE, not about
 * FIDELITY.
 *
 * These stay deliberately separate authorities (never merged into one
 * bigger classifier, never a `RepairabilityClassification` value): a
 * background can be perfectly, deterministically removable while the
 * artwork underneath is nowhere near big enough for the requested print,
 * and an artwork can be exactly enough real pixels while its background is
 * too complex to touch automatically. Conflating them would make it
 * impossible to say which fact drove which decision — the same reason
 * `artwork-preparation`'s three background-mask passes stay three modules
 * (see ARCHITECTURE.md §13h).
 *
 * LOW RESOLUTION IS NOT THE SAME THING AS BAD ARTWORK — and, just as
 * important, FITTING WITHIN THE SCALE CEILING IS NOT THE SAME THING AS
 * RECONSTRUCTING CLEANLY. A small, clean logo can be well within the
 * ceiling and reconstruct beautifully; a larger but degraded/ambiguous
 * source can be within the identical ceiling and still reconstruct poorly.
 * This module's ONLY current evidence is resolution/coverage arithmetic —
 * it does not yet detect compression artifacts, ambiguous marks, or
 * illegible small text (see "Explicitly out of scope" below), and it does
 * not distinguish artwork types — so it is deliberately named and
 * documented as evaluating what it can actually defend (scale eligibility),
 * not as a general "artwork quality" or "will reconstruct cleanly" verdict.
 * TRUE source recoverability — a real answer to "does this source contain
 * trustworthy visual evidence to reconstruct faithfully?" — remains
 * unbuilt. It would require additional evidence this module does not have
 * today: artwork-type distinction (hard-edge/logo vs. continuous-tone/
 * photo), calibrated absolute-detail evidence (not just a coverage ratio),
 * and eventually a reconstruction-fidelity authority that judges an actual
 * reconstruction attempt's output. A future phase with real evidence for
 * those signals would be a genuinely new authority, not an extension of
 * this one's name.
 *
 * ADVISORY, NOT AUTHORITATIVE (this phase). Nothing in this codebase calls
 * `classifyResolutionSufficiency` from a live request path yet. It exists,
 * fully tested, as the seam a future phase (routing reconstruction BEFORE
 * background removal, or a customer-facing message) can read from — see
 * this module's own "Future authority" note below. It does not gate
 * `canPrepareAutomatically`, does not change `RepairabilityAssessment`,
 * and does not touch the False Print-Ready Guard
 * (`reconstruction_certification_evidence`, `print-validation-capability.ts`),
 * which remains the sole, unweakened authority over automatic Print Ready
 * for reconstructed continuous-tone uploads.
 *
 * Pure — reads an already-computed `ArtworkAnalysis` (see `image-analysis.ts`)
 * and returns a classification. No pixels touched, no provider called, no
 * network, no I/O. Zero provider calls, structurally: this module does not
 * import anything that could make one.
 */

import type { ArtworkAnalysis } from "./contracts";

export type ResolutionSufficiencyClassification =
  | "resolution_adequate"
  | "reconstruction_scale_eligible"
  | "resolution_insufficient";

/** Stable machine reasons. Never customer-facing strings — see `preparation-copy.ts`'s own discipline. */
export type ResolutionSufficiencyReasonCode =
  | "no_visible_artwork"
  | "native_resolution_sufficient"
  | "within_governed_reconstruction_ceiling"
  | "exceeds_governed_reconstruction_ceiling";

/**
 * The ONE ceiling this module's rules are anchored to: the same hard
 * scale-factor limit `TopazTransparencyUpscaleProvider` enforces before any
 * request is dispatched
 * (`final-artwork/topaz-transparency-upscale-provider.ts`'s
 * `PROVIDER_MAX_RECONSTRUCTION_SCALE`). Defined locally, never imported,
 * because `ArtworkPreparationCapability` has no provider dependency at all
 * — the SAME "depends on no provider port, not even an unconfigured one"
 * rule `capability-boundaries.ts` states for this capability (ARCHITECTURE.md
 * §13h) — mirroring the identical precedent `sign-preparation/resolution-
 * policy.ts`'s `SIGN_RECONSTRUCTION_SCALE_CEILING` already set for the same
 * reason. `resolution-sufficiency.test.ts` cross-checks this value against
 * the real provider constant directly (test-only import, exempt from the
 * capability's own runtime dependency rule), so the two can never silently
 * drift apart.
 *
 * This is a genuine, already-governed architectural fact — a source needing
 * MORE than this scale factor cannot be enlarged by ANY currently
 * authorized mechanism, at any coverage percentage, regardless of how
 * clean the source otherwise looks. It is not a quality score and not
 * arbitrary: it is the exact boundary the real provider already refuses
 * at, before this module existed. It says nothing about whether a
 * reconstruction WITHIN that boundary will look good.
 */
export const RECONSTRUCTION_SCALE_CEILING = 4;

export interface ResolutionSufficiencyEvidence {
  /** The VISIBLE artwork's width, in real source pixels (alpha bbox) — never canvas width. Same measurement `PixelSufficiency`/`EnhancementDecision` already use. */
  visibleWidthPx: number;
  /** `targetWidthIn * targetPpi`, rounded, for the production context this was evaluated against. */
  requiredWidthPx: number;
  /** `visibleWidthPx / requiredWidthPx` — the EXACT same field/formula as `PixelSufficiency.coverageRatio`, never a second computation of it. */
  coverageRatio: number;
  /** `1` when `coverageRatio >= 1` (no enlargement needed); otherwise `1 / coverageRatio` — how much governed provider enlargement this source would require. */
  enlargementFactor: number;
  /** `RECONSTRUCTION_SCALE_CEILING`, carried on the evidence so a caller never has to re-import the constant to explain a verdict. */
  reconstructionCeiling: number;
}

export interface ResolutionSufficiencyAssessment {
  classification: ResolutionSufficiencyClassification;
  /** In evaluation order; only the reasons that actually applied. */
  reasons: ResolutionSufficiencyReasonCode[];
  evidence: ResolutionSufficiencyEvidence;
}

/**
 * `null` when no print-size context exists yet (`analysis.pixelSufficiency
 * === null` — no placement chosen). This classification is inherently a
 * claim about "enough native pixels, or an eligible enlargement path, for
 * the size the customer actually wants"; before that size exists there is
 * no honest classification to make (the same discipline
 * `measurePixelSufficiency` itself already applies — this function never
 * guesses a default size on the caller's behalf). Recompute this the same
 * way callers already recompute `RepairabilityAssessment` from `analysis`
 * on demand — never persist a separate, potentially-stale copy (see this
 * module's doc header and ARCHITECTURE.md's own note on why
 * `RepairabilityAssessment` itself is never persisted as its own blob).
 *
 * ## Exact rules (every branch, no hidden scoring)
 *
 *   1. No visible artwork at all (`analysis.artworkBounds === null`)
 *      → `resolution_insufficient`, reason `no_visible_artwork`. There is
 *      no visible content to measure — mirrors `classifyRepairability`'s
 *      own `NOT_REPAIRABLE` trigger, the one case both authorities agree
 *      is terminal for the identical reason.
 *   2. `coverageRatio >= 1` (native visible resolution already meets or
 *      exceeds the target) → `resolution_adequate`, reason
 *      `native_resolution_sufficient`. This says nothing about whether
 *      background preparation is complete — that remains
 *      `RepairabilityAssessment`'s own, separate answer.
 *   3. Otherwise, `enlargementFactor <= RECONSTRUCTION_SCALE_CEILING`
 *      → `reconstruction_scale_eligible`, reason
 *      `within_governed_reconstruction_ceiling`. This does NOT mean a
 *      future reconstruction attempt will reconstruct cleanly, and it does
 *      NOT mean it will automatically certify as Print Ready — the False
 *      Print-Ready Guard (`reconstruction_certification_evidence`) still
 *      withholds that without fidelity evidence, unchanged by this module.
 *      It means only that the required enlargement is within the scale a
 *      real provider will accept.
 *   4. Otherwise (`enlargementFactor > RECONSTRUCTION_SCALE_CEILING`)
 *      → `resolution_insufficient`, reason
 *      `exceeds_governed_reconstruction_ceiling`. No currently authorized
 *      mechanism can reach the requested size from this source at all,
 *      regardless of how clean it looks.
 *
 * Deliberately independent of `hasTransparency`, `backgroundIsEdgeConnected`,
 * `backgroundTreatment`, and every other background-related field on
 * `ArtworkAnalysis` — background presence/absence is a REPAIRABILITY fact,
 * never a resolution-sufficiency one. A photo-like continuous-tone upload
 * and a hard-edge logo are classified by the identical resolution
 * arithmetic; this module makes no hard-edge-vs-photo assumption anywhere
 * (see "Explicitly out of scope" below for why that distinction is not
 * attempted yet).
 */
export function classifyResolutionSufficiency(
  analysis: ArtworkAnalysis,
): ResolutionSufficiencyAssessment | null {
  if (!analysis.pixelSufficiency) return null;

  const { availableWidthPx, requiredWidthPx, coverageRatio } = analysis.pixelSufficiency;

  if (!analysis.artworkBounds) {
    return {
      classification: "resolution_insufficient",
      reasons: ["no_visible_artwork"],
      evidence: {
        visibleWidthPx: availableWidthPx,
        requiredWidthPx,
        coverageRatio,
        enlargementFactor: coverageRatio > 0 ? Math.max(1, 1 / coverageRatio) : Number.POSITIVE_INFINITY,
        reconstructionCeiling: RECONSTRUCTION_SCALE_CEILING,
      },
    };
  }

  const enlargementFactor = coverageRatio >= 1 ? 1 : 1 / coverageRatio;
  const evidence: ResolutionSufficiencyEvidence = {
    visibleWidthPx: availableWidthPx,
    requiredWidthPx,
    coverageRatio,
    enlargementFactor,
    reconstructionCeiling: RECONSTRUCTION_SCALE_CEILING,
  };

  if (coverageRatio >= 1) {
    return {
      classification: "resolution_adequate",
      reasons: ["native_resolution_sufficient"],
      evidence,
    };
  }

  if (enlargementFactor <= RECONSTRUCTION_SCALE_CEILING) {
    return {
      classification: "reconstruction_scale_eligible",
      reasons: ["within_governed_reconstruction_ceiling"],
      evidence,
    };
  }

  return {
    classification: "resolution_insufficient",
    reasons: ["exceeds_governed_reconstruction_ceiling"],
    evidence,
  };
}

/**
 * Explicitly out of scope for this phase (documented limitation, not a
 * silent gap):
 *
 *   - JPEG-style compression-artifact detection. A PNG upload whose pixel
 *     content was previously JPEG-compressed (re-saved as PNG before
 *     upload — the only way a JPEG-shaped artifact reaches this pipeline
 *     at all, since raw JPEG bytes are rejected at the format-sniffing
 *     stage per ARCHITECTURE.md §13h) is currently classified on
 *     resolution evidence alone. This can be optimistic for pixel-level
 *     fidelity: a screenshot with visible blockiness that technically has
 *     enough pixels for the target size registers as `resolution_adequate`
 *     today. Reliable, deterministic block-artifact detection was not
 *     built this phase — inventing an unproven heuristic here would be
 *     exactly the "sounds sophisticated" measurement this phase's own
 *     brief warned against.
 *   - Any hard-edge/logo-like vs. continuous-tone/photo-like coarse
 *     classification. No existing deterministic evidence in this codebase
 *     reliably supports that distinction yet (the closest existing
 *     signals — `edge.maxChannelStandardDeviation`/`dominantColorCoverage`
 *     — measure the BORDER's own uniformity for background-removal safety,
 *     not the INTERIOR content's tonal character). This module's rules are
 *     therefore deliberately content-type-agnostic rather than guessing.
 *   - Tiny/illegible text detection, OCR, or any judgment about what a
 *     mark or letterform actually says. This phase does not attempt to
 *     read the artwork, only to measure it.
 *   - Any absolute (non-ratio) minimum source pixel floor. No existing,
 *     calibrated number in this codebase defends one (`upload-limits.ts`'s
 *     `MIN_IMAGE_DIMENSION_PX = 16` is a corruption/degenerate-upload
 *     floor, not a resolution-sufficiency one) — and evaluated against a
 *     REAL requested print size, the ratio-based ceiling above already
 *     correctly reaches `resolution_insufficient` for a genuinely tiny
 *     source (a 150px logo requested at 10.5in/300PPI needs ~21x
 *     enlargement, far past the 4x ceiling) without inventing a second,
 *     undefended number.
 *   - **True source recoverability.** This module never claims to know
 *     whether the artwork WILL reconstruct cleanly — only whether the
 *     required enlargement is within the governed provider scale ceiling.
 *     Answering the recoverability question for real would need
 *     artwork-type distinction, calibrated absolute-detail evidence, and
 *     an eventual reconstruction-fidelity authority that judges actual
 *     reconstruction output — none of which exist in this codebase today.
 *     `reconstruction_scale_eligible` is deliberately named to avoid
 *     implying that unbuilt authority exists.
 *
 * Future authority this phase's contract is designed to support, not yet
 * wired: a later phase could read `classification ===
 * "reconstruction_scale_eligible"` as the missing evidence needed to route
 * reconstruction BEFORE background removal (rather than after, as today)
 * for exactly the sources this phase can already tell apart from
 * `"resolution_insufficient"` ones — see ARCHITECTURE.md's own note on
 * this contract for the full reasoning.
 */
