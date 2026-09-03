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
import type { ProductionTreatment } from "@/capabilities/shared/production-treatment";

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
   * architectural role only. NOT the admitted rigid-sign profile: its old
   * placeholder arm (36×72in guess, `targetPpi: null`, vector/spot-color
   * assumptions) is explicitly not rigid-sign policy (Constitution §16A,
   * Phase S0 audit) and must never be adopted for it.
   */
  | "signage"
  /**
   * Signs Phase S1: the constitutionally ADMITTED rigid-sign profile
   * (Constitution §16A / §16B) — an opaque, exact-size production PNG at
   * human-confirmed ordered width AND height. Deliberately distinct from
   * the dormant `signage` placeholder above.
   *
   * Brief-text classification NEVER produces this value: a sign order
   * enters through a structured, human-confirmed `SignProductionSpec`
   * (`capabilities/sign-preparation`), never through prose keywords — the
   * Sprint A2 lesson. Requirements for it are built by
   * `deriveRigidSignProductionRequirements`, never by
   * `deriveProductionRequirements`'s brief-derived path. As of S1 nothing
   * produces or validates a sign deliverable; inspection/diagnosis/planning
   * only.
   */
  | "rigid_sign_raster"
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
  // --- Print'em All Phase 2: DTF halftone treatment ------------------------
  // Emitted ONLY for a plate whose durable production treatment is
  // `halftone_dtf`, and replacing `reconstruction_sufficiency` rather than
  // joining it. That swap is the whole design: a halftone plate is a
  // different production representation, so asking it a continuous-tone
  // question ("were these pixels enlarged past their source detail?") would
  // fail every correct halftone ever made, and answering that question
  // leniently to let them through would corrupt the standard path's meaning.
  // Different representation, different — and in places stricter — proof.
  /**
   * The treatment's settings and engine identity were actually recorded, so
   * this plate can be reproduced and explained. Blocking: a screened plate
   * whose screen nobody wrote down is not one to certify.
   */
  "halftone_treatment",
  /**
   * The dot lattice was generated ACROSS THE DELIVERED PLATE'S OWN pixel
   * dimensions. Blocking, and the check the whole representation rests on —
   * a screen generated small and enlarged afterwards prints at a line
   * frequency the file no longer states correctly.
   */
  "halftone_final_size_generation",
  /**
   * The screen's physical geometry is right: cell pitch really is
   * `targetPpi / LPI`, the achieved frequency matches the requested one
   * within raster rounding, the LPI is inside the supported band, and the
   * smallest dot the screen can emit is above the minimum printable size.
   */
  "halftone_screen_geometry",
  /**
   * The prepared source carries at least the TONAL information the chosen
   * screen frequency consumes. A halftone's honest requirement, and a far
   * lower bar than continuous tone's — but a real one, and the reason this
   * treatment is not a way to print anything at any size.
   */
  "halftone_tonal_sufficiency",
  // --- DTF Feature Integrity Phase 1 ---------------------------------------
  // Emitted only when a `dtfFeatureIntegrity` measurement is present on the
  // input — a standard-raster (never halftone_dtf) production plate whose
  // final production geometry was actually measured. Supplements every check
  // above rather than replacing any of them: a file can pass every existing
  // check (valid PNG, correct physical size, 300 PPI, correct lineage) and
  // still contain features too physically small or fragile for reliable DTF
  // production — that is exactly the gap this phase closes. See
  // ARCHITECTURE.md's "DTF Feature Integrity" section and
  // `shared/dtf-feature-integrity-profile.ts` for the (explicitly
  // provisional) thresholds these checks classify against.
  /** Positive ink strokes/marks too physically thin, per the provisional DTF profile. */
  "dtf_positive_feature_integrity",
  /** Negative spaces (letter counters, gaps between shapes) too physically narrow. */
  "dtf_negative_space_integrity",
  /** Small/isolated printable components at risk of being lost during DTF powder/cure/peel. Never blindly flags every tiny fragment — distressed artwork intentionally contains them. */
  "dtf_isolated_feature_integrity",
  /** Diagnostic-only (never blocking — see the profile module): faint/partial-alpha fine features whose printed behavior this framework cannot observe. */
  "dtf_partial_alpha_feature_integrity",
  // --- Signs Phase S2: rigid_sign_raster profile ---------------------------
  // Emitted only under `validationProfile: "rigid_sign_raster"`. "Substrate
  // defines canvas" (Constitution §16A) — the opposite of every apparel
  // alpha-trim assumption above, which is why this profile does not reuse
  // `alpha_bound_artwork`/`transparent_dead_canvas`/`physical_width_policy`:
  // those ask "did the artwork's own bounds survive trim", and a sign has no
  // alpha trim to survive. See `validateRigidSign` in
  // `print-validation-capability.ts`.
  /** Both ordered axes (width AND height — never width-only apparel semantics) reconcile with the produced plate's own pixel geometry, within tolerance. */
  "exact_physical_dimensions",
  /** The plate is fully opaque. Rigid-sign production intent is opaque by construction (§16A.2); any alpha < 255 blocks, and nothing here invents a flattening colour. */
  "no_unintended_transparency",
  /** Every original source pixel remains inside the plate's bounds, and every added (extended/padded) region lies outside the original content region. */
  "content_within_bounds",
  /**
   * Signs Perimeter Safety Phase: defense-in-depth against a genuine real
   * false positive (project cc6cfc4b-...) — a plate that passed every check
   * above (dimensions correct, opaque, every source pixel preserved, no
   * crop) but whose geometry-extension repair pushed edge-relative artwork
   * (a border, frame, rounded-corner treatment, mounting-hole indicator)
   * away from the finished substrate edge it depends on. Blocking whenever
   * the plate's own edge evidence shows edge-dependent structure on an
   * extended edge AND no semantic verification affirmatively confirms that
   * relationship survived — independent of, and never inferable from,
   * `content_within_bounds`, `executed_plan_matches_recorded_plan`, or any
   * other check here. See `validateRigidSign`'s own reasoning.
   */
  "substrate_boundary_semantics",
  /**
   * Signs Phase 3B (Fit to Production, Section J — "the most important
   * requirement"): blocking whenever any edge's measured PROTECTED-content
   * clearance from the physical CUT edge is short of the SAFE inset, or
   * could not be affirmatively measured at all (`"unknown"` fails closed,
   * exactly like every other unproven-safety case in this profile). A
   * BLEED field genuinely reaching the cut edge is never itself a failure
   * — only non-bleed (protected or ambiguous) content found too close is.
   */
  "protected_content_safe_inset",
  /** A repair plan was actually persisted and recorded for this preparation — the plan the executed job claims to have replayed. */
  "repair_plan_recorded",
  /** The plan actually executed is provably the plan that was recorded: its canonical key recomputes identically and only S2-admitted, content-preserving steps were replayed. Also where the print-ready risk boundary is enforced — see this check's own reason text on a `review_required`/`blocked` plan. */
  "executed_plan_matches_recorded_plan",
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
  /**
   * Print'em All Phase 2: which production representation was judged. Always
   * present, so a stored report is self-describing about the fact that most
   * changes which checks ran — never leaving "reconstruction sufficiency was
   * inapplicable" and "reconstruction sufficiency was skipped" ambiguous.
   */
  productionTreatment: ProductionTreatment;
  status: PrintValidationStatus;
  requirements: ProductionRequirements;
  checks: PrintValidationCheck[];
  requiredTransformations: FinalizationTransformation[];
  /** Plain summaries of the checks that produced `status: "blocked"` or drove `finalization_required`. Internal only. */
  blockingIssues: string[];
  warnings: string[];
  evaluatedAt: string;
  /**
   * Operator Production Correction UX: the STRUCTURED, per-edge Fit to
   * Production evidence the `protected_content_safe_inset` check was
   * computed from — `checks[]` only ever carries that check's formatted
   * summary string, which is enough to state pass/fail but not enough for
   * an operator UI to draw a per-edge highlight. Present only under the
   * `rigid_sign_raster` profile (mirroring `RigidSignPlanEvidence.fitToProduction`'s
   * own scope); `null` otherwise, or when no analysis was ever recorded for
   * this plate. A reader (`sign-plan-operator-review.ts`) reads this back
   * exactly like it reads `checks[]` — never re-measures.
   */
  fitToProductionEvidence: RigidSignFitToProductionEvidence | null;
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
 *   - `"halftone_generated"` (Print'em All Phase 2) — the pixels are a
 *     halftone DOT LATTICE that the local screen engine drew across the final
 *     production canvas. Checks trust `widthPx`/`heightPx` directly, because
 *     the geometry is exact at the target density BY CONSTRUCTION: it was
 *     generated at that density rather than resampled to it.
 *
 *     It is deliberately its own value and must never be collapsed into
 *     `"reconstructed"`. `"reconstructed"` asserts that provider-manufactured
 *     CONTINUOUS-TONE DETAIL fills those pixels; a halftone plate asserts
 *     nothing of the kind and carries none. Reading one as the other would
 *     turn "300 PPI final-size dot geometry" into a claim of "300 PPI
 *     reconstructed source detail" — the exact overstatement Phase 2 exists
 *     to keep out of the record. What the source IS asked for here is tonal
 *     information at the screen's own frequency, and that is judged by
 *     `halftone_tonal_sufficiency`, never by pixel count.
 */
export type ResolutionProvenance =
  | "native"
  | "interpolated_upscale"
  | "reconstructed"
  | "halftone_generated"
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
/**
 * Signs Phase S2: `"rigid_sign_raster"` — the admitted rigid-sign profile
 * (Constitution §16A). The customer's supplied artwork, deterministically
 * repaired to an exact ordered substrate size, is the specification; there
 * is no Design Brief, no Concept Evaluation, and no apparel transparency
 * requirement. See `RigidSignPlanEvidence` and `validateRigidSign`.
 */
export type PrintValidationProfile =
  | "generated_concept"
  | "uploaded_preserve"
  | "rigid_sign_raster";

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
  enhancement: "skipped" | "reconstructed" | "halftone_screened";
}

