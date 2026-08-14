/**
 * Sprint 2M Phase 1: provider-neutral Print Validation contracts.
 *
 * Print Validation answers a different question than Concept Evaluation:
 *
 *   Concept Evaluation — "Did we generate the design the customer requested?"
 *   Print Validation   — "Can this artwork be produced correctly for the
 *                          intended print application?"
 *
 * A concept can pass Concept Evaluation and fail Print Validation — that is
 * expected, not a bug (a generated concept is ~1024x1024px; a full-back
 * print commonly needs 3600x4200px at production resolution). These
 * contracts are pure data. `PrintValidationCapability` never mutates a
 * Design Brief, never calls a generation/vision provider, and never
 * transforms artwork — it only determines what is currently known and
 * whether it is enough.
 */

import type {
  ConceptEvaluation,
  ConceptEvaluationStatus,
  PrintPlacement,
  StoredRequestedProductionOutput,
} from "@/lib/domain/types";
import type { ProductionMethod } from "@/capabilities/shared/contracts";
import type { PlacementSizingPolicy } from "@/capabilities/shared/print-placement-dimensions";

// ---------------------------------------------------------------------------
// Production Requirements (Goal 2 / Goal 3 / Goal 8)
// ---------------------------------------------------------------------------

/**
 * Internal print-production category — WHAT PRODUCTION ARTIFACT IS BEING
 * ASKED FOR, never customer-facing terminology.
 *
 * Sprint A2 boundary, stated here because conflating the two is exactly the
 * defect this category previously had: a category answers "what production
 * artifact is iHeartPrints being asked to produce?", NOT "what might the
 * customer eventually do with the artwork?". A decoration method the
 * customer merely mentions ("this will be screen printed", "I might
 * embroider it") is DECORATION CONTEXT — it is recorded on `printMethod`
 * and must never move an ordinary garment design off `apparel_raster`.
 * See `requestedUnsupportedOutput`.
 */
export type ProductionCategory =
  /**
   * The one production profile V1 implements: the transparent raster
   * Production PNG for apparel decoration (DTF/DTG launch focus). This is
   * where every ordinary garment design belongs, whatever decoration method
   * the customer mentions in passing.
   */
  | "apparel_raster"
  /**
   * The customer explicitly asked iHeartPrints to PRODUCE an apparel
   * production artifact it does not make — screen-print colour separations,
   * a digitized embroidery/stitch file, or a vector production file. Named
   * for the vector/digitized source such artifacts require. Reaching this
   * category is an honest "we do not produce that", never a raster
   * fallback: nothing downstream may satisfy it with a Production PNG.
   */
  | "apparel_vector"
  /**
   * The request is for a product outside the iHeartPrints product scope
   * entirely (yard sign, banner, mug, sticker, vehicle graphic). Not an
   * unimplemented production profile — a different product category, which
   * per the Constitution needs an amendment rather than a pipeline.
   */
  | "out_of_scope_product"
  /**
   * Reserved, dormant. No classification produces this today — non-apparel
   * print products resolve to `out_of_scope_product`. Retained as an
   * architectural role, not an unfinished V1 requirement (AGENTS.md).
   */
  | "signage"
  /**
   * Reserved, dormant. See `signage` — retained for a future explicit
   * vector production profile, produced by nothing today.
   */
  | "logo_vector"
  | "unknown";

/**
 * Sprint A2: which unsupported PRODUCTION ARTIFACT the customer explicitly
 * asked iHeartPrints to produce, when they did. `null` — the overwhelmingly
 * common case — means they asked for no such thing, including when they
 * named a decoration method as downstream context.
 *
 * The distinction this type exists to hold:
 *
 *   "I need a screen printed T-shirt design."  → null (decoration context)
 *   "Make the screen-print color separations." → "screen_print_separations"
 *   "I want this embroidered on a hoodie."     → null (decoration context)
 *   "Digitize this for embroidery."            → "embroidery_digitization"
 *
 * Internal only. Never a customer-facing string — it selects which honest
 * plain-language explanation applies, it is not itself that explanation.
 */
