import { randomUUID } from "crypto";

import { PNG } from "pngjs";

import type { ProjectRepository } from "@/lib/db/repository";
import type {
  ConceptDirectionKey,
  ConceptEvaluation,
  ConceptEvaluationStatus,
  ConversationPhase,
  DesignBriefSnapshotContent,
  GenerationJob,
  PaidImageIntent,
} from "@/lib/domain/types";
import type { AssetCapability } from "@/capabilities/assets";
import type { ConceptEvaluationCapability } from "@/capabilities/concept-evaluation";
import {
  createConceptEvaluationCapability,
  PlaceholderConceptEvaluationProvider,
} from "@/capabilities/concept-evaluation";
import type { RgbaImage } from "@/capabilities/final-artwork/raster-transform";
import type {
  GenerationIntent,
  PromptTranslationCapability,
} from "@/capabilities/prompt-translation";
import { withPrintPaletteCorrection } from "@/capabilities/prompt-translation";
import type { RevisionIntelligenceCapability } from "@/capabilities/revision-intelligence";
import { createRevisionIntelligenceCapability } from "@/capabilities/revision-intelligence";
import { GenerationUnavailableError } from "@/capabilities/providers";
import type { ConceptGenerationProvider } from "@/capabilities/providers";
import type {
  ConceptGenerationRequest,
  ConceptGenerationResult,
  GeneratedAssetPayload,
  GeneratedConceptDraft,
  SourceArtworkImage,
} from "@/capabilities/shared/contracts";
import { MAX_GENERATION_ATTEMPTS } from "@/capabilities/shared/generation-retry-policy";
import {
  buildPaidImageIntentKey,
  paidIntentBudgetForJob,
  REPLACEMENT_PAID_INTENT_EPOCH,
} from "@/capabilities/shared/paid-image-intent";
import {
  describePaidImageFailure,
  isPossiblyBilledFailureClass,
  readPaidImageFailureClass,
} from "@/capabilities/shared/paid-image-failure";
import { logPaidImageIntentOutcome } from "@/lib/config/paid-image-intent-logging";
import {
  executePaidImageUnit,
  PAID_IMAGE_CONCEPT_METADATA_KEY,
  PAID_IMAGE_INTENT_BLOCKED_ERROR_PREFIX,
  PAID_IMAGE_INTENT_METADATA_KEY,
  PaidImageIntentBlockedError,
  readPaidIntentDispatches,
  type PaidImageUnit,
  type PersistedPaidConcept,
} from "./paid-image-intent-executor";
import { CONCEPT_DIRECTIONS } from "@/lib/domain/concept-directions";
import type { PrintValidationCapability } from "@/capabilities/print-validation";
import {
  assembleProvisionalPrintValidationInput,
  createPrintValidationCapability,
} from "@/capabilities/print-validation";
import {
  classifyReplacementAcceptance,
  isHardPrintPaletteFailure,
  type ReplacementSkipReason,
} from "./hard-palette-replacement-policy";
import { logConceptGenerationUnavailable } from "@/lib/config/generation-provider-logging";
import {
  logConceptReplacement,
  logConceptSetOutcome,
} from "@/lib/config/concept-replacement-logging";
import {
  logProvisionalPrintValidation,
  logProvisionalPrintValidationFailure,
} from "@/lib/config/print-validation-logging";
import { getWorkerHeartbeatIntervalMs } from "@/lib/config/worker-config";

import { buildGenerationIntentForJob } from "./build-generation-intent";
import {
  isSupportedSourceContentType,
  TargetedRevisionSourceError,
} from "./targeted-revision-source-error";

/**
 * Sprint 2H Part 2A: a "running" job with no heartbeat for this long is
 * presumed abandoned (its worker process died) and becomes recoverable.
 * 15 minutes, matching the sprint's own recovery example.
 */
export const DEFAULT_STALE_JOB_MS = 15 * 60 * 1000;

const UNAVAILABLE_ERROR_PREFIX = "GENERATION_UNAVAILABLE:";

/**
 * True Source-Image Targeted Revision: stable, greppable prefix on
 * `GenerationJob.lastError` when a targeted revision could not load its
 * source artwork. Internal only — never customer-facing.
 */
export const TARGETED_REVISION_SOURCE_ERROR_PREFIX = "TARGETED_REVISION_SOURCE:";

/**
 * Phase 2C: stable, greppable prefix on `GenerationJob.lastError` when EVERY
 * direction hard-failed the print-palette constraint and the bounded
 * replacement budget could not rescue a single one. Internal only.
 */
export const CONCEPT_SET_UNRESOLVABLE_ERROR_PREFIX = "CONCEPT_SET_UNRESOLVABLE:";

/**
 * Phase 2C: not one concept in this batch can be shown.
 *
 * Distinct from a provider failure, and it must not be reported as one: the
 * images were bought and stored successfully — every one of them simply
 * violates a hard production constraint, and the platform refuses to present
 * artwork it knows cannot be printed as specified. Delivering zero concepts
 * is a failure the customer must be told about, so this fails the job rather
 * than completing it with an empty set.
 */
export class ConceptSetUnresolvableError extends Error {
  readonly withheldDirectionKeys: string[];

  constructor(withheldDirectionKeys: string[]) {
    super(
      `Every generated concept violated the required print palette and could not be automatically corrected (${withheldDirectionKeys.join(", ")}).`,
    );
    this.name = "ConceptSetUnresolvableError";
    this.withheldDirectionKeys = withheldDirectionKeys;
  }
}

/**
 * Phase 2C: one candidate concept, from the moment its image is bought until
 * the customer-visible `ArtworkVersion` batch is written.
 *
 * This intermediate form is what makes "never show a concept we are about to
 * take away" achievable: replacement decisions are made against these,
 * BEFORE a single `ArtworkVersion` row exists.
 */
interface ConceptCandidate {
  directionKey: ConceptDirectionKey | null;
  concept: PersistedPaidConcept;
  evaluated: EvaluatedConcept;
  /** True once `concept` is a Phase 2C replacement, not the original. */
  isReplacement: boolean;
  /** True when a hard failure could not be resolved — never shown. */
  withheld: boolean;
  skipReason: ReplacementSkipReason | null;
}

interface EvaluatedConcept {
  evaluationStatus: ConceptEvaluationStatus;
  evaluation: ConceptEvaluation;
  evaluationEvaluatedAt: string;
  evaluationProviderKey: string;
}

/**
 * Which conversation phase a finished generation hands back to the
 * customer — success or failure alike.
 *
 * `concepts_ready` means "pick one of these", and it deliberately blocks
 * free-text chat (`CHAT_BLOCKED_PHASES` in `ConversationCapability`),
 * which is right when three fresh directions are waiting to be chosen
 * between. A TARGETED REVISION has nothing to choose between — its one
 * revised concept is already selected — so leaving the conversation in
 * `concepts_ready` stranded the customer at exactly the moment the
 * assistant asked "how does this version look?": chat was refused
 * server-side, and the Use This Design action (gated on the revision
 * loop) never appeared. A targeted revision therefore returns to
 * `ask_revisions`, where another change and an explicit confirmation are
 * both available. The failure path needs the same phase for the same
 * reason — its message invites the customer to try the change again.
 */
function phaseAfterGeneration(job: GenerationJob): ConversationPhase {
  return job.targetArtworkVersionId ? "ask_revisions" : "concepts_ready";
}

/**
 * The "here is your artwork" message, phrased to match what the customer can
 * actually see.
 *
 * Phase 2C made this a function of the delivered count rather than a
 * constant. When a direction hard-fails the print palette and its one
 * automatic replacement cannot rescue it, that concept is withheld — and
 * announcing "here are three concept directions" above two cards would be a
 * small, avoidable lie in the exact moment the platform is being careful.
 * The three-concept wording is byte-for-byte unchanged, because that remains
 * the overwhelmingly common case.
 *
 * Deliberately says nothing about WHY a set is short: the customer-facing
 * explanation belongs to a UI phase that can design it properly, and a
 * half-explanation here ("one concept didn't meet our print requirements")
 * would leak production vocabulary into the conversation for no benefit.
 */
