import { randomUUID } from "crypto";

import type { ProjectRepository } from "@/lib/db/repository";
import type { GenerationJob } from "@/lib/domain/types";
import type { AssetCapability } from "@/capabilities/assets";
import type { PromptTranslationCapability } from "@/capabilities/prompt-translation";
import { GenerationUnavailableError } from "@/capabilities/providers";
import type { ConceptGenerationProvider } from "@/capabilities/providers";
import type {
  ConceptGenerationResult,
  GeneratedAssetPayload,
} from "@/capabilities/shared/contracts";
import { logConceptGenerationUnavailable } from "@/lib/config/generation-provider-logging";

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
      // recovered duplicate claim that lost the race) — nothing left to do.
      await repo.updateGenerationJob(job.id, {
        status: "completed",
        completedAt: new Date().toISOString(),
      });
      return;
    }

    try {
      const promptRequest = promptTranslation.translate(approvedVersion.content);
      await repo.touchGenerationJobHeartbeat(job.id);

      const result: ConceptGenerationResult = await provider.generate({
        designId,
        designBriefId: approvedVersion.id,
        conceptCount: job.conceptCount,
        prompt: promptRequest,
        idempotencyKey: job.idempotencyKey,
      });

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
      await repo.updateGenerationJob(job.id, {
        status: "failed",
        lastError: describeGenerationError(error),
      });

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