export type UnsupportedProductionOutput =
  | "embroidery_digitization"
  | "screen_print_separations"
  | "vector_production_file"
  | "sublimation_production_prep"
  /**
   * Sprint A2 Correction 2 (Goal 12): the persisted request could not be
   * interpreted by this build — a newer deploy wrote a production profile
   * this app has never heard of. Treated as unsupported, deliberately: an
   * app that cannot read what the customer asked for must refuse to produce
   * rather than assume the answer is a PNG.
   */
  | "unrecognized_request";

/**
 * How confidently `printMethod` / `category` were determined. The Design
 * Brief does not currently collect an explicit production method (Constitution
 * §6.6 — that is an internal decision, never asked of ordinary customers), so
 * this is deterministic keyword inference over already-collected brief text,
 * never a fabricated certainty.
 */
export type ProductionMethodConfidence = "confirmed" | "inferred" | "unknown";

/** Target physical print dimensions, always normalized to inches internally. */
export interface PhysicalDimensions {
  widthIn: number;
  /** `null` when only a width constraint is meaningful (rare in Phase 1). */
  heightIn: number | null;
}

export interface PixelDimensions {
  widthPx: number;
  heightPx: number;
}

export type RequiredOutputType = "raster" | "vector" | "raster_and_vector";

export type ColorModeExpectation =
  | "not_applicable"
  | "rgb"
  | "limited_spot_colors";

/**
 * Provider-neutral, internal production-readiness requirements for one
 * concept/placement combination. Never exposed as-is to a customer — see
 * ARCHITECTURE.md / Constitution §6.6 (Hide Technical Complexity).
 */
export interface ProductionRequirements {
  category: ProductionCategory;
  /**
   * The decoration method the customer's own words point at — DECORATION
   * CONTEXT, not an output contract (Sprint A2). "This will be screen
   * printed" records `screen_print` here and still produces the raster
   * Production PNG; `category` is what decides the artifact. Kept because
   * knowing the intended decoration method is genuinely useful downstream
   * intelligence, not because it selects a pipeline.
   */
  printMethod: ProductionMethod;
  printMethodConfidence: ProductionMethodConfidence;
  /**
   * Sprint A2: the unsupported production artifact the customer explicitly
   * requested, or `null` when they requested none. Populated only alongside
   * `category: "apparel_vector"`. Exists so an honest refusal can name what
   * was actually asked for instead of collapsing every unsupported request
   * into one vague "needs review".
   */
  requestedUnsupportedOutput: UnsupportedProductionOutput | null;
  printLocation: PrintPlacement | null;
  /**
   * The placement's printable ENVELOPE (largest area artwork may occupy) —
   * `null` when physical size is not the primary requirement (e.g.
   * `logo_vector`). Print-Ready Normalization Phase 1: this is deliberately
   * NOT the shape of the production deliverable. The deliverable is sized by
   * `sizing` (target physical width, artwork-derived height); the envelope
   * only bounds it and gives placement-level sufficiency intelligence about a
   * not-yet-normalized concept.
   */
  targetDimensions: PhysicalDimensions | null;
  /**
   * Print-Ready Normalization Phase 1: the explicit production sizing
   * strategy for this placement (`width_constrained_preserve_aspect`), or
   * `null` when raster physical sizing does not apply. The single source of
   * "how big should the printed artwork be" — never re-derived inside a
   * worker or provider.
   */
  sizing: PlacementSizingPolicy | null;
  requiredOutputType: RequiredOutputType;
  /**
   * Minimum acceptable production resolution for this method, in pixels per
   * inch. Only meaningful when `targetDimensions` is set and raster output
   * applies. Never treated as PNG DPI metadata — see `effective-resolution.ts`.
   */
  targetPpi: number | null;
  /** Derived minimum raster pixel dimensions (`targetDimensions` × `targetPpi`), when computable. */
  minRasterDimensionsPx: PixelDimensions | null;
  transparencyRequired: boolean;
  colorMode: ColorModeExpectation;
  /** Internal file kinds acceptable for final production — never a customer-facing format picker. */
  allowedFileFormats: string[];
  /**
   * Safe-margin-from-edge guidance for placing the print on the GARMENT,
   * expressed as a percent of the print area. Print-Ready Normalization
   * Phase 1: this no longer drives the production transform — the
   * deliverable's own transparent breathing room is the small artwork-edge
   * safety margin in `final-artwork/alpha-trim.ts`, not a percentage of a
   * fixed canvas.
   */
  artworkBoundaryMarginPercent: number;
  requiredWordingVerificationRequired: boolean;
  /** Internal rationale trail — never customer-facing copy. */
  notes: string[];
}

