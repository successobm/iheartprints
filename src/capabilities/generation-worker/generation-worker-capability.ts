import { randomUUID } from "crypto";

import type { ProjectRepository } from "@/lib/db/repository";
import type {
  ConceptEvaluation,
  ConceptEvaluationStatus,
  ConversationPhase,
  DesignBriefSnapshotContent,
  GenerationJob,
} from "@/lib/domain/types";
import type { AssetCapability } from "@/capabilities/assets";
import type { ConceptEvaluationCapability } from "@/capabilities/concept-evaluation";
import {
  createConceptEvaluationCapability,
  PlaceholderConceptEvaluationProvider,
} from "@/capabilities/concept-evaluation";
import type { PromptTranslationCapability } from "@/capabilities/prompt-translation";
import type { RevisionIntelligenceCapability } from "@/capabilities/revision-intelligence";
import { createRevisionIntelligenceCapability } from "@/capabilities/revision-intelligence";
import { GenerationUnavailableError } from "@/capabilities/providers";
import type { ConceptGenerationProvider } from "@/capabilities/providers";
import type {
  ConceptGenerationResult,
  GeneratedAssetPayload,
  SourceArtworkImage,
} from "@/capabilities/shared/contracts";
import { MAX_GENERATION_ATTEMPTS } from "@/capabilities/shared/generation-retry-policy";
import type { PrintValidationCapability } from "@/capabilities/print-validation";
import {
  assembleProvisionalPrintValidationInput,
  createPrintValidationCapability,
} from "@/capabilities/print-validation";
import { logConceptGenerationUnavailable } from "@/lib/config/generation-provider-logging";
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
      metadata: asset.providerMetadata,
    });

    return {
      primaryAssetId: primary.id,
      thumbnailAssetId: thumbnail?.id ?? null,
    };
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
   */
  async function evaluateConcept(input: {
    brief: DesignBriefSnapshotContent;
    title: string;
    summary: string;
    placeholderLabel: string;
    primaryAssetId: string | null;
    thumbnailAssetId: string | null;
    idempotencyKey: string;
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
      await repo.updateGenerationJob(job.id, {
        status: "completed",
        completedAt: new Date().toISOString(),
      });
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

      const result: ConceptGenerationResult = await withPeriodicHeartbeat(
        job.id,
        () =>
          provider.generate({
            designId,
            designBriefId: approvedVersion.id,
            conceptCount: job.conceptCount,
            prompt: promptRequest,
            idempotencyKey: job.idempotencyKey,
            sourceArtwork,
          }),
      );

      const startingVersionNumber = current.artworkVersions.length;
      // Sequential, not `Promise.all` — asset registration is a
      // read-modify-write against shared persistence (the local JSON store
      // has no transactional isolation), so concurrent writes here can
      // race and silently drop data. One concept at a time also gives a
      // meaningful point to heartbeat between concepts.
      const versionsInput: Parameters<ProjectRepository["addArtworkVersions"]>[1] =
        [];
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
      }> = [];
      for (const [index, concept] of result.concepts.entries()) {
        await repo.touchGenerationJobHeartbeat(job.id);
        const assetIds = await persistConceptAsset(
          designId,
          job.id,
          provider.providerKey,
          concept.asset,
        );
        // Sprint 2I Phase 1 pipeline:
        // Generation → Asset → Concept Evaluation → Persist evaluation.
        // Evaluation failure never discards the concept.
        const evaluated = await evaluateConcept({
          brief: approvedVersion.content,
          title: concept.title,
          summary: concept.summary,
          placeholderLabel: concept.placeholderLabel,
          primaryAssetId: assetIds.primaryAssetId,
          thumbnailAssetId: assetIds.thumbnailAssetId,
          idempotencyKey: `${job.idempotencyKey}:concept:${index}`,
        });
        versionsInput.push({
          versionNumber: startingVersionNumber + index + 1,
          kind: concept.kind,
          title: concept.title,
          summary: concept.summary,
          placeholderLabel: concept.placeholderLabel,
          accentColor: concept.accentColor,
          designBriefVersionId: approvedVersion.id,
          generationJobId: job.id,
          primaryAssetId: assetIds.primaryAssetId,
          thumbnailAssetId: assetIds.thumbnailAssetId,
          providerKey: provider.providerKey,
          evaluationStatus: evaluated.evaluationStatus,
          evaluation: evaluated.evaluation,
          evaluationEvaluatedAt: evaluated.evaluationEvaluatedAt,
          evaluationProviderKey: evaluated.evaluationProviderKey,
          // Sprint 2G Live Acceptance Corrective Pass: durable revision
          // lineage + which catalog direction this concept used.
          sourceArtworkVersionId: job.targetArtworkVersionId ?? null,
          conceptDirectionKey: concept.directionKey ?? null,
        });
        provisionalInputs.push({
          // The just-uploaded asset's own metadata is already in scope —
          // no extra repository round trip needed (`concept.asset` is
          // `undefined` for the placeholder provider, which produces no
          // real image bytes; provisional validation honestly reports
          // that as a missing asset, not a failure).
          asset: concept.asset
            ? {
                contentType: concept.asset.contentType,
                widthPx: concept.asset.widthPx,
                heightPx: concept.asset.heightPx,
                hasTransparency: concept.asset.hasTransparency,
              }
            : null,
          evaluationStatus: evaluated.evaluationStatus,
          evaluation: evaluated.evaluation,
        });
      }

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
      await repo.updateGenerationJob(job.id, {
        status: "completed",
        completedAt: new Date().toISOString(),
      });

      await repo.setProjectStatus(designId, "concepts_ready");
      await repo.updateConversationPhase(designId, phaseAfterGeneration(job));
      await repo.addMessage(designId, {
        role: "assistant",
        // The metadata phase stays "concepts_ready" on both paths: it marks
        // this message as the "here is artwork" anchor the concept grid
        // renders against, which is a property of the event, not of the
        // phase the conversation moves into next.
        content: job.targetArtworkVersionId
          ? "Here's your revised concept. How does this version look?"
          : job.kind === "regeneration"
            ? "Here are three new directions to consider. Pick the one that feels closest."
            : "Here are three concept directions. Pick the one that feels closest.",
        metadata: { phase: "concepts_ready" },
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