/**
 * Print'em All Phase 2: the halftone screen's own recorded geometry, as
 * authoritative Print Validation consumes it.
 *
 * Structurally a mirror of `ProductionNormalizationSummary`, and for the same
 * reason: these are CLAIMS the transform made about itself, and validation
 * recomputes from them rather than accepting them. `cellPx` is checked
 * against `targetPpi / lpi`, `achievedLpi` against `targetPpi / cellPx`, and
 * `screenWidthPx`/`screenHeightPx` against the delivered asset's own
 * dimensions — three independent facts that cannot all be wrong in the same
 * direction by accident.
 *
 * HONESTY BOUNDARY. None of this says the print will look good, that the LPI
 * suits any particular printer/film/powder/RIP combination, or that the
 * artwork's subject matter survived screening legibly. It says the plate is
 * the screen it claims to be, at the physical size it claims, generated where
 * it claims. Everything past that is a press test.
 */
export interface HalftoneProductionEvidence {
  /** Engine identity the settings were interpreted by. */
  algorithmVersion: string;
  lpi: number;
  angleDeg: number;
  dotShape: string;
  /** Gamma/midtone transfer control actually applied. */
  midtone: number;
  /** Edge choke actually applied, in output pixels. */
  chokePx: number;
  /** The garment colour the screen was tonally referenced against. Never composited into the deliverable. */
  garmentHex: string;
  targetPpi: number;
  /** Output pixels per halftone cell. Must equal `targetPpi / lpi`. */
  cellPx: number;
  /** Recomputed line frequency. Must equal `lpi` within raster rounding. */
  achievedLpi: number;
  /** Radius, in output pixels, of the smallest dot this screen can emit. */
  minDotRadiusPx: number;
  /** THE FINAL-SIZE PROOF: the pixel dimensions the lattice was drawn across. */
  screenWidthPx: number;
  screenHeightPx: number;
  /** Visible source pixels the screen was applied to. */
  visiblePixelCount: number;
  /** Fraction of those that came out carrying ink — the screen's measured result. */
  inkedPixelFraction: number;
}