function conceptsReadyContent(
  job: GenerationJob,
  deliveredCount: number,
): string {
  if (job.targetArtworkVersionId) {
    return "Here's your revised concept. How does this version look?";
  }
  if (deliveredCount === 3) {
    return job.kind === "regeneration"
      ? "Here are three new directions to consider. Pick the one that feels closest."
      : "Here are three concept directions. Pick the one that feels closest.";
  }
  if (deliveredCount === 1) {
    return job.kind === "regeneration"
      ? "Here's one new direction to consider. Would you like to work with it?"
      : "Here's one concept direction. Would you like to work with it?";
  }
  const spelled = SPELLED_COUNTS[deliveredCount] ?? String(deliveredCount);
  return job.kind === "regeneration"
    ? `Here are ${spelled} new directions to consider. Pick the one that feels closest.`
    : `Here are ${spelled} concept directions. Pick the one that feels closest.`;
}

/** Plain-language counts. Only ever reached for a short concept set. */
const SPELLED_COUNTS: Record<number, string> = { 2: "two", 3: "three" };

export interface GenerationWorkerCapability {
  /**
   * Claims and fully runs the single oldest due job (queued or
   * recoverable), if any exists. Self-sufficient given just a job row —
   * never talks to `ConversationCapability` or `ConceptGenerationCapability`
   * — which is exactly what lets this be lifted verbatim into a standalone
   * worker process later (same repo/provider/etc., different scheduler).
   * Safe to call repeatedly/concurrently: the underlying claim is
   * optimistic, so at most one caller ever actually runs a given job.
   */
  processNextJob(): Promise<{ processedJobId: string | null }>;
  /**
   * Sweeps jobs abandoned by a worker that died mid-attempt (see
   * `DEFAULT_STALE_JOB_MS`) back to "recoverable" so a future
   * `processNextJob` call can pick them up. Cheap — no provider calls —
   * safe to run on every status poll.
   */
  recoverAbandonedJobs(
    staleAfterMs?: number,
  ): Promise<{ recoveredCount: number }>;
}