// ---------------------------------------------------------------------------
// Print Validation Report (Goal 5)
// ---------------------------------------------------------------------------

export type PrintValidationStatus =
  | "ready"
  | "finalization_required"
  | "blocked";

export type PrintValidationCheckStatus =
  | "pass"
  | "warning"
  | "fail"
  | "unknown";

export type PrintValidationCheckSeverity = "info" | "warning" | "blocking";

export const PRINT_VALIDATION_CHECK_CODES = [
  "asset_exists",
  /**
   * Sprint A2: is this product inside the iHeartPrints product scope at all?
   * Blocking, and asked before any production arithmetic — a yard sign that
   * happens to satisfy every raster check is still not something this product
   * makes, and must never read as `"ready"`. Distinct from an unsupported
   * apparel production profile, which is an apparel job asking for an
   * artifact V1 does not produce (see `production_output_supported`).
   */
  "product_scope",
  /**
   * Sprint A2: was iHeartPrints asked to produce an artifact it does not
   * make (screen-print separations, embroidery digitization, a vector
   * production file)? Blocking, so the raster Production PNG can never be
   * presented as satisfying such a request. Merely NAMING a decoration
   * method never trips this — see `UnsupportedProductionOutput`.
   */
  "production_output_supported",
  "content_type",
  "raster_dimensions_known",
  "transparency",
  "effective_resolution",
  "minimum_raster_dimensions",
  "vector_source",
  "brief_provenance",
  "concept_evaluation_alignment",
  "required_wording_verification",
  "print_location_known",
  "production_method_known",
  /**
   * Sprint 2M Phase 2C: info-only diagnostic recording whether
   * `effective_resolution`/`minimum_raster_dimensions` were judged against
   * the asset's literal pixel dimensions ("native") or its true pre-upscale
   * source dimensions ("interpolated_upscale"/"unknown") — never itself
   * blocking, since its effect already flows through those two checks.
   */
  "resolution_provenance",
  // --- Print-Ready Normalization Phase 1 -----------------------------------
  // Production-asset-only checks: each is emitted solely when a
  // `productionNormalization` summary is present, so provisional
  // (concept-stage) validation is unchanged.
  /** The production transform actually recorded its own geometry — nothing about the plate is assumed. */
  "production_normalization",
  /** Meaningful alpha-bound artwork exists in the plate (never an empty or all-but-invisible deliverable). */
  "alpha_bound_artwork",
  /** The plate is not mostly transparent dead canvas — the exact defect the Print-Ready Production Output Audit found. */
  "transparent_dead_canvas",
  /** The plate's intended physical print width matches the placement policy, within tolerance. */
  "physical_width_policy",
  /** The artwork's aspect ratio survived trim + resize — never stretched, squashed, or letterboxed. */
  "aspect_ratio_preserved",
  /** Info-only: the PNG's embedded pHYs density agrees with the intended production PPI. Never authoritative. */
  "density_metadata",
  // --- Existing Artwork → Print Ready Phase 2 -----------------------------
  /**
   * Info-only: which APPLICABILITY PROFILE this run used. Emitted on every
   * run so a report is self-describing — "required wording was not checked"
   * must never be indistinguishable from "required wording passed".
   */
  "validation_profile",
  /**
   * `uploaded_preserve` only. The plate is provably derived from the exact
   * prepared artwork the customer approved — not the immutable original, not
   * another project's asset, not an unrecorded source.
   */
  "source_lineage",
  /**
   * `uploaded_preserve` only. The plate's own visible artwork still has the
   * proportions of the approved prepared artwork it was built from, so the
   * production pipeline neither cropped nor letterboxed the customer's design
   * on its way through reconstruction.
   */
  "preserved_source_geometry",
  /**
   * `uploaded_preserve` only. The plate was not stretched beyond the density
   * of the raster it was actually built from. Catches the honest failure mode
   * of a reconstruction that lands short of the production target: the file
   * has the required pixel count without the detail to match it.
   */
  "reconstruction_sufficiency",
] as const;

