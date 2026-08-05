import type { ProjectRepository } from "@/lib/db/repository";
import type {
  ArtworkVersion,
  DesignBriefVersion,
  ProjectSnapshot,
  TShirtDesignBrief,
} from "@/lib/domain/types";
import type { AssetCapability } from "@/capabilities/assets";
import type { PromptTranslationCapability } from "@/capabilities/prompt-translation";
import { GenerationUnavailableError } from "@/capabilities/providers";
import type { ConceptGenerationProvider } from "@/capabilities/providers";
import { diffBriefSections } from "@/capabilities/shared/brief-diff";
import { isConceptRelevantChange } from "@/capabilities/shared/concept-relevance";
import type {
  ConceptGenerationResult,
  ConceptStatusView,
  GeneratedAssetPayload,
} from "@/capabilities/shared/contracts";
import { logConceptGenerationUnavailable } from "@/lib/config/generation-provider-logging";

/**
 * Sprint 2H Part 1: a job that has failed this many times gives up asking
 * the provider again on its own — the customer has to explicitly retry
 * (ask again, or press the same button) rather than the platform looping
 * silently. Chosen small so a genuinely broken provider fails fast instead
 * of stalling the conversation across several turns.
 */
const MAX_GENERATION_ATTEMPTS = 3;

export interface ConceptGenerationCapability {
  /**
   * Provider-neutral generation entry point.
   *
   * Sprint 2D hard guard: `approvedVersionId` must reference an existing,
   * durable Design Brief version belonging to this project. This check lives
   * in the capability itself — not the UI or the route — so a direct API
   * call, a stale client, or an accidental orchestration call cannot bypass
   * the approval gate.
   *
   * Sprint 2H Part 1: internally now runs a real (provider-neutral)
   * generation pipeline — translate the approved brief, call the
   * configured provider, persist any real assets it returns, and record a
   * durable `GenerationJob` — behind the exact same signature and customer
   * workflow as before. A provider failure never throws out to the caller;
   * it resolves to a snapshot with a friendly assistant message instead.
   */
  generatePlaceholders(
    designId: string,
    approvedVersionId: string,
  ): Promise<ProjectSnapshot>;
  /**
   * Sprint 2G Part 2: generates a fresh batch of concepts after a
   * post-approval revision made the existing ones stale. Same approval
   * guard as `generatePlaceholders`, but continues artwork version
   * numbering from the existing count instead of guarding on "no concepts
   * yet" — prior concepts are never deleted (Constitution §6.11, Version
   * Everything), just superseded by a newer batch tied to the newer
   * approved brief version. Idempotent the same way: calling it again for
   * a version that already has concepts does not duplicate them. Clears
   * any prior concept selection, since it no longer applies to the new batch.
   */
  regenerateAfterRevision(
    designId: string,
    approvedVersionId: string,
  ): Promise<ProjectSnapshot>;
  /**
   * Sprint 2G Part 3: pure, read-only status of the current concept batch
   * relative to the working brief — "Current" / "Needs Update" / older
   * batches "superseded" — never exposing version IDs or internal state to
   * callers. Takes already-fetched data (no I/O) so it can be recomputed
   * on every snapshot read, not just right after a revision.
   */
  describeConceptStatus(
    brief: TShirtDesignBrief,
    artworkVersions: ArtworkVersion[],
    designBriefVersions: DesignBriefVersion[],
  ): ConceptStatusView;
  /** Exposes provider identity for future tracing — not persisted yet. */
  describeProvider(): string;
}

