/**
 * Signs Phase S4.1: deterministic preservation-verification evidence
 * shapes. Pure data — no I/O, no capability imports, mirroring the
 * `capability-boundaries.ts` discipline `print-validation/contracts.ts`
 * already follows for `RigidSignPlanEvidence`/`HalftoneProductionEvidence`.
 *
 * See `SignPreservationVerification`'s own doc comment
 * (`src/lib/domain/types.ts`) for the four-authority model this evidence is
 * exactly one part of, and `sign-preservation-deterministic-checks.ts` for
 * the functions that produce it.
 */

/** Explicit staleness lever — bump on any change to the deterministic-check algorithm below, forcing every prior verification to be re-run. */
export const SIGN_PRESERVATION_ALGORITHM_VERSION = "sign-preservation-deterministic:v1";

/**
 * One deterministic check's own verdict, deliberately distinct from the
 * OVERALL `SignPreservationStatus` — a single "concern" or even a
 * "catastrophic" sub-result does not by itself dictate the aggregate
 * (`aggregateDeterministicResult` below does that, conservatively).
 */
export type SignPreservationCheckResult = "pass" | "concern" | "catastrophic" | "unknown";

export interface SignPreservationLineageEvidence {
  result: SignPreservationCheckResult;
  sourceAssetExists: boolean;
  sourceShaMatchesPlan: boolean;
  sourceShaMatchesRehash: boolean;
  finalAssetBelongsToSignPreparation: boolean;
  finalAssetPlanKeyMatches: boolean;
  resolutionProvenanceIsReconstructed: boolean;
  executionEvidencePresentWhenAdapted: boolean;
  intermediateAssetExists: boolean;
  intermediateAssetTiedToSameJob: boolean;
  reasons: string[];
}

export interface SignPreservationContentRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SignPreservationRegionMappingEvidence {
  result: SignPreservationCheckResult;
  finalWidthPx: number;
  finalHeightPx: number;
  contentRegion: SignPreservationContentRegion | null;
  /** How the content region was derived — never a new persisted field, always re-derived from already-persisted evidence. */
  derivedFrom: "execution_geometry" | "plan_step" | "no_extension_step" | "unavailable";
  regionFitsWithinFinalCanvas: boolean;
  regionDimensionsMatchReconstruction: boolean;
  reasons: string[];
}

export interface SignPreservationRgbIntegrityEvidence {
  result: SignPreservationCheckResult;
  compared: boolean;
  reconstructionWidthPx: number | null;
  reconstructionHeightPx: number | null;
  contentRegionWidthPx: number | null;
  contentRegionHeightPx: number | null;
  /** Pixels whose R, G, or B channel differed between the reconstruction and the final content region. Any non-zero count is catastrophic — padding/normalization never resamples content. */
  mismatchedPixelCount: number;
  maxChannelDelta: number;
  reasons: string[];
}

export interface SignPreservationExtensionRegionEvidence {
  result: SignPreservationCheckResult;
  regionsChecked: number;
  totalExtensionPixels: number;
  /** Pixels in an extension region whose RGB did not exactly match the approved fill colour, or whose alpha was not exactly 255. */
  mismatchedPixelCount: number;
  approvedFillRgb: { r: number; g: number; b: number } | null;
  reasons: string[];
}

export interface SignPreservationSimilarityEvidence {
  result: SignPreservationCheckResult;
  /** `false` when the source/reconstruction dimensions are not an exact integer multiple — this evidence bucket is then simply unavailable, never guessed. */
  computed: boolean;
  scaleFactor: number | null;
  globalMeanAbsoluteError: number | null;
  worstTileMeanAbsoluteError: number | null;
  tileGridSize: number | null;
  reasons: string[];
}

/**
 * The full, versioned, bounded deterministic-evidence payload persisted on
 * `SignPreservationVerification.deterministicEvidence`. Deliberately no
 * per-pixel arrays anywhere in this shape — every field is a scalar,
 * boolean, small enum, or a short reasons list.
 */
export interface SignPreservationDeterministicEvidence {
  schemaVersion: typeof SIGN_PRESERVATION_ALGORITHM_VERSION;
  lineage: SignPreservationLineageEvidence;
  regionMapping: SignPreservationRegionMappingEvidence;
  reconstructionToFinalRgb: SignPreservationRgbIntegrityEvidence;
  extensionRegions: SignPreservationExtensionRegionEvidence;
  sourceSimilarity: SignPreservationSimilarityEvidence;
  /** `true` only when a deterministic check independently proved a structural impossibility — never set from ordinary similarity alone. */
  catastrophicAnomalyDetected: boolean;
  concerns: string[];
}