export type PrintValidationCheckCode =
  (typeof PRINT_VALIDATION_CHECK_CODES)[number];

export interface PrintValidationCheck {
  check: PrintValidationCheckCode;
  status: PrintValidationCheckStatus;
  severity: PrintValidationCheckSeverity;
  /** Internal rationale — never customer-facing copy (Goal 5, Goal 12). */
  reason: string;
}

/**
 * Provider-neutral description of a step the future Final Artwork /
 * Production Artwork capability would need to perform. Never executed here
 * — Print Validation determines the truth about what is required; it does
 * not transform, upscale, vectorize, or regenerate anything (Goal 9, Goal
 * 15, Goal 17).
 */
export const FINALIZATION_TRANSFORMATIONS = [
  "regenerate_at_production_dimensions",
  "upscale_raster_artwork",
  "remove_background",
  "create_vector_version",
  "verify_or_recreate_text",
  "convert_fonts_to_outlines",
  "resize_to_final_dimensions",
  "create_production_png",
  "create_vector_or_pdf_asset",
  "require_human_review",
] as const;

export type FinalizationTransformation =
  (typeof FINALIZATION_TRANSFORMATIONS)[number];

export interface PrintValidationReport {
  artworkVersionId: string;
  designBriefVersionId: string | null;
  /** Which applicability profile produced these checks — see `PrintValidationProfile`. */
  profile: PrintValidationProfile;
  status: PrintValidationStatus;
  requirements: ProductionRequirements;
  checks: PrintValidationCheck[];
  requiredTransformations: FinalizationTransformation[];
  /** Plain summaries of the checks that produced `status: "blocked"` or drove `finalization_required`. Internal only. */
  blockingIssues: string[];
  warnings: string[];
  evaluatedAt: string;
}

// ---------------------------------------------------------------------------
// Input (Goal 6 / Goal 11 / Goal 13)
// ---------------------------------------------------------------------------

/**
 * Sprint 2M Phase 2C — the "Upscaling Truthfulness" honesty mechanism.
 *
 * `widthPx`/`heightPx` describe the asset's actual, literal pixel
 * dimensions. Those are not, by themselves, trustworthy evidence of
 * production-quality detail: a 1024x1024 concept resized to 3600x3600 via
 * ordinary interpolation has 3600x3600 *pixels* without gaining any real
 * detail. `resolutionProvenance` records the difference so
 * `effective_resolution`/`minimum_raster_dimensions` checks can never be
 * fooled by pixel count alone (see `print-validation-capability.ts`'s use
 * of `nativeWidthPx`/`nativeHeightPx`):
 *
 *   - `"native"` — every pixel genuinely carries source detail (as-generated,
 *     or only ever downsized, never enlarged beyond native density). Checks
 *     may trust `widthPx`/`heightPx` directly.
 *   - `"interpolated_upscale"` — some or all of the asset's pixels were
 *     manufactured by resampling beyond the source's native density. Checks
 *     must evaluate sufficiency against `nativeWidthPx`/`nativeHeightPx`
 *     (the true pre-upscale source dimensions) instead, which — by
 *     definition of why an upscale was needed — will correctly fail to meet
 *     a target the native asset didn't already meet.
 *   - `"reconstructed"` (Sprint 2M Phase 2E) — pixels were produced by a
 *     genuine provider-hosted reconstruction (e.g. Topaz Transparency
 *     Upscale's super-resolution), never local geometric interpolation. This
 *     is real, provider-manufactured detail — checks trust `widthPx`/
 *     `heightPx` directly, exactly like `"native"`. It is still recorded as
 *     its own distinct value (never collapsed into `"native"`) so it is
 *     always possible to tell "the customer's original pixels" apart from
 *     "a provider's reconstruction of those pixels" in logs, diagnostics,
 *     and any future audit — see `nativeWidthPx`/`nativeHeightPx`, which
 *     continue to carry the true pre-reconstruction source dimensions even
 *     when `resolutionProvenance === "reconstructed"`.
 *   - `"unknown"` — provenance was not determined. Treated exactly like
 *     `"interpolated_upscale"` for validation purposes (never assumed safe).
 */
