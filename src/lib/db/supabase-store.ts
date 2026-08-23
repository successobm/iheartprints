import {
  OPENING_PROMPT,
  projectNameFromBrief,
} from "@/lib/domain/conversation";
import {
  ACTIVE_FINAL_ARTWORK_JOB_STATUSES,
  emptyInterviewState,
  OUTSTANDING_PAYMENT_TRANSACTION_STATUSES,
  readStoredPaymentEventOutcome,
  readStoredPaymentProvider,
  readStoredPaymentTransactionStatus,
  readStoredProductionProfile,
  readGarmentSizeClass,
  readHalftoneSettings,
  readProductionTreatment,
  readStoredProductionUnlockStatus,
  readStoredRequestedProductionOutput,
} from "@/lib/domain/types";
import type {
  AcquisitionEntitlement,
  AcquisitionFreeConceptClaim,
  AcquisitionSession,
  ArtworkPreparation,
  ArtworkPreparationStatus,
  ArtworkVersion,
  AssetKind,
  AssetRecord,
  ConceptDirectionKey,
  ConceptEvaluation,
  ConceptEvaluationStatus,
  ConversationMessage,
  ConversationPhase,
  DesignBriefVersion,
  DesignBriefVersionStatus,
  DesignConversation,
  FinalArtworkJob,
  FinalArtworkJobStatus,
  FinalDirectionApproval,
  FinalDirectionApprovalStatus,
  GenerationJob,
  GenerationJobStatus,
  InterviewStateData,
  PaidImageIntent,
  PaidImageIntentStatus,
  PaymentEvent,
  PaymentEventApplication,
  PaymentProviderKey,
  PaymentTransaction,
  PrintProject,
  ProductionAssetRole,
  ProductionAssetValidation,
  ProductionProfile,
  ProductionUnlock,
  ProjectSnapshot,
  ProjectStatus,
  TShirtDesignBrief,
} from "@/lib/domain/types";
import type {
  ApproveDesignBriefInput,
  CaptureAcquisitionEmailInput,
  CreateArtworkPreparationInput,
  CreateArtworkVersionInput,
  CreateAssetInput,
  CreateFinalArtworkJobInput,
  CreateFinalDirectionApprovalInput,
  CreateGenerationJobInput,
  CompletePaidImageIntentInput,
  CreateMessageInput,
  CreateProductionAssetValidationInput,
  ApplyPaymentEventInput,
  BindProviderCheckoutSessionInput,
  CreateProductionUnlockInput,
  FreeConceptAllocation,
  OpenPaymentTransactionInput,
  PaidImageIntentReservation,
  PaymentTransactionOpening,
  ProductionUnlockGrant,
  ProjectRepository,
  RecordPaidImageIntentFailureInput,
  ReservePaidImageIntentInput,
  UpdateArtworkEvaluationInput,
  UpdateArtworkPreparationInput,
  UpdateFinalArtworkJobInput,
  UpdateGenerationJobInput,
} from "./repository";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  FreeConceptAlreadyConsumedError,
  UniqueConstraintViolationError,
} from "./repository";
import { getSupabaseServiceClient, isSupabaseConfigured } from "./supabase-client";

type DbProject = {
  id: string;
  name: string;
  status: ProjectStatus;
  selected_artwork_version_id: string | null;
  /** Sprint 2M Phase 2G (Goal 3). */
  revision_pending: boolean | null;
  /** Sprint 2G Live Acceptance Corrective Pass. */
  final_direction_confirmed: boolean | null;
  /**
   * Sprint A4. Optional in the row type (not merely nullable) so a build
   * running against a database that has not yet applied the A4 migration
   * reads `undefined` and maps to the legacy `null` rather than crashing.
   */
  acquisition_session_id?: string | null;
  created_at: string;
  updated_at: string;
};

/** Sprint A4 Correction 2. */
type DbAcquisitionFreeConceptClaim = {
  acquisition_session_id: string;
  generation_job_id: string | null;
  claimed_at: string;
};

/** Sprint A4. */
type DbAcquisitionSession = {
  id: string;
  session_token: string;
  entitlement: AcquisitionEntitlement;
  free_concept_project_id: string | null;
  free_concept_allocated_at: string | null;
  free_concept_generation_job_id: string | null;
  free_concept_consumed_at: string | null;
  email: string | null;
  email_captured_at: string | null;
  internal_granted_at: string | null;
  created_at: string;
  updated_at: string;
};

/**
 * Sprint A5.1. `production_profile` and `status` are deliberately typed as
 * raw `string`, not as the narrow domain unions: the row is whatever is
 * actually in the database, including a value a newer deploy wrote, and
 * pretending otherwise at the type level would let `mapProductionUnlock` skip
 * the fail-closed narrowing that is the whole point.
 */
type DbProductionUnlock = {
  id: string;
  project_id: string;
  acquisition_session_id: string;
  production_profile: string | null;
  status: string | null;
  granted_at: string;
  revoked_at: string | null;
  revoked_reason: string | null;
  created_at: string;
  updated_at: string;
};

/**
 * Sprint A5.3. `production_profile`, `provider`, and `status` are raw
 * `string` for the same reason `DbProductionUnlock`'s are: the row is
 * whatever is actually in the database, and typing them narrowly would let
 * the mapper skip the fail-closed narrowing that is the point.
 */
type DbPaymentTransaction = {
  id: string;
  project_id: string;
  acquisition_session_id: string;
  production_profile: string | null;
  provider: string | null;
  provider_checkout_session_id: string | null;
  provider_checkout_url: string | null;
  provider_payment_intent_id: string | null;
  /** Postgres `integer` — arrives as a number; normalized defensively in the mapper. */
  amount_minor: number | string;
  currency: string;
  status: string | null;
  created_at: string;
  updated_at: string;
};

/** Sprint A5.4. Vocabulary columns typed as raw `string` so the mapper cannot skip narrowing. */
type DbPaymentEvent = {
  id: string;
  provider: string | null;
  provider_event_id: string;
  event_type: string;
  payload_digest: string;
  received_at: string;
  outcome: string | null;
  processed_at: string | null;
  created_at: string;
  updated_at: string;
};

type DbBrief = {
  id: string;
  project_id: string;
  customer_name: string | null;
  project_name: string | null;
  product_summary: string | null;
  design_description: string | null;
  exact_text: string | null;
  shirt_color: string | null;
  print_placement: TShirtDesignBrief["printPlacement"];
  intended_print_width_in: number | null;
  /** Print'em All Phase 1. Untyped `string | null` at the row boundary — narrowed by `readGarmentSizeClass`, which reads anything unrecognized as "never stated". */
  garment_size_class: string | null;
  production_size_confirmed_at: string | null;
  production_size_confirmed_width_in: number | null;
  production_size_confirmed_max_height_in: number | null;
  /** Print'em All Phase 2. Untyped at the row boundary — narrowed by `readProductionTreatment`, which reads anything unrecognized as standard raster. */
  production_treatment: string | null;
  /** Print'em All Phase 2. Raw JSONB — narrowed fail-closed by `readHalftoneSettings`; a partial document is no settings, never defaults filled in. */
  halftone_settings: unknown;
  production_treatment_selected_at: string | null;
  /** Sprint A2. Untyped `string | null` at the row boundary — narrowed by `readStoredRequestedProductionOutput`, which fails closed on anything unrecognized. */
  requested_production_output: string | null;
  preferred_colors: string[] | null;
  design_style: string | null;
  additional_instructions: string | null;
  audience: string | null;
  purpose: string | null;
  exclusions: string | null;
  deferred_sections: string[] | null;
  created_at: string;
  updated_at: string;
};

type DbConversation = {
  id: string;
  project_id: string;
  phase: ConversationPhase;
  interview_state: InterviewStateData | null;
  created_at: string;
  updated_at: string;
};

type DbMessage = {
  id: string;
  conversation_id: string;
  project_id: string;
  role: ConversationMessage["role"];
  content: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
};

type DbArtwork = {
  id: string;
  project_id: string;
  version_number: number;
  kind: ArtworkVersion["kind"];
  title: string;
  summary: string;
  placeholder_label: string;
  accent_color: string;
  is_selected: boolean;
  design_brief_version_id: string | null;
  generation_job_id: string | null;
  primary_asset_id: string | null;
  thumbnail_asset_id: string | null;
  provider_key: string | null;
  customer_rating: number | null;
  evaluation_status: ConceptEvaluationStatus | null;
  evaluation: ConceptEvaluation | null;
  evaluation_evaluated_at: string | null;
  evaluation_provider_key: string | null;
  print_validation_status: string | null;
  /** Sprint 2G Live Acceptance Corrective Pass. */
  source_artwork_version_id: string | null;
  concept_direction_key: ConceptDirectionKey | null;
  created_at: string;
};

type DbGenerationJob = {
  id: string;
  project_id: string;
  design_brief_version_id: string;
  status: GenerationJobStatus;
  kind: GenerationJob["kind"];
  concept_count: number;
  provider_key: string;
  idempotency_key: string;
  /** Sprint 2G Live Acceptance Corrective Pass. */
  target_artwork_version_id: string | null;
  /** True Source-Image Targeted Revision. */
  revision_instruction: string | null;
  /** Sprint A4 Correction 1. Optional so a build running against a database that has not applied the correction migration reads undefined rather than crashing. */
  acquisition_session_id?: string | null;
  attempts: number;
  last_error: string | null;
  started_at: string | null;
  completed_at: string | null;
  heartbeat_at: string | null;
  created_at: string;
  updated_at: string;
};

/** Phase 2C0.5 — see `supabase/migrations/20260812120000_paid_image_intents.sql`. */
type DbPaidImageIntent = {
  id: string;
  project_id: string;
  generation_job_id: string;
  intent_key: string;
  intent_kind: string;
  direction_key: string;
  paid_intent_ordinal: number;
  status: PaidImageIntentStatus;
  dispatches: number;
  claim_token: string | null;
  provider_key: string | null;
  provider_request_id: string | null;
  result: Record<string, unknown> | null;
  last_error: string | null;
  succeeded_at: string | null;
  created_at: string;
  updated_at: string;
};

type DbAsset = {
  id: string;
  project_id: string;
  kind: AssetKind;
  storage_key: string | null;
  content_type: string | null;
  is_thumbnail: boolean;
  width_px: number | null;
  height_px: number | null;
  has_transparency: boolean | null;
  provider_key: string | null;
  generation_job_id: string | null;
  metadata: Record<string, unknown> | null;
  vector_asset_id: string | null;
  print_asset_id: string | null;
  final_artwork_job_id: string | null;
  production_role: ProductionAssetRole | null;
  created_at: string;
};

type DbFinalDirectionApproval = {
  id: string;
  project_id: string;
  artwork_version_id: string;
  design_brief_version_id: string;
  status: FinalDirectionApprovalStatus;
  approved_at: string;
  superseded_at: string | null;
  created_at: string;
};

