import { randomUUID } from "crypto";

import type { ProjectRepository } from "@/lib/db/repository";
import type {
  ConceptEvaluation,
  ConceptEvaluationStatus,
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
} from "@/capabilities/shared/contracts";
import { MAX_GENERATION_ATTEMPTS } from "@/capabilities/shared/generation-retry-policy";
import { logConceptGenerationUnavailable } from "@/lib/config/generation-provider-logging";
import { getWorkerHeartbeatIntervalMs } from "@/lib/config/worker-config";

import { buildGenerationIntentForJob } from "./build-generation-intent";

/**
 * Sprint 2H Part 2A: a "running" job with no heartbeat for this long is
 * presumed abandoned (its worker process died) and becomes recoverable.
 * 15 minutes, matching the sprint's own recovery example.
 */
export const DEFAULT_STALE_JOB_MS = 15 * 60 * 1000;

const UNAVAILABLE_ERROR_PREFIX = "GENERATION_UNAVAILABLE:";

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
    } else {
      // Unlike the very first generation, concepts already exist here —
      // a failed regeneration should never take away what the customer
      // could already see (Constitution §14: revisions continue the
      // same design relationship, they don't restart it).
      await repo.setProjectStatus(designId, "concepts_ready");
      await repo.updateConversationPhase(designId, "concepts_ready");
      await repo.addMessage(designId, {
        role: "assistant",
        content: unavailable
          ? "Updating concepts is temporarily unavailable. Your current concepts are still available — please try again shortly."
          : "We ran into a problem updating your concepts. Your current concepts are still available — you can try again anytime.",
        metadata: {
          phase: "concepts_ready",
          act: "generation_failed",
          ...(unavailable ? { reason: "provider_unavailable" } : {}),
        },
      });
    }
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

    const alreadyGenerated = current.artworkVersions.some(
      (artwork) => artwork.designBriefVersionId === approvedVersion.id,
    );
    if (alreadyGenerated) {
      // Idempotent: a previous run already succeeded (e.g. this run is a
      // recovered duplicate claim that lost the race) — nothing left to do
      // for generation. Sprint 2I: backfill evaluation only when a prior
      // run left concepts without evaluationStatus.
      for (const artwork of current.artworkVersions) {
        if (
          artwork.designBriefVersionId === approvedVersion.id &&
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

      const result: ConceptGenerationResult = await withPeriodicHeartbeat(
        job.id,
        () =>
          provider.generate({
            designId,
            designBriefId: approvedVersion.id,
            conceptCount: job.conceptCount,
            prompt: promptRequest,
            idempotencyKey: job.idempotencyKey,
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
        });
      }

      await repo.addArtworkVersions(designId, versionsInput);
      if (job.kind === "regeneration") {
        await repo.updateProject(designId, { selectedArtworkVersionId: null });
      }
      await repo.updateGenerationJob(job.id, {
        status: "completed",
        completedAt: new Date().toISOString(),
      });

      await repo.setProjectStatus(designId, "concepts_ready");
      await repo.updateConversationPhase(designId, "concepts_ready");
      await repo.addMessage(designId, {
        role: "assistant",
        content:
          job.kind === "regeneration"
            ? "Here are three updated concept directions. Pick the one that feels closest."
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
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.length > 0) {
      return message;
    }
  }
  return "Generation failed for an unknown reason.";
}