export type ResolutionProvenance =
  | "native"
  | "interpolated_upscale"
  | "reconstructed"
  | "unknown";

/**
 * Opaque, already-sanitized summary of the concept's primary generated
 * asset. Deliberately excludes `storageKey` and any other internal storage
 * detail — mirrors `ConceptEvaluationAssetReference` (Goal 13: no raw
 * storage keys, no provider metadata reaching this boundary).
 */
export interface PrintValidationAssetSummary {
  contentType: string | null;
  widthPx: number | null;
  heightPx: number | null;
  hasTransparency: boolean | null;
  /** Reserved: populated once a future Final Artwork capability produces a vector companion asset. Always `null` today. */
  vectorAssetId: string | null;
  /** See `ResolutionProvenance`'s doc. Provisional (concept-stage) validation always passes `"native"` — a generated concept is never itself a resize of anything. */
  resolutionProvenance: ResolutionProvenance;
  /**
   * The true, pre-transformation source pixel dimensions this asset's
   * detail is actually derived from. Only load-bearing when
   * `resolutionProvenance === "interpolated_upscale"` (or `"unknown"`);
   * ignored otherwise. `null` when not applicable/not known.
   */
  nativeWidthPx: number | null;
  nativeHeightPx: number | null;
}

/**
 * Print-Ready Normalization Phase 1: what the production transform actually
 * did, as plain data. Present only for authoritative production-asset
 * validation; `null` for provisional concept-stage validation (a concept has
 * not been normalized for production at all).
 *
 * Print Validation RECOMPUTES from these measurements rather than trusting
 * any readiness claim in them:
 *
 *   - effective resolution = `widthPx / intendedWidthIn` (real pixel
 *     geometry ÷ real intended inches), never `densityPixelsPerMetre`
 *   - dead-canvas detection = `artworkOccupancy`, so a plate whose artwork
 *     covers half its pixels can never read as production-ready
 *   - aspect preservation = trimmed vs. produced ratio, so a stretched or
 *     letterboxed plate is caught even if every other number looks right
 *
 * Deliberately mirrors `final-artwork`'s `ProductionNormalizationMetadata`
 * without importing it — Print Validation never depends on the Final Artwork
 * capability (ARCHITECTURE.md dependency direction); the worker maps one to
 * the other.
 */