type DbFinalArtworkJob = {
  id: string;
  project_id: string;
  /** Existing Artwork → Print Ready Phase 2: nullable — a prepared-upload job's authority is `artwork_preparation_id` instead. */
  final_direction_approval_id: string | null;
  artwork_preparation_id: string | null;
  /** Postgres `numeric` arrives as a number or a string depending on driver/precision — normalized in `mapFinalArtworkJob`. */
  production_width_in: number | string | null;
  /** Sprint A2 Correction 2: raw column; narrowed fail-closed in `mapFinalArtworkJob`. */
  requested_production_output: string | null;
  /** Print'em All Phase 2: frozen treatment identity. NULL = legacy job predating treatment binding. */
  production_treatment_key: string | null;
  artwork_version_id: string;
  status: FinalArtworkJobStatus;
  attempts: number;
  last_error: string | null;
  started_at: string | null;
  completed_at: string | null;
  heartbeat_at: string | null;
  /** Sprint 2M Phase 2E (Goal 3): paid-call idempotency triple — see `FinalArtworkJob`'s domain doc. */
  provider_key: string | null;
  provider_request_id: string | null;
  provider_status: string | null;
  created_at: string;
  updated_at: string;
};

type DbProductionAssetValidation = {
  id: string;
  project_id: string;
  final_artwork_job_id: string;
  asset_id: string;
  status: string;
  report: Record<string, unknown>;
  validated_at: string;
  created_at: string;
};

/** Existing Artwork → Print Ready Phase 1. */
type DbArtworkPreparation = {
  id: string;
  project_id: string;
  status: ArtworkPreparationStatus;
  original_asset_id: string;
  prepared_asset_id: string | null;
  prepared_artwork_version_id: string | null;
  original_filename: string | null;
  analysis: Record<string, unknown> | null;
  preparation: Record<string, unknown> | null;
  /** Phase 1.2. Absent on rows written before the column existed. */
  guided_cleanup?: Record<string, unknown> | null;
  /** Intelligent Separation Phase 9. Absent on rows written before the column existed. */
  separation?: Record<string, unknown> | null;
  approved_at: string | null;
  created_at: string;
  updated_at: string;
};

type DbDesignBriefVersion = {
  id: string;
  project_id: string;
  brief_id: string;
  version_number: number;
  status: DesignBriefVersionStatus;
  content: DesignBriefVersion["content"];
  approved_at: string;
  created_at: string;
};

