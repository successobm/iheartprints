export const PROJECT_STATUSES = [
  "intake",
  "ready_to_generate",
  "generating",
  "concepts_ready",
  "revision_requested",
  "approved",
  "finalizing",
  /**
   * Sprint 2M Phase 2C: a `FinalArtworkJob` ran to completion — a real
   * production asset was created — but authoritative Print Validation did
   * not return `"ready"` (blocked, or genuinely needs review). Distinct
   * from `"finalizing"` (still in progress) and `"failed"` (the pipeline
   * itself errored, e.g. storage/transformation failure): this status means
   * the pipeline succeeded at producing *something*, and that something
   * honestly isn't print-ready yet. Never set without a real, authoritative
   * `PrintValidationCapability.validateArtwork` run against a real
   * production asset (Constitution §15 — no fabricated readiness).
   */
  "finalization_required",
  "print_ready",
  "failed",
  "archived",
] as const;

export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const CONVERSATION_PHASES = [
  // Legacy Sprint 1 scripted ladder. No longer used by new projects
  // (Sprint 2F), but preserved so historical rows remain readable/resumable.
  "ask_product",
  "ask_design",
  "ask_shirt_color",
  "ask_text",
  "skip_references",
  "generating",
  "concepts_ready",
  "ask_revisions",
  "revision_received",
  // Sprint 2D: Design Summary approval gate (additive).
  "awaiting_summary_confirmation",
  "brief_approved",
  "edit_requested",
  "continue_requested",
  // Sprint 2F: single adaptive interview lifecycle phase. Replaces the
  // ask_* ladder as the source of truth for new projects — the specific
  // pending question lives in `interviewState`, not in a dedicated phase
  // value per field.
  "interviewing",
] as const;

export type ConversationPhase = (typeof CONVERSATION_PHASES)[number];

export type MessageRole = "user" | "assistant" | "system";

/**
 * Existing Artwork → Print Ready Phase 1: `"prepared_upload"` is artwork the
 * CUSTOMER supplied, background-prepared deterministically and approved by
 * them — never AI-generated, never a concept, never a revision of one. It
 * exists as its own kind precisely so uploaded artwork can never be
 * mislabelled as a generated concept anywhere downstream (Constitution §6.11
 * / §16 — provenance is never inferred).
 */
export type ArtworkKind = "concept" | "revision" | "final" | "prepared_upload";

/**
 * Sprint 2G Live Acceptance Corrective Pass: the stable identity of one of
 * the three catalog creative directions (`lib/domain/concept-directions.ts`
 * — "Bold & Direct" / "Soft & Illustrated" / "Minimal Badge"). Defined here
 * rather than in `concept-directions.ts` to avoid a circular import
 * (`concept-directions.ts` already imports `GenerationPromptRequest` from
 * this file); `concept-directions.ts` re-exports it for callers that only
 * need the catalog. Persisted on `ArtworkVersion.conceptDirectionKey` so a
 * later single-concept revision of that exact artwork can regenerate in the
 * SAME direction rather than defaulting to a different one.
 */
export type ConceptDirectionKey = "bold_direct" | "soft_illustrated" | "minimal_badge";

/**
 * Phase 1.1: the three genuinely different states of "what text goes on this
 * design", as a first-class provider-neutral vocabulary.
 *
 *   "unknown"  — the customer has not answered yet. NOT a no-text request.
 *   "provided" — exact wording is required, character for character.
 *   "none"     — the customer explicitly said there is no wording. This is a
 *                HARD no-text constraint on the artwork, not merely the
 *                absence of a required string.
 *
 * Defined here rather than in `required-wording.ts` to avoid a circular
 * import (`required-wording.ts` already imports `TShirtDesignBrief` from this
 * file, and `GenerationPromptRequest` below needs the type);
 * `required-wording.ts` re-exports it and remains the one place the
 * `exactText` storage representation is interpreted.
 *
 * The live audit that motivated this: `exactText === ""` already derived
 * `mode: "none"` correctly, but `GenerationPromptRequest` flattened it back
 * to `requiredWording: null` — indistinguishable from "unresolved". Every
 * downstream layer therefore read an explicit no-text request as merely "no
 * required string", kept typography-forward direction language, and produced
 * artwork covered in invented lettering.
 */
export type RequiredWordingMode = "unknown" | "provided" | "none";

export type PrintPlacement =
  | "full_front"
  | "full_back"
  | "left_chest"
  | "sleeve";

/**
 * Print'em All Phase 1: the GARMENT SIZING CONTEXT a production box is
 * recommended for.
 *
 * This is apparel-product sizing terminology and nothing else. It describes
 * the GARMENT — the physical thing being decorated — never a person. It is
 * not a gender inference, not a body measurement, and not a customer
 * attribute; a single order routinely spans several of these classes.
 *
 * Deliberately five coarse classes and NOT a SKU catalogue, an apparel
 * inventory, or a manufacturer sizing database. The only question this type
 * exists to answer is "roughly how large a print box should we RECOMMEND?",
 * and five classes answer it. Anything finer would be a product expansion
 * the Constitution does not authorize.
 *
 * `"custom"` is not a garment at all — it is the explicit escape hatch for
 * an operator sizing to something this vocabulary does not name, and it
 * deliberately carries NO recommendation. `null` on the brief means the
 * class was never stated.
 */
export type GarmentSizeClass =
  | "youth"
  | "womens_small"
  | "adult_standard"
  | "adult_plus"
  | "custom";

/**
 * Print'em All Phase 2: which apparel-raster production REPRESENTATION a
 * project's plate is made as. See
 * `capabilities/shared/production-treatment.ts` for the full rationale and
 * every policy built on this value.
 *
 * Defined here rather than there because `lib/db` persists and reads it, and
 * `lib/db` never depends on `capabilities`. This file owns the persisted
 * VOCABULARY; the capability owns what may be done with it.
 */
export type ProductionTreatment = "standard_raster" | "halftone_dtf";

export const PRODUCTION_TREATMENTS: readonly ProductionTreatment[] = [
  "standard_raster",
  "halftone_dtf",
];

/**
 * The treatment a project has when nobody has chosen one — always standard
 * raster, which is also what every project predating this vocabulary
 * genuinely is.
 */
export const DEFAULT_PRODUCTION_TREATMENT: ProductionTreatment = "standard_raster";

export function isProductionTreatment(value: unknown): value is ProductionTreatment {
  return (
    typeof value === "string" &&
    (PRODUCTION_TREATMENTS as readonly string[]).includes(value)
  );
}

/**
 * Narrows a raw persisted treatment column.
 *
 * An unrecognized value — written by a newer deploy, or corrupt — reads back
 * as the DEFAULT rather than being honoured. This build physically cannot
 * produce a treatment it does not implement, so the only alternatives to
 * defaulting are guessing (producing a plate nobody specified) or crashing
 * (taking a project offline because a column has a newer word in it). It also
 * fails toward the SAFE representation: standard raster is the one whose
 * validation nothing was relaxed for.
 */
export function readProductionTreatment(value: unknown): ProductionTreatment {
  return isProductionTreatment(value) ? value : DEFAULT_PRODUCTION_TREATMENT;
}

/**
 * Print'em All Phase 2: the canonical treatment key every standard-raster job
 * carries — and, deliberately, the SAME string the migration's
 * `coalesce(production_treatment_key, 'standard_raster')` substitutes for a
 * legacy NULL.
 *
 * They must be identical. A legacy job and a newly written standard-raster job
 * describe the same production intent, so they have to land in the same
 * uniqueness bucket; giving the legacy sentinel its own value would stop every
 * historical job deduplicating against every other and reintroduce the
 * duplicate paid reconstruction these keys exist to prevent.
 */
export const STANDARD_RASTER_TREATMENT_KEY = "standard_raster";

/** Print'em All Phase 2: halftone dot shapes this build implements. */
export type HalftoneDotShape = "round" | "ellipse";

export const HALFTONE_DOT_SHAPES: readonly HalftoneDotShape[] = ["round", "ellipse"];

/** Print'em All Phase 2: halftone screen angles this build implements, in degrees. */
export type HalftoneScreenAngle = 22.5 | 45;

export const HALFTONE_SCREEN_ANGLES: readonly HalftoneScreenAngle[] = [22.5, 45];

/**
 * The bounded LPI band this build supports. See `DEFAULT_HALFTONE_LPI` in
 * `capabilities/shared/production-treatment.ts` for why this is a band an
 * operator moves inside rather than a single number the product asserts.
 */
export const MIN_HALFTONE_LPI = 25;
export const MAX_HALFTONE_LPI = 55;
/** Midtone/gamma transfer bounds. `1` is the identity transfer. */
export const MIN_HALFTONE_MIDTONE = 0.5;
export const MAX_HALFTONE_MIDTONE = 2;
/** Edge choke bounds, in output pixels. Small and explicit — never a matte editor. */
export const MIN_HALFTONE_CHOKE_PX = 0;
export const MAX_HALFTONE_CHOKE_PX = 2;

/**
 * A resolved garment colour: the label a human stated, and the exact RGB the
 * treatment used it as.
 *
 * BOTH are persisted because they answer different questions. The label is
 * what the operator chose; the RGB is what the engine actually did. A future
 * change to the colour table must be DETECTABLE rather than silently
 * rewriting what past plates were made against.
 */
export interface GarmentColor {
  /** Exactly as stated on the brief — never normalized away. */
  label: string;
  /** Uppercase `#RRGGBB`. */
  hex: string;
  rgb: { r: number; g: number; b: number };
}

/**
 * Print'em All Phase 2: everything needed to recreate one halftone plate
 * exactly.
 *
 * Persisted as durable authority, never held only in React state: an operator
 * who reloads the page must not have to remember what they chose, and a plate
 * whose settings nobody wrote down is a plate nobody can reproduce or explain
 * to a printer.
 */
export interface HalftoneSettings {
  lpi: number;
  angleDeg: HalftoneScreenAngle;
  dotShape: HalftoneDotShape;
  /** Gamma/midtone transfer control. `1` is linear; `>1` puts more ink in the midtones. */
  midtone: number;
  /** Edge cleanup erosion, in output pixels. `0` is off. */
  chokePx: number;
  /** The garment colour the screen was tonally referenced against. Never composited into the deliverable. */
  garment: GarmentColor;
  /** Which engine version interpreted these settings. */
  algorithmVersion: string;
}

/**
 * Narrows a raw persisted `halftone_settings` JSONB document.
 *
 * FAILS CLOSED, unlike `readGarmentSizeClass`, and the asymmetry is the same
 * one that distinguishes a suggestion from a specification. A garment class
 * only seeds a recommendation, so an unreadable one may safely become "never
 * stated". These settings ARE the plate — every value here changed output
 * pixels — so a partial or malformed document means the treatment cannot be
 * reproduced, and the honest reading of that is `null` (no usable settings),
 * never a document with defaults quietly filled into the gaps. A caller that
 * gets `null` while the treatment says halftone has a project whose
 * treatment is incomplete, which is exactly what it should see.
 */
export function readHalftoneSettings(value: unknown): HalftoneSettings | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;

  const lpi = raw.lpi;
  if (
    typeof lpi !== "number" ||
    !Number.isInteger(lpi) ||
    lpi < MIN_HALFTONE_LPI ||
    lpi > MAX_HALFTONE_LPI
  ) {
    return null;
  }

  const angleDeg = raw.angleDeg;
  if (
    typeof angleDeg !== "number" ||
    !(HALFTONE_SCREEN_ANGLES as readonly number[]).includes(angleDeg)
  ) {
    return null;
  }

  const dotShape = raw.dotShape;
  if (
    typeof dotShape !== "string" ||
    !(HALFTONE_DOT_SHAPES as readonly string[]).includes(dotShape)
  ) {
    return null;
  }

  const midtone = raw.midtone;
  if (
    typeof midtone !== "number" ||
    !Number.isFinite(midtone) ||
    midtone < MIN_HALFTONE_MIDTONE ||
    midtone > MAX_HALFTONE_MIDTONE
  ) {
    return null;
  }

  const chokePx = raw.chokePx;
  if (
    typeof chokePx !== "number" ||
    !Number.isInteger(chokePx) ||
    chokePx < MIN_HALFTONE_CHOKE_PX ||
    chokePx > MAX_HALFTONE_CHOKE_PX
  ) {
    return null;
  }

  const algorithmVersion = raw.algorithmVersion;
  if (typeof algorithmVersion !== "string" || !algorithmVersion) return null;

  const garment = readGarmentColor(raw.garment);
  if (!garment) return null;

  return {
    lpi,
    angleDeg: angleDeg as HalftoneScreenAngle,
    dotShape: dotShape as HalftoneDotShape,
    midtone,
    chokePx,
    garment,
    algorithmVersion,
  };
}

function readGarmentColor(value: unknown): GarmentColor | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const label = raw.label;
  const hex = raw.hex;
  if (typeof label !== "string" || !label) return null;
  if (typeof hex !== "string" || !/^#[0-9A-F]{6}$/.test(hex)) return null;
  const rgb = raw.rgb;
  if (!rgb || typeof rgb !== "object") return null;
  const { r, g, b } = rgb as Record<string, unknown>;
  const channels = [r, g, b];
  if (
    channels.some(
      (c) => typeof c !== "number" || !Number.isInteger(c) || c < 0 || c > 255,
    )
  ) {
    return null;
  }
  return { label, hex, rgb: { r: r as number, g: g as number, b: b as number } };
}

export const GARMENT_SIZE_CLASSES: readonly GarmentSizeClass[] = [
  "youth",
  "womens_small",
  "adult_standard",
  "adult_plus",
  "custom",
];

/**
 * Narrows a raw persisted column to the garment vocabulary.
 *
 * Unlike `readStoredRequestedProductionOutput`, an unrecognized value reads
 * back as `null` (= never stated) rather than a fail-closed sentinel, and
 * that asymmetry is deliberate. A requested production OUTPUT decides what we
 * are allowed to produce, so an unreadable one must refuse. A garment size
 * class only seeds a SUGGESTION and authorizes nothing; the thing standing
 * between this row and a paid provider call is
 * `productionSizeConfirmedAt`, which an unreadable garment class cannot
 * affect. Reading it as "never stated" therefore loses no safety and keeps an
 * older build usable against a newer row.
 *
 * Lives in the domain, not in `capabilities/shared`, so `lib/db` can narrow
 * its own rows without depending on a capability (ARCHITECTURE dependency
 * direction). `shared/garment-production-sizing.ts` re-exports it so the
 * capability layer still has one import surface for sizing.
 */