export function createConceptGenerationCapability(
  repo: ProjectRepository,
  provider: ConceptGenerationProvider,
  promptTranslation: PromptTranslationCapability,
  assets: AssetCapability,
): ConceptGenerationCapability {
  function buildIdempotencyKey(
    designId: string,
    approvedVersionId: string,
  ): string {
    return `concept-generation:${designId}:${approvedVersionId}`;
  }

  /**
   * Registers one concept's generated image (and a thumbnail record) via
   * `AssetCapability`. Placeholder-generated drafts have no `asset` payload
   * and get no asset rows at all — identical to today's behavior.
   */
  async function persistConceptAsset(
    designId: string,
    generationJobId: string,
    providerKey: string,
    asset: GeneratedAssetPayload | undefined,
  ): Promise<{ primaryAssetId: string | null; thumbnailAssetId: string | null }> {
    if (!asset) return { primaryAssetId: null, thumbnailAssetId: null };

    const primary = await assets.registerAsset(designId, {
      kind: "generated_artwork",
      storageKey: asset.storageKey,
      contentType: asset.contentType,
      isThumbnail: false,
      widthPx: asset.widthPx,
      heightPx: asset.heightPx,
      hasTransparency: asset.hasTransparency,
      providerKey,
      generationJobId,
      metadata: asset.providerMetadata,
      vectorAssetId: null,
      printAssetId: null,
    });

    // Real thumbnail resizing is future work (Sprint 2H Part 2); for now a
    // second asset record marks the same (or provider-supplied distinct)
    // image data as the thumbnail, so the Concept model's "Thumbnail"
    // reference is real and queryable rather than a placeholder id.
    const thumbnail = await assets.registerAsset(designId, {
      kind: "generated_artwork",
      storageKey: asset.thumbnailStorageKey ?? asset.storageKey,
      contentType: asset.contentType,
      isThumbnail: true,
      widthPx: asset.widthPx,
      heightPx: asset.heightPx,
      hasTransparency: asset.hasTransparency,
      providerKey,
      generationJobId,
      metadata: {},
      vectorAssetId: null,
      printAssetId: null,
    });

    return {
      primaryAssetId: primary?.id ?? null,
      thumbnailAssetId: thumbnail?.id ?? null,
    };
  }

  /**
   * Runs (or resumes) the generation job for one approved brief version.
   * Idempotent: if concepts already exist for this version, this is a
   * no-op success regardless of job status — actual persisted data, not
   * job bookkeeping, is the source of truth for "did this already happen"
   * (the same guard the pre-2H-Part-1 code used), so a crash between a
   * successful `addArtworkVersions` and marking the job "completed" can
   * never produce duplicate concepts on retry.
   */
  async function runGeneration(
    designId: string,
    approvedVersion: DesignBriefVersion,
    options: { clearSelectionOnSuccess: boolean },
  ): Promise<{ ok: boolean; unavailable: boolean }> {
    const idempotencyKey = buildIdempotencyKey(designId, approvedVersion.id);
    let job = await repo.getGenerationJobByIdempotencyKey(
      designId,
      idempotencyKey,
    );
    if (!job) {
      job = await repo.createGenerationJob(designId, {
        designBriefVersionId: approvedVersion.id,
        conceptCount: 3,
        providerKey: provider.providerKey,
        idempotencyKey,
      });
    }

    const current = await repo.getProject(designId);
    if (!current) throw new Error("Project not found");

    const alreadyGenerated = current.artworkVersions.some(
      (artwork) => artwork.designBriefVersionId === approvedVersion.id,
    );
    if (alreadyGenerated) {
      if (job.status !== "completed") {
        await repo.updateGenerationJob(job.id, { status: "completed" });
      }
      return { ok: true, unavailable: false };
    }

    if (job.status === "failed" && job.attempts >= MAX_GENERATION_ATTEMPTS) {
      return { ok: false, unavailable: wasUnavailableFailure(job.lastError) };
    }

    await repo.updateGenerationJob(job.id, {
      status: "running",
      attempts: job.attempts + 1,
    });

    try {
      const promptRequest = promptTranslation.translate(approvedVersion.content);
      const result: ConceptGenerationResult = await provider.generate({
        designId,
        designBriefId: approvedVersion.id,
        conceptCount: 3,
        prompt: promptRequest,
        idempotencyKey,
      });

      const startingVersionNumber = current.artworkVersions.length;
      // Sequential, not `Promise.all` — asset registration is a
      // read-modify-write against shared persistence (the local JSON store
      // has no transactional isolation), so concurrent writes here can
      // race and silently drop data. One concept at a time keeps every
      // write ordered and safe on both repository implementations.
      const versionsInput: Parameters<ProjectRepository["addArtworkVersions"]>[1] =
        [];
      for (const [index, concept] of result.concepts.entries()) {
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
      if (options.clearSelectionOnSuccess) {
        await repo.updateProject(designId, { selectedArtworkVersionId: null });
      }
      await repo.updateGenerationJob(job.id, { status: "completed" });
      return { ok: true, unavailable: false };
    } catch (error) {
      await repo.updateGenerationJob(job.id, {
        status: "failed",
        lastError: describeGenerationError(error),
      });

      if (error instanceof GenerationUnavailableError) {
        // Sprint 2H Part 1A: this is the one failure class worth a
        // structured server-side log — an invalid production configuration
        // that a customer would otherwise mistake for a transient hiccup.
        // Never includes the API key or any provider request detail.
        logConceptGenerationUnavailable({
          safeErrorCode: error.safeErrorCode,
          intendedProvider: error.intendedProviderKey,
          internalReason: error.message,
          environment: process.env.NODE_ENV ?? "development",
          generationJobId: job.id,
          projectId: designId,
        });
      }

      return { ok: false, unavailable: error instanceof GenerationUnavailableError };
    }
  }

  return {
    describeProvider() {
      return provider.providerKey;
    },

    async generatePlaceholders(designId, approvedVersionId) {
      if (!approvedVersionId) {
        throw new Error(
          "Cannot generate concepts without an approved design brief",
        );
      }

      const approvedVersion =
        await repo.getDesignBriefVersionById(approvedVersionId);
      if (!approvedVersion || approvedVersion.projectId !== designId) {
        throw new Error(
          "Cannot generate concepts without an approved design brief",
        );
      }

      await repo.setProjectStatus(designId, "generating");
      await repo.updateConversationPhase(designId, "generating");
      await repo.addMessage(designId, {
        role: "assistant",
        content:
          "Design brief approved — generating three concept directions...",
        metadata: { phase: "generating" },
      });

      // Preserve Sprint 1 simulated latency for UX validation.
      await sleep(1400);

      const { ok, unavailable } = await runGeneration(designId, approvedVersion, {
        clearSelectionOnSuccess: false,
      });

      if (ok) {
        await repo.setProjectStatus(designId, "concepts_ready");
        await repo.updateConversationPhase(designId, "concepts_ready");
        await repo.addMessage(designId, {
          role: "assistant",
          content:
            "Here are three concept directions. Pick the one that feels closest.",
          metadata: { phase: "concepts_ready" },
        });
      } else {
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
      }

      const snapshot = await repo.getProject(designId);
      if (!snapshot) throw new Error("Project not found");
      return snapshot;
    },

    async regenerateAfterRevision(designId, approvedVersionId) {
      if (!approvedVersionId) {
        throw new Error(
          "Cannot generate concepts without an approved design brief",
        );
      }

      const approvedVersion =
        await repo.getDesignBriefVersionById(approvedVersionId);
      if (!approvedVersion || approvedVersion.projectId !== designId) {
        throw new Error(
          "Cannot generate concepts without an approved design brief",
        );
      }

      await repo.setProjectStatus(designId, "generating");
      await repo.updateConversationPhase(designId, "generating");
      await repo.addMessage(designId, {
        role: "assistant",
        content:
          "Updating your concepts to match the changes — generating three new directions...",
        metadata: { phase: "generating" },
      });

      // Preserve Sprint 1 simulated latency for UX validation.
      await sleep(1400);

      const { ok, unavailable } = await runGeneration(designId, approvedVersion, {
        clearSelectionOnSuccess: true,
      });

      if (ok) {
        await repo.setProjectStatus(designId, "concepts_ready");
        await repo.updateConversationPhase(designId, "concepts_ready");
        await repo.addMessage(designId, {
          role: "assistant",
          content:
            "Here are three updated concept directions. Pick the one that feels closest.",
          metadata: { phase: "concepts_ready" },
        });
      } else {
        // Unlike the very first generation, concepts already exist here —
        // a failed regeneration should never take away what the customer
        // could already see (Constitution §14: revisions continue the same
        // design relationship, they don't restart it).
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

      const snapshot = await repo.getProject(designId);
      if (!snapshot) throw new Error("Project not found");
      return snapshot;
    },

    describeConceptStatus(brief, artworkVersions, designBriefVersions) {
      return describeConceptStatus(brief, artworkVersions, designBriefVersions);
    },
  };
}

/**
 * Marks the persisted `lastError` of an unavailable-configuration failure,
 * so a later call (e.g. after `MAX_GENERATION_ATTEMPTS` is exhausted) can
 * tell it apart from an ordinary transient provider failure without a
 * dedicated persisted column — see `wasUnavailableFailure`. Sprint 2H Part
 * 1B: generic across every `GenerationUnavailableSafeErrorCode` (missing
 * provider credentials, production-unsafe asset storage, ...) — the prefix
 * itself is the marker; the actual code that follows it is
 * `error.safeErrorCode`, never hardcoded to one specific failure class.
 */
const UNAVAILABLE_ERROR_PREFIX = "GENERATION_UNAVAILABLE:";

/**
 * Sanitized, non-secret description of a generation failure, safe to store
 * as `GenerationJob.lastError` (internal only — never surfaced through
 * `ProjectSnapshot` or the conversation). `ProviderError` already carries a
 * customer-safe message; anything else is reduced to its classification
 * only, so a raw provider error (which could contain request details) is
 * never persisted verbatim.
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

function wasUnavailableFailure(lastError: string | null): boolean {
  return lastError !== null && lastError.startsWith(UNAVAILABLE_ERROR_PREFIX);
}

/**
 * Standalone pure implementation (exported separately from the capability
 * closure so it's directly unit-testable without a repo/provider).
 */
export function describeConceptStatus(
  brief: TShirtDesignBrief,
  artworkVersions: ArtworkVersion[],
  designBriefVersions: DesignBriefVersion[],
): ConceptStatusView {
  if (artworkVersions.length === 0 || designBriefVersions.length === 0) {
    return {
      status: "none",
      message: "No concepts have been generated yet.",
      currentConcepts: [],
      previousBatches: [],
    };
  }

  const latestApproved = designBriefVersions[designBriefVersions.length - 1]!;
  const currentConcepts = artworkVersions.filter(
    (artwork) => artwork.designBriefVersionId === latestApproved.id,
  );

  const versionOrder = new Map(
    designBriefVersions.map((version, index) => [version.id, index]),
  );
  const otherVersionIds = [
    ...new Set(
      artworkVersions
        .filter((artwork) => artwork.designBriefVersionId !== latestApproved.id)
        .map((artwork) => artwork.designBriefVersionId)
        .filter((id): id is string => id !== null),
    ),
  ].sort((a, b) => (versionOrder.get(b) ?? -1) - (versionOrder.get(a) ?? -1));
  const previousBatches = otherVersionIds.map((id) =>
    artworkVersions.filter((artwork) => artwork.designBriefVersionId === id),
  );

  if (currentConcepts.length === 0) {
    // Defensive — every generation path ties its batch to the version it
    // just approved, so this should not happen in practice.
    return {
      status: "none",
      message: "No concepts have been generated yet.",
      currentConcepts: [],
      previousBatches,
    };
  }

  // Compare the working brief against the exact content that was approved
  // for the current batch, using the same field↔section diffing Revision
  // Intelligence uses — a synthetic brief built from the snapshot content
  // is enough since diffing only reads those fields.
  const approvedAsBrief: TShirtDesignBrief = { ...brief, ...latestApproved.content };
  const changedSinceApproval = diffBriefSections(approvedAsBrief, brief);
  const stale = isConceptRelevantChange(changedSinceApproval);

  return stale
    ? {
        status: "needs_update",
        message: "Your recent changes affect these concepts.",
        currentConcepts,
        previousBatches,
      }
    : {
        status: "current",
        message: "These concepts reflect your latest approved design.",
        currentConcepts,
        previousBatches,
      };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