// ---------------------------------------------------------------------
// Signs Phase S4.2A: semantic (multimodal) preservation-verification
// evidence — see `sign-preservation-capability.ts`'s `verifyPreservation`
// for the orchestration that produces this, and its own doc comment for
// the exact authority boundary (deterministic structural authority AND a
// well-formed semantic "preserved" verdict, never either alone).
// ---------------------------------------------------------------------

/**
 * The seven fixed, closed comparison categories every semantic
 * verification answers — never data-dependent, never customer-specific
 * (Ruth is an acceptance example, never a template baked into these
 * categories or any downstream code).
 */
export const SIGN_PRESERVATION_SEMANTIC_CATEGORIES = [
  "wording",
  "numerals_prices",
  "people_faces",
  "logos_marks",
  "meaningful_objects",
  "added_removed_invented",
  "meaningful_crop_loss",
] as const;

export type SignPreservationSemanticCategory =
  (typeof SIGN_PRESERVATION_SEMANTIC_CATEGORIES)[number];

/**
 * Deliberately closed — never a free-form "looks good". `not_applicable`
 * exists so a category the artwork genuinely does not contain (no faces,
 * no logo) can be said absent rather than forced into a hallucinated
 * `same`.
 */
export type SignPreservationSemanticAnswerValue =
  | "same"
  | "changed"
  | "cannot_determine"
  | "not_applicable";

export interface SignPreservationSemanticAnswer {
  category: SignPreservationSemanticCategory;
  answer: SignPreservationSemanticAnswerValue;
  /** Bounded prose evidence only — never itself an authorization channel. */
  reason: string;
  /** Bounded free-text region reference (e.g. "grid cell 2,1"), optional. */
  regionReference: string | null;
}

export type SignPreservationSemanticVerdict = "preserved" | "changed" | "unknown";

/**
 * The bounded, audit-sufficient record of one completed semantic
 * verification pass — persisted on
 * `SignPreservationVerification.semanticEvidence`. Deliberately excludes
 * the actual image payloads sent to the provider (data URIs, signed URLs)
 * — evidence of WHAT WAS ASKED AND ANSWERED, never a re-hostable copy of
 * the images themselves.
 */
export interface SignPreservationSemanticEvidence {
  providerKey: string;
  /** The exact model identity component this verification used — part of the combined verification identity, never trusted alone to prevent stale reuse (see `buildCombinedVerificationAlgorithmVersion`). */
  modelIdentity: string;
  promptVersion: string;
  schemaVersion: string;
  imageDerivationVersion: string;
  idempotencyKey: string;
  providerRequestId: string | null;
  answers: SignPreservationSemanticAnswer[];
  verdict: SignPreservationSemanticVerdict;
  /** Bounded, already-parsed summary only — never the full raw provider payload. */
  rawResponseSummary: Record<string, unknown> | null;
  requestedAt: string;
  respondedAt: string;
  tokenUsage: { inputTokens: number | null; outputTokens: number | null } | null;
}

/** Explicit staleness levers for the semantic layer — each bumped only when its own behavior-affecting component changes. */
export const SIGN_PRESERVATION_PROMPT_VERSION = "sign-preservation-prompt:v1";
export const SIGN_PRESERVATION_SEMANTIC_SCHEMA_VERSION = "sign-preservation-schema:v1";
/**
 * Bumped to v2 at Signs Phase S4.2B.2: reconstruction detail crops are no
 * longer sent at native upstream-reconstruction resolution (which could be
 * 4x+ the source and produced a ~52 MB single request — Signs Phase
 * S4.2B.1's transport diagnostic) — they are now capped at
 * `SIGN_PRESERVATION_DETAIL_CROP_LINEAR_SCALE`x the source crop's own
 * dimensions. This changes the bytes sent to the semantic provider, so any
 * verification evidence recorded under v1 must never be reused as-is under
 * v2 — the combined identity below encodes this directly.
 */