function mapProject(row: DbProject): PrintProject {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    selectedArtworkVersionId: row.selected_artwork_version_id,
    revisionPending: row.revision_pending ?? false,
    finalDirectionConfirmed: row.final_direction_confirmed ?? false,
    acquisitionSessionId: row.acquisition_session_id ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapBrief(row: DbBrief): TShirtDesignBrief {
  return {
    id: row.id,
    projectId: row.project_id,
    customerName: row.customer_name,
    projectName: row.project_name,
    productSummary: row.product_summary,
    designDescription: row.design_description,
    exactText: row.exact_text,
    shirtColor: row.shirt_color,
    printPlacement: row.print_placement,
    intendedPrintWidthIn: row.intended_print_width_in,
    // Print'em All Phase 1: an unrecognized class reads as "never stated",
    // which downgrades to "assume standard adult for the SUGGESTION and ask
    // a human to confirm". Unlike `requestedProductionOutput` there is no
    // fail-closed sentinel to reach for, and none is needed: a garment class
    // authorizes nothing, and the confirmation gate below is what actually
    // stands between this row and a paid provider call.
    garmentSizeClass: readGarmentSizeClass(row.garment_size_class),
    productionSizeConfirmedAt: row.production_size_confirmed_at,
    productionSizeConfirmedWidthIn: row.production_size_confirmed_width_in,
    productionSizeConfirmedMaxHeightIn:
      row.production_size_confirmed_max_height_in,
    // Print'em All Phase 2: an unrecognized treatment reads as standard
    // raster — the representation whose validation nothing was relaxed for.
    // Failing toward the SAFE representation is the point: a build that
    // cannot interpret a treatment must not produce a plate under rules it
    // does not have.
    productionTreatment: readProductionTreatment(row.production_treatment),
    // Fail-closed, unlike the treatment above, and the asymmetry is
    // deliberate: these values ARE the plate, so a partial document means
    // "not reproducible", never "reproducible with defaults in the gaps".
    halftoneSettings: readHalftoneSettings(row.halftone_settings),
    productionTreatmentSelectedAt: row.production_treatment_selected_at,
    // Sprint A2 Correction 2 (Goal 12): FAIL CLOSED. An unrecognized value
    // becomes the sentinel, never `null` — an older build that cannot read
    // what the customer asked for must refuse to produce, not assume PNG.
    requestedProductionOutput: readStoredRequestedProductionOutput(
      row.requested_production_output,
    ),
    preferredColors: row.preferred_colors ?? [],
    designStyle: row.design_style,
    additionalInstructions: row.additional_instructions,
    audience: row.audience ?? null,
    purpose: row.purpose ?? null,
    exclusions: row.exclusions ?? null,
    deferredSections: row.deferred_sections ?? [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapConversation(row: DbConversation): DesignConversation {
  return {
    id: row.id,
    projectId: row.project_id,
    phase: row.phase,
    // Spread onto the full default shape (not just `??`) so a row written
    // before a new InterviewStateData field existed still gets a default
    // for it instead of `undefined`.
    interviewState: { ...emptyInterviewState(), ...row.interview_state },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapMessage(row: DbMessage): ConversationMessage {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    projectId: row.project_id,
    role: row.role,
    content: row.content,
    metadata: row.metadata ?? {},
    createdAt: row.created_at,
  };
}

function mapArtwork(row: DbArtwork): ArtworkVersion {
  return {
    id: row.id,
    projectId: row.project_id,
    versionNumber: row.version_number,
    kind: row.kind,
    title: row.title,
    summary: row.summary,
    placeholderLabel: row.placeholder_label,
    accentColor: row.accent_color,
    isSelected: row.is_selected,
    designBriefVersionId: row.design_brief_version_id,
    generationJobId: row.generation_job_id ?? null,
    primaryAssetId: row.primary_asset_id ?? null,
    thumbnailAssetId: row.thumbnail_asset_id ?? null,
    providerKey: row.provider_key ?? null,
    customerRating: row.customer_rating ?? null,
    evaluationStatus: row.evaluation_status ?? null,
    evaluation: row.evaluation ?? null,
    evaluationEvaluatedAt: row.evaluation_evaluated_at ?? null,
    evaluationProviderKey: row.evaluation_provider_key ?? null,
    printValidationStatus: row.print_validation_status ?? null,
    sourceArtworkVersionId: row.source_artwork_version_id ?? null,
    conceptDirectionKey: row.concept_direction_key ?? null,
    createdAt: row.created_at,
  };
}

function mapGenerationJob(row: DbGenerationJob): GenerationJob {
  return {
    id: row.id,
    projectId: row.project_id,
    designBriefVersionId: row.design_brief_version_id,
    status: row.status,
    kind: row.kind,
    conceptCount: row.concept_count,
    providerKey: row.provider_key,
    idempotencyKey: row.idempotency_key,
    targetArtworkVersionId: row.target_artwork_version_id ?? null,
    revisionInstruction: row.revision_instruction ?? null,
    acquisitionSessionId: row.acquisition_session_id ?? null,
    attempts: row.attempts,
    lastError: row.last_error,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    heartbeatAt: row.heartbeat_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Sprint A4. Never returns `sessionToken` to anything customer-facing — that is the caller's boundary, enforced in `conversation-service`/routes. */
function mapAcquisitionSession(row: DbAcquisitionSession): AcquisitionSession {
  return {
    id: row.id,
    sessionToken: row.session_token,
    entitlement: row.entitlement,
    freeConceptProjectId: row.free_concept_project_id,
    freeConceptAllocatedAt: row.free_concept_allocated_at,
    freeConceptGenerationJobId: row.free_concept_generation_job_id,
    freeConceptConsumedAt: row.free_concept_consumed_at,
    email: row.email,
    emailCapturedAt: row.email_captured_at,
    internalGrantedAt: row.internal_granted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Sprint A5.1: narrows both authority-bearing columns FAIL-CLOSED.
 *
 * The database already refuses an out-of-vocabulary value via CHECK
 * constraints, so in a healthy deployment these narrowings are no-ops. They
 * exist for the case the constraints cannot cover: a NEWER deploy widening
 * the CHECK and writing a profile or status this build has never heard of.
 * Coercing such a value to `"apparel_raster"` / `"active"` would let an old
 * running instance authorize a production path it does not implement, or
 * treat a lifecycle state it cannot interpret as permission.
 */
function mapProductionUnlock(row: DbProductionUnlock): ProductionUnlock {
  return {
    id: row.id,
    projectId: row.project_id,
    acquisitionSessionId: row.acquisition_session_id,
    productionProfile: readStoredProductionProfile(row.production_profile),
    status: readStoredProductionUnlockStatus(row.status),
    grantedAt: row.granted_at,
    revokedAt: row.revoked_at,
    revokedReason: row.revoked_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Sprint A5.3: narrows all three vocabulary columns FAIL-CLOSED, for the
 * same reason `mapProductionUnlock` does — the CHECK constraints already
 * refuse an out-of-vocabulary value, so these exist for the case they cannot
 * cover: a NEWER deploy widening a CHECK and writing a value this build has
 * never heard of. Nothing may read such a value as `"paid"`, and nothing may
 * read it as an outstanding attempt either.
 */
/** Sprint A5.4: narrows provider and outcome FAIL-CLOSED, same reason as every other mapper here. */
function mapPaymentEvent(row: DbPaymentEvent): PaymentEvent {
  return {
    id: row.id,
    provider: readStoredPaymentProvider(row.provider),
    providerEventId: row.provider_event_id,
    eventType: row.event_type,
    payloadDigest: row.payload_digest,
    receivedAt: row.received_at,
    outcome: readStoredPaymentEventOutcome(row.outcome),
    processedAt: row.processed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapPaymentTransaction(row: DbPaymentTransaction): PaymentTransaction {
  return {
    id: row.id,
    projectId: row.project_id,
    acquisitionSessionId: row.acquisition_session_id,
    productionProfile: readStoredProductionProfile(row.production_profile),
    provider: readStoredPaymentProvider(row.provider),
    providerCheckoutSessionId: row.provider_checkout_session_id,
    providerCheckoutUrl: row.provider_checkout_url,
    providerPaymentIntentId: row.provider_payment_intent_id,
    amountMinor: Number(row.amount_minor),
    currency: row.currency,
    status: readStoredPaymentTransactionStatus(row.status),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapPaidImageIntent(row: DbPaidImageIntent): PaidImageIntent {
  return {
    id: row.id,
    projectId: row.project_id,
    generationJobId: row.generation_job_id,
    intentKey: row.intent_key,
    intentKind: row.intent_kind,
    directionKey: row.direction_key,
    paidIntentOrdinal: row.paid_intent_ordinal,
    status: row.status,
    dispatches: row.dispatches,
    claimToken: row.claim_token,
    providerKey: row.provider_key,
    providerRequestId: row.provider_request_id,
    result: row.result ?? null,
    lastError: row.last_error,
    succeededAt: row.succeeded_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapAsset(row: DbAsset): AssetRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    kind: row.kind,
    storageKey: row.storage_key,
    contentType: row.content_type,
    isThumbnail: row.is_thumbnail,
    widthPx: row.width_px,
    heightPx: row.height_px,
    hasTransparency: row.has_transparency,
    providerKey: row.provider_key,
    generationJobId: row.generation_job_id,
    metadata: row.metadata ?? {},
    vectorAssetId: row.vector_asset_id,
    printAssetId: row.print_asset_id,
    finalArtworkJobId: row.final_artwork_job_id ?? null,
    productionRole: row.production_role ?? null,
    createdAt: row.created_at,
  };
}

function mapFinalDirectionApproval(
  row: DbFinalDirectionApproval,
): FinalDirectionApproval {
  return {
    id: row.id,
    projectId: row.project_id,
    artworkVersionId: row.artwork_version_id,
    designBriefVersionId: row.design_brief_version_id,
    status: row.status,
    approvedAt: row.approved_at,
    supersededAt: row.superseded_at,
    createdAt: row.created_at,
  };
}

function mapFinalArtworkJob(row: DbFinalArtworkJob): FinalArtworkJob {
  const artworkPreparationId = row.artwork_preparation_id ?? null;
  return {
    id: row.id,
    projectId: row.project_id,
    // Derived, never a stored column — see `FinalArtworkSourceKind`.
    sourceKind: artworkPreparationId ? "prepared_upload" : "generated_concept",
    finalDirectionApprovalId: row.final_direction_approval_id ?? null,
    artworkPreparationId,
    productionWidthIn: readNumericColumn(row.production_width_in),
    // Sprint A2 Correction 2: the immutable intent this job was created to
    // satisfy. Fail-closed like the brief column — a value this build cannot
    // read must never let a job be mistaken for a Production PNG job.
    requestedProductionOutput: readStoredRequestedProductionOutput(
      row.requested_production_output,
    ),
    // Print'em All Phase 2: read raw, never narrowed. This is an opaque
    // IDENTITY string whose only job is to compare equal or unequal to the
    // project's current key — normalizing it would be able to make two
    // genuinely different production intents look like one.
    productionTreatmentKey: row.production_treatment_key ?? null,
    artworkVersionId: row.artwork_version_id,
    status: row.status,
    attempts: row.attempts,
    lastError: row.last_error,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    heartbeatAt: row.heartbeat_at,
    providerKey: row.provider_key ?? null,
    providerRequestId: row.provider_request_id ?? null,
    providerStatus: row.provider_status ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Postgres `numeric` has no lossless JavaScript equivalent, so PostgREST may
 * return it as a string. Normalized here rather than at every call site, and
 * anything unparseable becomes `null` — never a silently wrong production
 * size (Constitution §15: an unknown figure is stated as unknown, never
 * guessed).
 */
function readNumericColumn(value: number | string | null): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === "number" ? value : Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function mapProductionAssetValidation(
  row: DbProductionAssetValidation,
): ProductionAssetValidation {
  return {
    id: row.id,
    projectId: row.project_id,
    finalArtworkJobId: row.final_artwork_job_id,
    assetId: row.asset_id,
    status: row.status,
    report: row.report ?? {},
    validatedAt: row.validated_at,
    createdAt: row.created_at,
  };
}

function mapArtworkPreparation(row: DbArtworkPreparation): ArtworkPreparation {
  return {
    id: row.id,
    projectId: row.project_id,
    status: row.status,
    originalAssetId: row.original_asset_id,
    preparedAssetId: row.prepared_asset_id,
    preparedArtworkVersionId: row.prepared_artwork_version_id,
    originalFilename: row.original_filename,
    analysis: row.analysis ?? {},
    preparation: row.preparation ?? null,
    guidedCleanup: row.guided_cleanup ?? null,
    separation: row.separation ?? null,
    approvedAt: row.approved_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapDesignBriefVersion(row: DbDesignBriefVersion): DesignBriefVersion {
  return {
    id: row.id,
    projectId: row.project_id,
    briefId: row.brief_id,
    versionNumber: row.version_number,
    status: row.status,
    content: row.content,
    approvedAt: row.approved_at,
    createdAt: row.created_at,
  };
}

/** Postgres unique_violation. See https://www.postgresql.org/docs/current/errcodes-appendix.html */
const POSTGRES_UNIQUE_VIOLATION = "23505";

export { isSupabaseConfigured };

export class SupabaseProjectRepository implements ProjectRepository {
  private client: SupabaseClient;

  /**
   * Sprint 2H Part 2B: accepts an injectable client (mirroring
   * `SupabaseStorageAssetProvider`) so `claimNextQueuedJob` /
   * `recoverAbandonedJobs`'s atomic-claim query shape can be unit-tested
   * against a fake Postgrest client without live Supabase infrastructure.
   * Production call sites never pass an argument.
   */
  constructor(client: SupabaseClient = getSupabaseServiceClient()) {
    this.client = client;
  }

  async createProject(
    acquisitionSessionId: string | null = null,
  ): Promise<ProjectSnapshot> {
    // Sprint A4: the binding is written in the SAME insert that creates the
    // project, never as a follow-up update. A project that briefly existed
    // unbound would be indistinguishable from a legacy project and would
    // therefore be grandfathered — a free-generation hole opened by a
    // partial failure.
    const { data: projectRow, error: projectError } = await this.client
      .from("print_projects")
      .insert({
        name: "Untitled T-shirt design",
        status: "intake",
        ...(acquisitionSessionId
          ? { acquisition_session_id: acquisitionSessionId }
          : {}),
      })
      .select("*")
      .single();
    if (projectError) throw projectError;

    const project = mapProject(projectRow as DbProject);

    const { data: briefRow, error: briefError } = await this.client
      .from("tshirt_design_briefs")
      .insert({ project_id: project.id })
      .select("*")
      .single();
    if (briefError) throw briefError;

    // Sprint 2F: new projects start in the adaptive interview lifecycle.
    // "product" is always the first question — nothing can be known yet.
    const initialInterviewState = {
      ...emptyInterviewState(),
      pendingSection: "product",
      askCounts: { product: 1 },
    };
    const { data: conversationRow, error: conversationError } =
      await this.client
        .from("design_conversations")
        .insert({
          project_id: project.id,
          phase: "interviewing",
          interview_state: initialInterviewState,
        })
        .select("*")
        .single();
    if (conversationError) throw conversationError;

    const conversation = mapConversation(conversationRow as DbConversation);

    const { data: messageRow, error: messageError } = await this.client
      .from("conversation_messages")
      .insert({
        conversation_id: conversation.id,
        project_id: project.id,
        role: "assistant",
        content: OPENING_PROMPT,
        metadata: { phase: "interviewing", act: "ask", section: "product" },
      })
      .select("*")
      .single();
    if (messageError) throw messageError;

    return {
      project,
      brief: mapBrief(briefRow as DbBrief),
      conversation,
      messages: [mapMessage(messageRow as DbMessage)],
      artworkVersions: [],
      designBriefVersions: [],
    };
  }

  async getProject(projectId: string): Promise<ProjectSnapshot | null> {
    const { data: projectRow, error: projectError } = await this.client
      .from("print_projects")
      .select("*")
      .eq("id", projectId)
      .maybeSingle();
    if (projectError) throw projectError;
    if (!projectRow) return null;

    const [
      { data: briefRow },
      { data: conversationRow },
      { data: messages },
      { data: versions },
      { data: briefVersions },
    ] = await Promise.all([
      this.client
        .from("tshirt_design_briefs")
        .select("*")
        .eq("project_id", projectId)
        .single(),
      this.client
        .from("design_conversations")
        .select("*")
        .eq("project_id", projectId)
        .single(),
      this.client
        .from("conversation_messages")
        .select("*")
        .eq("project_id", projectId)
        .order("created_at", { ascending: true }),
      this.client
        .from("artwork_versions")
        .select("*")
        .eq("project_id", projectId)
        .order("version_number", { ascending: true }),
      this.client
        .from("design_brief_versions")
        .select("*")
        .eq("project_id", projectId)
        .order("version_number", { ascending: true }),
    ]);

    if (!briefRow || !conversationRow) return null;

    return {
      project: mapProject(projectRow as DbProject),
      brief: mapBrief(briefRow as DbBrief),
      conversation: mapConversation(conversationRow as DbConversation),
      messages: ((messages as DbMessage[]) ?? []).map(mapMessage),
      artworkVersions: ((versions as DbArtwork[]) ?? []).map(mapArtwork),
      designBriefVersions: ((briefVersions as DbDesignBriefVersion[]) ?? []).map(
        mapDesignBriefVersion,
      ),
    };
  }

  async updateProject(
    projectId: string,
    patch: Partial<
      Pick<
        PrintProject,
        | "name"
        | "status"
        | "selectedArtworkVersionId"
        | "revisionPending"
        | "finalDirectionConfirmed"
      >
    >,
  ): Promise<PrintProject> {
    const payload: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };
    if (patch.name !== undefined) payload.name = patch.name;
    if (patch.status !== undefined) payload.status = patch.status;
    if (patch.selectedArtworkVersionId !== undefined) {
      payload.selected_artwork_version_id = patch.selectedArtworkVersionId;
    }
    if (patch.revisionPending !== undefined) {
      payload.revision_pending = patch.revisionPending;
    }
    if (patch.finalDirectionConfirmed !== undefined) {
      payload.final_direction_confirmed = patch.finalDirectionConfirmed;
    }

    const { data, error } = await this.client
      .from("print_projects")
      .update(payload)
      .eq("id", projectId)
      .select("*")
      .single();
    if (error) throw error;
    return mapProject(data as DbProject);
  }

  async updateBrief(
    projectId: string,
    patch: Partial<
      Omit<TShirtDesignBrief, "id" | "projectId" | "createdAt" | "updatedAt">
    >,
  ): Promise<TShirtDesignBrief> {
    const payload: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };

    if (patch.customerName !== undefined)
      payload.customer_name = patch.customerName;
    if (patch.projectName !== undefined)
      payload.project_name = patch.projectName;
    if (patch.productSummary !== undefined)
      payload.product_summary = patch.productSummary;
    if (patch.designDescription !== undefined)
      payload.design_description = patch.designDescription;
    if (patch.exactText !== undefined) payload.exact_text = patch.exactText;
    if (patch.shirtColor !== undefined) payload.shirt_color = patch.shirtColor;
    if (patch.printPlacement !== undefined)
      payload.print_placement = patch.printPlacement;
    if (patch.intendedPrintWidthIn !== undefined)
      payload.intended_print_width_in = patch.intendedPrintWidthIn;
    if (patch.garmentSizeClass !== undefined)
      payload.garment_size_class = patch.garmentSizeClass;
    // Print'em All Phase 1: the three confirmation columns are always written
    // TOGETHER by `DesignBriefCapability.confirmProductionSize` (and cleared
    // together when a confirmation is withdrawn), so a half-written
    // confirmation — a timestamp with no width — never reaches the database.
    // `resolveProductionSizeConfirmation` fails closed on one anyway; this is
    // the belt to that suspenders.
    if (patch.productionSizeConfirmedAt !== undefined)
      payload.production_size_confirmed_at = patch.productionSizeConfirmedAt;
    if (patch.productionSizeConfirmedWidthIn !== undefined)
      payload.production_size_confirmed_width_in =
        patch.productionSizeConfirmedWidthIn;
    if (patch.productionSizeConfirmedMaxHeightIn !== undefined)
      payload.production_size_confirmed_max_height_in =
        patch.productionSizeConfirmedMaxHeightIn;
    // Print'em All Phase 2: the three treatment columns are always written
    // TOGETHER by `DesignBriefCapability.selectProductionTreatment` (and
    // cleared together when a treatment is retracted), for the same reason the
    // confirmation columns above are — a treatment recorded without its
    // settings, or settings without the timestamp that says a human chose
    // them, is not a treatment.
    if (patch.productionTreatment !== undefined)
      payload.production_treatment = patch.productionTreatment;
    if (patch.halftoneSettings !== undefined)
      payload.halftone_settings = patch.halftoneSettings;
    if (patch.productionTreatmentSelectedAt !== undefined)
      payload.production_treatment_selected_at =
        patch.productionTreatmentSelectedAt;
    if (patch.requestedProductionOutput !== undefined)
      payload.requested_production_output = patch.requestedProductionOutput;
    if (patch.preferredColors !== undefined)
      payload.preferred_colors = patch.preferredColors;
    if (patch.designStyle !== undefined)
      payload.design_style = patch.designStyle;
    if (patch.additionalInstructions !== undefined)
      payload.additional_instructions = patch.additionalInstructions;
    if (patch.audience !== undefined) payload.audience = patch.audience;
    if (patch.purpose !== undefined) payload.purpose = patch.purpose;
    if (patch.exclusions !== undefined) payload.exclusions = patch.exclusions;
    if (patch.deferredSections !== undefined)
      payload.deferred_sections = patch.deferredSections;

    const { data, error } = await this.client
      .from("tshirt_design_briefs")
      .update(payload)
      .eq("project_id", projectId)
      .select("*")
      .single();
    if (error) throw error;

    const brief = mapBrief(data as DbBrief);
    await this.updateProject(projectId, { name: projectNameFromBrief(brief) });
    return brief;
  }

  async updateConversationPhase(
    projectId: string,
    phase: ConversationPhase,
  ): Promise<DesignConversation> {
    const { data, error } = await this.client
      .from("design_conversations")
      .update({ phase, updated_at: new Date().toISOString() })
      .eq("project_id", projectId)
      .select("*")
      .single();
    if (error) throw error;
    return mapConversation(data as DbConversation);
  }

  async updateConversationInterviewState(
    projectId: string,
    interviewState: InterviewStateData,
  ): Promise<DesignConversation> {
    const { data, error } = await this.client
      .from("design_conversations")
      .update({
        interview_state: interviewState,
        updated_at: new Date().toISOString(),
      })
      .eq("project_id", projectId)
      .select("*")
      .single();
    if (error) throw error;
    return mapConversation(data as DbConversation);
  }

  async addMessage(
    projectId: string,
    input: CreateMessageInput,
  ): Promise<ConversationMessage> {
    const { data: conversation, error: conversationError } = await this.client
      .from("design_conversations")
      .select("id")
      .eq("project_id", projectId)
      .single();
    if (conversationError) throw conversationError;

    const { data, error } = await this.client
      .from("conversation_messages")
      .insert({
        conversation_id: conversation.id,
        project_id: projectId,
        role: input.role,
        content: input.content,
        metadata: input.metadata ?? {},
      })
      .select("*")
      .single();
    if (error) throw error;
    return mapMessage(data as DbMessage);
  }

  async addArtworkVersions(
    projectId: string,
    versions: CreateArtworkVersionInput[],
  ): Promise<ArtworkVersion[]> {
    const { data, error } = await this.client
      .from("artwork_versions")
      .insert(
        versions.map((version) => ({
          project_id: projectId,
          version_number: version.versionNumber,
          kind: version.kind,
          title: version.title,
          summary: version.summary,
          placeholder_label: version.placeholderLabel,
          accent_color: version.accentColor,
          is_selected: false,
          design_brief_version_id: version.designBriefVersionId,
          generation_job_id: version.generationJobId ?? null,
          primary_asset_id: version.primaryAssetId ?? null,
          thumbnail_asset_id: version.thumbnailAssetId ?? null,
          provider_key: version.providerKey ?? null,
          evaluation_status: version.evaluationStatus ?? null,
          evaluation: version.evaluation ?? null,
          evaluation_evaluated_at: version.evaluationEvaluatedAt ?? null,
          evaluation_provider_key: version.evaluationProviderKey ?? null,
          source_artwork_version_id: version.sourceArtworkVersionId ?? null,
          concept_direction_key: version.conceptDirectionKey ?? null,
        })),
      )
      .select("*")
      .order("version_number", { ascending: true });
    if (error) throw error;
    return ((data as DbArtwork[]) ?? []).map(mapArtwork);
  }

  async updateArtworkEvaluation(
    artworkVersionId: string,
    input: UpdateArtworkEvaluationInput,
  ): Promise<ArtworkVersion> {
    const { data, error } = await this.client
      .from("artwork_versions")
      .update({
        evaluation_status: input.evaluationStatus,
        evaluation: input.evaluation,
        evaluation_evaluated_at: input.evaluationEvaluatedAt,
        evaluation_provider_key: input.evaluationProviderKey,
      })
      .eq("id", artworkVersionId)
      .select("*")
      .single();
    if (error) throw error;
    return mapArtwork(data as DbArtwork);
  }

  async selectArtworkVersion(
    projectId: string,
    artworkVersionId: string,
  ): Promise<ProjectSnapshot> {
    await this.client
      .from("artwork_versions")
      .update({ is_selected: false })
      .eq("project_id", projectId);

    const { error: selectError } = await this.client
      .from("artwork_versions")
      .update({ is_selected: true })
      .eq("id", artworkVersionId)
      .eq("project_id", projectId);
    if (selectError) throw selectError;

    await this.updateProject(projectId, {
      selectedArtworkVersionId: artworkVersionId,
      status: "revision_requested",
    });

    const snapshot = await this.getProject(projectId);
    if (!snapshot) throw new Error("Project not found");
    return snapshot;
  }

  async clearArtworkSelection(projectId: string): Promise<ProjectSnapshot> {
    const { error: clearError } = await this.client
      .from("artwork_versions")
      .update({ is_selected: false })
      .eq("project_id", projectId);
    if (clearError) throw clearError;

    await this.updateProject(projectId, {
      selectedArtworkVersionId: null,
      // See the local store's identical note: a confirmation can never
      // outlive the selection it was made about.
      finalDirectionConfirmed: false,
      status: "concepts_ready",
    });

    const snapshot = await this.getProject(projectId);
    if (!snapshot) throw new Error("Project not found");
    return snapshot;
  }

  async setProjectStatus(
    projectId: string,
    status: ProjectStatus,
  ): Promise<PrintProject> {
    return this.updateProject(projectId, { status });
  }

  async approveDesignBrief(
    projectId: string,
    input: ApproveDesignBriefInput,
  ): Promise<DesignBriefVersion> {
    const { data, error } = await this.client
      .from("design_brief_versions")
      .insert({
        project_id: projectId,
        brief_id: input.briefId,
        version_number: input.versionNumber,
        status: "approved",
        content: input.content,
      })
      .select("*")
      .single();

    if (error) {
      if (error.code === POSTGRES_UNIQUE_VIOLATION) {
        throw new UniqueConstraintViolationError(
          "design_brief_versions_project_id_version_number",
        );
      }
      throw error;
    }

    return mapDesignBriefVersion(data as DbDesignBriefVersion);
  }

  async getLatestDesignBriefVersion(
    projectId: string,
  ): Promise<DesignBriefVersion | null> {
    const { data, error } = await this.client
      .from("design_brief_versions")
      .select("*")
      .eq("project_id", projectId)
      .order("version_number", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    return data ? mapDesignBriefVersion(data as DbDesignBriefVersion) : null;
  }

  async getDesignBriefVersionById(
    versionId: string,
  ): Promise<DesignBriefVersion | null> {
    const { data, error } = await this.client
      .from("design_brief_versions")
      .select("*")
      .eq("id", versionId)
      .maybeSingle();
    if (error) throw error;
    return data ? mapDesignBriefVersion(data as DbDesignBriefVersion) : null;
  }

  // --- Sprint 2H Part 1: generation jobs -----------------------------

  async createGenerationJob(
    projectId: string,
    input: CreateGenerationJobInput,
  ): Promise<GenerationJob> {
    const { data, error } = await this.client
      .from("generation_jobs")
      .insert({
        project_id: projectId,
        design_brief_version_id: input.designBriefVersionId,
        status: "queued",
        kind: input.kind,
        concept_count: input.conceptCount,
        provider_key: input.providerKey,
        idempotency_key: input.idempotencyKey,
        target_artwork_version_id: input.targetArtworkVersionId ?? null,
        revision_instruction: input.revisionInstruction ?? null,
        // Sprint A4 Correction 1: only ever set for the acquisition free
        // concept. A partial unique index on this column is what makes this
        // INSERT the entitlement authority.
        ...(input.acquisitionSessionId
          ? { acquisition_session_id: input.acquisitionSessionId }
          : {}),
        attempts: 0,
      })
      .select("*")
      .single();

    if (error) {
      if (error.code === POSTGRES_UNIQUE_VIOLATION) {
        // Sprint A4 Correction 1: TWO unique rules can land here and they
        // mean genuinely different things, so which one fired is resolved by
        // re-reading — never by parsing the error text (same discipline as
        // `reservePaidImageIntent`).

        // (project_id, idempotency_key): a concurrent or duplicate call
        // raced us to create the SAME logical job. Return the winner's row
        // rather than erroring — this is a resume, not a second request.
        const existing = await this.getGenerationJobByIdempotencyKey(
          projectId,
          input.idempotencyKey,
        );
        if (existing) return existing;

        // Sprint A4 Correction 2: EITHER the partial unique index on
        // `generation_jobs.acquisition_session_id` (a free job still exists)
        // OR the `acquisition_free_concept_claims` primary key, raised by
        // the BEFORE INSERT trigger inside this very statement (a claim
        // exists, whether or not its job still does).
        //
        // Both mean the same thing to the caller — this session has already
        // taken its one free attempt — so they are deliberately not
        // distinguished here. The claim is the one that keeps enforcing
        // after the job has been deleted, which is why it exists.
        //
        // Nothing was spent: the insert was refused before any job existed
        // for a worker to claim.
        if (input.acquisitionSessionId) {
          throw new FreeConceptAlreadyConsumedError();
        }
      }
      throw error;
    }

    return mapGenerationJob(data as DbGenerationJob);
  }

  async getFreeConceptClaim(
    acquisitionSessionId: string,
  ): Promise<AcquisitionFreeConceptClaim | null> {
    const { data, error } = await this.client
      .from("acquisition_free_concept_claims")
      .select("*")
      .eq("acquisition_session_id", acquisitionSessionId)
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    const row = data as DbAcquisitionFreeConceptClaim;
    return {
      acquisitionSessionId: row.acquisition_session_id,
      generationJobId: row.generation_job_id,
      claimedAt: row.claimed_at,
    };
  }

  async getFreeConceptGenerationJob(
    acquisitionSessionId: string,
  ): Promise<GenerationJob | null> {
    // At most one row can match — the partial unique index guarantees it —
    // so `maybeSingle` is a correctness assertion as much as a query shape.
    const { data, error } = await this.client
      .from("generation_jobs")
      .select("*")
      .eq("acquisition_session_id", acquisitionSessionId)
      .maybeSingle();
    if (error) throw error;
    return data ? mapGenerationJob(data as DbGenerationJob) : null;
  }

  async getGenerationJobByIdempotencyKey(
    projectId: string,
    idempotencyKey: string,
  ): Promise<GenerationJob | null> {
    const { data, error } = await this.client
      .from("generation_jobs")
      .select("*")
      .eq("project_id", projectId)
      .eq("idempotency_key", idempotencyKey)
      .maybeSingle();
    if (error) throw error;
    return data ? mapGenerationJob(data as DbGenerationJob) : null;
  }

  async getGenerationJob(jobId: string): Promise<GenerationJob | null> {
    const { data, error } = await this.client
      .from("generation_jobs")
      .select("*")
      .eq("id", jobId)
      .maybeSingle();
    if (error) throw error;
    return data ? mapGenerationJob(data as DbGenerationJob) : null;
  }

  async listGenerationJobs(projectId: string): Promise<GenerationJob[]> {
    const { data, error } = await this.client
      .from("generation_jobs")
      .select("*")
      .eq("project_id", projectId)
      .order("created_at", { ascending: true });
    if (error) throw error;
    return ((data as DbGenerationJob[]) ?? []).map(mapGenerationJob);
  }

  async updateGenerationJob(
    jobId: string,
    patch: UpdateGenerationJobInput,
  ): Promise<GenerationJob> {
    const payload: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };
    if (patch.status !== undefined) payload.status = patch.status;
    if (patch.attempts !== undefined) payload.attempts = patch.attempts;
    if (patch.lastError !== undefined) payload.last_error = patch.lastError;
    if (patch.startedAt !== undefined) payload.started_at = patch.startedAt;
    if (patch.completedAt !== undefined) payload.completed_at = patch.completedAt;
    if (patch.heartbeatAt !== undefined) payload.heartbeat_at = patch.heartbeatAt;

    const { data, error } = await this.client
      .from("generation_jobs")
      .update(payload)
      .eq("id", jobId)
      .select("*")
      .single();
    if (error) throw error;
    return mapGenerationJob(data as DbGenerationJob);
  }

  // --- Sprint 2H Part 2A: background worker ---------------------------

  async claimNextQueuedJob(): Promise<GenerationJob | null> {
    // Optimistic claim: read the oldest due candidate, then update it
    // conditioned on it still being in the status we read — if a
    // concurrent claimant won the race, the conditional update touches
    // zero rows and we simply report "nothing claimed" rather than
    // retrying, which is safe (the caller's next tick tries again).
    const { data: candidate, error: candidateError } = await this.client
      .from("generation_jobs")
      .select("*")
      .in("status", ["queued", "recoverable"])
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (candidateError) throw candidateError;
    if (!candidate) return null;

    const row = candidate as DbGenerationJob;
    const timestamp = new Date().toISOString();

    const { data, error } = await this.client
      .from("generation_jobs")
      .update({
        status: "running",
        attempts: row.attempts + 1,
        started_at: timestamp,
        heartbeat_at: timestamp,
        updated_at: timestamp,
      })
      .eq("id", row.id)
      .eq("status", row.status)
      .select("*")
      .maybeSingle();
    if (error) throw error;
    return data ? mapGenerationJob(data as DbGenerationJob) : null;
  }

  async touchGenerationJobHeartbeat(jobId: string): Promise<void> {
    const { error } = await this.client
      .from("generation_jobs")
      .update({ heartbeat_at: new Date().toISOString() })
      .eq("id", jobId);
    if (error) throw error;
  }

  async recoverAbandonedJobs(staleAfterMs: number): Promise<GenerationJob[]> {
    const staleBefore = new Date(Date.now() - staleAfterMs).toISOString();

    // Sprint 2H Part 2B: a single atomic conditional UPDATE — no
    // select-then-write gap. The earlier version selected stale candidates
    // first and then unconditionally flipped exactly those row IDs to
    // "recoverable", which meant a job that legitimately heartbeated (or
    // even completed) in the gap between the SELECT and the UPDATE would
    // still get recovered — a second worker could then claim and re-run a
    // job that was never actually abandoned, producing a duplicate
    // concept batch. Folding the staleness filter directly into the
    // UPDATE's WHERE clause means Postgres evaluates it against each row's
    // *current* state at commit time, so a job is recovered "only once":
    // any legitimate heartbeat or completion between when this query was
    // issued and when it executes excludes that row from the update,
    // exactly like `claimNextQueuedJob`'s conditional claim.
    const { data, error } = await this.client
      .from("generation_jobs")
      .update({ status: "recoverable", updated_at: new Date().toISOString() })
      .eq("status", "running")
      .or(
        `and(heartbeat_at.is.null,started_at.lt.${staleBefore}),heartbeat_at.lt.${staleBefore}`,
      )
      .select("*");
    if (error) throw error;

    return ((data as DbGenerationJob[]) ?? []).map(mapGenerationJob);
  }

  // --- Sprint A4: acquisition sessions ---------------------------------

  async createAcquisitionSession(
    sessionToken: string,
  ): Promise<AcquisitionSession> {
    const { data, error } = await this.client
      .from("acquisition_sessions")
      .insert({ session_token: sessionToken, entitlement: "prospect" })
      .select("*")
      .single();
    if (error) throw error;
    return mapAcquisitionSession(data as DbAcquisitionSession);
  }

  async getAcquisitionSessionByToken(
    sessionToken: string,
  ): Promise<AcquisitionSession | null> {
    const { data, error } = await this.client
      .from("acquisition_sessions")
      .select("*")
      .eq("session_token", sessionToken)
      .maybeSingle();
    if (error) throw error;
    return data ? mapAcquisitionSession(data as DbAcquisitionSession) : null;
  }

  async getAcquisitionSession(
    sessionId: string,
  ): Promise<AcquisitionSession | null> {
    const { data, error } = await this.client
      .from("acquisition_sessions")
      .select("*")
      .eq("id", sessionId)
      .maybeSingle();
    if (error) throw error;
    return data ? mapAcquisitionSession(data as DbAcquisitionSession) : null;
  }

  async allocateFreeConcept(
    sessionId: string,
    projectId: string,
  ): Promise<FreeConceptAllocation> {
    // Single atomic conditional UPDATE — the same optimistic-claim shape as
    // `claimNextQueuedJob` and `beginPaidImageIntentDispatch`, and for the
    // same reason: this decides whether money may be spent, so it must not
    // have a read-then-write gap two requests could both pass through.
    //
    // Both NULL conditions matter. `free_concept_project_id is null` is the
    // allocation race; `free_concept_generation_job_id is null` refuses to
    // re-allocate an entitlement a durable job has already consumed, even
    // if some future code path cleared the project id.
    const timestamp = new Date().toISOString();
    const { data: claimed, error: claimError } = await this.client
      .from("acquisition_sessions")
      .update({
        free_concept_project_id: projectId,
        free_concept_allocated_at: timestamp,
        updated_at: timestamp,
      })
      .eq("id", sessionId)
      .is("free_concept_project_id", null)
      // Sprint A4 Correction 1: `free_concept_consumed_at` is the authority
      // for "was it spent"; the job id beside it is an immutable historical
      // reference that no longer carries a foreign key. Both are required to
      // be unset so neither alone can be cleared into a fresh allocation.
      .is("free_concept_consumed_at", null)
      .is("free_concept_generation_job_id", null)
      .select("*")
      .maybeSingle();
    if (claimError) throw claimError;
    if (claimed) {
      return {
        outcome: "allocated",
        session: mapAcquisitionSession(claimed as DbAcquisitionSession),
      };
    }

    // The conditional update touched no row. Re-read to learn WHY, rather
    // than inferring it — "already mine" and "already someone else's" are
    // different answers and only the row can distinguish them.
    const session = await this.getAcquisitionSession(sessionId);
    if (!session) throw new Error("Acquisition session not found");
    if (session.freeConceptConsumedAt || session.freeConceptGenerationJobId) {
      return { outcome: "exhausted", session };
    }
    if (session.freeConceptProjectId === projectId) {
      // Sprint A4 Correction 1: the allocation is still ours, but the
      // consumption marker is not the only evidence a job was created. A
      // crash between the job insert and the marker write leaves the marker
      // false and a real, executable, spend-bounded job behind — so the
      // durable evidence is consulted before reporting this resumable.
      //
      // Reporting `resumed` here would not actually produce a second paid
      // attempt (the insert would be refused), but it would tell the
      // customer their free concept is still available when it is not, and
      // every state derived from this call would inherit that lie.
      //
      // Sprint A4 Correction 2: the CLAIM is checked first — it is what the
      // insert is really validated against, and unlike the job it survives
      // that job being deleted.
      if (await this.getFreeConceptClaim(sessionId)) {
        return { outcome: "exhausted", session };
      }
      const spent = await this.getFreeConceptGenerationJob(sessionId);
      if (spent) return { outcome: "exhausted", session };
      return { outcome: "resumed", session };
    }
    return { outcome: "exhausted", session };
  }

  async recordFreeConceptConsumed(
    sessionId: string,
    generationJobId: string,
  ): Promise<AcquisitionSession | null> {
    const timestamp = new Date().toISOString();
    const { data, error } = await this.client
      .from("acquisition_sessions")
      .update({
        free_concept_generation_job_id: generationJobId,
        free_concept_consumed_at: timestamp,
        updated_at: timestamp,
      })
      .eq("id", sessionId)
      .is("free_concept_generation_job_id", null)
      .select("*")
      .maybeSingle();
    if (error) throw error;
    // No row updated means consumption was already recorded. Return the
    // session as it genuinely stands — the caller needs the WINNING job id,
    // not a failure.
    if (!data) return this.getAcquisitionSession(sessionId);
    return mapAcquisitionSession(data as DbAcquisitionSession);
  }

  async captureAcquisitionEmail(
    sessionId: string,
    input: CaptureAcquisitionEmailInput,
  ): Promise<AcquisitionSession | null> {
    const existing = await this.getAcquisitionSession(sessionId);
    if (!existing) return null;

    const timestamp = new Date().toISOString();
    const { data, error } = await this.client
      .from("acquisition_sessions")
      .update({
        email: input.email,
        // First capture only. A correction is not a new capture, and moving
        // this timestamp would rewrite when the prospect entered the funnel.
        email_captured_at: existing.emailCapturedAt ?? timestamp,
        updated_at: timestamp,
      })
      .eq("id", sessionId)
      .select("*")
      .maybeSingle();
    if (error) throw error;
    return data ? mapAcquisitionSession(data as DbAcquisitionSession) : null;
  }

  async grantInternalEntitlement(
    sessionId: string,
  ): Promise<AcquisitionSession | null> {
    const existing = await this.getAcquisitionSession(sessionId);
    if (!existing) return null;

    const timestamp = new Date().toISOString();
    const { data, error } = await this.client
      .from("acquisition_sessions")
      .update({
        entitlement: "internal",
        internal_granted_at: existing.internalGrantedAt ?? timestamp,
        updated_at: timestamp,
      })
      .eq("id", sessionId)
      .select("*")
      .maybeSingle();
    if (error) throw error;
    return data ? mapAcquisitionSession(data as DbAcquisitionSession) : null;
  }

  // --- Sprint A5.1: production unlocks (commercial entitlement) --------

  async getActiveProductionUnlock(
    projectId: string,
    productionProfile: ProductionProfile,
  ): Promise<ProductionUnlock | null> {
    // `.eq("status", "active")` is part of the guarantee, not an
    // optimization: a revoked unlock must be unable to reach a gate at all,
    // rather than relying on every caller to remember to check. The partial
    // unique index makes this a single-row lookup.
    const { data, error } = await this.client
      .from("production_unlocks")
      .select("*")
      .eq("project_id", projectId)
      .eq("production_profile", productionProfile)
      .eq("status", "active")
      .maybeSingle();
    if (error) throw error;
    return data ? mapProductionUnlock(data as DbProductionUnlock) : null;
  }

  async createProductionUnlock(
    projectId: string,
    input: CreateProductionUnlockInput,
  ): Promise<ProductionUnlockGrant> {
    const { data, error } = await this.client
      .from("production_unlocks")
      .insert({
        project_id: projectId,
        acquisition_session_id: input.acquisitionSessionId,
        production_profile: input.productionProfile,
        status: "active",
      })
      .select("*")
      .single();

    if (error) {
      // THE UNIQUENESS IS THE GUARANTEE. A concurrent grant — a duplicate
      // request, two operator clicks, and in A5.3+ two webhook deliveries —
      // loses here, and the correct response is to report the WINNER rather
      // than to fail: the desired end state (this project is unlocked) holds
      // either way, and raising would tempt a caller into retrying, which is
      // how a second entitlement gets created.
      //
      // Re-read rather than assume: only the row can say who won, and the
      // caller needs the real id.
      if (error.code === POSTGRES_UNIQUE_VIOLATION) {
        const raced = await this.getActiveProductionUnlock(
          projectId,
          input.productionProfile,
        );
        if (raced) return { outcome: "existing", unlock: raced };
      }
      throw error;
    }

    return { outcome: "granted", unlock: mapProductionUnlock(data as DbProductionUnlock) };
  }

  async revokeProductionUnlock(
    projectId: string,
    productionProfile: ProductionProfile,
    reason: string | null,
  ): Promise<ProductionUnlock | null> {
    const timestamp = new Date().toISOString();
    // A single conditional UPDATE, the same optimistic shape every other
    // authority transition in this store uses. `.eq("status", "active")` is
    // what makes a duplicate revocation a no-op instead of moving
    // `revoked_at` on an already-revoked row and rewriting when it happened.
    //
    // The row is never deleted, and nothing else is touched: final artwork
    // jobs, production assets, and their validations all stay exactly as they
    // are, because that work genuinely happened. Revocation stops FUTURE
    // finalization only.
    const { data, error } = await this.client
      .from("production_unlocks")
      .update({
        status: "revoked",
        revoked_at: timestamp,
        revoked_reason: reason,
        updated_at: timestamp,
      })
      .eq("project_id", projectId)
      .eq("production_profile", productionProfile)
      .eq("status", "active")
      .select("*")
      .maybeSingle();
    if (error) throw error;
    // No row updated means there was nothing active to revoke. Not an error:
    // revoking twice, or revoking something never granted, both leave the
    // world in the state the caller asked for.
    return data ? mapProductionUnlock(data as DbProductionUnlock) : null;
  }

  // --- Sprint A5.3: payment transactions (checkout attempts) -----------

  async getOutstandingPaymentTransaction(
    projectId: string,
    productionProfile: ProductionProfile,
  ): Promise<PaymentTransaction | null> {
    // The status filter is part of the guarantee. Terminal rows must not
    // surface: a `failed` attempt would strand a customer entitled to try
    // again, and a `paid` one would put a completed purchase back in front of
    // them. The partial unique index makes this a single-row lookup.
    const { data, error } = await this.client
      .from("payment_transactions")
      .select("*")
      .eq("project_id", projectId)
      .eq("production_profile", productionProfile)
      .in("status", [...OUTSTANDING_PAYMENT_TRANSACTION_STATUSES])
      .maybeSingle();
    if (error) throw error;
    return data ? mapPaymentTransaction(data as DbPaymentTransaction) : null;
  }

  async getPaymentTransaction(id: string): Promise<PaymentTransaction | null> {
    const { data, error } = await this.client
      .from("payment_transactions")
      .select("*")
      .eq("id", id)
      .maybeSingle();
    if (error) throw error;
    return data ? mapPaymentTransaction(data as DbPaymentTransaction) : null;
  }

  async openPaymentTransaction(
    projectId: string,
    input: OpenPaymentTransactionInput,
  ): Promise<PaymentTransactionOpening> {
    const { data, error } = await this.client
      .from("payment_transactions")
      .insert({
        project_id: projectId,
        acquisition_session_id: input.acquisitionSessionId,
        production_profile: input.productionProfile,
        provider: input.provider,
        amount_minor: input.amountMinor,
        currency: input.currency,
        // Nothing exists at the provider yet, and the row says exactly that.
        status: "pending_provider",
      })
      .select("*")
      .single();

    if (error) {
      // THE UNIQUENESS IS THE GUARANTEE. A concurrent opening — two tabs, a
      // double click, a duplicated request — loses here, and the correct
      // response is to report the WINNER rather than to raise: two customers'
      // worth of payment pages for one purchase is exactly what the index
      // exists to prevent, and an error would tempt a retry that creates one.
      if (error.code === POSTGRES_UNIQUE_VIOLATION) {
        const raced = await this.getOutstandingPaymentTransaction(
          projectId,
          input.productionProfile,
        );
        if (raced) return { outcome: "existing", transaction: raced };
      }
      throw error;
    }

    return {
      outcome: "opened",
      transaction: mapPaymentTransaction(data as DbPaymentTransaction),
    };
  }

  async bindProviderCheckoutSession(
    id: string,
    input: BindProviderCheckoutSessionInput,
  ): Promise<PaymentTransaction | null> {
    const timestamp = new Date().toISOString();
    // Conditional on the row still being pre-provider: a late or duplicated
    // bind must never re-point a transaction at a different session, and must
    // never resurrect a terminal one.
    const { data, error } = await this.client
      .from("payment_transactions")
      .update({
        provider_checkout_session_id: input.providerCheckoutSessionId,
        provider_checkout_url: input.providerCheckoutUrl,
        provider_payment_intent_id: input.providerPaymentIntentId ?? null,
        status: "created",
        updated_at: timestamp,
      })
      .eq("id", id)
      .eq("status", "pending_provider")
      .select("*")
      .maybeSingle();

    if (error) {
      if (error.code === POSTGRES_UNIQUE_VIOLATION) {
        throw new UniqueConstraintViolationError(
          "payment_transactions_provider_checkout_session_id_key",
        );
      }
      throw error;
    }

    // No row updated means the transaction was no longer pre-provider — a
    // concurrent bind won, or it is terminal. Return it as it genuinely
    // stands; the caller needs the winning session, not a failure.
    if (!data) return this.getPaymentTransaction(id);
    return mapPaymentTransaction(data as DbPaymentTransaction);
  }

  // --- Sprint A5.4: verified payment events + atomic activation --------

  async getPaymentEventByProviderId(
    provider: PaymentProviderKey,
    providerEventId: string,
  ): Promise<PaymentEvent | null> {
    const { data, error } = await this.client
      .from("payment_events")
      .select("*")
      .eq("provider", provider)
      .eq("provider_event_id", providerEventId)
      .maybeSingle();
    if (error) throw error;
    return data ? mapPaymentEvent(data as DbPaymentEvent) : null;
  }

  /**
   * THE ATOMIC PAYMENT-TO-ENTITLEMENT TRANSITION — a single database
   * function call, and deliberately not a sequence of REST writes.
   *
   * The PostgREST API cannot span two tables in one transaction, so
   * "mark the transaction paid" and "activate the unlock" as separate calls
   * would leave a crash window producing exactly the two states this product
   * must never be in: charged-with-no-entitlement, or entitled-without-payment.
   * `apply_payment_event` puts the whole decision inside one PostgreSQL
   * transaction, where the database's own atomicity is the guarantee.
   *
   * Note which parameters are ABSENT: project, acquisition session, and
   * production profile. The function reads them from the transaction row, so
   * a webhook cannot name a different customer's project.
   *
   * An RPC-level error is a genuine infrastructure fault and is thrown. Every
   * BUSINESS outcome — unmatched, mismatched, ignored, duplicate — comes back
   * as a return value, so a webhook that will never become valid is answered
   * rather than retried forever.
   */
  async applyPaymentEvent(
    input: ApplyPaymentEventInput,
  ): Promise<PaymentEventApplication> {
    const { data, error } = await this.client.rpc("apply_payment_event", {
      p_provider: input.provider,
      p_provider_event_id: input.providerEventId,
      p_event_type: input.eventType,
      p_payload_digest: input.payloadDigest,
      p_action: input.action,
      p_payment_transaction_id: input.paymentTransactionId,
      p_provider_checkout_session_id: input.providerCheckoutSessionId,
      p_provider_payment_intent_id: input.providerPaymentIntentId,
      p_amount_minor: input.amountMinor,
      p_currency: input.currency,
    });
    if (error) throw error;

    // Narrowed fail-closed: a return value this build cannot interpret is
    // never read as a successful activation. The function's vocabulary and
    // this list must agree, and if they ever diverge the safe answer is
    // "something happened that we did not understand", not "processed".
    const outcome = typeof data === "string" ? data : "";
    if (
      outcome === "processed" ||
      outcome === "ignored" ||
      outcome === "unmatched" ||
      outcome === "rejected_mismatch" ||
      outcome === "duplicate"
    ) {
      return outcome;
    }
    throw new Error("apply_payment_event returned an unrecognized outcome");
  }

  async failPendingPaymentTransaction(
    id: string,
    reason: string | null,
  ): Promise<PaymentTransaction | null> {
    const timestamp = new Date().toISOString();
    // Only a pre-provider attempt may be failed. A `created` row describes a
    // real provider session and a terminal row is already history; rewriting
    // either would destroy the record rather than close it.
    const { data, error } = await this.client
      .from("payment_transactions")
      .update({ status: "failed", updated_at: timestamp })
      .eq("id", id)
      .eq("status", "pending_provider")
      .select("*")
      .maybeSingle();
    if (error) throw error;
    // Deliberately not persisted — there is no column for it, and adding one
    // to carry a provider's error text is how provider dialect leaks into the
    // durable domain. The caller logs it server-side instead.
    void reason;
    if (!data) return this.getPaymentTransaction(id);
    return mapPaymentTransaction(data as DbPaymentTransaction);
  }

  // --- Phase 2C0.5: durable paid image intents -------------------------

  async reservePaidImageIntent(
    projectId: string,
    input: ReservePaidImageIntentInput,
  ): Promise<PaidImageIntentReservation> {
    const { data, error } = await this.client
      .from("paid_image_intents")
      .insert({
        project_id: projectId,
        generation_job_id: input.generationJobId,
        intent_key: input.intentKey,
        intent_kind: input.intentKind,
        direction_key: input.directionKey,
        paid_intent_ordinal: input.paidIntentOrdinal,
        status: "reserved",
        dispatches: 0,
        provider_key: input.providerKey,
      })
      .select("*")
      .single();

    if (error) {
      if (error.code === POSTGRES_UNIQUE_VIOLATION) {
        // Two different unique constraints can land here, and they mean
        // genuinely different things — so resolve which one actually fired
        // by re-reading, never by parsing the error text.
        const existing = await this.getPaidImageIntentByKey(
          projectId,
          input.intentKey,
        );
        // (project_id, intent_key): this exact logical intent already
        // exists. Reuse/retry is decided from its own state by the caller.
        if (existing) return { outcome: "existing", intent: existing };
        // (generation_job_id, paid_intent_ordinal): a concurrent worker won
        // this budget slot with a DIFFERENT intent. No paid call happened.
        return { outcome: "ordinal_taken" };
      }
      throw error;
    }

    return { outcome: "created", intent: mapPaidImageIntent(data as DbPaidImageIntent) };
  }

  async beginPaidImageIntentDispatch(
    intentId: string,
    claimToken: string,
    maxDispatches: number,
  ): Promise<PaidImageIntent | null> {
    // Compare-and-set, the same optimistic-claim shape as
    // `claimNextQueuedJob` — and for a stricter reason: this is the ONE
    // gate that authorizes spending money, so it must never have a
    // read-then-write gap two workers could both pass through. PostgREST
    // cannot express `dispatches = dispatches + 1`, so the previously-read
    // value goes into the WHERE clause instead: a concurrent worker that
    // incremented first makes this update match zero rows, and a refused
    // dispatch means no paid call, which is always the safe direction.
    const { data: current, error: readError } = await this.client
      .from("paid_image_intents")
      .select("*")
      .eq("id", intentId)
      .maybeSingle();
    if (readError) throw readError;
    if (!current) return null;

    const row = current as DbPaidImageIntent;
    if (row.status !== "reserved") return null;
    if (row.dispatches >= maxDispatches) return null;

    const { data, error } = await this.client
      .from("paid_image_intents")
      .update({
        dispatches: row.dispatches + 1,
        claim_token: claimToken,
        updated_at: new Date().toISOString(),
      })
      .eq("id", intentId)
      .eq("status", "reserved")
      .eq("dispatches", row.dispatches)
      .select("*")
      .maybeSingle();
    if (error) throw error;
    return data ? mapPaidImageIntent(data as DbPaidImageIntent) : null;
  }

  async completePaidImageIntent(
    intentId: string,
    claimToken: string,
    input: CompletePaidImageIntentInput,
  ): Promise<PaidImageIntent | null> {
    const payload: Record<string, unknown> = {
      status: input.status,
      updated_at: new Date().toISOString(),
    };
    if (input.result !== undefined) payload.result = input.result;
    if (input.providerRequestId !== undefined) {
      payload.provider_request_id = input.providerRequestId;
    }
    if (input.lastError !== undefined) payload.last_error = input.lastError;
    if (input.status === "succeeded") {
      payload.succeeded_at = new Date().toISOString();
    }

    // Fenced on `claim_token`: a zombie worker whose job was reclaimed
    // holds the previous token, matches zero rows, and gets `null` back
    // instead of overwriting the live worker's result.
    const { data, error } = await this.client
      .from("paid_image_intents")
      .update(payload)
      .eq("id", intentId)
      .eq("claim_token", claimToken)
      .select("*")
      .maybeSingle();
    if (error) throw error;
    return data ? mapPaidImageIntent(data as DbPaidImageIntent) : null;
  }

  async recordPaidImageIntentFailure(
    intentId: string,
    claimToken: string,
    input: RecordPaidImageIntentFailureInput,
  ): Promise<PaidImageIntent | null> {
    // Read first, for two reasons that both need the current row: a durable
    // success must never be downgraded by a late failure write, and a
    // provider request id must never be cleared by a later failure that
    // learned less than an earlier one did.
    const { data: current, error: readError } = await this.client
      .from("paid_image_intents")
      .select("*")
      .eq("id", intentId)
      .maybeSingle();
    if (readError) throw readError;
    if (!current) return null;

    const row = current as DbPaidImageIntent;
    if (row.status === "succeeded") return null;

    const payload: Record<string, unknown> = {
      last_error: input.lastError,
      updated_at: new Date().toISOString(),
    };
    if (input.providerRequestId) {
      payload.provider_request_id = input.providerRequestId;
    }
    // Absent `terminal`, `status` is deliberately not in the payload at all
    // — an intent whose parent job still intends to retry keeps whatever
    // status it has and stays retry-eligible.
    if (input.terminal === true) payload.status = "failed";

    // Fenced on `claim_token`, and additionally guarded against a success
    // that landed between the read above and this write.
    const { data, error } = await this.client
      .from("paid_image_intents")
      .update(payload)
      .eq("id", intentId)
      .eq("claim_token", claimToken)
      .neq("status", "succeeded")
      .select("*")
      .maybeSingle();
    if (error) throw error;
    return data ? mapPaidImageIntent(data as DbPaidImageIntent) : null;
  }

  async getPaidImageIntentByKey(
    projectId: string,
    intentKey: string,
  ): Promise<PaidImageIntent | null> {
    const { data, error } = await this.client
      .from("paid_image_intents")
      .select("*")
      .eq("project_id", projectId)
      .eq("intent_key", intentKey)
      .maybeSingle();
    if (error) throw error;
    return data ? mapPaidImageIntent(data as DbPaidImageIntent) : null;
  }

  async listPaidImageIntentsForJob(
    projectId: string,
    generationJobId: string,
  ): Promise<PaidImageIntent[]> {
    const { data, error } = await this.client
      .from("paid_image_intents")
      .select("*")
      .eq("project_id", projectId)
      .eq("generation_job_id", generationJobId)
      .order("paid_intent_ordinal", { ascending: true });
    if (error) throw error;
    return ((data as DbPaidImageIntent[]) ?? []).map(mapPaidImageIntent);
  }

  // --- Sprint 2H Part 1: assets ---------------------------------------

  async createAsset(
    projectId: string,
    input: CreateAssetInput,
  ): Promise<AssetRecord> {
    const { data, error } = await this.client
      .from("assets")
      .insert({
        project_id: projectId,
        kind: input.kind,
        storage_key: input.storageKey,
        content_type: input.contentType,
        is_thumbnail: input.isThumbnail,
        width_px: input.widthPx,
        height_px: input.heightPx,
        has_transparency: input.hasTransparency,
        provider_key: input.providerKey,
        generation_job_id: input.generationJobId,
        metadata: input.metadata,
        vector_asset_id: input.vectorAssetId,
        print_asset_id: input.printAssetId,
        final_artwork_job_id: input.finalArtworkJobId,
        production_role: input.productionRole,
      })
      .select("*")
      .single();
    if (error) throw error;
    return mapAsset(data as DbAsset);
  }

  async listAssets(projectId: string): Promise<AssetRecord[]> {
    const { data, error } = await this.client
      .from("assets")
      .select("*")
      .eq("project_id", projectId)
      .order("created_at", { ascending: true });
    if (error) throw error;
    return ((data as DbAsset[]) ?? []).map(mapAsset);
  }

  async getAssetById(assetId: string): Promise<AssetRecord | null> {
    const { data, error } = await this.client
      .from("assets")
      .select("*")
      .eq("id", assetId)
      .maybeSingle();
    if (error) throw error;
    return data ? mapAsset(data as DbAsset) : null;
  }

  async deleteAsset(assetId: string): Promise<void> {
    const { error } = await this.client.from("assets").delete().eq("id", assetId);
    if (error) throw error;
  }

  // --- Sprint 2M Phase 2B: final direction approval + final artwork job ---

  async createFinalDirectionApproval(
    projectId: string,
    input: CreateFinalDirectionApprovalInput,
  ): Promise<FinalDirectionApproval> {
    const { data, error } = await this.client
      .from("final_direction_approvals")
      .insert({
        project_id: projectId,
        artwork_version_id: input.artworkVersionId,
        design_brief_version_id: input.designBriefVersionId,
        status: "active",
      })
      .select("*")
      .single();

    if (error) {
      if (error.code === POSTGRES_UNIQUE_VIOLATION) {
        throw new UniqueConstraintViolationError(
          "final_direction_approvals_active_per_project",
        );
      }
      throw error;
    }

    return mapFinalDirectionApproval(data as DbFinalDirectionApproval);
  }

  async getActiveFinalDirectionApproval(
    projectId: string,
  ): Promise<FinalDirectionApproval | null> {
    const { data, error } = await this.client
      .from("final_direction_approvals")
      .select("*")
      .eq("project_id", projectId)
      .eq("status", "active")
      .maybeSingle();
    if (error) throw error;
    return data
      ? mapFinalDirectionApproval(data as DbFinalDirectionApproval)
      : null;
  }

  async supersedeActiveFinalDirectionApproval(
    projectId: string,
  ): Promise<FinalDirectionApproval | null> {
    const { data, error } = await this.client
      .from("final_direction_approvals")
      .update({ status: "superseded", superseded_at: new Date().toISOString() })
      .eq("project_id", projectId)
      .eq("status", "active")
      .select("*")
      .maybeSingle();
    if (error) throw error;
    return data
      ? mapFinalDirectionApproval(data as DbFinalDirectionApproval)
      : null;
  }

  async createFinalArtworkJob(
    projectId: string,
    input: CreateFinalArtworkJobInput,
  ): Promise<FinalArtworkJob> {
    const { data, error } = await this.client
      .from("final_artwork_jobs")
      .insert(
        input.sourceKind === "generated_concept"
          ? {
              project_id: projectId,
              final_direction_approval_id: input.finalDirectionApprovalId,
              artwork_version_id: input.artworkVersionId,
              // Sprint A2 Correction 2: always written explicitly and always
              // normalized, so the column's NULL is reserved for genuinely
              // legacy rows and never means "this build forgot".
              requested_production_output: input.requestedProductionOutput,
              // Print'em All Phase 1: written for create_new too, for exactly
              // the same reason — NULL here now means "enqueued before width
              // binding existed", never "this build forgot".
              production_width_in: input.productionWidthIn,
              // Print'em All Phase 2: always written explicitly, for the same
              // reason as the two above — this column's NULL is reserved for
              // rows enqueued before treatment binding existed and must never
              // mean "this build forgot".
              production_treatment_key: input.productionTreatmentKey,
              status: "queued",
            }
          : {
              project_id: projectId,
              artwork_preparation_id: input.artworkPreparationId,
              production_width_in: input.productionWidthIn,
              artwork_version_id: input.artworkVersionId,
              requested_production_output: input.requestedProductionOutput,
              production_treatment_key: input.productionTreatmentKey,
              status: "queued",
            },
      )
      .select("*")
      .single();

    if (error) {
      if (error.code === POSTGRES_UNIQUE_VIOLATION) {
        throw new UniqueConstraintViolationError(
          input.sourceKind === "generated_concept"
            ? "final_artwork_jobs_project_id_final_direction_approval_id"
            : "final_artwork_jobs_project_id_artwork_preparation_id_width",
        );
      }
      throw error;
    }

    return mapFinalArtworkJob(data as DbFinalArtworkJob);
  }

  async listFinalArtworkJobsForPreparation(
    projectId: string,
    artworkPreparationId: string,
  ): Promise<FinalArtworkJob[]> {
    const { data, error } = await this.client
      .from("final_artwork_jobs")
      .select("*")
      .eq("project_id", projectId)
      .eq("artwork_preparation_id", artworkPreparationId)
      .order("created_at", { ascending: true });
    if (error) throw error;
    return ((data as DbFinalArtworkJob[]) ?? []).map(mapFinalArtworkJob);
  }

  async getFinalArtworkJobByApprovalId(
    projectId: string,
    finalDirectionApprovalId: string,
  ): Promise<FinalArtworkJob | null> {
    // Sprint A2 Correction 2: one approval may now own several jobs (one per
    // requested production output), so `.maybeSingle()` — which THROWS on
    // more than one row — is no longer safe here. Ordered + limited instead,
    // returning the oldest, which is the historical behavior for the
    // overwhelmingly common single-job case.
    const { data, error } = await this.client
      .from("final_artwork_jobs")
      .select("*")
      .eq("project_id", projectId)
      .eq("final_direction_approval_id", finalDirectionApprovalId)
      .order("created_at", { ascending: true })
      .limit(1);
    if (error) throw error;
    const row = (data as DbFinalArtworkJob[] | null)?.[0];
    return row ? mapFinalArtworkJob(row) : null;
  }

  async listActiveFinalArtworkJobs(projectId: string): Promise<FinalArtworkJob[]> {
    const { data, error } = await this.client
      .from("final_artwork_jobs")
      .select("*")
      .eq("project_id", projectId)
      // Filtered in the QUERY rather than in JS: this runs on every guarded
      // mutation, and a project's terminal job history grows without bound
      // while its active set is almost always empty.
      .in("status", [...ACTIVE_FINAL_ARTWORK_JOB_STATUSES])
      .order("created_at", { ascending: true });
    if (error) throw error;
    return ((data as DbFinalArtworkJob[]) ?? []).map(mapFinalArtworkJob);
  }

  async listFinalArtworkJobsForApproval(
    projectId: string,
    finalDirectionApprovalId: string,
  ): Promise<FinalArtworkJob[]> {
    const { data, error } = await this.client
      .from("final_artwork_jobs")
      .select("*")
      .eq("project_id", projectId)
      .eq("final_direction_approval_id", finalDirectionApprovalId)
      .order("created_at", { ascending: true });
    if (error) throw error;
    return ((data as DbFinalArtworkJob[]) ?? []).map(mapFinalArtworkJob);
  }

  async getFinalDirectionApprovalById(
    id: string,
  ): Promise<FinalDirectionApproval | null> {
    const { data, error } = await this.client
      .from("final_direction_approvals")
      .select("*")
      .eq("id", id)
      .maybeSingle();
    if (error) throw error;
    return data
      ? mapFinalDirectionApproval(data as DbFinalDirectionApproval)
      : null;
  }

  // --- Sprint 2M Phase 2C: final artwork worker -------------------------

  async getFinalArtworkJob(jobId: string): Promise<FinalArtworkJob | null> {
    const { data, error } = await this.client
      .from("final_artwork_jobs")
      .select("*")
      .eq("id", jobId)
      .maybeSingle();
    if (error) throw error;
    return data ? mapFinalArtworkJob(data as DbFinalArtworkJob) : null;
  }

  async updateFinalArtworkJob(
    jobId: string,
    patch: UpdateFinalArtworkJobInput,
  ): Promise<FinalArtworkJob> {
    const payload: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };
    if (patch.status !== undefined) payload.status = patch.status;
    if (patch.attempts !== undefined) payload.attempts = patch.attempts;
    if (patch.lastError !== undefined) payload.last_error = patch.lastError;
    if (patch.startedAt !== undefined) payload.started_at = patch.startedAt;
    if (patch.completedAt !== undefined) payload.completed_at = patch.completedAt;
    if (patch.heartbeatAt !== undefined) payload.heartbeat_at = patch.heartbeatAt;
    if (patch.providerKey !== undefined) payload.provider_key = patch.providerKey;
    if (patch.providerRequestId !== undefined) payload.provider_request_id = patch.providerRequestId;
    if (patch.providerStatus !== undefined) payload.provider_status = patch.providerStatus;

    const { data, error } = await this.client
      .from("final_artwork_jobs")
      .update(payload)
      .eq("id", jobId)
      .select("*")
      .single();
    if (error) throw error;
    return mapFinalArtworkJob(data as DbFinalArtworkJob);
  }

  async claimNextQueuedFinalArtworkJob(): Promise<FinalArtworkJob | null> {
    // Same optimistic-claim shape as `claimNextQueuedJob` — read the oldest
    // due candidate, then update it conditioned on it still being in the
    // status we read; a lost race touches zero rows and reports "nothing
    // claimed" rather than retrying.
    const { data: candidate, error: candidateError } = await this.client
      .from("final_artwork_jobs")
      .select("*")
      .in("status", ["queued", "recoverable"])
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (candidateError) throw candidateError;
    if (!candidate) return null;

    const row = candidate as DbFinalArtworkJob;
    const timestamp = new Date().toISOString();

    const { data, error } = await this.client
      .from("final_artwork_jobs")
      .update({
        status: "running",
        attempts: row.attempts + 1,
        started_at: timestamp,
        heartbeat_at: timestamp,
        updated_at: timestamp,
      })
      .eq("id", row.id)
      .eq("status", row.status)
      .select("*")
      .maybeSingle();
    if (error) throw error;
    return data ? mapFinalArtworkJob(data as DbFinalArtworkJob) : null;
  }

  async touchFinalArtworkJobHeartbeat(jobId: string): Promise<void> {
    const { error } = await this.client
      .from("final_artwork_jobs")
      .update({ heartbeat_at: new Date().toISOString() })
      .eq("id", jobId);
    if (error) throw error;
  }

  async recoverAbandonedFinalArtworkJobs(
    staleAfterMs: number,
  ): Promise<FinalArtworkJob[]> {
    const staleBefore = new Date(Date.now() - staleAfterMs).toISOString();

    // Single atomic conditional UPDATE — same reasoning as
    // `recoverAbandonedJobs`: folding the staleness filter into the WHERE
    // clause means a job that legitimately heartbeats or completes between
    // issuing and executing this query is never double-recovered.
    const { data, error } = await this.client
      .from("final_artwork_jobs")
      .update({ status: "recoverable", updated_at: new Date().toISOString() })
      .eq("status", "running")
      .or(
        `and(heartbeat_at.is.null,started_at.lt.${staleBefore}),heartbeat_at.lt.${staleBefore}`,
      )
      .select("*");
    if (error) throw error;

    return ((data as DbFinalArtworkJob[]) ?? []).map(mapFinalArtworkJob);
  }

  async createProductionAssetValidation(
    projectId: string,
    input: CreateProductionAssetValidationInput,
  ): Promise<ProductionAssetValidation> {
    const { data, error } = await this.client
      .from("production_asset_validations")
      .insert({
        project_id: projectId,
        final_artwork_job_id: input.finalArtworkJobId,
        asset_id: input.assetId,
        status: input.status,
        report: input.report,
      })
      .select("*")
      .single();
    if (error) throw error;
    return mapProductionAssetValidation(data as DbProductionAssetValidation);
  }

  async getLatestProductionAssetValidationForJob(
    projectId: string,
    finalArtworkJobId: string,
  ): Promise<ProductionAssetValidation | null> {
    const { data, error } = await this.client
      .from("production_asset_validations")
      .select("*")
      .eq("project_id", projectId)
      .eq("final_artwork_job_id", finalArtworkJobId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    return data
      ? mapProductionAssetValidation(data as DbProductionAssetValidation)
      : null;
  }

  async createArtworkPreparation(
    projectId: string,
    input: CreateArtworkPreparationInput,
  ): Promise<ArtworkPreparation> {
    const { data, error } = await this.client
      .from("artwork_preparations")
      .insert({
        project_id: projectId,
        status: "analyzed",
        original_asset_id: input.originalAssetId,
        original_filename: input.originalFilename,
        analysis: input.analysis,
      })
      .select("*")
      .single();
    if (error) throw error;
    return mapArtworkPreparation(data as DbArtworkPreparation);
  }

  async getArtworkPreparation(
    projectId: string,
  ): Promise<ArtworkPreparation | null> {
    const { data, error } = await this.client
      .from("artwork_preparations")
      .select("*")
      .eq("project_id", projectId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    return data ? mapArtworkPreparation(data as DbArtworkPreparation) : null;
  }

  async getArtworkPreparationById(
    id: string,
  ): Promise<ArtworkPreparation | null> {
    const { data, error } = await this.client
      .from("artwork_preparations")
      .select("*")
      .eq("id", id)
      .maybeSingle();
    if (error) throw error;
    return data ? mapArtworkPreparation(data as DbArtworkPreparation) : null;
  }

  async updateArtworkPreparation(
    id: string,
    patch: UpdateArtworkPreparationInput,
  ): Promise<ArtworkPreparation> {
    const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (patch.status !== undefined) update.status = patch.status;
    if (patch.preparedAssetId !== undefined) {
      update.prepared_asset_id = patch.preparedAssetId;
    }
    if (patch.preparedArtworkVersionId !== undefined) {
      update.prepared_artwork_version_id = patch.preparedArtworkVersionId;
    }
    if (patch.analysis !== undefined) update.analysis = patch.analysis;
    if (patch.preparation !== undefined) update.preparation = patch.preparation;
    if (patch.guidedCleanup !== undefined) {
      update.guided_cleanup = patch.guidedCleanup;
    }
    if (patch.separation !== undefined) update.separation = patch.separation;
    if (patch.approvedAt !== undefined) update.approved_at = patch.approvedAt;

    const { data, error } = await this.client
      .from("artwork_preparations")
      .update(update)
      .eq("id", id)
      .select("*")
      .single();
    if (error) throw error;
    return mapArtworkPreparation(data as DbArtworkPreparation);
  }
}