export function readGarmentSizeClass(
  value: string | null | undefined,
): GarmentSizeClass | null {
  if (!value) return null;
  return (GARMENT_SIZE_CLASSES as readonly string[]).includes(value)
    ? (value as GarmentSizeClass)
    : null;
}

export interface PrintProject {
  id: string;
  name: string;
  status: ProjectStatus;
  selectedArtworkVersionId: string | null;
  /**
   * Sprint 2M Phase 2G (Goal 3): the durable authority that "the customer
   * requested a change that is not yet represented by the artwork." Kept
   * as its own boolean rather than overloading `status` — the Revision
   * Lifecycle Audit found `status === "revision_requested"` is written on
   * every message in the revision loop (including ones that changed
   * nothing) and is therefore too weak a signal to gate finalization on.
   * `true` from the moment an explicit revision request is understood
   * until a new `ArtworkVersion` batch produced by that revision exists
   * (cleared on regeneration completion, never merely on enqueue). While
   * `true`, `FinalArtworkCapability.requestFinalArtwork` refuses to create
   * a `FinalDirectionApproval`/`FinalArtworkJob` for this project, and any
   * previously-active approval is superseded immediately rather than left
   * to be raced by a still-running finalization job.
   */
  revisionPending: boolean;
  /**
   * Sprint 2G Live Acceptance Corrective Pass: the explicit "this is my
   * final direction, no more changes" confirmation — distinct from, and
   * strictly stronger than, `selectedArtworkVersionId` (which only ever
   * means "I want to work with this direction" and is immediately
   * revisable). `false` from the moment a concept is selected (or a
   * revision changes the current artwork) until the customer explicitly
   * confirms via `ConversationCapability.confirmSelectedDirection` (or the
   * equivalent "no changes" chat phrase). `FinalArtworkCapability.requestFinalArtwork`
   * refuses to finalize while this is `false`, independent of
   * `revisionPending` — a customer who has never been asked "does this
   * look right?" must never be able to finalize just because nothing is
   * currently pending.
   */
  finalDirectionConfirmed: boolean;
  /**
   * Sprint A4: the acquisition session that created this project — the
   * server-side authority every paid-value gate resolves from.
   *
   * Deliberately resolved from the PROJECT rather than from the request.
   * A gate that trusted a cookie could be bypassed by clearing it; a gate
   * that reads the project's own durable binding cannot, which is what
   * makes a direct API call no more powerful than the UI (Goal 17).
   *
   * `null` means the project was created before acquisition sessions
   * existed — a legacy project, grandfathered so pre-A4 work keeps
   * functioning. It never means "unentitled". After A4 every project
   * created through the API is bound at insert, so no new `null` can
   * appear through a customer path.
   */
  acquisitionSessionId: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Sprint A4: the acquisition entitlement tier a session holds.
 *
 *   "prospect" — an ordinary anonymous visitor. One free concept, then
 *                email to continue, then (Sprint A5) payment.
 *   "internal" — explicitly granted server-side against a configured
 *                secret, for real Print'em All production work and
 *                acceptance testing. Never inferred from an email address,
 *                a query string, a browser flag, or `NODE_ENV`.
 *
 * There is deliberately no `"paid"` tier. Payment entitlement is Sprint A5
 * work, and introducing a value nothing can legitimately write would be a
 * capability that only looks implemented.
 */
export type AcquisitionEntitlement = "prospect" | "internal";

/**
 * Sprint A4: an opaque, server-issued anonymous session.
 *
 * NOT authentication, NOT an account, NOT a customer identity model. Its
 * entire job is spend control — "has this browser session already had its
 * one free concept?" — plus the email captured to continue the design
 * session. It holds no password, no verified identity, and no marketing
 * consent, and its existence must never be described to a customer as an
 * account having been created.
 *
 * ALLOCATION vs CONSUMPTION is the distinction the whole entitlement rests
 * on, and the two fields below are not redundant:
 *
 *   freeConceptProjectId — the free concept has been ALLOCATED to this
 *     project. Claimed atomically before any generation job exists, so two
 *     racing requests cannot both be allocated. Allocation alone costs the
 *     customer nothing: a prospect whose enqueue failed before a durable
 *     job existed still has their free concept, and re-requesting on the
 *     same project simply resumes the same allocation.
 *
 *   freeConceptGenerationJobId — the free concept has been CONSUMED by this
 *     job. Written only after the `GenerationJob` row is durable, which is
 *     the moment the platform has actually committed to a recoverable,
 *     idempotent, spend-bounded generation attempt. Once set, no second
 *     free generation is ever authorized for this session.
 */
/**
 * Sprint A4 Correction 2: the durable tombstone recording that an
 * acquisition session has taken its ONE free concept attempt.
 *
 * The session id is the PRIMARY KEY of the backing table, so the row itself
 * IS the invariant — one claim per session, for the lifetime of the session
 * rather than the lifetime of a generation job.
 *
 * `generationJobId` is deliberately historical evidence rather than a live
 * relationship: it carries no foreign key, so it keeps its value (and the
 * claim keeps enforcing) after the job it names has been deleted. A dangling
 * id here is the correct record of what happened, not corruption.
 */
export interface AcquisitionFreeConceptClaim {
  acquisitionSessionId: string;
  /** The job that took the claim. May no longer resolve. */
  generationJobId: string | null;
  claimedAt: string;
}

export interface AcquisitionSession {
  id: string;
  /**
   * The opaque bearer value carried in an httpOnly cookie. Never logged,
   * never returned in a customer-facing snapshot, never placed in a URL.
   */
  sessionToken: string;
  entitlement: AcquisitionEntitlement;
  freeConceptProjectId: string | null;
  freeConceptAllocatedAt: string | null;
  freeConceptGenerationJobId: string | null;
  freeConceptConsumedAt: string | null;
  /** Normalized (trimmed, lowercased). Captured to continue, never consent. */
  email: string | null;
  emailCapturedAt: string | null;
  internalGrantedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Sprint A5.1 — the Production Unlock (commercial entitlement)
// ---------------------------------------------------------------------------

/**
 * Sprint A5.1: WHICH PRODUCTION PATH a commercial unlock authorizes.
 *
 * WHY THIS IS ITS OWN NARROW UNION AND NOT `ProductionCategory`
 *
 * `ProductionCategory` (`capabilities/print-validation/contracts.ts`) is the
 * right VOCABULARY — `"apparel_raster"` there means exactly what it means
 * here, and inventing a parallel "productionTarget" concept would be the
 * duplicate-authority mistake this architecture keeps refusing. But that
 * union is a CLASSIFICATION of what is being asked for, so it also carries
 * values that describe refusals and dormant roles:
 *
 *   apparel_vector        an honest "we do not produce that"
 *   out_of_scope_product  outside the product entirely
 *   signage / logo_vector reserved, dormant, produced by nothing today
 *   unknown               could not be classified
 *
 * None of those is a thing a customer can be sold, and a grantable-profile
 * type that contains them is one typo away from persisting an unlock for a
 * production path that does not exist. So this is the strict GRANTABLE
 * subset — every value here is a production outcome iHeartPrints actually
 * produces, and `production-unlock-profile.test.ts` asserts at compile time
 * that it stays a subset of `ProductionCategory` (a type-level check rather
 * than an import, so the domain layer keeps depending on nothing).
 *
 * The database carries the same restriction independently, as a CHECK
 * constraint. A string existing in a column must never be what authorizes a
 * production path.
 *
 * This is a production OUTCOME, never a file format. `"apparel_raster"` is
 * "raster garment decoration", not "PNG" — the deliverable that profile
 * currently produces is a validated Production PNG, and that is a fact about
 * V1's pipeline, not about what was purchased.
 */
export const GRANTABLE_PRODUCTION_PROFILES = ["apparel_raster"] as const;

export type ProductionProfile = (typeof GRANTABLE_PRODUCTION_PROFILES)[number];

/** The one production profile V1 sells. Named so call sites read as intent. */
export const APPAREL_RASTER_PRODUCTION_PROFILE = "apparel_raster" as const;

/**
 * Sprint A5.1: a persisted production profile this build cannot interpret —
 * a newer deploy (or a corrupt row) wrote a value that is not in
 * `GRANTABLE_PRODUCTION_PROFILES`.
 *
 * Deliberately a distinct sentinel rather than a coercion to
 * `"apparel_raster"`, exactly mirroring `UnrecognizedProductionOutput`: an
 * app that cannot read which production path was purchased must refuse to
 * authorize one, not assume the answer is the one it happens to implement.
 */
export const UNRECOGNIZED_PRODUCTION_PROFILE = "unrecognized_profile" as const;

export type UnrecognizedProductionProfile =
  typeof UNRECOGNIZED_PRODUCTION_PROFILE;

/** What a persisted profile column may narrow to. */
export type StoredProductionProfile =
  | ProductionProfile
  | UnrecognizedProductionProfile;

/**
 * Sprint A5.1: the lifecycle of one production unlock.
 *
 *   "active"  — this project may be prepared for production under this
 *               profile. The only value any gate treats as permission.
 *   "revoked" — the grant was withdrawn (refund, chargeback, operator
 *               action). The row is NEVER deleted and prior FinalArtworkJobs
 *               and produced assets are never touched: revocation stops
 *               FUTURE finalization, it does not rewrite history.
 *
 * Deliberately NO payment-lifecycle values (`pending`, `paid`, `failed`).
 * Those belong to a payment TRANSACTION record, which A5.3+ introduces; a
 * status enum that mixed "did the money arrive" with "may this project be
 * produced" would make the entitlement question unanswerable without also
 * knowing a provider's vocabulary. This slice deliberately has no provider.
 */
export const PRODUCTION_UNLOCK_STATUSES = ["active", "revoked"] as const;

export type ProductionUnlockStatus =
  (typeof PRODUCTION_UNLOCK_STATUSES)[number];

/**
 * Sprint A5.1: a persisted status this build cannot interpret. Same
 * reasoning as `UNRECOGNIZED_PRODUCTION_PROFILE`, in the direction that
 * matters most: **NULL and unknown are never "active"**.
 */
export const UNRECOGNIZED_PRODUCTION_UNLOCK_STATUS =
  "unrecognized_status" as const;

export type StoredProductionUnlockStatus =
  | ProductionUnlockStatus
  | typeof UNRECOGNIZED_PRODUCTION_UNLOCK_STATUS;

/**
 * Sprint A5.1 — THE COMMERCIAL ENTITLEMENT.
 *
 * "This design project may be prepared for production under one production
 * profile."
 *
 * THE KEY IS THE PROJECT. Deliberately, and this is the load-bearing design
 * decision of the whole sprint. The obvious alternative — binding the
 * purchase to the `FinalDirectionApproval` the customer was looking at when
 * they paid — is wrong because that record is designed to be cheap to
 * supersede, and is superseded from four separate code paths, one of which
 * fires the moment a customer *says* they want a change
 * (`ConversationCapability.triggerAutomaticRevision`). An entitlement bound
 * there would be revoked by the customer's first post-purchase sentence.
 *
 * Every other candidate fails for a related reason:
 *
 *   ArtworkVersion            replaced by every targeted revision
 *   FinalArtworkJob           created AFTER the gate that would authorize it
 *   AssetRecord / the PNG     an OUTPUT of the paid work, not the permission
 *   requestedProductionOutput deliberately mutable — the customer may change
 *                             their mind, and doing so must not void a
 *                             purchase
 *
 * The project is the only identifier in this domain that survives revision,
 * approval supersession, regeneration, and a change of requested output. It
 * is also already the authority every acquisition gate resolves from
 * (`AcquisitionCapability.resolveAuthority`), so the commercial gate and the
 * spend gate agree by construction rather than by convention.
 *
 * WHAT THIS RECORD IS NOT
 *
 *   Not a payment. No amount, no currency, no provider id, no transaction
 *   state — those belong to payment records this slice deliberately does not
 *   create. An unlock says a project may be produced; it says nothing about
 *   how that permission was obtained, which is what lets an operator grant
 *   one for support reasons without inventing a fake charge.
 *
 *   Not a technical capability. A project may hold an active unlock and
 *   still be refused finalization because it asks for an artifact V1 does
 *   not produce (`requestedProductionOutput`), because its concepts are
 *   stale, or because a revision is pending. Commercial permission never
 *   manufactures technical capability.
 *
 *   Not a generation allowance. A5.1/A5.2 unlocks FINALIZATION ONLY.
 *   `authorizeConceptGeneration` is untouched.
 *
 *   Not identity. `acquisitionSessionId` records WHO bought it, resolved
 *   server-side from the project's own durable binding — never from a
 *   cookie, a header, or a request body.
 */
export interface ProductionUnlock {
  id: string;
  /** The durable entitlement key. */
  projectId: string;
  /**
   * The acquisition session that held this project when the unlock was
   * granted. Attribution and a fail-closed cross-check — never an
   * independent authority, and never accepted from a caller.
   */
  acquisitionSessionId: string;
  /** Narrowed fail-closed on read; an uninterpretable value never authorizes. */
  productionProfile: StoredProductionProfile;
  /** Narrowed fail-closed on read; only the literal `"active"` is permission. */
  status: StoredProductionUnlockStatus;
  grantedAt: string;
  revokedAt: string | null;
  /** Operational note. Never customer-facing, never a provider message. */
  revokedReason: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Narrows a raw persisted profile column to the grantable vocabulary,
 * FAILING CLOSED.
 *
 *   recognized grantable value → that value
 *   anything else, including
 *   null/empty                 → the unrecognized sentinel, which no gate
 *                                treats as authorization
 *
 * Never returns `null` for a present-but-unreadable value: "absent" and
 * "unreadable" would then be the same thing to a caller, and only one of
 * them means a row exists that somebody may have paid for.
 */
export function readStoredProductionProfile(
  raw: string | null | undefined,
): StoredProductionProfile {
  if (raw == null || raw === "") return UNRECOGNIZED_PRODUCTION_PROFILE;
  if ((GRANTABLE_PRODUCTION_PROFILES as readonly string[]).includes(raw)) {
    return raw as ProductionProfile;
  }
  return UNRECOGNIZED_PRODUCTION_PROFILE;
}

/** The same narrowing for the status column. NULL is never `"active"`. */
export function readStoredProductionUnlockStatus(
  raw: string | null | undefined,
): StoredProductionUnlockStatus {
  if (raw == null || raw === "") return UNRECOGNIZED_PRODUCTION_UNLOCK_STATUS;
  if ((PRODUCTION_UNLOCK_STATUSES as readonly string[]).includes(raw)) {
    return raw as ProductionUnlockStatus;
  }
  return UNRECOGNIZED_PRODUCTION_UNLOCK_STATUS;
}

/**
 * THE ONE PLACE an unlock becomes permission.
 *
 * Every condition is positive and explicit — there is no "not revoked"
 * anywhere, because a future status this build has never heard of must not
 * pass a negative test. The profile is re-checked here as well as in the
 * query, because a gate that trusts its caller's filter is a gate that stops
 * working the day someone adds a second call site.
 */
export function productionUnlockAuthorizes(
  unlock: ProductionUnlock | null | undefined,
  input: { projectId: string; productionProfile: ProductionProfile },
): boolean {
  if (!unlock) return false;
  if (unlock.status !== "active") return false;
  if (unlock.productionProfile !== input.productionProfile) return false;
  if (unlock.projectId !== input.projectId) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Sprint A5.3 — the Payment Transaction (one checkout / payment attempt)
// ---------------------------------------------------------------------------

/**
 * Sprint A5.3: which payment provider a transaction belongs to.
 *
 * A vocabulary rather than a free string for the same reason
 * `ProductionProfile` is one: a value in a column must never be what selects
 * a code path. Exactly one provider exists today.
 */
export const KNOWN_PAYMENT_PROVIDERS = ["stripe"] as const;

export type PaymentProviderKey = (typeof KNOWN_PAYMENT_PROVIDERS)[number];

export const UNRECOGNIZED_PAYMENT_PROVIDER = "unrecognized_provider" as const;

export type StoredPaymentProviderKey =
  | PaymentProviderKey
  | typeof UNRECOGNIZED_PAYMENT_PROVIDER;

/**
 * Sprint A5.3 — the lifecycle of ONE checkout / payment attempt.
 *
 * `"pending_provider"` IS THE POINT OF THIS ENUM, and it is not a
 * placeholder. A durable row has to exist BEFORE the provider is called,
 * because the provider needs our internal transaction id as its idempotency
 * key and as the metadata handle a later verified webhook reconciles
 * through. But at that instant no checkout session exists anywhere, and
 * calling that state `"created"` would be a lie that a crash then makes
 * permanent — a row claiming a checkout that was never created, occupying
 * the outstanding-attempt slot forever.
 *
 *   "pending_provider" — we intend to check out. Nothing exists at the
 *                        provider yet, or the attempt to create it ended
 *                        ambiguously. RESUMABLE: retrying replays the same
 *                        idempotency key, so the provider returns the same
 *                        session rather than a second one.
 *   "created"          — a provider checkout session genuinely exists and is
 *                        bound to this row. The customer may be sent to it.
 *                        NOT payment: `created` authorizes nothing.
 *   "failed"           — the attempt ended in a way that provably never
 *                        created a provider session. Frees the outstanding
 *                        slot so a fresh attempt may be made.
 *   "paid"             — Sprint A5.4 only, and only from a VERIFIED webhook.
 *   "expired"          — Sprint A5.4+: the provider session lapsed unused.
 *   "refunded"         — Sprint A5.4+.
 *
 * Sprint A5.3 writes only `pending_provider`, `created`, and `failed`. The
 * later three exist in the vocabulary now so the schema does not have to
 * change to record them, NOT because anything writes them yet.
 *
 * NONE OF THESE IS ENTITLEMENT AUTHORITY. Even `"paid"` will not be: it
 * records that money arrived. Whether a project may be prepared for
 * production is answered by `ProductionUnlock` and nothing else.
 */
export const PAYMENT_TRANSACTION_STATUSES = [
  "pending_provider",
  "created",
  "paid",
  "failed",
  "expired",
  "refunded",
] as const;

export type PaymentTransactionStatus =
  (typeof PAYMENT_TRANSACTION_STATUSES)[number];

export const UNRECOGNIZED_PAYMENT_TRANSACTION_STATUS =
  "unrecognized_status" as const;

export type StoredPaymentTransactionStatus =
  | PaymentTransactionStatus
  | typeof UNRECOGNIZED_PAYMENT_TRANSACTION_STATUS;

/**
 * The statuses that occupy the one outstanding-attempt slot for a
 * (project, profile). Mirrors the migration's partial unique index
 * predicate exactly; the two must not drift.
 *
 * `pending_provider` is included deliberately. An attempt whose provider
 * call ended ambiguously may correspond to a real, live checkout session we
 * simply failed to record — letting a second attempt start alongside it is
 * how a customer ends up looking at two payment pages for one purchase.
 */
export const OUTSTANDING_PAYMENT_TRANSACTION_STATUSES: readonly PaymentTransactionStatus[] =
  ["pending_provider", "created"];

/**
 * Sprint A5.3 — ONE CHECKOUT / PAYMENT ATTEMPT.
 *
 * WHAT THIS IS NOT: the entitlement. `ProductionUnlock` is, and remains,
 * the only thing that authorizes production preparation. A transaction
 * records that somebody was sent to a payment page and what happened next;
 * it never, at any status, grants anything. That separation is what makes
 * "the browser came back from Stripe" structurally incapable of unlocking a
 * project.
 *
 * `providerCheckoutSessionId` / `providerPaymentIntentId` are RECONCILIATION
 * HANDLES, never authority. They exist so a verified webhook (A5.4) can find
 * the row it is talking about. Possession of one proves nothing — anyone can
 * read a Stripe id out of a redirect URL.
 *
 * `amountMinor` / `currency` / `productionProfile` are frozen from
 * server-resolved configuration at creation and never re-read from config
 * afterwards. A price change must not retroactively rewrite what somebody
 * was charged.
 */
export interface PaymentTransaction {
  id: string;
  /** The project this attempt would unlock. Always the entitlement key. */
  projectId: string;
  /** Resolved from the PROJECT's durable binding, never from a request. */
  acquisitionSessionId: string;
  /** Narrowed fail-closed on read. */
  productionProfile: StoredProductionProfile;
  /** Narrowed fail-closed on read. */
  provider: StoredPaymentProviderKey;
  /** `null` until a provider checkout session genuinely exists. */
  providerCheckoutSessionId: string | null;
  /**
   * Where to send the customer. Stored rather than re-derived so a repeat
   * request reuses the SAME live session instead of creating a second one.
   * Provider-issued and short-lived; never a secret.
   */
  providerCheckoutUrl: string | null;
  /** `null` until the provider reports one (often only at completion). */
  providerPaymentIntentId: string | null;
  /** Frozen at creation from server config. Positive integer, minor units. */
  amountMinor: number;
  /** Frozen at creation. Lowercase ISO 4217. */
  currency: string;
  /** Narrowed fail-closed on read; nothing treats an unknown status as paid. */
  status: StoredPaymentTransactionStatus;
  createdAt: string;
  updatedAt: string;
}

/** Narrows a persisted provider column, FAILING CLOSED. */
export function readStoredPaymentProvider(
  raw: string | null | undefined,
): StoredPaymentProviderKey {
  if (raw == null || raw === "") return UNRECOGNIZED_PAYMENT_PROVIDER;
  if ((KNOWN_PAYMENT_PROVIDERS as readonly string[]).includes(raw)) {
    return raw as PaymentProviderKey;
  }
  return UNRECOGNIZED_PAYMENT_PROVIDER;
}

/**
 * Narrows a persisted transaction status, FAILING CLOSED.
 *
 * The direction that matters: a status this build cannot interpret is never
 * `"paid"`, and — just as importantly — is never silently treated as
 * outstanding either, so a corrupt row cannot permanently block a customer
 * from checking out.
 */
export function readStoredPaymentTransactionStatus(
  raw: string | null | undefined,
): StoredPaymentTransactionStatus {
  if (raw == null || raw === "") {
    return UNRECOGNIZED_PAYMENT_TRANSACTION_STATUS;
  }
  if ((PAYMENT_TRANSACTION_STATUSES as readonly string[]).includes(raw)) {
    return raw as PaymentTransactionStatus;
  }
  return UNRECOGNIZED_PAYMENT_TRANSACTION_STATUS;
}

/**
 * Whether a transaction currently occupies the outstanding-attempt slot.
 * Positive and explicit — never "not finished", which a future status this
 * build has never heard of would silently pass.
 */
export function isOutstandingPaymentTransaction(
  transaction: PaymentTransaction | null | undefined,
): boolean {
  if (!transaction) return false;
  return (OUTSTANDING_PAYMENT_TRANSACTION_STATUSES as readonly string[]).includes(
    transaction.status,
  );
}

/**
 * Whether this transaction can be handed to a customer as-is: a genuinely
 * created provider session with somewhere to send them.
 *
 * Deliberately requires BOTH the id and the URL. A `created` row missing
 * either is not a usable checkout, and pretending otherwise would send a
 * customer to `undefined`.
 */
export function isUsableCheckout(
  transaction: PaymentTransaction | null | undefined,
): transaction is PaymentTransaction & {
  providerCheckoutSessionId: string;
  providerCheckoutUrl: string;
} {
  if (!transaction) return false;
  return (
    transaction.status === "created" &&
    typeof transaction.providerCheckoutSessionId === "string" &&
    transaction.providerCheckoutSessionId.length > 0 &&
    typeof transaction.providerCheckoutUrl === "string" &&
    transaction.providerCheckoutUrl.length > 0
  );
}

// ---------------------------------------------------------------------------
// Sprint A5.4 — the Payment Event (one verified provider notification)
// ---------------------------------------------------------------------------

/**
 * Sprint A5.4: what the platform DID about one verified provider event.
 *
 * Deliberately a small, stable, product-owned vocabulary — NOT the provider's
 * event type, which is stored separately in `eventType`. Putting
 * `checkout.session.completed` in an outcome field would make the schema
 * track a provider's taxonomy forever and would answer the wrong question:
 * "what did they tell us" is not "what did we do about it".
 *
 *   "processed"         — the event was acted on. A payment was applied and a
 *                         `ProductionUnlock` is active, or a stale attempt was
 *                         expired. The ONLY outcome that ever accompanies a
 *                         commercial state change.
 *   "ignored"           — a validly-signed event this build does not act on:
 *                         an unsupported event type, or a state transition
 *                         that must not happen (an `expired` arriving for a
 *                         transaction that is already paid).
 *   "unmatched"         — no `PaymentTransaction` could be resolved. Provider
 *                         metadata NEVER bootstraps a purchase, so an event
 *                         naming a transaction we have no record of is
 *                         recorded and dropped.
 *   "rejected_mismatch" — a transaction was found and reconciliation FAILED:
 *                         wrong checkout session, wrong amount, wrong
 *                         currency, an unpaid payment status, a payment
 *                         intent already bound elsewhere, or a transaction in
 *                         a state that may not be activated. Nothing is
 *                         mutated. This is the outcome that must never be
 *                         confused with success.
 */
export const PAYMENT_EVENT_OUTCOMES = [
  "processed",
  "ignored",
  "unmatched",
  "rejected_mismatch",
] as const;

export type PaymentEventOutcome = (typeof PAYMENT_EVENT_OUTCOMES)[number];

export const UNRECOGNIZED_PAYMENT_EVENT_OUTCOME =
  "unrecognized_outcome" as const;

export type StoredPaymentEventOutcome =
  | PaymentEventOutcome
  | typeof UNRECOGNIZED_PAYMENT_EVENT_OUTCOME;

/**
 * Sprint A5.4 — the durable record that ONE verified provider event was
 * received, and what was done about it.
 *
 * THE UNIQUENESS ON `providerEventId` IS THE IDEMPOTENCY AUTHORITY. A payment
 * provider retries a webhook until it gets a 2xx, and network partitions mean
 * a retry can arrive while the first delivery is still being processed. The
 * insert of this row is taken FIRST, inside the same database transaction as
 * the payment application, so a concurrent duplicate blocks on the unique
 * index and then finds the conflict — it does not "check first and then act",
 * which is the pattern that lets two deliveries both pass a read.
 *
 * WHAT IS NOT STORED: the raw webhook payload. A provider's event body
 * carries a customer's email, billing address, card brand and last four,
 * provider customer and account identifiers, and amounts — none of which this
 * product needs after reconciliation, and all of which would become a durable
 * copy of payment PII sitting in the application database forever.
 * `payloadDigest` is a SHA-256 of the exact verified bytes: enough to prove
 * afterwards that a specific body was the one processed, and useless for
 * reconstructing what was in it.
 */
export interface PaymentEvent {
  id: string;
  /** Narrowed fail-closed on read. */
  provider: StoredPaymentProviderKey;
  /** The provider's own event id. UNIQUE — this is the idempotency fence. */
  providerEventId: string;
  /**
   * The provider's event type verbatim (e.g. `checkout.session.completed`).
   * Recorded for operational forensics only; no gate branches on it after
   * the fact.
   */
  eventType: string;
  /** SHA-256 (hex) of the exact raw bytes whose signature was verified. */
  payloadDigest: string;
  receivedAt: string;
  /** Set when the platform finished deciding. Narrowed fail-closed. */
  outcome: StoredPaymentEventOutcome;
  processedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Narrows a persisted outcome, FAILING CLOSED — an unknown value is never `processed`. */
export function readStoredPaymentEventOutcome(
  raw: string | null | undefined,
): StoredPaymentEventOutcome {
  if (raw == null || raw === "") return UNRECOGNIZED_PAYMENT_EVENT_OUTCOME;
  if ((PAYMENT_EVENT_OUTCOMES as readonly string[]).includes(raw)) {
    return raw as PaymentEventOutcome;
  }
  return UNRECOGNIZED_PAYMENT_EVENT_OUTCOME;
}

/**
 * Sprint A5.4: what the reconciliation authority decided. Returned by the
 * atomic operation and by nothing else.
 *
 * `"duplicate"` is deliberately NOT a stored outcome — a duplicate delivery
 * creates no row at all; it collides with the one that already exists. It is
 * a return value meaning "this event was already decided, and the answer
 * stands".
 */
export type PaymentEventApplication = PaymentEventOutcome | "duplicate";

/**
 * Sprint A2 (corrected): WHAT PRODUCTION ARTIFACT THE CUSTOMER ASKED
 * IHEARTPRINTS TO PRODUCE — structured, authoritative, and deliberately not
 * a decoration method.
 *
 * This exists because the first A2 pass derived the same fact by running
 * regexes over `productSummary`/`designDescription` at finalization time,
 * which is wrong in both directions. It blocked valid jobs whose prose
 * merely CONTAINED an artifact word ("no separations are needed", "I already
 * have the DST file", a shirt whose wording is "COLOR SEPARATIONS", a
 * customer called Screen Print Separations LLC), and it silently lost real
 * requests typed in chat that never reached those two brief fields at all.
 * Re-interpreting prose at the finalization gate cannot be made safe by
 * adding more regex; the interpretation has to happen once, at the point the
 * customer speaks, and be persisted as a value.
 *
 * `null` means UNSPECIFIED — the customer never asked for a particular
 * artifact. That is the overwhelmingly common case, the default for every
 * historical project, and it resolves to the supported Production PNG path
 * exactly as it always has.
 *
 *   "This will be screen printed."      → null (decoration context)
 *   "Just give me the PNG."             → "production_png"
 *   "Make the screen-print separations." → "screen_print_separations"
 *   "Digitize this for embroidery."     → "embroidery_digitization"
 *
 * A decoration method (`screen_print`, `embroidery`, `dtf`, `dtg`) is NEVER
 * one of these values. Naming a method says where artwork is going; it does
 * not order a file.
 */
export type RequestedProductionOutput =
  /** The supported iHeartPrints V1 deliverable. Behaves identically to `null`. */
  | "production_png"
  | "embroidery_digitization"
  | "screen_print_separations"
  | "vector_output"
  | "sublimation_specific";

/** Every value that is not the supported V1 output. Used by the finalization gates. */
export const UNSUPPORTED_REQUESTED_PRODUCTION_OUTPUTS = [
  "embroidery_digitization",
  "screen_print_separations",
  "vector_output",
  "sublimation_specific",
] as const satisfies readonly RequestedProductionOutput[];

/**
 * Sprint A2 Correction 2 (Goal 12): a persisted requested-output value the
 * RUNNING BUILD DOES NOT RECOGNIZE — a newer deploy wrote a production
 * profile this older app has never heard of, or a row was hand-edited.
 *
 * This build never WRITES this value; it only ever reads it, as the result
 * of failing to parse something. It exists because collapsing an
 * unrecognized string to `null` — the previous behavior — is the single most
 * dangerous thing this system could do with it: `null` means "the customer
 * asked for nothing in particular", so an unknown production request would
 * silently be answered with a Production PNG. An older app that cannot tell
 * what a customer asked for must refuse to produce, not guess.
 *
 * Deliberately NOT the same as `null`. `null` is a fact ("never asked");
 * this is an absence of knowledge ("asked for something we cannot read").
 * They are backward-compatible in opposite directions and must never be
 * merged.
 */
export const UNRECOGNIZED_PRODUCTION_OUTPUT = "unrecognized_production_output";

export type UnrecognizedProductionOutput = typeof UNRECOGNIZED_PRODUCTION_OUTPUT;

/**
 * What a persisted requested-output column can hold once read back: a known
 * value, or the fail-closed sentinel. `null` (never asked) is expressed by
 * the surrounding `| null`, never by this type.
 */
export type StoredRequestedProductionOutput =
  | RequestedProductionOutput
  | UnrecognizedProductionOutput;

/** Values this build knows how to write and act on. */
const KNOWN_REQUESTED_PRODUCTION_OUTPUTS: readonly string[] = [
  "production_png",
  ...UNSUPPORTED_REQUESTED_PRODUCTION_OUTPUTS,
];

/**
 * Narrows a raw persisted column to the domain vocabulary, FAILING CLOSED.
 *
 *   null/empty        → `null`   (never asked; every historical row)
 *   recognized value  → that value
 *   anything else     → the unrecognized sentinel, which no gate treats as
 *                       producible
 */
export function readStoredRequestedProductionOutput(
  raw: string | null | undefined,
): StoredRequestedProductionOutput | null {
  if (raw == null || raw === "") return null;
  if (KNOWN_REQUESTED_PRODUCTION_OUTPUTS.includes(raw)) {
    return raw as RequestedProductionOutput;
  }
  return UNRECOGNIZED_PRODUCTION_OUTPUT;
}

/**
 * Whether this value blocks production of the supported Production PNG.
 * `null` (never asked) and `"production_png"` do not; every unsupported
 * value does, and so does the unrecognized sentinel — that is what "fail
 * closed" means here.
 */
export function isUnsupportedRequestedProductionOutput(
  value: StoredRequestedProductionOutput | null | undefined,
): boolean {
  if (value == null) return false;
  return (
    value === UNRECOGNIZED_PRODUCTION_OUTPUT ||
    (UNSUPPORTED_REQUESTED_PRODUCTION_OUTPUTS as readonly string[]).includes(value)
  );
}

/**
 * The single normalization used for JOB IDENTITY and for comparing bound
 * intent against current intent. `null` and `"production_png"` are the same
 * request — a customer who never mentioned an artifact and one who
 * explicitly said "just the PNG" are asking for the identical deliverable —
 * so they must resolve to one key, or a retraction would fail to match the
 * PNG job it should reuse.
 *
 * Mirrors the migration's `coalesce(requested_production_output,
 * 'production_png')` index expression exactly; the two must not drift.
 */
export function normalizeProductionIntent(
  value: StoredRequestedProductionOutput | null | undefined,
): StoredRequestedProductionOutput {
  return value ?? "production_png";
}

/** Whether a job's bound intent still satisfies the project's current intent. */
export function productionIntentMatches(
  bound: StoredRequestedProductionOutput | null | undefined,
  current: StoredRequestedProductionOutput | null | undefined,
): boolean {
  return normalizeProductionIntent(bound) === normalizeProductionIntent(current);
}

export interface TShirtDesignBrief {
  id: string;
  projectId: string;
  customerName: string | null;
  projectName: string | null;
  productSummary: string | null;
  designDescription: string | null;
  exactText: string | null;
  shirtColor: string | null;
  /**
   * Sprint 2F: nullable. `null` means the customer has never confirmed a
   * print location — it is no longer defaulted to "full_front" at creation,
   * since that default was previously indistinguishable from a real answer.
   */
  printPlacement: PrintPlacement | null;
  /**
   * The WORKING production width intent, in inches. `null` means the
   * customer/operator has never expressed one.
   *
   * Print'em All Phase 1: this field is NOT production spend authority and
   * never was — a numeric value here can equally be a real choice or the
   * residue of one, and it cannot distinguish the two. The authority is
   * `productionSizeConfirmedAt` + `productionSizeConfirmedWidthIn` below.
   * See `shared/confirmed-production-size.ts`.
   */
  intendedPrintWidthIn: number | null;
  /**
   * Print'em All Phase 1: which garment sizing context the RECOMMENDED
   * production box should be derived for. `null` = never stated, which is
   * treated as an ASSUMED standard adult garment for recommendation purposes
   * only — and an assumption is never authority, which is exactly why
   * confirmation is a separate persisted fact.
   *
   * Lives on the MUTABLE working brief alongside `intendedPrintWidthIn` and
   * `requestedProductionOutput`, for the same reason: it is a production
   * specification, not creative content. Choosing a youth garment must not
   * restyle artwork, supersede an approved brief version, or mark concepts
   * stale, and it must be retractable.
   */
  garmentSizeClass: GarmentSizeClass | null;
  /**
   * Print'em All Phase 1 — THE PRODUCTION SPEND AUTHORITY.
   *
   * When the physical production size was EXPLICITLY confirmed by a human,
   * as an ISO timestamp. `null` means it never was, and no paid provider
   * work may be authorized for this project's current size.
   *
   * A persisted FACT rather than an inference. The live Print'em All job
   * that spent a Topaz credit with `intended_print_width_in = null` is the
   * reason: "a width exists" and "a human confirmed this width" are
   * different statements, and only the second one is spend authority.
   *
   * Never backfilled. A historical project whose width came from a default
   * is honestly unconfirmed, and must be confirmed before NEW paid work.
   */
  productionSizeConfirmedAt: string | null;
  /**
   * The exact physical print WIDTH, in inches, that
   * `productionSizeConfirmedAt` authorizes. Self-describing on purpose: the
   * confirmation names the size it approved, so no other writer of
   * `intendedPrintWidthIn` can ever inherit somebody else's confirmation.
   */
  productionSizeConfirmedWidthIn: number | null;
  /**
   * The confirmed CONTAINING BOX's height bound, in inches, or `null` when
   * the operator confirmed a width alone and height simply follows the
   * artwork's aspect ratio (bounded only by the placement's technical
   * limit).
   *
   * Set when a recommended BOX is confirmed — a 10.5x10.5 recommendation
   * contains a 2:3 portrait to 7.0x10.5, which a width alone cannot express.
   * Never an independent Y scale: both axes always move together.
   */
  productionSizeConfirmedMaxHeightIn: number | null;
  /**
   * Sprint A2 (corrected): the structured, authoritative answer to "what
   * production artifact are we being asked to produce?". `null` =
   * unspecified = the supported Production PNG path.
   *
   * Lives on the MUTABLE working brief and is deliberately absent from
   * `DesignBriefSnapshotContent`, for the same reason `intendedPrintWidthIn`
   * is: this is a production specification, not creative content. Two
   * consequences make that the only correct home:
   *
   *   - Asking for separations must not restyle artwork, supersede an
   *     approved brief version, or mark existing concepts stale. Nothing
   *     about the DESIGN changed.
   *   - It must be RETRACTABLE. A customer who says "actually, just give me
   *     the PNG" has to be able to un-ask. Frozen into an immutable approved
   *     version, an unsupported request would poison the project for good,
   *     recoverable only through a whole new approval cycle.
   *
   * Both workflows read it from here: Create New via the project snapshot's
   * working brief, and Existing Artwork the same way (uploads share the
   * project, brief, and conversation — there is no second brief to keep in
   * sync, and no fabricated `DesignBriefVersion`).
   */
  requestedProductionOutput: StoredRequestedProductionOutput | null;
  /**
   * Print'em All Phase 2 — THE PRODUCTION TREATMENT AUTHORITY.
   *
   * Which apparel-raster REPRESENTATION this project's plate is made as.
   * `"standard_raster"` unless a human explicitly selected otherwise; see
   * `shared/production-treatment.ts`.
   *
   * Recorded as a decision rather than derived, and the reason is specific:
   * DTF halftone can produce a plate at a physical size standard raster
   * honestly refuses (the live fixture needs 5.6x against a proven 4x
   * provider ceiling), so "standard raster was refused, therefore halftone"
   * is a chain a machine must never be able to complete on its own. It would
   * be the system talking itself into changing a customer's artwork.
   *
   * Lives on the MUTABLE working brief alongside `intendedPrintWidthIn`,
   * `garmentSizeClass`, and `requestedProductionOutput`, for the same
   * reason: a production specification, not creative content, and it must be
   * retractable without a new approval cycle.
   */
  productionTreatment: ProductionTreatment;
  /**
   * Print'em All Phase 2: the exact halftone screen settings the operator
   * selected — LPI, angle, dot shape, midtone, choke, the resolved garment
   * colour, and the engine version that interpreted them. `null` whenever
   * `productionTreatment` is not `"halftone_dtf"`.
   *
   * Persisted, never held in React state (Goal 16): an operator who reloads
   * must not have to remember what they chose, and a plate whose settings
   * nobody wrote down is a plate nobody can reproduce or explain to a printer.
   */
  halftoneSettings: HalftoneSettings | null;
  /**
   * Print'em All Phase 2: when a human EXPLICITLY selected the current
   * production treatment, as an ISO timestamp. `null` = never selected =
   * the default.
   *
   * The same audit fact `productionSizeConfirmedAt` is, for the same reason:
   * it is what keeps "halftone because an operator chose it" distinguishable,
   * forever afterwards, from "halftone because something defaulted".
   */
  productionTreatmentSelectedAt: string | null;
  preferredColors: string[];
  designStyle: string | null;
  additionalInstructions: string | null;
  /** Sprint 2F additions — additive, nullable, no historical backfill needed. */
  audience: string | null;
  purpose: string | null;
  exclusions: string | null;
  /**
   * Section keys (loosely typed as `string` here to avoid a domain →
   * capabilities import cycle; narrowed to `BriefSectionKey` at the
   * capability boundary) the customer explicitly deferred to the designer's
   * judgment, e.g. "you choose" in reply to a style question.
   */
  deferredSections: string[];
  createdAt: string;
  updatedAt: string;
}

/**
 * Sprint 2F: per-conversation adaptive interview bookkeeping. Never used as
 * Design Brief content — purely interview UX state (which section is
 * pending, how many times it has been asked, which advisories have already
 * been surfaced) so a reload can resume the adaptive loop without repeating
 * itself. `pendingSection` is loosely typed as `string` for the same reason
 * as `TShirtDesignBrief.deferredSections`.
 */
/**
 * Sprint 2G Part 3: one level of undo. The revisable-field snapshot of the
 * brief immediately before the most recently accepted change, plus enough
 * to describe it in plain language. Overwritten (not stacked) by the next
 * accepted change, and cleared after an undo — "undo most recent accepted
 * revision", not arbitrary history editing.
 */
export interface LastRevisionSnapshot {
  previousBrief: DesignBriefSnapshotContent;
  changedSections: string[];
}

export interface InterviewStateData {
  pendingSection: string | null;
  askCounts: Record<string, number>;
  dismissedAdvisories: string[];
  /** Sprint 2G Part 3: see `LastRevisionSnapshot`. `null` when there is nothing to undo. */
  lastRevision: LastRevisionSnapshot | null;
}

export function emptyInterviewState(): InterviewStateData {
  return {
    pendingSection: null,
    askCounts: {},
    dismissedAdvisories: [],
    lastRevision: null,
  };
}

export interface DesignConversation {
  id: string;
  projectId: string;
  phase: ConversationPhase;
  interviewState: InterviewStateData;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationMessage {
  id: string;
  conversationId: string;
  projectId: string;
  role: MessageRole;
  content: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

/**
 * Sprint 2H Part 1: provider-neutral, plain-language description of what to
 * generate — the only thing a `ConceptGenerationProvider` ever receives.
 * Produced by `PromptTranslationCapability` from an approved Design Brief
 * snapshot. Contains no provider prompt syntax or quality-boosting keywords
 * ("highly detailed", "8k", "masterpiece", "photorealistic", etc.) — those
 * belong exclusively inside each provider adapter's own internal prompt
 * translation, never here and never on the Design Brief itself.
 */
/**
 * Phase 2A: how `GenerationPromptRequest.colors` must be treated by a
 * generation provider. Derived by Prompt Translation from the approved
 * brief — never persisted on the brief itself.
 *
 * - `"hard"` — strong print/render palette emphasis for the image model
 *   when subject-object colors conflict with preferredColors (prompt
 *   guidance). Phase 2C.3A: inferred `"hard"` alone does NOT authorize
 *   automatic paid replacement — that requires `explicitInkRestriction`.
 * - `"soft"` — casual preferred-color preference; not a hard ink override.
 * - `"none"` — no artwork palette preference (or colors deferred).
 */
export type PrintPaletteEnforcement = "hard" | "soft" | "none";

/**
 * Phase 2C.3A: customer language that literally restricts printable ink.
 * Derived by Prompt Translation from existing brief text — never persisted.
 * Distinct from preferredColors / inferred `printPaletteEnforcement`.
 */
export type ExplicitInkRestrictionKind = "white_ink_only" | "no_black_ink";

export interface ExplicitInkRestrictionSummary {
  kind: ExplicitInkRestrictionKind;
}

export interface GenerationPromptRequest {
  product: string;
  subject: string;
  style: string | null;
  colors: string[];
  /**
   * Phase 2A: hard/soft/none treatment for `colors`. Providers must not
   * phrase a `"hard"` palette as optional "preferred colors".
   * Phase 2C.3A: this is prompt emphasis, not automatic spend authority.
   */
  printPaletteEnforcement: PrintPaletteEnforcement;
  /**
   * Phase 2C.3A: explicit literal ink restriction when the customer used
   * restrictive language (e.g. "white ink only"). Null for ordinary
   * preferred-color / contrast guidance. Spend authority and stronger
   * prohibition wording key off this field — not inferred `"hard"` alone.
   */
  explicitInkRestriction: ExplicitInkRestrictionSummary | null;
  /**
   * Phase 2A: color words that appear in subject semantics but are NOT part
   * of the print palette. Empty unless `printPaletteEnforcement` is
   * `"hard"`. Lets adapters warn against dominant ink in those colors
   * without erasing subject identity.
   */
  subjectOnlyColors: string[];
  productColor: string | null;
  /** The exact text to print — non-null ONLY when `wordingMode` is `"provided"`. */
  requiredWording: string | null;
  /**
   * Phase 1.1: which of the three text states this generation is under.
   * `requiredWording: null` alone is ambiguous — it is produced both by "the
   * customer hasn't answered yet" and by "the customer explicitly wants no
   * text at all", and those demand opposite provider behavior. Every
   * consumer must branch on this field, never guess from `requiredWording`.
   *
   * `"none"` is a HARD constraint: no words, letters, numbers, typography,
   * labels, captions, signage, decorative lettering, or invented brand text
   * anywhere in the artwork. It outranks concept-direction treatment, style
   * preferences, and every provider default.
   */
  wordingMode: RequiredWordingMode;
  printLocation: PrintPlacement | null;
  audience: string | null;
  purpose: string | null;
  exclusions: string | null;
  notes: string | null;
  /**
   * Sprint 2K Phase 3 (Goal 4): stylistic/reference touchpoints the customer
   * mentioned — era, mood, pop-culture cues such as "inspired by a 1960s
   * sitcom" or "like an old travel poster" — pulled out of `subject`/`style`
   * by `PromptTranslationCapability` so they never read as literal content.
   * These inform visual language only (typography, composition, era,
   * graphic language, palette) and must never be translated into an
   * instruction to depict real people, characters, logos, or copyrighted
   * material from the referenced work. Empty when the customer gave no such
   * reference.
   */
  inspirationReferences: string[];
  /**
   * Sprint 2K Phase 3 (Goal 7): whether the generated artwork may include
   * text beyond `requiredWording`. Always `false` today — generation must
   * not invent slogans, dates, or other wording the brief never asked for.
   * Represented here (provider-neutral) rather than left to each adapter's
   * own prompt phrasing.
   */
  allowAdditionalText: boolean;
  /**
   * Sprint 2G Live Acceptance Corrective Pass: when set, generation must
   * produce exactly ONE concept in this specific catalog direction — a
   * targeted revision of a customer-selected concept, never a fresh
   * three-direction exploration. `null` for initial exploration and for an
   * explicit "show me alternatives" request, both of which still produce
   * all three directions.
   */
  targetConceptDirectionKey?: ConceptDirectionKey | null;
  /**
   * Phase 2C: `true` ONLY when this generation is an automatic REPLACEMENT
   * for a candidate the deterministic Phase 2B validator hard-failed on the
   * required print palette / garment contrast.
   *
   * Provider-neutral by design — it states the FACT, never the wording. A
   * replacement is otherwise byte-for-byte the same request as the candidate
   * it replaces (same brief, same direction, same hard palette, same wording
   * contract, same exclusions), because a replacement is that concept
   * corrected, not a different design. Absent/`false` everywhere else,
   * including on every targeted revision.
   */
  printPaletteCorrection?: boolean;
  /**
   * True Source-Image Targeted Revision: present ONLY for a targeted
   * revision of a customer-selected concept. When set, the generation
   * contract changes shape entirely — the provider must EDIT the supplied
   * source artwork rather than interpret the brief afresh:
   *
   *     REVISED ARTWORK = SELECTED SOURCE ARTWORK + REQUESTED DELTA
   *
   * `null` for initial generation and for a three-direction "show me
   * alternatives" regeneration, both of which remain pure text-to-image.
   */
  revision?: RevisionDirective | null;
}

/**
 * True Source-Image Targeted Revision: the provider-neutral delta for one
 * targeted revision. Plain customer-facing language only — never prompt
 * syntax, never a provider dialect, never a Design Brief entity.
 *
 * Built by `PromptTranslationCapability` from the customer's literal
 * instruction plus the `RegenerationPlan`; consumed by an image-edit
 * provider adapter, which owns 100% of the wording that expresses it.
 */
export interface RevisionDirective {
  /**
   * The distinct changes the customer actually asked for, in the order
   * they asked for them. "change the font to retro and remove the sunset"
   * arrives here as TWO entries — never as one blurred restatement of the
   * whole design, and never collapsed into `notes`.
   */
  requestedChanges: string[];
  /**
   * Elements confirmed to be working that must survive the edit unchanged.
   * The DEFAULT contract is "preserve everything not listed in
   * `requestedChanges`"; this only adds specifics worth naming explicitly.
   */
  preserve: string[];
  /** Elements that must not appear — exclusions and rejected directions. */
  avoid: string[];
  /**
   * Exact wording that must come through the edit character-for-character.
   * `null` when the design has no required wording, or when the customer's
   * own requested delta is a wording change (in which case changing it is
   * the point — see `wordingChangeRequested`).
   */
  lockedWording: string | null;
  /**
   * True when the customer explicitly asked to change the wording. Keeps
   * "protect the exact wording" from silently overriding "change the
   * wording to MR2 TURBO".
   *
   * Live Acceptance Cleanup: naming a text element while asking for an
   * APPEARANCE change ("make the 3 SONS text the same color as the ball")
   * is emphatically NOT this — see `shared/revision-delta.ts` and Prompt
   * Translation's `requestsWordingChange`. Misclassifying it lifted the
   * exact-wording lock and let an unrelated word be re-rendered.
   */
  wordingChangeRequested: boolean;
  /**
   * Live Acceptance Cleanup: the customer explicitly said "everything else
   * stays the same" (or "don't change anything else" / "leave the rest
   * alone"). The default contract is already "preserve everything not in
   * `requestedChanges`"; this records that the customer stated it, so the
   * adapter can express it as its own hard constraint rather than leaving
   * it buried inside a change description. `false` when they simply didn't
   * say it — never inferred, and never a weaker contract when absent.
   */
  preserveEverythingElse: boolean;
}

/**
 * Sprint 2H Part 1: customer-never-sees-this lifecycle for a single
 * generation attempt. Modeled as its own durable record (rather than inline
 * fields on `ArtworkVersion`) so a job can be looked up, resumed, and
 * retried by its deterministic `idempotencyKey` without depending on
 * whether it ever produced any concepts.
 */
export type GenerationJobStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  /**
   * Sprint 2H Part 2A: a "running" job whose worker went silent (no
   * heartbeat) for too long — the process that claimed it likely died
   * mid-attempt. Distinct from "failed": nothing about generation itself
   * failed, so a job in this state is eligible to be claimed and retried
   * again, same as "queued".
   */
  | "recoverable";

/**
 * Sprint 2H Part 2A: which customer-facing flow this job belongs to. The
 * worker is otherwise fully self-sufficient (it never talks to
 * ConversationCapability) — this is what lets it choose the right
 * completion/failure message and post-success side effect (clearing the
 * concept selection only applies to a regeneration) purely from the job
 * record, without the caller staying involved after enqueueing.
 */
export type GenerationJobKind = "initial" | "regeneration";

export interface GenerationJob {
  id: string;
  projectId: string;
  designBriefVersionId: string;
  status: GenerationJobStatus;
  kind: GenerationJobKind;
  conceptCount: number;
  /** Internal only — never surfaced to conversation/customer. */
  providerKey: string;
  /**
   * Deterministic identity — the same (project, approved brief version)
   * pair always maps to the same job, so retrying never creates duplicate
   * concepts (Sprint 2H Part 1 idempotency strategy).
   */
  idempotencyKey: string;
  /**
   * Sprint 2G Live Acceptance Corrective Pass: when set, this job is a
   * targeted revision of ONE customer-selected `ArtworkVersion` — the
   * worker produces exactly one new concept, tagged
   * `sourceArtworkVersionId` = this value, in that source's own
   * `conceptDirectionKey`. `null` for initial exploration and for an
   * explicit "show me alternatives" regeneration, both of which still
   * produce three independent directions with no source.
   */
  targetArtworkVersionId?: string | null;
  /**
   * True Source-Image Targeted Revision: the customer's literal revision
   * instruction for this job ("make the border red and change it to a
   * shield"), captured at enqueue time.
   *
   * A targeted revision is SOURCE ARTWORK + REQUESTED DELTA, and the delta
   * only exists in the customer's own words: the Design Brief records
   * design *state*, and `RegenerationPlan` only knows which brief sections
   * were touched. Without this column the worker has no durable way to tell
   * an image-edit provider what to change, which is exactly how a "targeted
   * revision" degenerated into a fresh text-to-image generation.
   *
   * Internal only — never surfaced through `ProjectSnapshot`, never shown to
   * the customer, never mistaken for prompt text (Prompt Translation, not
   * this field, decides how it reaches a provider). `null` for initial
   * generation, for a three-direction "show me alternatives" regeneration,
   * and for jobs created before this column existed.
   */
  revisionInstruction?: string | null;
  /**
   * Sprint A4 Correction 1: the acquisition session whose ONE free concept
   * this job spends. `null` for every ordinary job — internal, legacy, paid,
   * and every job that existed before this column.
   *
   * It is deliberately three things at once, and each one has to be durable
   * on the JOB rather than derived from somewhere else:
   *
   *   AUTHORITY. A partial unique index on this column makes "at most one
   *     free-concept job per acquisition session" a database invariant. That
   *     is what makes a second free job impossible even if the session's own
   *     consumption marker was never written — the failure mode a separate
   *     durable write cannot defend against.
   *
   *   ECONOMICS. `paidIntentBudgetForGenerationJob` caps a job with this set
   *     at exactly ONE paid image dispatch, and Phase 2C replacement is not
   *     offered for it. `conceptCount === 1` alone was never sufficient: the
   *     replacement allowance is added on top of the concept count, so a
   *     "one free concept" job carried a budget of three paid images.
   *
   *   RECONCILIATION. "Has this session spent its free concept?" is
   *     answerable from here when `AcquisitionSession.freeConceptConsumedAt`
   *     is missing because a crash landed between the two writes.
   *
   * The worker reads it from the job it claimed. It must never be inferred
   * from request context, a cookie, or UI state — none of which a background
   * worker has, and none of which is authority in the first place.
   */
  acquisitionSessionId?: string | null;
  attempts: number;
  /** Sanitized, non-secret description of the most recent failure, if any. */
  lastError: string | null;
  /** Sprint 2H Part 2A: set each time a worker claims this job. */
  startedAt: string | null;
  /** Sprint 2H Part 2A: set once, when the job reaches "completed". */
  completedAt: string | null;
  /**
   * Sprint 2H Part 2A: bumped periodically while a worker is actively
   * running this job. `recoverAbandonedJobs` uses staleness here — not
   * `updatedAt` — to decide a job's worker has gone silent, so an
   * intentional status/attempts update doesn't reset the abandonment clock.
   */
  heartbeatAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Phase 2C0.5: the lifecycle of ONE logical paid image intent.
 *
 *   "reserved"  — a worker has durably claimed this intent and is about to
 *                 dispatch (or has dispatched) a paid provider request for
 *                 it. Reserved BEFORE the call, never after, so a crash
 *                 mid-flight leaves evidence that money may already have
 *                 been spent.
 *   "succeeded" — the provider returned a usable image AND its bytes are
 *                 durably persisted as an `AssetRecord`. This is the only
 *                 status that authorizes REUSE without paying again.
 *   "failed"    — this intent exhausted `MAX_PAID_DISPATCHES_PER_INTENT`
 *                 without ever producing a durable image. Terminal: the
 *                 job fails rather than paying a third time.
 */
export type PaidImageIntentStatus = "reserved" | "succeeded" | "failed";

/**
 * Phase 2C0.5: the durable, at-most-once record of one paid image intent.
 *
 * This is the smallest unit that can answer "has this exact paid image
 * already been bought?" — see `capabilities/shared/paid-image-intent.ts`
 * for the identity contract and why no existing table could carry it.
 *
 * Internal only: never surfaced through `ProjectSnapshot`, never shown to a
 * customer, and `result` is a SANITIZED concept envelope (titles, direction,
 * asset ids, asset dimensions) — never prompt text, never image bytes,
 * never credentials.
 */
export interface PaidImageIntent {
  id: string;
  projectId: string;
  generationJobId: string;
  /** Deterministic identity — see `buildPaidImageIntentKey`. */
  intentKey: string;
  /** `"initial_concept" | "targeted_revision" | "replacement"`. */
  intentKind: string;
  /** Catalog direction, or `"batch"` for a provider with no per-direction path. */
  directionKey: string;
  /**
   * 1-based slot within this job's paid-intent budget. Unique per job, so
   * two racing workers can never both take the same slot, and bounded by a
   * database CHECK so a sixth intent is impossible even if code is wrong.
   */
  paidIntentOrdinal: number;
  status: PaidImageIntentStatus;
  /**
   * How many times this intent has been DISPATCHED to the provider, across
   * every worker and every reclaim. Bounded by
   * `MAX_PAID_DISPATCHES_PER_INTENT`.
   */
  dispatches: number;
  /**
   * Fencing token for the current reservation. Only the worker holding the
   * live token may mark this intent succeeded — a zombie worker that wakes
   * up after its job was reclaimed holds a stale token and its write is
   * refused, so it can never overwrite the newer worker's result.
   */
  claimToken: string | null;
  providerKey: string | null;
  /** Present when the provider exposed one — never a credential. */
  providerRequestId: string | null;
  /** Sanitized concept envelope; `null` until the intent succeeds. */
  result: Record<string, unknown> | null;
  /** Sanitized, non-secret description of the most recent failure. */
  lastError: string | null;
  succeededAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Sprint 2H Part 1: a generated or uploaded file and its metadata. Storage
 * itself stays abstracted behind `storageKey` (an opaque reference — a data
 * URI today, a real object-store key in a future sprint) so swapping
 * storage backends never touches the domain model.
 */
export type AssetKind =
  | "customer_upload"
  | "logo"
  | "reference_image"
  | "generated_artwork"
  | "svg"
  | "png"
  | "pdf";

export interface AssetRecord {
  id: string;
  projectId: string;
  kind: AssetKind;
  /** Opaque reference to where the bytes live. Never a customer-facing detail. */
  storageKey: string | null;
  contentType: string | null;
  /** True when this record is a thumbnail companion to another asset. */
  isThumbnail: boolean;
  widthPx: number | null;
  heightPx: number | null;
  hasTransparency: boolean | null;
  /** Internal provenance only — never surfaced to the customer. */
  providerKey: string | null;
  generationJobId: string | null;
  /** Sanitized provider response envelope. Must never contain prompt text or credentials. */
  metadata: Record<string, unknown>;
  /** Reserved for a future vector (SVG) companion asset. */
  vectorAssetId: string | null;
  /** Reserved for a future print-ready production asset. */
  printAssetId: string | null;
  /**
   * Sprint 2M Phase 2B: set only on a production asset a
   * `FinalArtworkCapability`/`FinalArtworkWorkerCapability` transformation
   * produces for a given `FinalArtworkJob` — never set on a concept-stage
   * asset. This is the unambiguous, non-filename, non-path way to tell a
   * concept source image apart from a production deliverable (Goal 8):
   * `generationJobId !== null` means "concept asset"; `finalArtworkJobId
   * !== null` means "production asset". One `FinalArtworkJob` may
   * eventually own multiple production assets (PNG + SVG + PDF), since
   * this is a foreign key, not a 1:1 slot. Always `null` until Sprint 2M
   * Phase 2C's worker runs.
   */
  finalArtworkJobId: string | null;
  /**
   * Sprint 2M Phase 2C: explicit production-deliverable classification —
   * Goal 10 requires this because the `finalArtworkJobId` foreign key alone
   * cannot distinguish a future PNG from an SVG from a PDF once one job
   * owns more than one production asset. `null` for every concept-stage
   * asset (`generationJobId !== null`). Never inferred from `contentType`
   * or a filename — always set explicitly by whichever capability creates
   * the row.
   */
  productionRole: ProductionAssetRole | null;
  createdAt: string;
}

/**
 * Sprint 2M Phase 2C (Goal 10): explicit production-asset kind. Phase 2C
 * only ever produces `"production_png"` (Goal 17 — raster apparel PNG is
 * the only supported production output); `"production_svg"`/
 * `"production_pdf"` are reserved for a future vector/PDF production
 * pipeline, not implemented here.
 */
export type ProductionAssetRole =
  | "production_png"
  | "production_svg"
  | "production_pdf";

/**
 * Sprint 2I Phase 1: internal ArtworkVersion workflow state for Concept
 * Evaluation. Never invents customer-visible wording — UI must not render
 * these labels as product language.
 */
export type ConceptEvaluationStatus =
  | "pending"
  | "passed"
  | "needs_review"
  | "failed";

export type ConceptEvaluationCriterionKey =
  | "required_wording"
  | "style"
  | "graphics"
  | "color_palette"
  | "product_compatibility"
  | "composition"
  | "readability"
  | "exclusions"
  | "overall_alignment";

export interface ConceptEvaluationCriterionScore {
  key: ConceptEvaluationCriterionKey;
  /** 0–100, or null when the criterion was not assessed. */
  score: number | null;
  /** null when the provider could not determine pass/fail. */
  passed: boolean | null;
  /** 0–100 confidence for this criterion alone. */
  confidence: number;
  /** Internal notes — never customer-facing copy. */
  notes: string | null;
}

/**
 * Phase 2B: deterministic print-palette / garment-contrast gate statuses.
 * Authoritative for hard palette compliance; OpenAI Vision must not reverse
 * a hard `fail`. Phase 2C reads a hard `fail` as the sole trigger for one
 * bounded automatic replacement of that concept.
 */
export type PrintPaletteComplianceStatus =
  | "pass"
  | "warn"
  | "fail"
  | "not_applicable";

/**
 * Compact diagnostics persisted on `ConceptEvaluation` (JSONB — no migration).
 * Metrics are fractions / counts only; never raw pixels.
 */
export interface PrintPaletteCompliance {
  status: PrintPaletteComplianceStatus;
  metrics: {
    visiblePixelWeight: number;
    visiblePixelFraction: number;
    veryLightPixelFraction: number;
    lightPixelFraction: number;
    midtonePixelFraction: number;
    darkPixelFraction: number;
    nearBlackPixelFraction: number;
    paletteCoverageFraction: number;
    garmentMatchingFraction: number;
    meanVisibleLuminance: number;
    garmentLuminance: number | null;
    garmentClass: "light" | "mid" | "dark" | "unknown";
    luminanceContrastDelta: number | null;
    requiredPaletteFamily: "light" | "dark" | "mid" | "unknown";
    enforcement: PrintPaletteEnforcement;
  };
  reasons: string[];
}

/**
 * Provider-neutral Concept Evaluation payload persisted on ArtworkVersion.
 * Distinct from Print Validation (DPI, transparency, print size, etc.).
 */
export interface ConceptEvaluation {
  overallScore: number | null;
  passed: boolean | null;
  confidence: number;
  criteria: ConceptEvaluationCriterionScore[];
  warnings: string[];
  recommendations: string[];
  missingRequirements: string[];
  matchedRequirements: string[];
  /** Internal provider envelope — never customer-facing. */
  providerMetadata: Record<string, unknown>;
  /**
   * Phase 2B: deterministic print-palette / garment-contrast compliance.
   * Optional for records written before Phase 2B; JSONB — no migration.
   */
  printPaletteCompliance?: PrintPaletteCompliance | null;
}

export interface ArtworkVersion {
  id: string;
  projectId: string;
  versionNumber: number;
  kind: ArtworkKind;
  title: string;
  summary: string;
  placeholderLabel: string;
  accentColor: string;
  isSelected: boolean;
  /**
   * Sprint 2G Live Acceptance Corrective Pass: the artwork this one is a
   * targeted revision of, if any. `null` for an original (initial
   * exploration or explicit "show me alternatives") concept. Never
   * destructive — the source artwork remains a separate, historical row.
   * The durable lineage authority: a chain of `sourceArtworkVersionId`
   * links, not a parallel history table.
   */
  sourceArtworkVersionId?: string | null;
  /**
   * Sprint 2G Live Acceptance Corrective Pass: which of the three catalog
   * creative directions (`lib/domain/concept-directions.ts`) this concept
   * used, when known. Lets a later single-concept revision of this exact
   * artwork regenerate in the SAME direction instead of defaulting to a
   * different one. `null` for historical rows generated before this field
   * existed.
   */
  conceptDirectionKey?: ConceptDirectionKey | null;
  /** Sprint 2D: the approved Design Brief version that authorized this concept. */
  designBriefVersionId: string | null;
  /**
   * Sprint 2H Part 1: internal generation provenance. `null` for
   * placeholder-generated concepts (no real generation job exists for
   * them). Never surfaced to the customer.
   */
  generationJobId: string | null;
  /** Internal reference to the primary generated image asset, if any. */
  primaryAssetId: string | null;
  /** Internal reference to the thumbnail asset, if any. */
  thumbnailAssetId: string | null;
  /** Internal provenance only — which provider produced this concept. Never rendered to the customer. */
  providerKey: string | null;
  /** Reserved for a future customer rating feature. Always null until implemented. */
  customerRating: number | null;
  /**
   * Sprint 2I Phase 1: Concept Evaluation workflow state. Internal only —
   * never blocks customer presentation in this phase.
   */
  evaluationStatus: ConceptEvaluationStatus | null;
  /** Sprint 2I Phase 1: provider-neutral evaluation payload, if any. */
  evaluation: ConceptEvaluation | null;
  /** Sprint 2I Phase 1: when evaluation was last written. */
  evaluationEvaluatedAt: string | null;
  /** Sprint 2I Phase 1: which evaluation provider produced `evaluation`. */
  evaluationProviderKey: string | null;
  /** Reserved for future print validation. Always null until implemented. */
  printValidationStatus: string | null;
  createdAt: string;
}

/**
 * Sprint 2D: frozen, provider-neutral copy of the working brief fields at
 * the moment of customer approval. Intentionally excludes ids/timestamps —
 * those live on the version row itself.
 */
export interface DesignBriefSnapshotContent {
  productSummary: string | null;
  designDescription: string | null;
  exactText: string | null;
  shirtColor: string | null;
  printPlacement: PrintPlacement | null;
  preferredColors: string[];
  designStyle: string | null;
  additionalInstructions: string | null;
  audience: string | null;
  purpose: string | null;
  exclusions: string | null;
  deferredSections: string[];
}

export type DesignBriefVersionStatus = "draft" | "approved" | "superseded";

/** Durable, immutable approval record. Never overwritten after creation. */
export interface DesignBriefVersion {
  id: string;
  projectId: string;
  briefId: string;
  versionNumber: number;
  status: DesignBriefVersionStatus;
  content: DesignBriefSnapshotContent;
  approvedAt: string;
  createdAt: string;
}

export interface ProjectSnapshot {
  project: PrintProject;
  brief: TShirtDesignBrief;
  conversation: DesignConversation;
  messages: ConversationMessage[];
  artworkVersions: ArtworkVersion[];
  /** Sprint 2D: append-only approved brief versions, most recent last. */
  designBriefVersions: DesignBriefVersion[];
}

/**
 * Sprint 2M Phase 2B: the customer's explicit, durable "this is my final
 * direction — prepare it for production" decision. Distinct from concept
 * *selection* (`ArtworkVersion.isSelected` /
 * `PrintProject.selectedArtworkVersionId`), which only means "I want to work
 * with this direction" and may still be revised freely.
 *
 * Modeled as its own append-only, immutable record (never as a mutable
 * boolean on `ArtworkVersion` or `PrintProject`) for the same reasons
 * `DesignBriefVersion` is its own table rather than a flag on the working
 * brief: auditability (who approved what, when), the ability to supersede
 * without destroying history (Constitution §6.11 — Version Everything), and
 * unambiguous idempotency (`status`, not a shared mutable field, decides
 * what is currently authoritative). Internal only — never included in
 * `ProjectSnapshot`, mirroring `GenerationJob`/`AssetRecord`; a customer-safe
 * derived status is computed separately (see `conversation-service.ts`).
 */
export type FinalDirectionApprovalStatus = "active" | "superseded";

export interface FinalDirectionApproval {
  id: string;
  projectId: string;
  /** The exact, immutable concept this approval authorizes — never "whatever is currently selected". */
  artworkVersionId: string;
  /** The approved Design Brief version this artwork was generated against, at the moment of approval. */
  designBriefVersionId: string;
  /**
   * At most one row per project may be "active" at a time. A newer approval
   * (a different `artworkVersionId`) or a new concept batch produced by
   * regeneration after this approval both supersede it — see
   * `FinalArtworkCapability` and `GenerationWorkerCapability`'s
   * regeneration-completion path. Superseding never deletes or rewrites this
   * row; it only flips `status`/`supersededAt` going forward.
   */
  status: FinalDirectionApprovalStatus;
  approvedAt: string;
  supersededAt: string | null;
  createdAt: string;
}

/**
 * Sprint 2M Phase 2B: customer-never-sees-this lifecycle for a single
 * production-finalization attempt, keyed 1:1 to the `FinalDirectionApproval`
 * that authorized it (never to a `PrintProject` or `ArtworkVersion` directly
 * — that keying is what makes "double-click"/"duplicate request" naturally
 * idempotent without a separate dedupe key). Deliberately its own table
 * rather than a reuse of `GenerationJob`: different trigger (explicit
 * approval, not brief approval), different idempotency authority (the
 * approval id, not `(project, approvedBriefVersion)`), different output
 * (production `AssetRecord`s + an eventual authoritative
 * `PrintValidationReport`, not concept `ArtworkVersion`s).
 *
 * Sprint 2M Phase 2C: `FinalArtworkWorkerCapability` now claims and runs
 * this job — `"recoverable"` and the claim/heartbeat fields below mirror
 * `GenerationJob`'s own worker lifecycle exactly (same atomic-claim,
 * stale-recovery shape, different table).
 */
export type FinalArtworkJobStatus =
  | "queued"
  | "running"
  | "recoverable"
  | "completed"
  | "failed"
  | "cancelled";

/**
 * Print'em All Phase 2 — WHICH JOB STATUSES MEAN "WORK IS ACTUALLY IN FLIGHT".
 *
 * The three statuses a worker can still act on: `queued` and `recoverable`
 * are claimable, `running` is claimed. Everything else is finished —
 * `completed`, `failed`, and `cancelled` are all terminal, and none of them
 * is a reason to refuse an operator a change.
 *
 * THIS EXISTS BECAUSE `PrintProject.status` CANNOT ANSWER THE QUESTION.
 * `failJob` deliberately leaves the project at `"finalizing"` (an
 * infrastructure failure is retryable, so the lifecycle really is still open),
 * which means a project sits at `"finalizing"` indefinitely after ANY failed
 * job. Reading that as "a plate is being made right now" produced a live
 * dead-end: an internal operator whose Standard Raster attempt had failed was
 * refused every recovery action — garment class, print size, and production
 * treatment alike — while the very same screen told them the attempt had
 * finished. Both readings were correct about different fields; only one of
 * them was the question being asked.
 *
 * A lifecycle marker says a story is unfinished. Only a JOB says somebody is
 * working right now.
 */
export const ACTIVE_FINAL_ARTWORK_JOB_STATUSES: readonly FinalArtworkJobStatus[] = [
  "queued",
  "running",
  "recoverable",
];

export function isActiveFinalArtworkJobStatus(
  status: FinalArtworkJobStatus,
): boolean {
  return ACTIVE_FINAL_ARTWORK_JOB_STATUSES.includes(status);
}

/**
 * Existing Artwork → Print Ready Phase 2: which customer authority a
 * `FinalArtworkJob` was created under. DERIVED, never a stored column — it is
 * `"prepared_upload"` exactly when `artworkPreparationId` is set, and
 * `"generated_concept"` exactly when `finalDirectionApprovalId` is
 * (the persistence layer enforces "exactly one"). Modelling it as a derived
 * discriminant rather than an enum column keeps the schema from carrying a
 * third fact that could disagree with the two foreign keys.
 *
 *   "generated_concept" — Create New Artwork. The authority is the customer's
 *     `FinalDirectionApproval` ("this concept is my final direction").
 *   "prepared_upload"   — Upload Existing Artwork. The authority is the
 *     customer's approval of their own PREPARED artwork
 *     (`ArtworkPreparation.status === "approved"`). There is deliberately no
 *     `FinalDirectionApproval` on this path — see `ArtworkPreparation`'s doc
 *     and ARCHITECTURE.md §13i for why fabricating one would be a second,
 *     competing production-approval authority.
 */
/**
 * Signs Phase S2: the third authority. `"sign_preparation"` exactly when
 * `signPreparationId` is set — see `SignPreparation` (S1) and the
 * `20260830130000_sign_final_artwork_authority.sql` migration's own audit
 * for why the FK-based "exactly one" model required a third column rather
 * than being expressed inside either existing one.
 */
export type FinalArtworkSourceKind =
  | "generated_concept"
  | "prepared_upload"
  | "sign_preparation";

export interface FinalArtworkJob {
  id: string;
  projectId: string;
  /** See `FinalArtworkSourceKind` — derived from which authority id is set, never persisted separately. */
  sourceKind: FinalArtworkSourceKind;
  /** The Create New Artwork authority. `null` for a `"prepared_upload"` job. */
  finalDirectionApprovalId: string | null;
  /**
   * Existing Artwork → Print Ready Phase 2: the Upload Existing Artwork
   * authority — the `ArtworkPreparation` whose customer approval authorized
   * this finalization. `null` for a `"generated_concept"` job.
   */
  artworkPreparationId: string | null;
  /**
   * Signs Phase S2: the rigid-sign production authority — the
   * `SignPreparation` whose persisted, planned repair authorized this job.
   * `null` for every other `sourceKind`.
   */
  signPreparationId: string | null;
  /**
   * Signs Phase S2: the canonical `SignRepairPlan` identity this job was
   * enqueued to execute — frozen at enqueue, immutable, and half of the sign
   * workflow's idempotency key (mirrors `productionTreatmentKey`: a re-plan
   * supersedes a queued job rather than re-aiming it). `null` for every
   * `sourceKind` other than `"sign_preparation"`.
   */
  signPlanKey: string | null;
  /**
   * Existing Artwork → Print Ready Phase 2: the production print WIDTH, in
   * inches, this job was enqueued for — frozen at enqueue rather than re-read
   * from the working brief while the job runs.
   *
   * Only set for `"prepared_upload"`, where it is half of the idempotency key
   * (Goal 14: exactly one active finalization per preparation approval +
   * production-size intent, and a size change after a completed plate demands
   * a NEW job rather than silently reusing a mismatched deliverable).
   * `"generated_concept"` keeps its existing behavior — the worker reads
   * `TShirtDesignBrief.intendedPrintWidthIn` at run time — so nothing about
   * that path changes.
   */
  productionWidthIn: number | null;
  /**
   * Print'em All Phase 2: the canonical production-treatment identity THIS
   * JOB WAS CREATED TO SATISFY — snapshotted at enqueue and immutable, exactly
   * like `productionWidthIn` and `requestedProductionOutput`.
   *
   * Reading the project's live treatment at run time instead would let a
   * queued job silently re-aim itself every time an operator moved a slider:
   * change LPI while a job waits and the plate that comes out is not the plate
   * that was authorized. It is also part of JOB IDENTITY (see the migration's
   * unique indexes), so different settings are different jobs with their own
   * evidence rather than one row fighting over two meanings — which is what
   * makes returning to previous settings reuse that plate instead of redoing
   * it.
   *
   * `null` = a legacy job enqueued before this column existed. Those all
   * predate any way to select anything else, so they mean standard raster —
   * normalized by `treatmentKeyMatchesJob`, never by reading `null` as
   * "unspecified" a second time.
   */
  productionTreatmentKey: string | null;
  /**
   * Sprint A2 Correction 2 (Goal 1): the production output THIS JOB WAS
   * CREATED TO SATISFY, snapshotted from the project's current intent at
   * enqueue and immutable thereafter.
   *
   * `TShirtDesignBrief.requestedProductionOutput` is deliberately mutable —
   * a customer must be able to change their mind. That makes it unusable on
   * its own as job authority, which was the remaining defect: a job carried
   * no record of what it was for, so a running PNG job could still flip a
   * project to `print_ready` after the customer had asked for separations,
   * and a completed unsupported job could be handed back as "already done"
   * after they retracted. Bound intent is what lets every gate ask the only
   * question that matters: *does this job still answer what is being asked?*
   *
   * It is also part of JOB IDENTITY (see the migration's unique indexes), so
   * a PNG job and a separations job are different jobs rather than one row
   * fighting over two meanings. That is what makes PNG → unsupported → PNG
   * reuse the existing, already-paid-for plate instead of redoing it.
   *
   * `null` = a legacy job enqueued before this column existed. Those all
   * predate any way to request anything else, so they mean `production_png`
   * — normalized by `normalizeProductionIntent`, never by reading `null` as
   * "unspecified" a second time.
   */
  requestedProductionOutput: StoredRequestedProductionOutput | null;
  /**
   * Denormalized for convenient querying — always the same artwork the
   * authorizing record references. LIVE PRODUCT BLOCKER #4E: `null` for a
   * `"sign_preparation"` job — no `ArtworkVersion` exists for a sign
   * (Constitution §16A), and the earlier design (storing the authorizing
   * `SignPreparation.id` here instead) was a real production defect, not a
   * narrower-but-honest choice: this column carries a real foreign key to
   * `artwork_versions`, so a sign preparation's id here is rejected by the
   * database — see the S2.5 schema-fix migration's own audit. The
   * authorizing `SignPreparation.id` lives on `signPreparationId`, which
   * already fills that structural role.
   */
  artworkVersionId: string | null;
  status: FinalArtworkJobStatus;
  /**
   * Sprint 2M Phase 2C: mirrors `GenerationJob.attempts` — bumped on every
   * claim, backing the same shared-retry-budget shape
   * (`MAX_GENERATION_ATTEMPTS`-style ceiling) so a job whose worker keeps
   * dying mid-attempt eventually fails permanently instead of recovering
   * forever.
   */
  attempts: number;
  lastError: string | null;
  /** Sprint 2M Phase 2C: set each time a worker claims this job. */
  startedAt: string | null;
  /** Sprint 2M Phase 2C: set once, when the job reaches a terminal status. */
  completedAt: string | null;
  /** Sprint 2M Phase 2C: bumped periodically while a worker is actively running this job — same stale-recovery signal as `GenerationJob.heartbeatAt`. */
  heartbeatAt: string | null;
  /**
   * Sprint 2M Phase 2E (Goal 3): durable paid-provider request identity for
   * this job, so a worker crash/race between submitting a paid
   * reconstruction request (e.g. Topaz) and persisting its resulting
   * production asset never causes a second paid request on retry/recovery.
   * `providerKey` records which provider the in-flight/completed request
   * belongs to (a job whose provider changed between attempts is never
   * resumed against a stale request from a different provider).
   * `providerRequestId` is the provider's own request/job id — internal
   * only, never customer-facing. `providerStatus` is the last known raw
   * provider status string, for internal diagnostics only. All three are
   * `null` until a provider that performs a real paid submission actually
   * submits one, and stay `null` forever for a provider with no paid
   * request concept (e.g. local raster interpolation).
   */
  providerKey: string | null;
  providerRequestId: string | null;
  providerStatus: string | null;
  /**
   * "Separate Provider Recovery Attempt Budget": how many claims have
   * attempted to poll/download the CURRENT `providerRequestId` (never a
   * fresh paid submission) — the separate, more generous budget that lets
   * infrastructure/readback retries against an already-paid request
   * recover without being blocked by, or consuming, `attempts`'s own
   * fresh-execution ceiling (`MAX_FINAL_ARTWORK_ATTEMPTS`, in
   * `final-artwork-worker-capability.ts`, next to
   * `MAX_FINAL_ARTWORK_RECOVERY_ATTEMPTS`, its counterpart). Reset to `0`
   * every time `providerKey`/`providerRequestId` are cleared or replaced —
   * this counts recovery attempts against ONE specific paid request, never
   * across a job's whole lifetime. `0` for a job that has never had a
   * provider request, or whose provider has no paid-request concept.
   */
  providerRecoveryAttempts: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * Existing Artwork → Print Ready Phase 1: the lifecycle of ONE piece of
 * customer-uploaded artwork on its way to becoming print-ready.
 *
 *   "analyzed" — the immutable original is stored and deterministic analysis
 *                has run. Nothing derived exists yet.
 *   "prepared" — a derived, transparent PNG exists (background isolated,
 *                edges cleaned). The customer has NOT approved it.
 *   "approved" — the customer explicitly confirmed the prepared artwork
 *                faithfully represents what they uploaded. This is NOT a
 *                claim that production ran, that enhancement happened, or
 *                that print validation passed (Constitution §15).
 *
 * There is deliberately no "rejected"/"failed" status: a preparation the
 * analyzer refuses to auto-repair simply stays `"analyzed"` and carries an
 * honest classification, which is a truthful description of reality rather
 * than a terminal state that would have to be un-stuck later.
 */
export type ArtworkPreparationStatus = "analyzed" | "prepared" | "approved";

/**
 * Existing Artwork → Print Ready Phase 1: the durable record of the second
 * first-class iHeartPrints workflow — "I already have artwork; make THAT
 * print-ready."
 *
 * WHY this is its own record rather than fields squeezed onto existing rows
 * (the schema-discipline audit for Phase 1):
 *
 *   1. It is the WORKFLOW IDENTITY. "Is this project `create_new` or
 *      `prepare_existing`?" is answered by "does a preparation exist for
 *      it?" — a real domain fact, not a speculative enum column added to
 *      `PrintProject` ahead of any second consumer.
 *   2. `AssetRecord` cannot express original → prepared lineage honestly:
 *      `vectorAssetId` means "a vector companion" and `printAssetId` means
 *      "a print-ready production asset". Neither means "the customer upload
 *      this was derived from", and reusing one would make a narrower field
 *      lie (explicitly forbidden by the Phase 1 brief).
 *   3. The customer's prepared-artwork APPROVAL must survive reload and is
 *      not any existing flag: `finalDirectionConfirmed` means "no more
 *      creative changes" in the generated-concept lifecycle and is reset by
 *      `selectConcept`; `selectedArtworkVersionId` means "the direction I'm
 *      working with". Neither means "this prepared file faithfully
 *      represents my upload".
 *
 * `analysis` / `preparation` are loosely typed as plain objects for the same
 * domain-layer-independence reason `ProductionAssetValidation.report` is —
 * they are narrowed at the `ArtworkPreparationCapability` boundary that
 * writes and reads them. Both are INTERNAL diagnostics: customer-facing copy
 * is derived from them (`preparation-copy.ts`), never rendered from them.
 */
export interface ArtworkPreparation {
  id: string;
  projectId: string;
  status: ArtworkPreparationStatus;
  /**
   * The customer's uploaded bytes, exactly as received. Immutable — every
   * transformation produces a NEW asset and this id never changes.
   */
  originalAssetId: string;
  /** The derived transparent PNG. `null` until background preparation runs. */
  preparedAssetId: string | null;
  /**
   * The `ArtworkVersion` (`kind: "prepared_upload"`) created when the
   * customer approves the prepared artwork — the handoff Phase 2's
   * `FinalArtwork` pipeline consumes. `null` until approval.
   *
   * Phase 2: together with `status === "approved"`, this IS the production
   * authority for the upload workflow — `FinalArtworkJob.artworkPreparationId`
   * points back here rather than at a fabricated `FinalDirectionApproval`.
   */
  preparedArtworkVersionId: string | null;
  /** Sanitized customer filename. Display only — never a storage path. */
  originalFilename: string | null;
  /** Deterministic `ArtworkAnalysis`. Internal diagnostics; never rendered raw. */
  analysis: Record<string, unknown>;
  /** Deterministic `BackgroundPreparationRecord`. `null` until prepared. */
  preparation: Record<string, unknown> | null;
  /**
   * Existing Artwork → Print Ready Phase 1.2: the customer's own background
   * cleanup, as the ORDERED LIST OF POINTS THEY CLICKED. `null` until they
   * click something.
   *
   * Deliberately the INPUT, not the output. The prepared PNG is a derived
   * asset that any of these clicks replaces; the clicks are the only fact the
   * customer actually authored, and re-running the deterministic pipeline over
   * the immutable original with this list reproduces the prepared bytes
   * exactly. That is what makes a reload, a retry, and an undo all cheap and
   * all honest — and it is why storing a pixel mask here instead would be
   * strictly worse: a mask cannot be replayed against a re-analysis, cannot be
   * undone one step at a time, and could disagree with the original it claims
   * to describe.
   *
   * Loosely typed for the same reason `analysis` and `preparation` are:
   * `GuidedCleanupRecord` is narrowed at the `ArtworkPreparationCapability`
   * boundary that writes and reads it.
   */
  guidedCleanup: Record<string, unknown> | null;
  /**
   * Intelligent Separation Phase 9: the operator-confirmed
   * `SeparationDecisionSet` (`region-separation-contracts.ts`), when this
   * preparation has gone through consequential-region review. `null` for
   * every preparation that never needed it, and for every preparation made
   * before this phase — loosely typed for the same reason `preparation` and
   * `guidedCleanup` are: narrowed at the `ArtworkPreparationCapability`
   * boundary that writes and reads it, never trusted raw.
   */
  separation: Record<string, unknown> | null;
  approvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Signs Phase S1: lifecycle of one rigid-sign preparation.
 *
 *   'inspected' → immutable original stored, deterministic inspection done.
 *                 The ordered physical size may or may not be confirmed yet.
 *   'planned'   → a repair PLAN exists for the confirmed ordered size.
 *                 NOT executed, NOT approved for production, NOT a
 *                 print-readiness claim of any kind (Constitution §16A/§16B —
 *                 the profile is admitted; nothing is produced or validated
 *                 in S1).
 *
 * Mirrors `ArtworkPreparationStatus`'s honesty rule: there is no
 * "rejected"/"failed" status — a sign the planner refuses stays at its last
 * truthful stage carrying explicit defects.
 */
export type SignPreparationStatus = "inspected" | "planned";

/**
 * LIVE PRODUCT BLOCKER #4: WHO authorized a rigid-sign plan for production.
 * Never a personal identity (this codebase has no user-authentication
 * layer at all — ARCHITECTURE.md §23) — a narrow actor TYPE, exactly wide
 * enough to answer the one question the risk rules need: was this the
 * customer themselves, or an internal operator?
 *
 *   "customer" — the customer's own self-service action. Sufficient ONLY
 *                for an `auto_safe` plan.
 *   "operator" — an internal, `isInternalProject`-gated action. Required
 *                for a `review_required` plan; also sufficient for
 *                `auto_safe`.
 *
 * `"blocked"` deliberately has no corresponding actor — a blocked planning
 * outcome persists no plan at all, so there is nothing to authorize.
 */
export const SIGN_PLAN_AUTHORIZATION_ACTORS = ["customer", "operator"] as const;
export type SignPlanAuthorizationActor = (typeof SIGN_PLAN_AUTHORIZATION_ACTORS)[number];

/**
 * Signs Phase S1: the durable record of one rigid-sign order's artwork —
 * "understand this sign order before changing any pixels."
 *
 * Its own record, not fields on `ArtworkPreparation`, for the same
 * schema-discipline reasons that record exists at all:
 *
 *   1. It is the SIGN-WORKFLOW IDENTITY. "Is this project a rigid-sign
 *      preparation?" is answered by whether a row exists here — the same
 *      no-workflow-enum rule the apparel upload workflow established.
 *   2. `ArtworkPreparation`'s lifecycle ('analyzed'/'prepared'/'approved'),
 *      its background-isolation diagnostics, and its transparent prepared
 *      asset are apparel-DTF facts. A sign preparation has none of them and
 *      has facts of its own (ordered width AND height, a resolution policy,
 *      a repair plan) that would make the apparel record lie.
 *   3. Ordered sign dimensions must not flow through the apparel
 *      width-only placement model (`intendedPrintWidthIn` /
 *      `PrintPlacement`) — Constitution §16A: width AND height are
 *      authoritative, human-confirmed, and never inferred.
 *
 * `inspection` / `plan` are loosely typed plain objects for the same
 * domain-layer-independence reason `ArtworkPreparation.analysis` is — they
 * are narrowed at the `SignPreparationCapability` boundary that writes and
 * reads them, recomputed rather than trusted as authority, and are INTERNAL
 * diagnostics never rendered raw to a customer.
 */
export interface SignPreparation {
  id: string;
  projectId: string;
  status: SignPreparationStatus;
  /**
   * The customer's uploaded bytes, exactly as received. Immutable — every
   * later transformation (S2+) derives a NEW asset; this id never changes.
   */
  originalAssetId: string;
  /** Sanitized customer filename. Display only — never a storage path. */
  originalFilename: string | null;
  /**
   * The human-confirmed ordered physical size (Constitution §16A.2):
   * BOTH dimensions authoritative, never defaulted, never inferred from
   * artwork, filename, prose, or the dormant `signage` placeholder.
   * `null` until explicitly confirmed; planning fails closed without them.
   */
  orderedWidthIn: number | null;
  orderedHeightIn: number | null;
  /**
   * When a human explicitly confirmed the ordered size. The consent
   * provenance — mirrors `productionSizeConfirmedAt`'s "a default is not a
   * decision" rule. `null` means never confirmed.
   */
  specConfirmedAt: string | null;
  /**
   * Which sign resolution policy governed the confirmation (e.g. the V1
   * rigid-rectangle 150-target/100-minimum policy), stamped at confirm time
   * so a later policy revision cannot silently re-govern an old order.
   */
  resolutionPolicyId: string | null;
  /** Deterministic `SignInspectionReport`. Internal diagnostics; never rendered raw. */
  inspection: Record<string, unknown> | null;
  /** Persisted `SignRepairPlan`. `null` until planning succeeds. Never executed in S1. */
  plan: Record<string, unknown> | null;
  /**
   * Canonical, order-insensitive identity of `plan` — the future
   * `FinalArtworkJob` binding key (the `production_treatment_key`
   * precedent). Changes whenever any production-significant plan input
   * changes; never changes on cosmetic serialization differences.
   */
  planKey: string | null;
  /**
   * LIVE PRODUCT BLOCKER #4: the durable production-risk authorization for
   * THIS plan — a genuinely separate decision from `specConfirmedAt`
   * (which authorizes an ordered SIZE) and from planning itself (which
   * only FORMULATES a plan, never authorizes running it). `null` means
   * never authorized.
   *
   * Binds to `planKey` explicitly, exactly like `production_size_confirmed
   * _at`'s precedent — a default is not a decision, and a re-plan (a
   * changed `planKey`) must never be silently covered by an authorization
   * that was granted for a DIFFERENT plan. `requestSignFinalArtwork`
   * refuses unless `authorizedPlanKey === ` the current, recomputed
   * `planKey`.
   */
  authorizedPlanKey: string | null;
  /** When authorization was granted. `null` means never — mirrors `specConfirmedAt`'s consent-provenance discipline. */
  authorizedAt: string | null;
  /** WHO authorized it — see `SignPlanAuthorizationActor`. `null` means never authorized. */
  authorizedBy: SignPlanAuthorizationActor | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Sprint 2M Phase 2C (Goal 12): authoritative Print Validation's persisted
 * home. Deliberately its own record — never a single status column on
 * `ArtworkVersion` (Phase 2A/2B both audited and rejected that; see
 * ARCHITECTURE.md) — because one `FinalArtworkJob` may eventually produce
 * more than one production asset (PNG today; SVG/PDF reserved for later),
 * and each asset's readiness is independently true or false. Append-only:
 * a revalidation creates a new row rather than overwriting the last one, so
 * validation history stays auditable (Constitution §6.11).
 */
export interface ProductionAssetValidation {
  id: string;
  projectId: string;
  finalArtworkJobId: string;
  /** The production `AssetRecord` this validation run evaluated — never a concept-stage asset. */
  assetId: string;
  /**
   * Loosely typed as `string` (mirrors `TShirtDesignBrief.deferredSections`)
   * to avoid a domain → capabilities import cycle; narrowed to
   * `PrintValidationStatus` at the capability boundary that writes it
   * (`FinalArtworkWorkerCapability`).
   */
  status: string;
  /**
   * The full, internal `PrintValidationReport` this run produced — check
   * reasons, requirements, required transformations. Print-shop/internal
   * diagnostics only; never surfaced to the customer as-is (Goal 13).
   * Serialized as a plain object (mirrors `AssetRecord.metadata`) for the
   * same domain-layer-independence reason `status` is loosely typed.
   */
  report: Record<string, unknown>;
  validatedAt: string;
  createdAt: string;
}

/**
 * Signs Phase S4.1: the durable, append-only result of one preservation-
 * verification pass against one immutable final rigid-sign production
 * asset — "did the reconstruction stay semantically faithful to the
 * customer's artwork?"
 *
 * Constitution §16A.3 recognizes four SEPARATE S4 authorities, and this
 * record is exactly one of them, never all of them:
 *
 *   1. APPROVED REPAIR PLAN   — `SignPreparation.plan`/`planKey`. What was
 *      authorized. Immutable; this record never rewrites it.
 *   2. EXECUTION EVIDENCE     — the final asset's own `rigidSign.
 *      executionGeometry`/`providerAlphaNormalization` metadata. What
 *      actually happened.
 *   3. PRESERVATION EVIDENCE  — THIS record. Whether the reconstructed
 *      customer content remained faithful.
 *   4. REVIEW-RISK APPROVAL   — Signs Phase S4.3 (not yet implemented).
 *      Whether an operator accepted a known, faithful-but-risky result.
 *      This record's `status` can never imply that approval, and that
 *      approval can never imply this record's `status`.
 *
 * ITS OWN TABLE, never a column on `assets`: assets are append-only
 * (Constitution §6.11, "Version Everything" — `ProjectRepository` exposes
 * no method to update an already-created asset's metadata, confirmed
 * across Signs Phases S3C/S3D). Verification is a genuinely separate,
 * independently-idempotent, potentially-paid (from S4.2 onward) step that
 * must be able to run and be re-verified AFTER the final asset already
 * exists, without ever rewriting it — the identical reasoning
 * `ProductionAssetValidation` above is already its own append-only table
 * rather than a column on `assets`.
 *
 * Signs Phase S4.1 establishes ONLY deterministic evidence.
 * `status` may be `"changed"` (a proven structural impossibility) or
 * `"unknown"` (the fail-closed default whenever evidence is missing,
 * inconsistent, or merely inconclusive) — it can NEVER be `"preserved"`
 * until Signs Phase S4.2's semantic verification exists; enforced as an
 * explicit invariant in `sign-preservation-capability.ts`, not merely a
 * convention.
 */
export type SignPreservationStatus = "preserved" | "changed" | "unknown";

export interface SignPreservationVerification {
  id: string;
  projectId: string;
  signPreparationId: string;
  /** The customer's immutable original upload this verification traces its lineage to. */
  sourceAssetId: string;
  sourceSha256: string;
  /**
   * The persisted reconstruction-intermediate asset (`pass1_intermediate`,
   * Signs Phase S3A/28V) this verification compares the final content
   * region against. A preservation verification only ever runs against a
   * `resolutionProvenance: "reconstructed"` final asset, which always has
   * exactly one of these — never null.
   */
  intermediateAssetId: string;
  /**
   * The exact, immutable final production asset this verification is FOR —
   * THE binding identity (Constitution §6.11: assets never change once
   * created, so this is a permanent, unambiguous reference). A verification
   * for one asset must never be read as authorizing a different one.
   */
  finalAssetId: string;
  /** Independently re-hashed at verification time — evidence, not identity (the asset id above is already immutable/unique on its own). */
  finalAssetSha256: string;
  /** The approved plan's own canonical identity, re-verified at read time — a redundant, fail-closed cross-check alongside `finalAssetId`. */
  planKey: string;
  /** Explicit staleness lever: bumping this forces re-verification even against an otherwise-unchanged final asset. */
  verificationAlgorithmVersion: string;
  /**
   * Structured, versioned, bounded deterministic evidence (lineage, region
   * mapping, reconstruction↔final RGB integrity, extension-region
   * verification, source↔reconstruction similarity) — see
   * `sign-preservation/contracts.ts`. Deliberately never enormous per-pixel
   * arrays; bounded summaries sufficient for audit/reproducibility.
   * Serialized as a plain object for the same domain-layer-independence
   * reason `ProductionAssetValidation.report` is.
   */
  deterministicEvidence: Record<string, unknown>;
  /** Reserved for Signs Phase S4.2's semantic/multimodal verification. Always `null` until then. */
  semanticEvidence: Record<string, unknown> | null;
  status: SignPreservationStatus;
  reasons: string[];
  createdAt: string;
}

/**
 * Signs Phase S4.2C.1: durable, RECOVERABLE bookkeeping for one in-flight
 * OpenAI Files-transport semantic-preservation attempt — deliberately NOT
 * permanent semantic evidence (that remains
 * `SignPreservationVerification.semanticEvidence`, above). This record
 * exists solely so a crash mid-attempt (after some uploads, after all
 * uploads but before inference, or after inference but before cleanup) can
 * be recovered without a duplicate paid model-inference dispatch and
 * without silently losing track of files uploaded to OpenAI that still
 * need deleting.
 *
 * Bound to the EXACT semantic verification identity it is transporting for
 * — `finalAssetId` + `combinedVerificationAlgorithmVersion` — mirroring
 * `SignPreservationVerification`'s own idempotency key exactly, so a
 * transport attempt can never be mistaken for a different verification
 * identity's in-flight work.
 *
 * Mutable (unlike the append-only `SignPreservationVerification`) —
 * deliberately so: this is transient recovery state, not durable audit
 * history. Never contains image bytes/base64 (`files[].contentHash` is a
 * SHA-256 of the derived PNG bytes, never the bytes themselves).
 */
export type SignPreservationTransportAttemptStatus =
  | "in_progress"
  | "uploads_complete"
  | "inference_dispatched_ambiguous"
  | "inference_completed"
  | "cleanup_complete";

export type SignPreservationTransportInferenceOutcome =
  | "dispatched_ambiguous"
  | "completed"
  | "failed_pre_dispatch";

export interface SignPreservationTransportFileRecord {
  /** One of the 14 fixed, deterministic image roles (e.g. "source_overview", "reconstruction_crop_0_1") — never customer-identifying text. */
  role: string;
  /** SHA-256 of the derived PNG bytes for this role, in THIS attempt — the recovery-time proof that a reused file id still corresponds to the currently-derived image, not a stale one from a prior derivation. */
  contentHash: string;
  /** `null` until this role's upload completes. Redacted (set back to `null`) once cleanup for this file succeeds — Signs Phase S4.2C.1 §11: prefer retaining upload count/timestamps over a now-deleted provider identifier. */
  providerFileId: string | null;
  uploadCompletedAt: string | null;
  cleanupCompletedAt: string | null;
}

export interface SignPreservationTransportAttempt {
  id: string;
  projectId: string;
  finalAssetId: string;
  sourceAssetId: string;
  intermediateAssetId: string;
  planKey: string;
  /** The exact `SignPreservationVerification.verificationAlgorithmVersion` this transport attempt is working toward — the binding identity, alongside `finalAssetId`. */
  combinedVerificationAlgorithmVersion: string;
  /** Explicit staleness lever for TRANSPORT MECHANISM behavior, independent of `imageDerivationVersion`/model/prompt/schema — see `SIGN_PRESERVATION_TRANSPORT_VERSION_FILE_ID` in `sign-preservation/contracts.ts`. */
  transportVersion: string;
  status: SignPreservationTransportAttemptStatus;
  /** Exactly `SIGN_PRESERVATION_BASE_IMAGE_COUNT` (14) entries once uploads are underway — `SIGN_PRESERVATION_PERIMETER_OVERVIEW_IMAGE_COUNT` (2) more when the request also carries perimeter-visible evidence (`reconstruct_parametric_frame`) — never fewer once `status !== "in_progress"` with any file recorded, for whichever shape this attempt's own request actually used. */
  files: SignPreservationTransportFileRecord[];
  inferenceDispatchedAt: string | null;
  inferenceOutcome: SignPreservationTransportInferenceOutcome | null;
  createdAt: string;
  updatedAt: string;
}