export const SIGN_PRESERVATION_IMAGE_DERIVATION_VERSION = "sign-preservation-image-derivation:v2";
/** 2 columns x 3 rows = 6 grid cells over the source's own frame, deterministic and data-independent. */
export const SIGN_PRESERVATION_GRID_COLUMNS = 2;
export const SIGN_PRESERVATION_GRID_ROWS = 3;
/**
 * Signs Phase S4.2B.2: how much larger a reconstruction detail crop is
 * kept than its corresponding source crop's own dimensions — fixed at 2x
 * regardless of the upstream reconstruction provider's own native scale
 * (which may be 4x or more). Retains genuine 2x linear extra detail over
 * the immutable customer source (enough to distinguish small wording,
 * numerals, and prices), while capping payload size. Never upscaled beyond
 * the reconstruction's own native resolution — see
 * `deriveSemanticComparisonImages`'s `Math.min` use of this constant; this
 * module fabricates no new detail, exactly like `raster-transform.ts`'s
 * own "Upscaling Truthfulness" discipline.
 */
export const SIGN_PRESERVATION_DETAIL_CROP_LINEAR_SCALE = 2;
/** source overview + reconstruction overview + 6 source crops + 6 reconstruction crops. */
export const SIGN_PRESERVATION_MAX_IMAGE_COUNT = 14;

/**
 * The combined, behavior-versioned verification identity S4.2A persists
 * under — deliberately NOT `SIGN_PRESERVATION_ALGORITHM_VERSION` alone
 * (that constant remains reserved for `verifyDeterministicPreservation`'s
 * own deterministic-only S4.1 identity, unchanged). Encodes every
 * behavior-affecting component directly IN THE STRING, so a provider/model/
 * prompt/schema/grid change can never silently reuse incompatible old
 * evidence — the DB's `unique(final_asset_id, verification_algorithm_version)`
 * constraint does the rest. Never relies on `semantic_evidence`'s own
 * recorded provider/model fields to prevent stale reuse — those are audit
 * data, not identity.
 */
export function buildCombinedVerificationAlgorithmVersion(
  semanticProviderKey: string,
  semanticModelIdentity: string,
): string {
  return [
    "sign-preservation:v1",
    `det=${SIGN_PRESERVATION_ALGORITHM_VERSION}`,
    `sem=${semanticProviderKey}:${semanticModelIdentity}`,
    `prompt=${SIGN_PRESERVATION_PROMPT_VERSION}`,
    `schema=${SIGN_PRESERVATION_SEMANTIC_SCHEMA_VERSION}`,
    `grid=${SIGN_PRESERVATION_IMAGE_DERIVATION_VERSION}`,
  ].join("|");
}

/**
 * Structural validation of a provider's returned answers — exactly one
 * answer per required category, every `answer` a recognized enum value.
 * A response failing this is NOT a completed semantic verdict (Signs
 * Phase S4.2A §9B) — the caller must treat it exactly like a transport
 * failure: no record persisted, a later invocation may retry.
 */
export function validateSemanticAnswers(
  answers: SignPreservationSemanticAnswer[] | null | undefined,
): answers is SignPreservationSemanticAnswer[] {
  if (!Array.isArray(answers) || answers.length !== SIGN_PRESERVATION_SEMANTIC_CATEGORIES.length) {
    return false;
  }
  const seen = new Set<string>();
  const validAnswers: SignPreservationSemanticAnswerValue[] = [
    "same",
    "changed",
    "cannot_determine",
    "not_applicable",
  ];
  for (const item of answers) {
    if (!item || typeof item !== "object") return false;
    if (!SIGN_PRESERVATION_SEMANTIC_CATEGORIES.includes(item.category)) return false;
    if (seen.has(item.category)) return false; // no duplicate category
    seen.add(item.category);
    if (!validAnswers.includes(item.answer)) return false;
    if (typeof item.reason !== "string") return false;
  }
  return seen.size === SIGN_PRESERVATION_SEMANTIC_CATEGORIES.length;
}

/**
 * Signs Phase S4.2A §5's exact closed-question composition rule. Only ever
 * called on an already-`validateSemanticAnswers`-passed array — a
 * structurally invalid response never reaches here (see §9B).
 */
export function deriveSemanticVerdict(
  answers: SignPreservationSemanticAnswer[],
): SignPreservationSemanticVerdict {
  if (answers.some((a) => a.answer === "changed")) return "changed";
  if (answers.some((a) => a.answer === "cannot_determine")) return "unknown";
  const hasAtLeastOneSame = answers.some((a) => a.answer === "same");
  const everyAnswerSameOrNotApplicable = answers.every(
    (a) => a.answer === "same" || a.answer === "not_applicable",
  );
  if (everyAnswerSameOrNotApplicable && hasAtLeastOneSame) return "preserved";
  // Every category not_applicable — a contract violation for artwork that
  // plainly has SOME content; fail closed rather than certify an empty sign.
  return "unknown";
}