// ---------------------------------------------------------------------------
// DTF Feature Integrity (Phase 1 + Phase 2A structural discrimination)
// ---------------------------------------------------------------------------

export type DtfFeatureRiskKind =
  | "positive_feature_thin"
  | "negative_space_narrow"
  | "isolated_component_small"
  | "partial_alpha_fragile";

export interface DtfFeatureRiskBoundingBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * One diagnostic risk region — enough to locate WHERE a risk is (Section 17
 * of Phase 1's plan), never a repair instruction. Capped and worst-first;
 * `DtfFeatureIntegritySummary.limitations` states when the full measurement
 * found more than survived here.
 */
export interface DtfFeatureRiskRegion {
  kind: DtfFeatureRiskKind;
  boundingBoxPx: DtfFeatureRiskBoundingBox;
  /** Measured stroke/gap width, in mm — set for `positive_feature_thin`/`negative_space_narrow`, `null` otherwise. */
  measuredWidthMm: number | null;
  /** Measured equivalent diameter, in mm — set for `isolated_component_small`/`partial_alpha_fragile`, `null` otherwise. */
  measuredDiameterMm: number | null;
  /** Phase 2A: this region's own physical area, in mm². */
  physicalAreaMm2: number | null;
  /** Phase 2A: median stroke/gap width across this region's own ridge — set for `positive_feature_thin`/`negative_space_narrow` only. Paired with `measuredWidthMm` (the region's minimum) to give a human a sense of whether the minimum is representative or an outlier. */
  medianWidthMm: number | null;
  /** Phase 2A: this region's OWN fraction-below-floor pair (see `StructuralFractions`), always both `null` or both present together. `null` for `isolated_component_small`/`partial_alpha_fragile`, which have no internal ridge distribution to speak of. */
  fractionBelowBlockingFloor: number | null;
  fractionBelowWarningFloor: number | null;
  pixelArea: number;
}

/**
 * Print Validation's own, independent copy of the Feature Integrity
 * engine's measurement — mirrors `ProductionNormalizationSummary`'s
 * relationship to `final-artwork`'s `ProductionNormalizationMetadata` and
 * `HalftoneProductionEvidence`'s relationship to `HalftoneScreenMetadata`.
 * Print Validation must never depend on the Final Artwork capability
 * (ARCHITECTURE.md dependency direction; `capability-boundaries.ts`'s
 * explicit "print-validation MUST NOT import the engine" rule for the
 * structurally identical halftone case) — `FinalArtworkWorkerCapability`,
 * which legitimately knows both shapes, is the one place a real
 * `FeatureIntegrityMeasurement` is reduced onto this summary.
 *
 * Deliberately RAW measurements only — no pass/warning/blocking verdict is
 * carried here. Classification against the provisional DTF profile happens
 * once, inside `print-validation-capability.ts`'s own check functions, so
 * the tier logic is never duplicated between this assembly step and the
 * capability that is supposed to be the sole judge of it.
 */
export interface DtfFeatureIntegritySummary {
  algorithmVersion: string;
  pixelPitchXMm: number;
  pixelPitchYMm: number;
  positive: {
    measuredComponentCount: number;
    globalMinStrokeWidthMm: number | null;
    percentile5StrokeWidthMm: number | null;
    /**
     * Phase 2A: the single component whose own fraction-below-floor is
     * highest, paired with THAT SAME component's own minimum width — see
     * `final-artwork/feature-integrity`'s `PositiveFeatureGeometry.worstStructuralComponent`
     * for why this pairing is computed before any capping and must never be
     * reconstructed by mixing fields from two different regions. This is
     * what `checkDtfPositiveFeatureIntegrity` actually classifies
     * structural-vs-incidental from. `null` when no component was measured.
     */
    worstStructuralComponent: {
      minStrokeWidthMm: number | null;
      fractionBelowBlockingFloor: number;
      fractionBelowWarningFloor: number;
    } | null;
  };
  negative: {
    measuredChannelCount: number;
    globalMinGapWidthMm: number | null;
    percentile5GapWidthMm: number | null;
    /** Phase 2A — same contract as `positive.worstStructuralComponent`, for negative-space channels. */
    worstStructuralComponent: {
      minGapWidthMm: number | null;
      fractionBelowBlockingFloor: number;
      fractionBelowWarningFloor: number;
    } | null;
  };
  isolated: {
    totalComponentCount: number;
    smallestEquivalentDiameterMm: number | null;
    /**
     * Phase 2A (Section 7): population-level view of isolated MICRO
     * components — how many, how much combined area, what fraction of all
     * printed area, and whether they read as crisp marks or faint residue.
     * Diagnostic only; never itself a pass/fail input.
     */
    microComponents: {
      microComponentCount: number;
      totalMicroComponentPhysicalAreaMm2: number;
      fractionOfPrintedArea: number;
      meanPartialAlphaFraction: number;
    };
  };
  partialAlpha: {
    partialAlphaFractionOfVisible: number;
    smallestEquivalentDiameterMm: number | null;
  };
  /** Capped, worst-first diagnostic regions across all four categories. Never authoritative by itself — the checks below recompute their own verdicts from the aggregate fields above. */
  riskRegions: DtfFeatureRiskRegion[];
  /** Honest measurement limitations/notes carried through from the engine (e.g. non-square pixel pitch, capped region lists). */
  limitations: string[];
}

/**
 * Everything `PrintValidationCapability.validateArtwork` needs, already
 * resolved by the caller. Print Validation itself never reads a repository
 * (Goal 16/17 — "PrintValidation should remain pure validation"), mirroring
 * `ConceptEvaluationCapability.evaluate`'s `ConceptEvaluationInput` pattern:
 * the caller (a future Final Artwork orchestrator, a route, or a test) does
 * the I/O; this capability only decides.
 */
/**
 * Signs Phase S2: the deterministic plan-lineage and print-ready-risk
 * evidence for one rigid-sign production plate. Present only under the
 * `rigid_sign_raster` profile.
 *
 * Print Validation must never depend on `capabilities/sign-preparation`
 * (the same dependency-direction rule that keeps this module from importing
 * `final-artwork` or the halftone engine — `capability-boundaries.ts`).
 * This is this module's OWN, independent copy of the facts it needs,
 * mirroring `UploadedPreserveEvidence`'s/`HalftoneProductionEvidence`'s
 * relationship to their real engines: `FinalArtworkWorkerCapability`, which
 * legitimately depends on both `sign-preparation` and `print-validation`, is
 * the one place a real `SignRepairPlan` is reduced onto this shape.
 *
 * HONESTY BOUNDARY: `planKeyVerified`/`executedStepsMatchPlan` prove the
 * worker replayed the EXACT plan it was bound to, byte-for-byte — they do
 * not prove the plan was a good idea. `planOverallRisk` carries the
 * planner's own risk classification through so this profile can enforce
 * the print-ready boundary (Constitution §16A.3 / S0.5 Rule 1: no
 * unapproved review-class action, and no provider reconstruction, may ever
 * reach `print_ready`) without re-deriving it.
 */
export interface RigidSignPlanEvidence {
  /** The immutable original asset the plan was formulated against. */
  sourceAssetId: string;
  /** SHA-256 of the exact source bytes the worker actually read before executing. */
  sourceSha256: string;
  /** The plan's own canonical identity, as persisted. */
  planKey: string;
  planSchemaVersion: string;
  policyId: string;
  /** True only when the worker independently recomputed the plan key from the CURRENTLY PERSISTED plan fields, immediately before executing, and it matched `planKey`. */
  planKeyVerified: boolean;
  /** True only when every step actually executed, in order, has the exact kind+params the persisted plan recorded — a full, unmodified replay. */
  executedStepsMatchPlan: boolean;
  /** The plan's own risk classification (`sign-preparation/contracts.ts`'s `SignRiskClass`, carried as a string so this module never imports that type). */
  planOverallRisk: "auto_safe" | "review_required" | "blocked";
  /** True when every executed step's kind is one of S2's admitted deterministic operations — never `reconstruct_resolution` or `approved_crop`. */
  containsOnlyAdmittedSteps: boolean;
  /**
   * LIVE PRODUCT BLOCKER #4B: true when the recorded plan's ONLY
   * non-S2-admitted content is exactly one `reconstruct_resolution` step —
   * the Signs Phase S3A/S4 bounded-provider-reconstruction shape
   * (`sign-preparation/sign-transform-executor.ts`'s own
   * `planRequiresBoundedReconstruction`, carried here as a plain boolean —
   * this module never imports that function). Distinct from
   * `containsOnlyAdmittedSteps`, which is `false` for any such plan by
   * construction (`reconstruct_resolution` itself is never S2-admitted).
   * Exists so `planIntegrityOk` can admit a genuinely reconstructed,
   * genuinely preserved plate — never any OTHER non-admitted shape (e.g.
   * `approved_crop`, or a plan the worker itself refused to execute) —
   * without weakening what `containsOnlyAdmittedSteps` alone still
   * protects for a plan needing no reconstruction at all.
   */
  planRequiresBoundedReconstruction: boolean;
  /**
   * LIVE PRODUCT BLOCKER #4D: non-null ONLY when `executedStepsMatchPlan`
   * is `false` because a real reconstruction-provider result diverged
   * (proportionally) from the plan's own requested reconstruction size,
   * and the worker deterministically re-derived a geometry step's pixel
   * amounts to still reach the ordered aspect — the Signs Phase S3C
   * adaptive-geometry path. `null` for every OTHER reason
   * `executedStepsMatchPlan` might be `false` (this is never a general
   * escape hatch). PrintValidation independently re-verifies
   * proportionality and step-identity preservation from these raw facts
   * — it never trusts a bare "the adaptation was valid" claim, the same
   * discipline `preservationVerification`/`authorization` already apply.
   */
  executedGeometryAdaptation: RigidSignExecutedGeometryAdaptationEvidence | null;
  /** The exact ordered physical size the plate was produced for. Both axes — never width-only apparel semantics. */
  orderedWidthIn: number;
  orderedHeightIn: number;
  /** The governing resolution policy's own target/minimum PPI (Constitution §16A.4) — a policy value, never a constant. */
  targetPpi: number;
  minPpi: number;
  /** Worker-measured geometric fact: every original source pixel remains inside the plate, and every added region lies outside the original content region. */
  contentBoundsWithinOutput: boolean;
  /** Internal rationale for `contentBoundsWithinOutput` — never customer-facing copy. */
  contentBoundsReason: string;
  /**
   * Signs Phase S4→PrintValidation integration: the identity of the asset
   * THIS evidence is for — the exact plate being validated. Exists solely
   * so `preservationVerification.finalAssetId` (below) can be compared
   * against something independent of itself; see that field's own doc for
   * why this redundant-looking check matters.
   */
  finalAssetId: string;
  /**
   * The resolved, authoritative Signs preservation-verification record for
   * this plate — never fabricated by this module. `null` means "no record
   * was found/resolved", which fails closed exactly like every other
   * missing-evidence case in this profile. Ignored when
   * `planRequiresSemanticPreservationVerification` (below) is `false` — a
   * plan that never needed the question asked has nothing to verify.
   *
   * Print Validation must never depend on `capabilities/sign-preservation`
   * (same dependency-direction rule as `sign-preparation`, above) — this is
   * this module's own narrow copy of exactly the fields needed to bind the
   * verification to THIS plate/source/plan/algorithm identity, mirroring
   * `RigidSignPlanEvidence` itself.
   */
  preservationVerification: RigidSignPreservationVerificationEvidence | null;
  /**
   * Semantic Worker Wiring Phase: true iff the recorded plan is one this
   * profile must independently prove `preservationVerification.status ===
   * "preserved"` for before it can certify ready — mirrors `sign-
   * preparation/sign-transform-executor.ts`'s own
   * `planRequiresSemanticPreservationVerification` exactly (this module
   * never imports that function; the caller re-derives the identical fact
   * and hands it over as a plain boolean, the same discipline
   * `planRequiresBoundedReconstruction` already follows).
   *
   * Deliberately NOT derived here from `primaryAsset.resolutionProvenance
   * === "reconstructed"` — that was the exact bug this phase closes.
   * `reconstruct_perimeter_structure` needs this question asked despite
   * `resolutionProvenance` staying `"native"` (no provider ever touches
   * those pixels); gating on provenance silently skipped the preservation-
   * status check entirely for every such plan, no matter what its semantic
   * verification actually concluded.
   */
  planRequiresSemanticPreservationVerification: boolean;
  /**
   * The verification-algorithm identity CURRENTLY authoritative for this
   * preservation check, resolved by the worker independently of any
   * specific verification record (`SignPreservationCapability
   * .resolveCurrentVerificationAlgorithmVersion`) — never read off the
   * record being checked itself, which would make this comparison
   * trivially circular. A provider/model/prompt/schema change changes this
   * value, so an older, differently-keyed verification can never silently
   * authorize a newer plate.
   */
  expectedPreservationAlgorithmVersion: string;
  /**
   * LIVE PRODUCT BLOCKER #4: the resolved production-risk authorization
   * for this plan — `null` when none exists. `"customer"`/`"operator"` are
   * carried as plain strings for the same reason `planOverallRisk` is (this
   * module must never import `sign-preparation`'s
   * `SignPlanAuthorizationActor` type). Compared against `planKey` (never
   * trusted merely for existing) and combined with `planOverallRisk` to
   * decide `riskAuthorized` — an `auto_safe` plan accepts either actor; a
   * `review_required` plan accepts only `"operator"`.
   */
  authorization: RigidSignPlanAuthorizationEvidence | null;
  /**
   * Signs Perimeter Safety Phase: see `RigidSignSubstrateBoundaryEvidence`'s
   * own doc. Required (never optional/undefined) so no existing caller can
   * silently omit it and have this defense-in-depth check pass by absence —
   * every caller must state, explicitly, whether an extension happened and
   * whether its finished-edge relationship was verified.
   */
  substrateBoundary: RigidSignSubstrateBoundaryEvidence;
  /**
   * Signs Phase 3B (Fit to Production): CUT/SAFE/BLEED/PROTECTED evidence
   * for the actual produced plate, measured by the worker (`sign-
   * preparation/sign-fit-to-production.ts`'s own `analyzeSignFitToProduction`
   * — this module never imports that function; the caller re-derives the
   * facts and hands over a plain, already-computed result, the same
   * discipline every other cross-capability fact in this evidence object
   * already follows). `null` means the analysis was never run for this
   * plate (a historical asset produced before this phase, or an
   * infrastructure failure) — fails closed exactly like every other
   * missing-evidence case in this profile, never silently treated as safe.
   */
  fitToProduction: RigidSignFitToProductionEvidence | null;
}

/**
 * Signs Phase 3B (Fit to Production): this module's own narrow copy of
 * `sign-preparation/sign-fit-to-production.ts`'s `SignFitToProductionResult`
 * shape — never imported, mirroring every other cross-capability evidence
 * type in this file. `edge` values are plain strings, never `SignEdge`.
 */
export interface RigidSignFitToProductionEdgeEvidence {
  edge: "top" | "right" | "bottom" | "left";
  requiredSafeInsetIn: number;
  requiredSafeInsetPx: number;
  nearestNonBleedPx: number | null;
  nearestNonBleedIn: number | null;
  result: "pass" | "fail" | "unknown";
  reason: string;
  /**
   * Operator Production Correction UX: mirrors `sign-preparation/sign-fit-
   * to-production.ts`'s own `violatingPositionPx` — the along-edge column
   * (top/bottom) or row (left/right) index where `nearestNonBleedPx` was
   * measured, so an operator UI can highlight the actionable region of a
   * failing edge. `null` whenever `nearestNonBleedPx` is `null`.
   */
  violatingPositionPx: number | null;
}

export interface RigidSignFitToProductionEvidence {
  safeInsetIn: number;
  achievedPpiX: number;
  achievedPpiY: number;
  edges: RigidSignFitToProductionEdgeEvidence[];
  overallResult: "pass" | "fail" | "unknown";
}

/**
 * LIVE PRODUCT BLOCKER #4: the narrow, identity-bound facts this profile
 * needs from one durable plan authorization — mirrors
 * `RigidSignPreservationVerificationEvidence`'s own shape and reasoning
 * exactly. Never a bare `authorized: true`.
 */
export interface RigidSignPlanAuthorizationEvidence {
  /** Compared against `RigidSignPlanEvidence.planKey` — an authorization for a superseded plan must never authorize the current one. */
  planKey: string;
  /** WHO authorized it. Only `"operator"` is sufficient for a `review_required` plan. */
  authorizedBy: "customer" | "operator";
}

/**
 * Signs Phase S4→PrintValidation integration: the narrow, identity-bound
 * facts this profile needs from one `SignPreservationVerification` row —
 * never a bare `preservationPassed: true` shortcut. Every field here exists
 * to be compared against an independent fact already present elsewhere in
 * `RigidSignPlanEvidence`/`PrimaryAssetEvidence`, so a verification that is
 * real but for a DIFFERENT asset, source, plan, or algorithm identity can
 * never authorize THIS plate.
 */
export interface RigidSignPreservationVerificationEvidence {
  /** Compared against `RigidSignPlanEvidence.finalAssetId` — a verification for a different asset must never authorize this one. */
  finalAssetId: string;
  /** Compared against `RigidSignPlanEvidence.sourceAssetId`. */
  sourceAssetId: string;
  /** Compared against `RigidSignPlanEvidence.sourceSha256`. */
  sourceSha256: string;
  /** Compared against `RigidSignPlanEvidence.planKey` — a verification bound to a superseded plan must never authorize the current one. */
  planKey: string;
  /** Compared against `RigidSignPlanEvidence.expectedPreservationAlgorithmVersion` — a verification computed under an old provider/model/prompt/schema identity must never silently pass under a new one. */
  verificationAlgorithmVersion: string;
  /**
   * The verification's own conclusion. Only `"preserved"` may ever
   * contribute to a `print_ready` result — `"changed"` and `"unknown"`
   * both fail exactly like a missing record.
   */
  status: "preserved" | "changed" | "unknown";
}

/**
 * LIVE PRODUCT BLOCKER #4D: the identity of ONE geometry-stage step
 * (`extend_uniform_background`/`pad_uniform_background`), stripped to
 * exactly the fields that must NEVER change between the approved plan's
 * own recorded step and what actually executed — `kind`/`axis`/fill.
 * `leadingPx`/`trailingPx` are deliberately excluded: those are the ONE
 * thing a legitimate S3C adaptation is allowed to re-derive.
 */
/**
 * Signs Perimeter Safety Phase: the minimum defense-in-depth evidence
 * PrintValidation needs to independently refuse `print_ready` when a
 * geometry-extension repair may have moved edge-relative artwork (a
 * border, frame, rounded-corner treatment, mounting-hole indicator, or
 * similar) away from the finished substrate edge it depends on — even if
 * `sign-repair-planner.ts` itself has a future bug that admits such a
 * repair anyway. Deliberately keyed to NOTHING image/customer-specific
 * (never a planKey, never a colour, never a project id) — this is a
 * general production invariant, re-derivable for any rigid-sign plate.
 *
 * This module must never import `capabilities/sign-preparation` or
 * `capabilities/sign-preservation` (same dependency-direction rule
 * `RigidSignPlanEvidence` itself already follows) — both fields here are
 * plain booleans/string-unions the WORKER re-derives independently, never
 * types borrowed from either of those capabilities.
 */
export interface RigidSignSubstrateBoundaryEvidence {
  /**
   * True when the executed geometry-extension step's own affected edge(s)
   * carried the deterministic edge-dependence signal
   * (`sign-preparation/edge-dependence.ts`'s `isEdgeDependentStructure`,
   * re-derived by the worker from the plate's own persisted edge evidence —
   * never trusted from the plan's own defect list alone). `false` when no
   * geometry-extension step executed at all (nothing was extended, nothing
   * to check) — never a reason to fail this check on its own.
   */
  edgeDependentStructureOnAffectedEdge: boolean;
  /**
   * The semantic preservation verification's own answer for the
   * `perimeter_edge_alignment` category, carried as a plain string (never
   * `SignPreservationSemanticAnswerValue`, to preserve the dependency
   * direction above). `null` when no semantic verification exists for this
   * plate at all — treated exactly like a `"changed"`/`"cannot_determine"`
   * answer below: missing evidence never authorizes.
   */
  perimeterAlignmentAnswer: "same" | "changed" | "cannot_determine" | "not_applicable" | null;
}

export interface RigidSignGeometryStepEvidence {
  kind: string;
  axis: string | null;
  colorR: number | null;
  colorG: number | null;
  colorB: number | null;
  color: string | null;
}

/**
 * LIVE PRODUCT BLOCKER #4D: the raw facts behind ONE Signs Phase S3C
 * adaptive-geometry execution — never a bare "the adaptation was valid"
 * claim. See `RigidSignPlanEvidence.executedGeometryAdaptation`'s own doc.
 */
export interface RigidSignExecutedGeometryAdaptationEvidence {
  /** What the approved plan's own `reconstruct_resolution` step requested. */
  reconstructionRequestedWidthPx: number;
  reconstructionRequestedHeightPx: number;
  /** What the reconstruction provider actually returned. */
  reconstructionActualWidthPx: number;
  reconstructionActualHeightPx: number;
  /** The approved plan's OWN recorded geometry step — approval authority, never mutated. `null` when the plan had no geometry step (reconstruction alone was expected to reach the ordered aspect). */
  plannedStep: RigidSignGeometryStepEvidence | null;
  /** What actually executed — `kind`/`axis`/fill must be identical to `plannedStep`; only pixel amounts (not carried here) may differ. `null` exactly when `plannedStep` is also `null`. */
  executedStep: RigidSignGeometryStepEvidence | null;
}

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
  /**
   * Print'em All Phase 2: WHICH PRODUCTION REPRESENTATION this plate is.
   * Absent/`undefined` means `"standard_raster"`, so every existing caller —
   * and every plate produced before treatments existed — keeps byte-for-byte
   * the behavior it had.
   *
   * Deliberately a separate axis from `validationProfile`. The profile says
   * whose specification the artwork answers to (a brief we were given, or the
   * customer's own pixels); the treatment says which physical representation
   * was made. They vary independently, and folding one into the other would
   * mean adding a profile every time either changes.
   */
  productionTreatment?: ProductionTreatment;
  /**
   * Print'em All Phase 2: the screen's recorded geometry. REQUIRED when
   * `productionTreatment` is `"halftone_dtf"` (its absence is itself a
   * blocking `halftone_treatment` failure — same rule as uploaded-preserve
   * lineage: a plate whose screen nobody recorded is not one to certify);
   * ignored otherwise.
   */
  halftone?: HalftoneProductionEvidence | null;
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
  /**
   * DTF Feature Integrity Phase 1: the production plate's measured feature
   * geometry, when it was measured. Present only for a standard-raster
   * (never `halftone_dtf`) production-asset validation whose final raster
   * was actually decoded and measured — `null`/absent for provisional
   * concept-stage validation, a halftone plate (its dot lattice is not
   * continuous-tone stroke/gap geometry — see ARCHITECTURE.md), or a
   * production asset persisted before this phase existed. Never emitted as
   * a false pass: the four `dtf_*` checks are not emitted at all when this
   * is absent, mirroring how halftone/reconstruction checks are not emitted
   * outside their own applicable profile.
   */
  dtfFeatureIntegrity?: DtfFeatureIntegritySummary | null;
  /**
   * Signs Phase S2: pre-classified `ProductionRequirements` for the
   * `rigid_sign_raster` profile, built by
   * `deriveRigidSignProductionRequirements` from a confirmed
   * `SignProductionSpec` — REQUIRED under this profile, and never derived
   * from brief text (`printPlacement`/`productSummary`/`designDescription`
   * above are ignored entirely when this profile is active; a sign has no
   * brief). Absence under this profile is itself a hard block.
   */
  rigidSignRequirements?: ProductionRequirements | null;
  /** Signs Phase S2: REQUIRED under the `rigid_sign_raster` profile. Absence is itself a hard block — a plate with no recorded plan lineage is not one to certify. */
  rigidSign?: RigidSignPlanEvidence | null;
}