export function createGenerationWorkerCapability(
  repo: ProjectRepository,
  provider: ConceptGenerationProvider,
  promptTranslation: PromptTranslationCapability,
  assets: AssetCapability,
  /**
   * Sprint 2I Phase 1: Concept Evaluation runs after assets are persisted
   * and before conversation completion. Defaults to the placeholder
   * evaluator so existing tests remain valid without wiring changes.
   */
  conceptEvaluation: ConceptEvaluationCapability = createConceptEvaluationCapability(
    new PlaceholderConceptEvaluationProvider(),
  ),
  /**
   * Sprint 2J Phase 3: used only on the regeneration path to recompute
   * TimedRevisionImpact entries from consecutive approved brief versions.
   */
  revisionIntelligence: RevisionIntelligenceCapability = createRevisionIntelligenceCapability(),
  /**
   * Sprint 2M Phase 2A: runs PROVISIONAL print-readiness intelligence right
   * after Concept Evaluation completes for a concept. Never authoritative,
   * never persisted, never blocks or fails the job — see
   * `runProvisionalPrintValidation` and ARCHITECTURE.md's "Provisional
   * Print Readiness" section. Defaults to a fresh pure instance so existing
   * call sites/tests need no wiring changes.
   */
  printValidation: PrintValidationCapability = createPrintValidationCapability(),
): GenerationWorkerCapability {
  async function persistConceptAsset(
    designId: string,
    generationJobId: string,
    providerKey: string,
    asset: GeneratedAssetPayload | undefined,
    /**
     * Phase 2C0.5: extra SANITIZED provenance stamped onto the asset so a
     * crash between "asset written" and "intent marked succeeded" leaves a
     * recoverable trail instead of a paid-for, invisible image. Never
     * prompt text, never credentials — see `paid-image-intent-executor`.
     */
    intentProvenance: Record<string, unknown> = {},
  ): Promise<{ primaryAssetId: string | null; thumbnailAssetId: string | null }> {
    if (!asset) return { primaryAssetId: null, thumbnailAssetId: null };

    const { primary, thumbnail } = await assets.uploadConceptImage(designId, {
      conceptId: randomUUID(),
      bytes: asset.imageBytes,
      contentType: asset.contentType,
      widthPx: asset.widthPx,
      heightPx: asset.heightPx,
      hasTransparency: asset.hasTransparency,
      providerKey,
      generationJobId,
      metadata: { ...asset.providerMetadata, ...intentProvenance },
    });

    return {
      primaryAssetId: primary.id,
      thumbnailAssetId: thumbnail?.id ?? null,
    };
  }

  /**
   * Phase 2C0.5: stores the bytes one paid intent just bought, and returns
   * the sanitized envelope that becomes `PaidImageIntent.result`.
   *
   * Runs BEFORE the intent is marked succeeded, so "succeeded" always means
   * "durably recoverable", never merely "the provider answered". Every
   * primary asset is stamped with the intent key so the orphan-adoption
   * path can recover it if the process dies in the gap between this
   * function returning and the intent write landing.
   */
  async function persistPaidConcepts(
    designId: string,
    generationJobId: string,
    providerKey: string,
    drafts: readonly GeneratedConceptDraft[],
    intentKey: string,
  ): Promise<PersistedPaidConcept[]> {
    const persisted: PersistedPaidConcept[] = [];
    for (const draft of drafts) {
      const envelope = {
        title: draft.title,
        summary: draft.summary,
        placeholderLabel: draft.placeholderLabel,
        accentColor: draft.accentColor,
        kind: draft.kind,
        directionKey: draft.directionKey ?? null,
      };
      const assetIds = await persistConceptAsset(
        designId,
        generationJobId,
        providerKey,
        draft.asset,
        {
          [PAID_IMAGE_INTENT_METADATA_KEY]: intentKey,
          [PAID_IMAGE_CONCEPT_METADATA_KEY]: envelope,
        },
      );
      persisted.push({
        ...envelope,
        primaryAssetId: assetIds.primaryAssetId,
        thumbnailAssetId: assetIds.thumbnailAssetId,
        contentType: draft.asset?.contentType ?? null,
        widthPx: draft.asset?.widthPx ?? null,
        heightPx: draft.asset?.heightPx ?? null,
        hasTransparency: draft.asset?.hasTransparency ?? null,
        providerRequestId: readProviderRequestId(draft),
      });
    }
    return persisted;
  }

  /**
   * Phase 2C0.5: which LOGICAL PAID INTENTS this job is made of.
   *
   * Before this phase the whole three-direction batch was one indivisible
   * provider call, so nothing could record that Bold and Soft were already
   * bought when Minimal failed. Splitting the job into explicit units is
   * what makes per-direction durability possible.
   *
   * An adapter that exposes `generateDirection` (any adapter that actually
   * spends money) gets one unit per direction. One that does not — the
   * placeholder stub, and the fakes the existing test suite is written
   * against — produces its batch atomically, so its honest identity is a
   * single `"batch"` unit rather than three units that could never be
   * checkpointed apart.
   */
  function planPaidImageUnits(
    job: GenerationJob,
    directionKey: ConceptDirectionKey | null,
  ): PaidImageUnit[] {
    if (job.targetArtworkVersionId) {
      // A targeted revision is exactly one paid edit of exactly one
      // concept. Binding the target into the identity is what keeps a
      // second, genuinely different revision of the same concept a NEW paid
      // intent rather than a recovery of the previous one.
      return [
        {
          kind: "targeted_revision",
          scopeKey: directionKey ?? "batch",
          targetArtworkVersionId: job.targetArtworkVersionId,
        },
      ];
    }

    if (!provider.generateDirection) {
      return [{ kind: "initial_concept", scopeKey: "batch" }];
    }

    return CONCEPT_DIRECTIONS.slice(0, job.conceptCount).map((direction) => ({
      kind: "initial_concept" as const,
      scopeKey: direction.key,
    }));
  }

  /**
   * True Source-Image Targeted Revision: resolves the ACTUAL pixels of the
   * concept the customer selected, so the revision can be performed as an
   * edit of that artwork rather than a fresh interpretation of the brief.
   *
   * Exactly the lookup chain the lineage already records:
   *   GenerationJob.targetArtworkVersionId
   *     → ArtworkVersion (that exact selected concept)
   *     → ArtworkVersion.primaryAssetId
   *     → AssetCapability.downloadAssetBytes  (the same server-side byte
   *       fetch FinalArtworkWorkerCapability uses — never a signed URL,
   *       never a storage key, and never an `AssetRecord` past this point).
   *
   * Every failure along that chain throws. There is deliberately no
   * fallback: see `TargetedRevisionSourceError`.
   */
  async function loadSourceArtwork(
    project: { artworkVersions: readonly { id: string; primaryAssetId: string | null }[] },
    targetArtworkVersionId: string,
  ): Promise<SourceArtworkImage> {
    const source = project.artworkVersions.find(
      (artwork) => artwork.id === targetArtworkVersionId,
    );
    if (!source) {
      throw new TargetedRevisionSourceError(
        "source_artwork_missing",
        targetArtworkVersionId,
        "The selected concept to revise no longer exists.",
      );
    }
    if (!source.primaryAssetId) {
      throw new TargetedRevisionSourceError(
        "source_asset_missing",
        targetArtworkVersionId,
        "The selected concept has no stored artwork image to revise.",
      );
    }

    const downloaded = await assets.downloadAssetBytes(source.primaryAssetId);
    if (!downloaded || downloaded.bytes.length === 0) {
      throw new TargetedRevisionSourceError(
        "source_bytes_unavailable",
        targetArtworkVersionId,
        "The selected concept's artwork image could not be read from storage.",
      );
    }
    if (!isSupportedSourceContentType(downloaded.contentType)) {
      throw new TargetedRevisionSourceError(
        "source_content_type_unsupported",
        targetArtworkVersionId,
        `The selected concept's artwork image type (${downloaded.contentType}) cannot be edited.`,
      );
    }

    return {
      sourceArtworkVersionId: targetArtworkVersionId,
      imageBytes: downloaded.bytes,
      contentType: downloaded.contentType,
    };
  }

  /**
   * Sprint 2I Phase 1: evaluate one concept against the approved brief.
   * Evaluation failure never discards the concept — a needs_review fallback
   * is persisted instead. Customer presentation is unchanged.
   *
   * Phase 2B: when primary bytes are available, decode them and pass the
   * RGBA raster into Concept Evaluation so deterministic print-palette
   * compliance can inspect actual pixels. Still never rejects the concept.
   */
  async function evaluateConcept(input: {
    brief: DesignBriefSnapshotContent;
    title: string;
    summary: string;
    placeholderLabel: string;
    primaryAssetId: string | null;
    thumbnailAssetId: string | null;
    idempotencyKey: string;
    /** Fresh-generation path may already hold PNG bytes — avoid a re-download. */
    primaryBytes?: Buffer | null;
  }): Promise<{
    evaluationStatus: ConceptEvaluationStatus;
    evaluation: ConceptEvaluation;
    evaluationEvaluatedAt: string;
    evaluationProviderKey: string;
  }> {
    const assetRefs = [];
    if (input.primaryAssetId) {
      const primary = await repo.getAssetById(input.primaryAssetId);
      if (primary) {
        assetRefs.push({
          assetId: primary.id,
          contentType: primary.contentType,
          widthPx: primary.widthPx,
          heightPx: primary.heightPx,
          isThumbnail: false,
          // Sprint 2I Phase 2: same short-lived, expiring URL the browser
          // would use — never a raw storage key. `getSignedUrl` already
          // returns `null` when there is nothing to sign; evaluation
          // proceeds either way (see failure fallback).
          sourceUrl: await assets.getSignedUrl(primary.id),
        });
      }
    }
    if (input.thumbnailAssetId) {
      const thumb = await repo.getAssetById(input.thumbnailAssetId);
      if (thumb) {
        assetRefs.push({
          assetId: thumb.id,
          contentType: thumb.contentType,
          widthPx: thumb.widthPx,
          heightPx: thumb.heightPx,
          isThumbnail: true,
          sourceUrl: await assets.getSignedUrl(thumb.id),
        });
      }
    }

    const image = await resolveConceptImageForPaletteCheck({
      primaryAssetId: input.primaryAssetId,
      primaryBytes: input.primaryBytes ?? null,
    });

    let result;
    try {
      result = await conceptEvaluation.evaluate({
        brief: input.brief,
        concept: {
          title: input.title,
          summary: input.summary,
          placeholderLabel: input.placeholderLabel,
        },
        assets: assetRefs,
        idempotencyKey: input.idempotencyKey,
        image,
      });
    } catch (error) {
      result = conceptEvaluation.evaluationFailureFallback(error);
    }

    const persisted = conceptEvaluation.toPersistedEvaluation(result);
    return {
      ...persisted,
      evaluationEvaluatedAt: new Date().toISOString(),
    };
  }

  /**
   * Phase 2B: decode concept PNG bytes for deterministic palette compliance.
   * Swallow decode failures — evaluation still proceeds; compliance records
   * `pixels_unavailable` rather than failing the generation job.
   */
  async function resolveConceptImageForPaletteCheck(input: {
    primaryAssetId: string | null;
    primaryBytes: Buffer | null;
  }): Promise<RgbaImage | null> {
    let bytes = input.primaryBytes;
    if ((!bytes || bytes.length === 0) && input.primaryAssetId) {
      try {
        const downloaded = await assets.downloadAssetBytes(input.primaryAssetId);
        bytes = downloaded?.bytes ?? null;
      } catch {
        return null;
      }
    }
    if (!bytes || bytes.length === 0) return null;
    try {
      const decoded = PNG.sync.read(bytes);
      if (
        !decoded.width ||
        !decoded.height ||
        decoded.data.length !== decoded.width * decoded.height * 4
      ) {
        return null;
      }
      return {
        width: decoded.width,
        height: decoded.height,
        data: Buffer.from(decoded.data),
      };
    } catch {
      return null;
    }
  }

  /**
   * Phase 2C: AUTOMATIC HARD-FAIL CONCEPT REPLACEMENT.
   *
   * Runs once, after every candidate in the batch has been evaluated and
   * BEFORE any `ArtworkVersion` row exists. That position is the whole
   * point: a customer never sees a hard-failing concept that later vanishes,
   * because the failing concept was never presented in the first place.
   *
   * Mutates `candidates` in place. Deliberately never throws — the initial
   * set is already bought, stored, and evaluated by this point, and a
   * problem while trying to IMPROVE it must never destroy it. Every failure
   * mode degrades to "this direction is withheld", which the caller turns
   * into a smaller (never a dishonest) concept set.
   *
   * SPEND SAFETY. There is no replacement counter here, on purpose. A
   * replacement is attempted by asking `executePaidImageUnit` to reserve a
   * slot; the durable `paid_image_intents` budget refusing that reservation
   * IS the limit, and it refuses BEFORE the provider is contacted. That is
   * what makes "at most two replacements, at most five paid images" survive
   * a crash, a reclaim, and two workers racing — none of which an in-memory
   * tally would survive.
   *
   * ORDER is the catalog direction order (Bold & Direct, Soft & Illustrated,
   * Minimal Badge), which is the order the candidates were generated in and
   * therefore the order they sit in this array. It is fixed and independent
   * of async timing, so when all three fail, the SAME two directions are
   * replaced on every run and on every reclaim.
   */
  async function resolveHardPaletteFailures(input: {
    job: GenerationJob;
    designId: string;
    brief: DesignBriefSnapshotContent;
    generationIntent: GenerationIntent;
    generationRequest: ConceptGenerationRequest;
    candidates: ConceptCandidate[];
  }): Promise<void> {
    // A targeted revision is a customer-requested change to one concept the
    // customer already chose — a different intent kind, a different paid
    // identity, and emphatically not something to silently re-buy over a
    // palette verdict. Phase 2C replaces INITIAL concepts only.
    if (input.job.targetArtworkVersionId) return;

    const failing = input.candidates.filter(
      (candidate) =>
        candidate.directionKey !== null &&
        isHardPrintPaletteFailure(candidate.evaluated.evaluation),
    );
    if (failing.length === 0) return;

    const budget = paidIntentBudgetForJob(input.job.conceptCount);
    const generateDirection = provider.generateDirection;

    // An adapter with no per-direction entry point produced the batch as one
    // indivisible paid unit (see `planPaidImageUnits`), so there is no single
    // direction to re-buy. Withholding rather than regenerating the whole
    // batch keeps the guarantee — never show a known hard failure — without
    // inventing a coarser, more expensive replacement path.
    if (!generateDirection) {
      for (const candidate of failing) {
        candidate.withheld = true;
        candidate.skipReason = "no_per_direction_paid_unit";
      }
      return;
    }

    // Built once: a replacement is the SAME request as the candidate it
    // replaces, plus the deterministic palette correction. Prompt Translation
    // owns the DTO and the provider owns the wording — neither is assembled
    // here (see `withPrintPaletteCorrection`).
    const correctedRequest: ConceptGenerationRequest = {
      ...input.generationRequest,
      prompt: promptTranslation.translate(
        withPrintPaletteCorrection(input.generationIntent),
      ),
    };

    for (const candidate of failing) {
      const directionKey = candidate.directionKey!;
      // The candidate being replaced has no `ArtworkVersion` id yet — by
      // design — so its logical paid intent is what identifies it. Pure over
      // (project, job, kind, epoch, direction), so a reclaim rebuilds both
      // this and the replacement key byte-for-byte and reuses the image.
      const replacedPaidIntentKey = buildPaidImageIntentKey({
        projectId: input.designId,
        generationJobId: input.job.id,
        kind: "initial_concept",
        scopeKey: directionKey,
      });
      const replacementPaidIntentKey = buildPaidImageIntentKey({
        projectId: input.designId,
        generationJobId: input.job.id,
        kind: "replacement",
        scopeKey: directionKey,
        replacedPaidIntentKey,
        epoch: REPLACEMENT_PAID_INTENT_EPOCH,
      });
      const logBase = {
        projectId: input.designId,
        generationJobId: input.job.id,
        jobAttempt: input.job.attempts,
        directionKey,
        replacedPaidIntentKey,
        replacementPaidIntentKey,
        replacementEpoch: REPLACEMENT_PAID_INTENT_EPOCH,
        deterministicStatusBefore:
          candidate.evaluated.evaluation.printPaletteCompliance?.status ?? "unknown",
        paidIntentBudget: budget,
        providerKey: provider.providerKey,
      };

      logConceptReplacement({
        ...logBase,
        decision: "replacement_requested",
        deterministicStatusAfter: null,
        paidIntentOrdinal: null,
        paidIntentBudgetRemaining: null,
        paidCallMade: null,
      });

      // Phase 2C.2C: the DURABLE dispatch count before this attempt.
      //
      // "Did we pay?" and "did we end up with a usable replacement?" are
      // different questions, and this path used to answer the first with the
      // second. A live Soft replacement that OpenAI billed and answered, and
      // whose local persistence then failed, was logged `paidCallMade:
      // false` — the single most misleading field the phase produced.
      // Comparing this count before and after is authoritative for every
      // failure shape, including ones that throw before any value returns.
      const dispatchesBefore = await readPaidIntentDispatches(
        repo,
        input.designId,
        replacementPaidIntentKey,
      );

      let executed: {
        concepts: PersistedPaidConcept[];
        paidCallMade: boolean;
      };
      try {
        await repo.touchGenerationJobHeartbeat(input.job.id);
        executed = await withPeriodicHeartbeat(input.job.id, () =>
          executePaidImageUnit(
            {
              repo,
              job: input.job,
              providerKey: provider.providerKey,
              dispatch: async () => {
                const result = await generateDirection.call(
                  provider,
                  correctedRequest,
                  directionKey,
                );
                return result.concepts;
              },
              persist: (drafts, intentKey) =>
                persistPaidConcepts(
                  input.designId,
                  input.job.id,
                  provider.providerKey,
                  drafts,
                  intentKey,
                ),
            },
            {
              kind: "replacement",
              scopeKey: directionKey,
              replacedPaidIntentKey,
              epoch: REPLACEMENT_PAID_INTENT_EPOCH,
            },
          ),
        );
      } catch (error) {
        // The direction keeps its known-bad candidate hidden either way. The
        // two reasons are separated because they mean different things to an
        // operator: one is a deliberate refusal to spend, the other is a
        // genuine generation/storage problem.
        const outOfBudget =
          error instanceof PaidImageIntentBlockedError &&
          error.reason === "budget_exhausted";
        candidate.withheld = true;
        candidate.skipReason = outOfBudget
          ? "paid_budget_exhausted"
          : "replacement_generation_failed";
        // Read AFTER the failure, from the same durable counter. A refusal
        // to spend leaves it untouched (nothing was dispatched); a provider
        // call that happened and then failed locally has already
        // incremented it, whatever became of the image afterwards.
        const failedIntent = await repo
          .getPaidImageIntentByKey(input.designId, replacementPaidIntentKey)
          .catch(() => null);
        logConceptReplacement({
          ...logBase,
          decision: "replacement_unavailable",
          deterministicStatusAfter: null,
          paidIntentOrdinal: failedIntent?.paidIntentOrdinal ?? null,
          paidIntentBudgetRemaining: await countRemainingPaidIntents(
            input.designId,
            input.job.id,
            budget,
          ),
          paidCallMade: didPaidCallHappen(failedIntent, dispatchesBefore),
          providerRequestId: failedIntent?.providerRequestId ?? null,
          skipReason: candidate.skipReason,
        });
        // The budget is spent for this whole job, not just this direction —
        // every STILL-UNRESOLVED failure would be refused identically, and
        // asking again would only produce noise. Directions already rescued
        // by an accepted replacement are emphatically not affected: they are
        // resolved, paid for, and customer-visible, and the budget running
        // out afterwards must never retroactively take them away.
        if (outOfBudget) {
          for (const remaining of failing) {
            if (remaining.withheld || remaining.isReplacement) continue;
            remaining.withheld = true;
            remaining.skipReason = "paid_budget_exhausted";
          }
          return;
        }
        continue;
      }

      const replacement = executed.concepts[0];
      if (!replacement) {
        candidate.withheld = true;
        candidate.skipReason = "replacement_generation_failed";
        continue;
      }

      const intent = await repo.getPaidImageIntentByKey(
        input.designId,
        replacementPaidIntentKey,
      );
      logConceptReplacement({
        ...logBase,
        decision: "replacement_generated",
        deterministicStatusAfter: null,
        paidIntentOrdinal: intent?.paidIntentOrdinal ?? null,
        paidIntentBudgetRemaining: await countRemainingPaidIntents(
          input.designId,
          input.job.id,
          budget,
        ),
        paidCallMade: executed.paidCallMade,
        providerRequestId: replacement.providerRequestId,
      });

      // Every replacement goes through the NORMAL evaluation pipeline —
      // deterministic Phase 2B plus the configured vision evaluation. There
      // is deliberately no lighter-weight "did the palette improve?" check:
      // a replacement that fixed the palette by dropping a required element
      // must be caught by exactly the same gate as any other concept.
      await repo.touchGenerationJobHeartbeat(input.job.id);
      const evaluated = await evaluateConcept({
        brief: input.brief,
        title: replacement.title,
        summary: replacement.summary,
        placeholderLabel: replacement.placeholderLabel,
        primaryAssetId: replacement.primaryAssetId,
        thumbnailAssetId: replacement.thumbnailAssetId,
        idempotencyKey: `${input.job.idempotencyKey}:replacement:${directionKey}`,
      });
      const compliance = evaluated.evaluation.printPaletteCompliance ?? null;
      const acceptance = classifyReplacementAcceptance(compliance);

      if (acceptance === "reject") {
        // One automatic replacement per direction is the entire budget for
        // this policy. No second image, no third — the direction is withheld.
        candidate.withheld = true;
        candidate.skipReason = "replacement_failed_validation";
        logConceptReplacement({
          ...logBase,
          decision: "replacement_rejected",
          deterministicStatusAfter: compliance?.status ?? "unknown",
          paidIntentOrdinal: intent?.paidIntentOrdinal ?? null,
          paidIntentBudgetRemaining: await countRemainingPaidIntents(
            input.designId,
            input.job.id,
            budget,
          ),
          paidCallMade: executed.paidCallMade,
          skipReason: candidate.skipReason,
          providerRequestId: replacement.providerRequestId,
        });
        continue;
      }

      candidate.concept = replacement;
      candidate.isReplacement = true;
      candidate.evaluated =
        acceptance === "accept_unverified"
          ? { ...evaluated, evaluationStatus: "needs_review" }
          : evaluated;

      logConceptReplacement({
        ...logBase,
        decision:
          acceptance === "accept_unverified"
            ? "replacement_accepted_unverified"
            : "replacement_accepted",
        deterministicStatusAfter: compliance?.status ?? "unknown",
        paidIntentOrdinal: intent?.paidIntentOrdinal ?? null,
        paidIntentBudgetRemaining: await countRemainingPaidIntents(
          input.designId,
          input.job.id,
          budget,
        ),
        paidCallMade: executed.paidCallMade,
        providerRequestId: replacement.providerRequestId,
      });
    }
  }

  /**
   * Phase 2C.2C: whether a paid provider call actually happened for this
   * replacement attempt, decided from DURABLE state alone.
   *
   * Two durable facts, and both are needed:
   *
   *   1. the dispatch counter moved — the platform authorized and attempted
   *      a paid call, whatever became of it afterwards. This alone is what
   *      the live log got wrong: it inferred payment from whether the
   *      replacement ASSET completed, so a billed image whose persistence
   *      failed was reported as free.
   *   2. the recorded failure class does not PROVE the request never left
   *      the process. A DNS failure increments the counter but bills
   *      nothing, and claiming otherwise would be its own lie.
   *
   * An unclassified failure (or none) defaults to "billed" — the expensive
   * reading is the safe one, and the reason this function exists at all is
   * that the cheap reading was wrong.
   */
  function didPaidCallHappen(
    intent: PaidImageIntent | null,
    dispatchesBefore: number,
  ): boolean {
    if ((intent?.dispatches ?? 0) <= dispatchesBefore) return false;
    const failureClass = readPaidImageFailureClass(intent?.lastError);
    return failureClass === null || isPossiblyBilledFailureClass(failureClass);
  }

  /**
   * Phase 2C.2C: PARENT-COMPLETION HYGIENE.
   *
   * A generation job that intentionally completes will never be claimed
   * again — `recoverAbandonedJobs` only ever sweeps `"running"` jobs. So a
   * paid intent left `"reserved"` with `dispatches > 0` at that moment is not
   * "still going to resolve"; it is a permanently stranded row that reads
   * like outstanding work. That is precisely the state the live Harley run
   * ended in: a Soft replacement OpenAI had billed, sitting `reserved`,
   * attached to a `completed` job, under a `concepts_ready` project, with
   * its direction withheld.
   *
   * Terminalizing it says the true thing — this image was dispatched, it
   * never produced durable artwork, and nothing is going to retry it — while
   * PRESERVING every piece of evidence about why (`last_error`,
   * `provider_request_id`, `dispatches`).
   *
   * Deliberately narrow, and each condition is load-bearing:
   *
   *   - only at INTENTIONAL completion. A job that fails, or is reclaimed,
   *     still intends recovery, and its intents must stay retry-eligible
   *     within their existing dispatch budget (nothing here runs on those
   *     paths).
   *   - only `dispatches > 0`. An intent reserved but never dispatched cost
   *     nothing and means nothing; failing it would invent a spend record.
   *   - fenced on the row's own `claimToken`. If a worker began a dispatch
   *     between the read and the write, the token changed, the fenced write
   *     returns `null`, and the live dispatch is left alone — refusing to
   *     terminalize an actively-running intent is the correct outcome, not
   *     an error.
   *
   * Best-effort throughout: hygiene must never fail a job that has genuinely
   * completed and whose concepts are already customer-visible.
   */
  async function terminalizeStrandedPaidIntents(
    projectId: string,
    job: GenerationJob,
  ): Promise<void> {
    let intents: PaidImageIntent[];
    try {
      intents = await repo.listPaidImageIntentsForJob(projectId, job.id);
    } catch {
      return;
    }

    for (const intent of intents) {
      if (intent.status !== "reserved") continue;
      if (intent.dispatches <= 0) continue;
      if (!intent.claimToken) continue;

      try {
        const terminalized = await repo.recordPaidImageIntentFailure(
          intent.id,
          intent.claimToken,
          {
            lastError:
              intent.lastError ??
              describePaidImageFailure(
                "unknown_local_failure",
                "A paid dispatch left no durable artwork and its parent job completed without retrying it.",
              ),
            terminal: true,
          },
        );
        if (!terminalized) continue;
        logPaidImageIntentOutcome({
          projectId,
          generationJobId: job.id,
          logicalPaidIntentKey: intent.intentKey,
          directionKey: intent.directionKey,
          generationKind: intent.intentKind,
          paidIntentOrdinal: intent.paidIntentOrdinal,
          transportAttempt: intent.dispatches,
          outcome: "terminalized",
          failureClassification: "intent_stranded_on_parent_completion",
          possiblyBilled: true,
          providerRequestId: terminalized.providerRequestId,
          lastErrorSummary: terminalized.lastError,
          terminalized: true,
          parentOutcome: "completed",
        });
      } catch {
        // Best-effort — see above.
      }
    }
  }

  /**
   * The one place a generation job is intentionally marked completed, so the
   * stranded-intent sweep can never be forgotten on a future completion path.
   */
  async function completeGenerationJob(
    projectId: string,
    job: GenerationJob,
  ): Promise<void> {
    await terminalizeStrandedPaidIntents(projectId, job);
    await repo.updateGenerationJob(job.id, {
      status: "completed",
      completedAt: new Date().toISOString(),
    });
  }

  /** Budget slots this job has left. Best-effort observability only. */
  async function countRemainingPaidIntents(
    projectId: string,
    generationJobId: string,
    budget: number,
  ): Promise<number | null> {
    try {
      const intents = await repo.listPaidImageIntentsForJob(
        projectId,
        generationJobId,
      );
      return Math.max(0, budget - intents.length);
    } catch {
      return null;
    }
  }

  /**
   * Sprint 2M Phase 2A: PROVISIONAL print-readiness intelligence, run
   * immediately after Concept Evaluation completes for one concept.
   *
   * This answers "what production work would eventually be required to
   * make this concept print-ready?" — never "is this concept final
   * production artwork?" (it is not; see ARCHITECTURE.md). The result is
   * never persisted (see the Phase 2A report's persistence audit — writing
   * it to `ArtworkVersion.printValidationStatus` today would ambiguously
   * mix provisional concept-stage intelligence with a future authoritative
   * production-validation meaning for the same column) and never changes
   * `PrintProject.status`, never freezes the concept, and never executes
   * `requiredTransformations`. It is deliberately swallow-on-error: a
   * failure here must never destabilize a successful concept generation
   * (Goal 9) — this is intelligence *about* the pipeline's output, not a
   * step the pipeline depends on.
   */
  async function runProvisionalPrintValidation(input: {
    projectId: string;
    generationJobId: string;
    artworkVersionId: string;
    designBriefVersionId: string;
    brief: DesignBriefSnapshotContent;
    asset: {
      contentType: string | null;
      widthPx: number | null;
      heightPx: number | null;
      hasTransparency: boolean | null;
    } | null;
    evaluationStatus: ConceptEvaluationStatus;
    evaluation: ConceptEvaluation;
  }): Promise<void> {
    try {
      // Resolved fresh (never cached/threaded through from job start) so a
      // brief re-approved while this job was running is detected honestly
      // — `PrintValidationCapability`'s own `brief_provenance` check is
      // exactly what surfaces that as `"blocked"` rather than a false
      // `"ready"`.
      const currentApproved = await repo.getLatestDesignBriefVersion(
        input.projectId,
      );
      const printValidationInput = assembleProvisionalPrintValidationInput({
        artworkVersionId: input.artworkVersionId,
        designBriefVersionId: input.designBriefVersionId,
        currentApprovedDesignBriefVersionId: currentApproved?.id ?? null,
        brief: input.brief,
        asset: input.asset,
        conceptEvaluationStatus: input.evaluationStatus,
        conceptEvaluation: input.evaluation,
      });
      const report = printValidation.validateArtwork(printValidationInput);
      logProvisionalPrintValidation({
        projectId: input.projectId,
        artworkVersionId: input.artworkVersionId,
        generationJobId: input.generationJobId,
        status: report.status,
        requiredTransformationCount: report.requiredTransformations.length,
        blockingIssueCount: report.blockingIssues.length,
      });
    } catch (error) {
      logProvisionalPrintValidationFailure({
        projectId: input.projectId,
        generationJobId: input.generationJobId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Sprint 2H Part 2B: keeps `job`'s heartbeat fresh for the whole duration
   * of `fn`, not just at the fixed call sites already sprinkled through
   * `runClaimedJob` — a slow provider call between two of those fixed
   * points would otherwise still be able to look abandoned to
   * `recoverAbandonedJobs` well before it actually is. Best-effort: a
   * missed tick just means recovery leans on the next successful one, and
   * never aborts the generation call itself.
   */
  async function withPeriodicHeartbeat<T>(
    jobId: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const intervalMs = getWorkerHeartbeatIntervalMs();
    const timer = setInterval(() => {
      void repo.touchGenerationJobHeartbeat(jobId).catch(() => {
        /* best-effort — see doc comment above */
      });
    }, intervalMs);
    timer.unref?.();
    try {
      return await fn();
    } finally {
      clearInterval(timer);
    }
  }

  /**
   * Shared failure path for both a genuine provider failure and a
   * retry-budget exhaustion (Sprint 2H Part 2B) — same job bookkeeping,
   * same customer messaging rules (never take away concepts the customer
   * can already see, per Constitution §14).
   */
  async function failClaimedJob(
    job: GenerationJob,
    designId: string,
    lastError: string,
    unavailable: boolean,
  ): Promise<void> {
    await repo.updateGenerationJob(job.id, { status: "failed", lastError });

    if (job.kind === "initial") {
      await repo.setProjectStatus(designId, "failed");
      await repo.addMessage(designId, {
        role: "assistant",
        content: unavailable
          ? "Concept generation is temporarily unavailable. Please try again shortly."
          : "We ran into a problem creating your concepts. Let's give it another try — just ask me to try again whenever you're ready.",
        metadata: {
          phase: "generating",
          act: "generation_failed",
          ...(unavailable ? { reason: "provider_unavailable" } : {}),
        },
      });
      return;
    }

    // Unlike the very first generation, concepts already exist here — a
    // failed regeneration should never take away what the customer could
    // already see (Constitution §14: revisions continue the same design
    // relationship, they don't restart it). `revisionPending` and
    // `finalDirectionConfirmed` are deliberately left untouched: the
    // requested revision genuinely has not happened yet, so the pending
    // authority must stay true, and nothing here may ever imply the
    // (unrevised) prior artwork is now a confirmed final direction —
    // that is what previously let "Prepare Print-Ready Artwork" appear
    // right after a failure message (Sprint 2G Live Acceptance Corrective
    // Pass, Goal 5).
    await repo.setProjectStatus(designId, "concepts_ready");
    await repo.updateConversationPhase(designId, phaseAfterGeneration(job));
    await repo.addMessage(designId, {
      role: "assistant",
      content: job.targetArtworkVersionId
        ? unavailable
          ? "Updating this concept is temporarily unavailable. Your selected concept is still available — please try again shortly."
          : "We ran into a problem updating this concept. Your selected concept is unchanged — you can try the change again anytime."
        : unavailable
          ? "Updating concepts is temporarily unavailable. Your current concepts are still available — please try again shortly."
          : "We ran into a problem updating your concepts. Your current concepts are still available — you can try again anytime.",
      metadata: {
        phase: "concepts_ready",
        act: "generation_failed",
        ...(unavailable ? { reason: "provider_unavailable" } : {}),
      },
    });
  }

  async function runClaimedJob(job: GenerationJob): Promise<void> {
    const designId = job.projectId;
    const approvedVersion = await repo.getDesignBriefVersionById(
      job.designBriefVersionId,
    );

    if (!approvedVersion) {
      // Defensive — every job is created against a real, already-approved
      // version; this should never happen in practice.
      await repo.updateGenerationJob(job.id, {
        status: "failed",
        lastError: "Referenced Design Brief version no longer exists.",
      });
      return;
    }

    const current = await repo.getProject(designId);
    if (!current) return;

    // Idempotency is keyed on THIS JOB having already produced artwork, not
    // on the approved brief version having any artwork at all.
    //
    // Live Acceptance Cleanup (Issue 3): those were the same question until
    // "Show Me 3 New Concepts" made one approved brief version able to own
    // more than one batch. Keying on the version would make every additional
    // batch a silent no-op — a job that completes having generated nothing.
    // Keying on the job is also the more precise statement of what this
    // guard was always for: "a previous run of this exact job already
    // succeeded and this claim lost the race."
    const alreadyGenerated = current.artworkVersions.some(
      (artwork) => artwork.generationJobId === job.id,
    );
    if (alreadyGenerated) {
      // Phase 2C deliberately does NOT run here. Once this job's concepts are
      // customer-visible, replacing one would be exactly the "it was there a
      // moment ago" behavior the phase exists to prevent — and it would spend
      // money to do it. Automatic replacement is a pre-exposure decision, and
      // only ever a pre-exposure decision.
      //
      // Sprint 2I: backfill evaluation only when a prior run left this job's
      // concepts without evaluationStatus.
      for (const artwork of current.artworkVersions) {
        if (
          artwork.generationJobId === job.id &&
          artwork.evaluationStatus === null
        ) {
          await repo.touchGenerationJobHeartbeat(job.id);
          const evaluated = await evaluateConcept({
            brief: approvedVersion.content,
            title: artwork.title,
            summary: artwork.summary,
            placeholderLabel: artwork.placeholderLabel,
            primaryAssetId: artwork.primaryAssetId,
            thumbnailAssetId: artwork.thumbnailAssetId,
            idempotencyKey: `${artwork.id}:${approvedVersion.id}`,
          });
          await repo.updateArtworkEvaluation(artwork.id, evaluated);

          const primaryAsset = artwork.primaryAssetId
            ? await repo.getAssetById(artwork.primaryAssetId)
            : null;
          await runProvisionalPrintValidation({
            projectId: designId,
            generationJobId: job.id,
            artworkVersionId: artwork.id,
            designBriefVersionId: approvedVersion.id,
            brief: approvedVersion.content,
            asset: primaryAsset
              ? {
                  contentType: primaryAsset.contentType,
                  widthPx: primaryAsset.widthPx,
                  heightPx: primaryAsset.heightPx,
                  hasTransparency: primaryAsset.hasTransparency,
                }
              : null,
            evaluationStatus: evaluated.evaluationStatus,
            evaluation: evaluated.evaluation,
          });
        }
      }
      await completeGenerationJob(designId, job);
      return;
    }

    if (job.attempts > MAX_GENERATION_ATTEMPTS) {
      // Sprint 2H Part 2B: closes the recovery retry-budget gap — a job
      // that keeps crashing its worker mid-attempt (not just a job that
      // keeps failing at the provider) would otherwise recover and reclaim
      // forever, since `claimNextQueuedJob` increments `attempts` on every
      // claim regardless of how the job got back to "queued"/"recoverable".
      // This is the same budget `ConceptGenerationCapability.enqueue` uses
      // for customer-initiated retries — see `shared/generation-retry-policy`.
      await failClaimedJob(
        job,
        designId,
        `Exceeded maximum generation attempts (${MAX_GENERATION_ATTEMPTS}) after repeated recovery.`,
        false,
      );
      return;
    }

    try {
      // Sprint 2J Phase 3: GenerationIntent is the sole PromptTranslation
      // input. Initial jobs get a brief-only intent (byte-for-byte equivalent
      // to pre-Phase-3 translation). Regeneration jobs derive RevisionTimeline
      // → RegenerationPlan → intent with plan. Timeline/plan/intent are
      // never persisted.
      const generationJobs = await repo.listGenerationJobs(designId);
      const generationIntent = buildGenerationIntentForJob({
        job,
        approvedVersion,
        project: current,
        generationJobs,
        deps: { revisionIntelligence },
      });
      const promptRequest = promptTranslation.translate(generationIntent);
      await repo.touchGenerationJobHeartbeat(job.id);

      // True Source-Image Targeted Revision: a targeted revision is an EDIT
      // of the selected concept, so its real pixels must cross the provider
      // boundary. Resolved before the provider call and never optional —
      // a failure here fails the job (see `TargetedRevisionSourceError`)
      // rather than degrading to text-to-image. Initial generation and
      // three-direction regeneration pass `null` and are untouched.
      const sourceArtwork =
        job.targetArtworkVersionId && provider.editsSourceArtwork
          ? await loadSourceArtwork(current, job.targetArtworkVersionId)
          : null;

      const generationRequest = {
        designId,
        designBriefId: approvedVersion.id,
        conceptCount: job.conceptCount,
        prompt: promptRequest,
        idempotencyKey: job.idempotencyKey,
        sourceArtwork,
      };

      // Phase 2C0.5: PERSIST AS YOU GO. Each logical paid intent is
      // reserved, dispatched, stored, and durably checkpointed on its own,
      // in order — so a failure on the third direction can never make the
      // platform pay for the first two again. Nothing here waits for all
      // three provider responses before creating durable knowledge that
      // directions one and two succeeded.
      //
      // The customer-visible lifecycle is unchanged: `ArtworkVersion` rows
      // are still created in ONE batch below, after every unit resolves, so
      // no partially-completed concept set is ever exposed.
      const units = planPaidImageUnits(
        job,
        promptRequest.targetConceptDirectionKey ?? null,
      );
      const paidConcepts: PersistedPaidConcept[] = [];
      for (const unit of units) {
        await repo.touchGenerationJobHeartbeat(job.id);
        const executed = await withPeriodicHeartbeat(job.id, () =>
          executePaidImageUnit(
            {
              repo,
              job,
              providerKey: provider.providerKey,
              dispatch: async () => {
                // Only a per-direction CONCEPT unit may use the
                // per-direction entry point. A targeted revision keeps
                // going through `generate`, which is what routes it to the
                // provider's EDIT path — sending it to `generateDirection`
                // would silently turn an edit of the customer's selected
                // artwork back into a fresh text-to-image generation, the
                // exact defect True Source-Image Targeted Revision exists
                // to prevent.
                const perDirection =
                  unit.kind === "initial_concept" &&
                  unit.scopeKey !== "batch" &&
                  provider.generateDirection;
                const result: ConceptGenerationResult = perDirection
                  ? await perDirection.call(
                      provider,
                      generationRequest,
                      unit.scopeKey as ConceptDirectionKey,
                    )
                  : await provider.generate(generationRequest);
                return result.concepts;
              },
              persist: (drafts, intentKey) =>
                persistPaidConcepts(
                  designId,
                  job.id,
                  provider.providerKey,
                  drafts,
                  intentKey,
                ),
            },
            unit,
          ),
        );
        paidConcepts.push(...executed.concepts);
      }

      const startingVersionNumber = current.artworkVersions.length;
      // Sequential, not `Promise.all` — asset registration is a
      // read-modify-write against shared persistence (the local JSON store
      // has no transactional isolation), so concurrent writes here can
      // race and silently drop data. One concept at a time also gives a
      // meaningful point to heartbeat between concepts.
      //
      // Phase 2C0.5: the assets themselves are already stored by this point
      // (that is what "persist as you go" means). This loop now only
      // evaluates and assembles the customer-visible batch.
      //
      // Phase 2C: evaluation and REPLACEMENT both happen here, before a
      // single `ArtworkVersion` row is written. Nothing below this point can
      // be reached with a customer-visible concept that is about to be
      // taken away, because no concept is customer-visible yet.
      const candidates: ConceptCandidate[] = [];
      for (const [index, concept] of paidConcepts.entries()) {
        await repo.touchGenerationJobHeartbeat(job.id);
        // Sprint 2I Phase 1 pipeline:
        // Generation → Asset → Concept Evaluation → Persist evaluation.
        // Evaluation failure never discards the concept.
        //
        // Phase 2C0.5: evaluation is deliberately NOT cached on the paid
        // intent and is always re-run here. It is non-billable, and a
        // reused image must still be evaluated against whatever the brief
        // says now — caching it would trade a free recomputation for a
        // stale verdict.
        const evaluated = await evaluateConcept({
          brief: approvedVersion.content,
          title: concept.title,
          summary: concept.summary,
          placeholderLabel: concept.placeholderLabel,
          primaryAssetId: concept.primaryAssetId,
          thumbnailAssetId: concept.thumbnailAssetId,
          idempotencyKey: `${job.idempotencyKey}:concept:${index}`,
        });
        candidates.push({
          directionKey: concept.directionKey ?? null,
          concept,
          evaluated,
          isReplacement: false,
          withheld: false,
          skipReason: null,
        });
      }

      // Phase 2C: bounded automatic replacement of HARD print-palette
      // failures. Never throws — see `resolveHardPaletteFailures`.
      await resolveHardPaletteFailures({
        job,
        designId,
        brief: approvedVersion.content,
        generationIntent,
        generationRequest,
        candidates,
      });

      const delivered = candidates.filter((candidate) => !candidate.withheld);
      const withheld = candidates.filter((candidate) => candidate.withheld);
      logConceptSetOutcome({
        projectId: designId,
        generationJobId: job.id,
        requestedConceptCount: job.conceptCount,
        deliveredConceptCount: delivered.length,
        withheldDirectionKeys: withheld.map(
          (candidate) => candidate.directionKey ?? "unknown",
        ),
        replacedDirectionKeys: delivered
          .filter((candidate) => candidate.isReplacement)
          .map((candidate) => candidate.directionKey ?? "unknown"),
        paidIntentsUsed: (
          await repo.listPaidImageIntentsForJob(designId, job.id)
        ).length,
        paidIntentBudget: paidIntentBudgetForJob(job.conceptCount),
      });

      if (delivered.length === 0) {
        // Nothing honest is left to show. Fails the job rather than
        // completing it with an empty concept set — see the error's doc.
        throw new ConceptSetUnresolvableError(
          withheld.map((candidate) => candidate.directionKey ?? "unknown"),
        );
      }

      // Version numbers are assigned over the DELIVERED set, so a withheld
      // direction leaves no gap in what the customer sees.
      const versionsInput: Parameters<ProjectRepository["addArtworkVersions"]>[1] =
        delivered.map((candidate, index) => ({
          versionNumber: startingVersionNumber + index + 1,
          kind: candidate.concept.kind,
          title: candidate.concept.title,
          summary: candidate.concept.summary,
          placeholderLabel: candidate.concept.placeholderLabel,
          accentColor: candidate.concept.accentColor,
          designBriefVersionId: approvedVersion.id,
          generationJobId: job.id,
          primaryAssetId: candidate.concept.primaryAssetId,
          thumbnailAssetId: candidate.concept.thumbnailAssetId,
          providerKey: provider.providerKey,
          evaluationStatus: candidate.evaluated.evaluationStatus,
          evaluation: candidate.evaluated.evaluation,
          evaluationEvaluatedAt: candidate.evaluated.evaluationEvaluatedAt,
          evaluationProviderKey: candidate.evaluated.evaluationProviderKey,
          // Sprint 2G Live Acceptance Corrective Pass: durable revision
          // lineage + which catalog direction this concept used.
          sourceArtworkVersionId: job.targetArtworkVersionId ?? null,
          conceptDirectionKey: candidate.concept.directionKey ?? null,
        }));
      // Sprint 2M Phase 2A: per-concept data `runProvisionalPrintValidation`
      // needs, captured in the same order as `versionsInput` — the real
      // `artworkVersionId` only exists after `addArtworkVersions` returns,
      // so provisional validation itself runs in a second pass below.
      const provisionalInputs: Array<{
        asset: {
          contentType: string | null;
          widthPx: number | null;
          heightPx: number | null;
          hasTransparency: boolean | null;
        } | null;
        evaluationStatus: ConceptEvaluationStatus;
        evaluation: ConceptEvaluation;
      }> = delivered.map((candidate) => ({
        // Asset facts come from the durable paid-intent record rather
        // than from in-memory provider output, so a REUSED concept and a
        // freshly generated one produce identical provisional validation
        // input. (`null` for the placeholder provider, which produces no
        // real image bytes; provisional validation honestly reports that
        // as a missing asset, not a failure.)
        asset: candidate.concept.primaryAssetId
          ? {
              contentType: candidate.concept.contentType,
              widthPx: candidate.concept.widthPx,
              heightPx: candidate.concept.heightPx,
              hasTransparency: candidate.concept.hasTransparency,
            }
          : null,
        evaluationStatus: candidate.evaluated.evaluationStatus,
        evaluation: candidate.evaluated.evaluation,
      }));

      const createdVersions = await repo.addArtworkVersions(designId, versionsInput);
      // Sprint 2M Phase 2A: PROVISIONAL print-readiness intelligence only —
      // never authoritative, never persisted, never blocks this job. See
      // `runProvisionalPrintValidation` and ARCHITECTURE.md.
      for (const [index, artwork] of createdVersions.entries()) {
        const provisional = provisionalInputs[index];
        if (!provisional) continue;
        await runProvisionalPrintValidation({
          projectId: designId,
          generationJobId: job.id,
          artworkVersionId: artwork.id,
          designBriefVersionId: approvedVersion.id,
          brief: approvedVersion.content,
          asset: provisional.asset,
          evaluationStatus: provisional.evaluationStatus,
          evaluation: provisional.evaluation,
        });
      }
      if (job.kind === "regeneration") {
        // Sprint 2G Live Acceptance Corrective Pass: a targeted
        // single-concept revision has exactly one candidate — auto-select
        // it as the thing under review (there is nothing else to pick
        // from), but `finalDirectionConfirmed` stays false regardless (set
        // only by the customer's explicit confirmation) so this can never
        // itself make finalization eligible. An ordinary three-direction
        // "show me alternatives" regeneration still clears selection, same
        // as before — the customer must pick one of the three.
        const revisedArtwork = job.targetArtworkVersionId
          ? createdVersions[0]
          : undefined;
        await repo.updateProject(designId, {
          selectedArtworkVersionId: revisedArtwork?.id ?? null,
          // Sprint 2M Phase 2G (Goal 3): the requested revision is now
          // represented by a real ArtworkVersion batch — clear the pending
          // authority here, at completion, never merely at enqueue time.
          revisionPending: false,
          finalDirectionConfirmed: false,
        });
        // Sprint 2M Phase 2B (Goal 4): a new concept batch means the
        // artwork behind any prior final-direction approval no longer
        // exists as "the current direction" — the prior approval can never
        // silently authorize production of what just replaced it. Safe to
        // call unconditionally: a no-op when nothing is currently active.
        // (Sprint 2M Phase 2G, Goal 7: the common case is now already a
        // no-op here — `triggerAutomaticRevision` already superseded the
        // active approval, if any, at the moment the revision was
        // understood, not just now at completion.)
        await repo.supersedeActiveFinalDirectionApproval(designId);
      }
      await completeGenerationJob(designId, job);

      await repo.setProjectStatus(designId, "concepts_ready");
      await repo.updateConversationPhase(designId, phaseAfterGeneration(job));
      await repo.addMessage(designId, {
        role: "assistant",
        // The metadata phase stays "concepts_ready" on both paths: it marks
        // this message as the "here is artwork" anchor the concept grid
        // renders against, which is a property of the event, not of the
        // phase the conversation moves into next.
        content: conceptsReadyContent(job, createdVersions.length),
        metadata: {
          phase: "concepts_ready",
          // Phase 2C: durable, non-technical UX data so a later phase can
          // explain a short set without re-deriving it. Nothing renders it
          // today, and it is deliberately a count — never a reason code, a
          // validator verdict, or any production setting (Constitution §8).
          ...(withheld.length > 0 ? { conceptsWithheld: withheld.length } : {}),
        },
      });
    } catch (error) {
      const unavailable = error instanceof GenerationUnavailableError;
      if (unavailable) {
        // Sprint 2H Part 1A/2A: the one failure class worth a structured
        // server-side log — an invalid production configuration a
        // customer would otherwise mistake for a transient hiccup. Never
        // includes an API key or any provider request detail.
        logConceptGenerationUnavailable({
          safeErrorCode: error.safeErrorCode,
          intendedProvider: error.intendedProviderKey,
          internalReason: error.message,
          environment: process.env.NODE_ENV ?? "development",
          generationJobId: job.id,
          projectId: designId,
        });
      }

      await failClaimedJob(job, designId, describeGenerationError(error), unavailable);
    }
  }

  return {
    async processNextJob() {
      const job = await repo.claimNextQueuedJob();
      if (!job) return { processedJobId: null };
      await runClaimedJob(job);
      return { processedJobId: job.id };
    },

    async recoverAbandonedJobs(staleAfterMs = DEFAULT_STALE_JOB_MS) {
      const recovered = await repo.recoverAbandonedJobs(staleAfterMs);
      return { recoveredCount: recovered.length };
    },
  };
}

/**
 * Sanitized, non-secret description of a generation failure, safe to store
 * as `GenerationJob.lastError` (internal only — never surfaced through
 * `ProjectSnapshot` or the conversation).
 */
function describeGenerationError(error: unknown): string {
  if (error instanceof GenerationUnavailableError) {
    return `${UNAVAILABLE_ERROR_PREFIX}${error.safeErrorCode}: ${error.message}`;
  }
  // Phase 2C0.5: an actionable internal failure — the platform REFUSED to
  // spend, rather than failing to. Greppable so an operator can tell a
  // spend-guard stop apart from a provider outage at a glance.
  if (error instanceof PaidImageIntentBlockedError) {
    return `${PAID_IMAGE_INTENT_BLOCKED_ERROR_PREFIX}${error.reason}: ${error.message}`;
  }
  // Phase 2C: every concept in the batch hard-failed the print palette and
  // the bounded replacement budget could not rescue one. Greppable so an
  // operator can tell this apart from a provider outage — the images were
  // bought and stored fine; they simply cannot be honestly presented.
  if (error instanceof ConceptSetUnresolvableError) {
    return `${CONCEPT_SET_UNRESOLVABLE_ERROR_PREFIX}${error.message}`;
  }
  // True Source-Image Targeted Revision: an actionable internal failure —
  // the revision could not be performed as an edit, and was NOT quietly
  // downgraded to a fresh text-to-image generation.
  if (error instanceof TargetedRevisionSourceError) {
    return `${TARGETED_REVISION_SOURCE_ERROR_PREFIX}${error.reason}: ${error.message}`;
  }
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.length > 0) {
      return message;
    }
  }
  return "Generation failed for an unknown reason.";
}

/**
 * Phase 2C0.5: the provider's own request id, when it exposed one, read
 * from the SANITIZED metadata envelope a provider adapter already
 * produces. Best-effort observability only — never load-bearing, and never
 * part of the logical intent identity (it changes on every dispatch, which
 * is exactly what the identity must not do).
 */
function readProviderRequestId(draft: GeneratedConceptDraft): string | null {
  const value = draft.asset?.providerMetadata?.providerRequestId;
  return typeof value === "string" && value.length > 0 ? value : null;
}
