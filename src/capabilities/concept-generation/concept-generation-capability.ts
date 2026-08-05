import type { ProjectRepository } from "@/lib/db/repository";
import type {
  ArtworkVersion,
  DesignBriefVersion,
  ProjectSnapshot,
  TShirtDesignBrief,
} from "@/lib/domain/types";
import { diffBriefSections } from "@/capabilities/shared/brief-diff";
import { isConceptRelevantChange } from "@/capabilities/shared/concept-relevance";
import type { ConceptStatusView } from "@/capabilities/shared/contracts";

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
   * Sprint 2H Part 2A: this now ONLY enqueues a durable `GenerationJob` and
   * returns immediately — the customer never waits on a synchronous
   * provider call. Actual generation runs in `GenerationWorkerCapability`,
   * out of band; the returned snapshot reflects "generating", not the
   * finished result. Idempotent the same way Part 1 was: calling this
   * again while a job is already in flight (or already succeeded) is a
   * safe no-op rather than a duplicate job/message.
   */
  generatePlaceholders(
    designId: string,
    approvedVersionId: string,
  ): Promise<ProjectSnapshot>;
  /**
   * Sprint 2G Part 2: generates a fresh batch of concepts after a
   * post-approval revision made the existing ones stale. Same approval
   * guard and enqueue-only behavior as `generatePlaceholders`, but
   * continues artwork version numbering from the existing count instead of
   * guarding on "no concepts yet" — prior concepts are never deleted
   * (Constitution §6.11, Version Everything), just superseded by a newer
   * batch tied to the newer approved brief version. Idempotent the same
   * way: calling it again for a version that already has concepts does not
   * duplicate them. Clearing any prior concept selection happens once the
   * new batch actually completes, not at enqueue time.
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
  providerKey: string,
): ConceptGenerationCapability {
  function buildIdempotencyKey(
    designId: string,
    approvedVersionId: string,
  ): string {
    return `concept-generation:${designId}:${approvedVersionId}`;
  }

  /**
   * Enqueues (or resumes enqueueing) a generation job for one approved
   * brief version and returns immediately — never calls a provider, never
   * uploads an asset. `kind` records which customer-facing flow this is,
   * so the worker can later choose the right completion/failure message
   * and post-success side effect without staying coupled to this call.
   */
  async function enqueue(
    designId: string,
    approvedVersionId: string,
    kind: "initial" | "regeneration",
  ): Promise<ProjectSnapshot> {
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

    const idempotencyKey = buildIdempotencyKey(designId, approvedVersion.id);
    let job = await repo.getGenerationJobByIdempotencyKey(
      designId,
      idempotencyKey,
    );

    const current = await repo.getProject(designId);
    if (!current) throw new Error("Project not found");

    const alreadyGenerated = current.artworkVersions.some(
      (artwork) => artwork.designBriefVersionId === approvedVersion.id,
    );
    if (alreadyGenerated) {
      // Idempotent: concepts already exist for this version — nothing to
      // enqueue. Reconcile a lagging job record if one exists, but don't
      // touch messages/status; whatever completed this already posted them.
      if (job && job.status !== "completed") {
        await repo.updateGenerationJob(job.id, {
          status: "completed",
          completedAt: new Date().toISOString(),
        });
      }
      return current;
    }

    let shouldAnnounce = false;

    if (!job) {
      job = await repo.createGenerationJob(designId, {
        designBriefVersionId: approvedVersion.id,
        kind,
        conceptCount: 3,
        providerKey,
        idempotencyKey,
      });
      shouldAnnounce = true;
    } else if (job.status === "failed") {
      if (job.attempts >= MAX_GENERATION_ATTEMPTS) {
        // Gave up — the customer already saw why. Re-queuing endlessly
        // would just retry a provider that has already failed repeatedly;
        // a genuinely new attempt needs a genuinely new approved version.
        return current;
      }
      await repo.updateGenerationJob(job.id, { status: "queued" });
      shouldAnnounce = true;
    }
    // Otherwise the job is already queued/running/recoverable — already
    // announced when it was first enqueued; nothing new to say here.

    if (shouldAnnounce) {
      await repo.setProjectStatus(designId, "generating");
      await repo.updateConversationPhase(designId, "generating");
      await repo.addMessage(designId, {
        role: "assistant",
        content:
          kind === "initial"
            ? "Design brief approved — generating three concept directions..."
            : "Updating your concepts to match the changes — generating three new directions...",
        metadata: { phase: "generating" },
      });
    }

    const snapshot = await repo.getProject(designId);
    if (!snapshot) throw new Error("Project not found");
    return snapshot;
  }

  return {
    describeProvider() {
      return providerKey;
    },

    generatePlaceholders(designId, approvedVersionId) {
      return enqueue(designId, approvedVersionId, "initial");
    },

    regenerateAfterRevision(designId, approvedVersionId) {
      return enqueue(designId, approvedVersionId, "regeneration");
    },

    describeConceptStatus(brief, artworkVersions, designBriefVersions) {
      return describeConceptStatus(brief, artworkVersions, designBriefVersions);
    },
  };
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