export interface ProductionNormalizationSummary {
  /** The sizing strategy the plate was produced under. Only `"width_constrained_preserve_aspect"` exists today. */
  strategy: "width_constrained_preserve_aspect";
  /** Alpha bounding box of the artwork inside the trimmed plate, in pixels. */
  alphaBBoxWidthPx: number;
  alphaBBoxHeightPx: number;
  /** Dimensions after alpha trim + safety margin, before production resampling. */
  trimmedWidthPx: number;
  trimmedHeightPx: number;
  /** Alpha-bbox area ÷ trimmed area. `1` is a perfectly tight crop. */
  artworkOccupancy: number;
  /** Policy target physical print width, in inches. */
  targetWidthIn: number;
  /** Allowed deviation from `targetWidthIn`, in inches — explicit tolerance, never float equality. */
  widthToleranceIn: number;
  targetPpi: number;
  /** Intended physical print size of the plate's actual pixels, in inches. */
  intendedWidthIn: number;
  intendedHeightIn: number;
  /** `"max_height"` when a tall/narrow artwork was proportionally reduced to fit the placement's printable height. */
  constrainedBy: "width" | "max_height";
  /** Embedded PNG pHYs density, in pixels per metre. `null` when the file carries no density tag. Informational only. */
  densityPixelsPerMetre: number | null;
}

/**
 * Existing Artwork → Print Ready Phase 2: WHICH CHECKS APPLY to the artwork
 * being validated. Not a strictness dial and not a way to skip inconvenient
 * rules — an applicability profile, in the same sense a print shop applies
 * different pre-flight checks to a customer-supplied file than to one it
 * designed itself.
 *
 *   "generated_concept" (default) — artwork this platform generated from an
 *     approved Design Brief. The brief is the specification, so the brief IS
 *     checkable: was this concept generated from the currently approved brief
 *     version, did Concept Evaluation agree it matches, and was the
 *     customer's required wording verified as present and correct? Behavior
 *     is byte-for-byte what it was before this profile existed.
 *
 *   "uploaded_preserve" — artwork the CUSTOMER supplied and explicitly
 *     approved after background preparation. The uploaded pixels are the
 *     specification. Three checks are therefore not merely relaxed but
 *     genuinely INAPPLICABLE, and are not emitted at all:
 *
 *       brief_provenance             — no Design Brief version authorizes
 *                                      this artwork; the customer's own file
 *                                      and their approval of the prepared
 *                                      version do (see `ArtworkPreparation`).
 *       concept_evaluation_alignment — "does this match the brief we were
 *                                      given?" has no answer when there is no
 *                                      brief describing the artwork. Nothing
 *                                      generated it to compare against.
 *       required_wording_verification— the customer never typed the wording;
 *                                      it is already IN their pixels. Asking
 *                                      them to retype it so we can check our
 *                                      own transform against it would invent
 *                                      a requirement, and Phase 2 performs no
 *                                      OCR.
 *
 *     Everything a print shop would actually reject a file for still blocks,
 *     unchanged: decodability, transparency, physical width, effective
 *     resolution, minimum pixels, aspect preservation, alpha-bound content,
 *     dead canvas, and the plate's own recorded production geometry. Three
 *     preservation checks are ADDED (`source_lineage`,
 *     `preserved_source_geometry`, `reconstruction_sufficiency`), so this
 *     profile is not a weaker one — it is a different, and in places
 *     stricter, set.
 */
export type PrintValidationProfile = "generated_concept" | "uploaded_preserve";

/**
 * Existing Artwork → Print Ready Phase 2 (Goal 8): the deterministic
 * preservation evidence for one uploaded-artwork production plate. Present
 * only under the `uploaded_preserve` profile.
 *
 * HONESTY BOUNDARY, stated plainly because it would otherwise be tempting to
 * read more into these numbers than they carry: none of this proves the
 * artwork still LOOKS the same. A provider-hosted reconstruction is a genuine
 * enhancement transform, and visual fidelity after it remains
 * provider-dependent and unproven by arithmetic. What these fields DO prove is
 * that the pipeline used the artwork the customer approved (not the original
 * upload, not another project's asset), and that the geometry survived —
 * nothing was cropped away, stretched, letterboxed, or invented past the
 * density of the raster it was built from.
 */
export interface UploadedPreserveEvidence {
  /** The approved prepared `ArtworkVersion` this plate was produced from. Must equal the report's `artworkVersionId`. */
  preparedArtworkVersionId: string;
  /** The approved prepared (transparent PNG) asset whose pixels the transform actually consumed. */
  preparedAssetId: string;
  /** The customer's immutable original upload — recorded so lineage can prove it was NOT the enhancement source (Goal 6). */
  originalAssetId: string;
  /** SHA-256 of the exact prepared source bytes the transform read. Pixel-source lineage, not a fidelity claim. */
  sourceBytesSha256: string;
  /**
   * The approved prepared artwork's own alpha bounding box, measured with the
   * SAME threshold production normalization uses — so comparing it against
   * the plate's alpha bounding box is one measurement against another rather
   * than two different definitions of "visible".
   */
  sourceAlphaBBoxWidthPx: number;
  sourceAlphaBBoxHeightPx: number;
  /** Which enhancement path produced the plate. Internal only — the provider's name never appears here. */
  enhancement: "skipped" | "reconstructed";
}

/**
 * Everything `PrintValidationCapability.validateArtwork` needs, already
 * resolved by the caller. Print Validation itself never reads a repository
 * (Goal 16/17 — "PrintValidation should remain pure validation"), mirroring
 * `ConceptEvaluationCapability.evaluate`'s `ConceptEvaluationInput` pattern:
 * the caller (a future Final Artwork orchestrator, a route, or a test) does
 * the I/O; this capability only decides.
 */
export interface PrintValidationInput {
  artworkVersionId: string;
  /**
   * Which checks apply. Omitted/`undefined` means `"generated_concept"`, so
   * every existing caller keeps exactly the behavior it had.
   */
  validationProfile?: PrintValidationProfile;
  /**
   * Existing Artwork → Print Ready Phase 2: preservation evidence for an
   * uploaded-artwork plate. REQUIRED under the `uploaded_preserve` profile
   * (its absence is itself a blocking `source_lineage` failure — a plate
   * whose lineage nobody recorded is not one to certify); ignored otherwise.
   */
  uploadedPreserve?: UploadedPreserveEvidence | null;
  /** The approved Design Brief version this concept claims to have been generated against. `null` for uploaded artwork, which no brief version authorizes. */
  designBriefVersionId: string | null;
  /** The design's current/latest approved Design Brief version id, for provenance comparison (Goal 6, Goal 14 Scenario H). */
  currentApprovedDesignBriefVersionId: string | null;
  /** Print placement from the approved brief snapshot that authorized this concept, when resolvable. */
  printPlacement: PrintPlacement | null;
  /** Free-text product description from the approved brief snapshot — used only for deterministic product-scope and decoration-context inference (Goal 3). Never sent to a provider. */
  productSummary: string | null;
  designDescription: string | null;
  /**
   * Sprint A2 (corrected): the STRUCTURED requested-production-output
   * authority, resolved from `TShirtDesignBrief.requestedProductionOutput` by
   * the caller. Print Validation does not re-interpret prose to derive it —
   * that was the defect this replaced. Absent/`null` means the customer never
   * asked for a particular artifact, which is the supported Production PNG
   * path and every historical project's behavior.
   */
  requestedProductionOutput?: StoredRequestedProductionOutput | null;
  /** Concept Evaluation state already computed and persisted for this concept, if any (Goal 6, Goal 14 Scenario I). Read-only — never recomputed here. */
  conceptEvaluationStatus: ConceptEvaluationStatus | null;
  conceptEvaluation: ConceptEvaluation | null;
  /**
   * Live Acceptance Cleanup (Issue 5): the customer's chosen production
   * print width, in inches — authoritative production intent. `null`/absent
   * resolves to the placement default, exactly as before.
   */
  intendedPrintWidthIn?: number | null;
  /** `null` when no generated asset exists yet (Goal 14 Scenario G). */
  primaryAsset: PrintValidationAssetSummary | null;
  /**
   * Print-Ready Normalization Phase 1: present only when `primaryAsset` is a
   * NORMALIZED PRODUCTION plate (authoritative validation). `null`/absent for
   * provisional concept-stage validation, which then behaves exactly as it
   * did before this phase.
   */
  productionNormalization?: ProductionNormalizationSummary | null;
}
