import {
  FreeConceptAlreadyConsumedError,
  type ProjectRepository,
} from "@/lib/db/repository";
import type {
  ArtworkVersion,
  DesignBriefVersion,
  ProjectSnapshot,
  TShirtDesignBrief,
} from "@/lib/domain/types";
import {
  createAcquisitionCapability,
  FREE_CONCEPT_WAITING_MESSAGE,
  PAID_GENERATION_LOCKED_MESSAGE,
  type AcquisitionCapability,
} from "@/capabilities/acquisition";
import {
  createIpSafetyCapability,
  describeIpSafetyDecisionForCustomer,
  type IpSafetyCapability,
} from "@/capabilities/ip-safety";
import { diffBriefSections } from "@/capabilities/shared/brief-diff";
import { groupConceptBatches } from "@/capabilities/shared/concept-batches";
import { isConceptRelevantChange } from "@/capabilities/shared/concept-relevance";
import type { ConceptStatusView } from "@/capabilities/shared/contracts";
import { MAX_GENERATION_ATTEMPTS } from "@/capabilities/shared/generation-retry-policy";
import {
  ALTERNATIVE_CONCEPTS_WAITING_MESSAGE,
  INITIAL_CONCEPTS_WAITING_MESSAGE,
  NEW_CONCEPT_BATCH_WAITING_MESSAGE,
  TARGETED_REVISION_WAITING_MESSAGE,
} from "@/capabilities/shared/waiting-copy";

/**
 * Sprint 2H Part 1: a job that has failed this many times gives up asking
 * the provider again on its own — the customer has to explicitly retry
 * (ask again, or press the same button) rather than the platform looping
 * silently. Chosen small so a genuinely broken provider fails fast instead
 * of stalling the conversation across several turns.
 *
 * Sprint 2H Part 2B: the budget itself now lives in
 * `shared/generation-retry-policy` so `GenerationWorkerCapability`'s
 * recovery path enforces the exact same cap — see that module's doc
 * comment for why a single shared constant matters here.
 */

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
   * Sprint 2G Live Acceptance Corrective Pass: the default post-selection
   * revision operation — a targeted revision of ONE customer-selected
   * concept, producing exactly one new concept (never three unrelated
   * directions). The new concept is tagged `sourceArtworkVersionId =
   * sourceArtworkVersionId` and generated in that source's own
   * `conceptDirectionKey`. Same approval guard and enqueue-only behavior as
   * `generatePlaceholders`/`regenerateAfterRevision`. Distinct from
   * `regenerateAfterRevision`, which remains the explicit "show me a few
   * alternatives" three-direction operation — see Constitution §14 and
   * ARCHITECTURE.md.
   */
  /**
   * Live Acceptance Cleanup (Issue 3): "Show Me 3 New Concepts" — a fresh
   * batch of three creative directions from the SAME already-approved
   * Design Brief version.
   *
   * The middle option between "select one of these three" and "Start Over":
   * the customer dislikes every current direction, but the brief (product,
   * color, placement, required wording, subject, constraints) is right, so
   * restarting the project would throw away work that is perfectly good.
   * Never approves a new brief version, never mutates the brief, never
   * infers a selection or a final approval.
   *
   * Distinct from `regenerateAfterRevision`, which exists for the opposite
   * situation — the brief CHANGED and the existing batch is now stale.
   * That path is idempotent per approved version by design; this one
   * deliberately adds a batch to a version that already has one, so it
   * carries its own per-batch idempotency (an exploration already in flight
   * for this version is never duplicated by a second click).
   *
   * Prior batches are never deleted — they stay selectable through Design
   * History, exactly like every other superseded batch.
   */
  exploreNewConceptBatch(
    designId: string,
    approvedVersionId: string,
  ): Promise<ProjectSnapshot>;
  reviseSelectedConcept(
    designId: string,
    approvedVersionId: string,
    sourceArtworkVersionId: string,
    /**
     * True Source-Image Targeted Revision: the customer's literal
     * instruction ("make the border red and change it to a shield"),
     * persisted on the `GenerationJob` so the worker can express the
     * requested DELTA to an image-edit provider. The approved brief records
     * design state and can never say "change it to a shield". Optional so
     * existing call sites (and recovery paths with no instruction to hand)
     * stay valid — a `null` delta still produces a real edit of the source
     * artwork, just without specific change instructions.
     */
    revisionInstruction?: string | null,
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
  /**
   * Sprint A3 — THE ENQUEUE FENCE.
   *
   * This capability is enqueue-only and never calls a provider, which is
   * precisely why the fence belongs here: no `GenerationJob` means no worker
   * claim, which means no paid provider call, structurally rather than by
   * policy. Every generation path in the product (initial, three-direction
   * alternatives, additional exploration batch, targeted revision) funnels
   * through the two functions below, so one fence covers all of them.
   *
   * Defaults to a fresh pure instance rather than being required: a call
   * site that forgets to pass it gets the boundary anyway, which is the
   * correct direction for a safety fence to fail.
   */
  ipSafety: IpSafetyCapability = createIpSafetyCapability(),
  /**
   * Sprint A4 — THE ACQUISITION FENCE, in the same place and for the same
   * structural reason as the IP fence above.
   *
   * This capability is enqueue-only. No `GenerationJob` means no worker
   * claim, which means no paid provider call — so refusing here refuses
   * spend by construction rather than by policy. All four generation paths
   * (initial, three-direction alternatives, additional exploration batch,
   * targeted revision) funnel through the two enqueue functions below, so
   * one fence covers every one of them, including a direct API call that
   * skips the UI entirely (Goal 17).
   *
   * It resolves authority from the PROJECT, never from the request, which
   * is why nothing about request context has to be threaded down here.
   *
   * Defaults to a fresh instance for the same reason `ipSafety` does: a
   * call site that forgets to pass one still gets the boundary.
   */
  acquisition: AcquisitionCapability = createAcquisitionCapability(repo),
): ConceptGenerationCapability {
  /**
   * Evaluates the STRUCTURED generation intent — the approved brief version's
   * generation-bearing design content plus this request's literal revision
   * instruction — never the conversation transcript. Re-scanning old turns
   * here would both resurrect requests the customer already retracted and
   * miss design content that arrived structurally.
   *
   * Correction 2: the fields are composed into ONE canonical subject by
   * `ip-safety/safety-subject.ts`, the same construction
   * `GenerationWorkerCapability` uses, so a request split across fields
   * ("Raiders" in the description, "use the exact shield" in the notes) is
   * seen the way the prompt translator will see it — and the two fences
   * cannot drift.
   *
   * Returns the customer-facing redirect when generation must not proceed.
   */
  function refuseUnsafeGeneration(
    approvedContent: DesignBriefVersion["content"],
    revisionInstruction: string | null,
  ): string | null {
    const decision = ipSafety.evaluateGenerationIntent({
      designDescription: approvedContent.designDescription,
      designStyle: approvedContent.designStyle,
      additionalInstructions: approvedContent.additionalInstructions,
      exclusions: approvedContent.exclusions,
      revisionInstruction,
    });
    return describeIpSafetyDecisionForCustomer(decision);
  }

  /**
   * Posts a customer-safe refusal and returns the unchanged project.
   * Shared by the IP fence and the acquisition fence: both refuse BEFORE
   * any job row exists, so in both cases there is nothing for a worker to
   * claim and no paid provider call is reachable.
   */
  async function announceGenerationRefusal(
    designId: string,
    content: string,
  ): Promise<ProjectSnapshot> {
    const current = await repo.getProject(designId);
    if (!current) throw new Error("Project not found");

    // Sprint A4: idempotent. A refused revision leaves a pending-revision
    // authority with no job behind it, which is exactly the state
    // `ConversationCapability.recoverInterruptedGenerationRequest` tries to
    // repair — on every project read. Without this guard each reload would
    // re-attempt the enqueue, be refused again, and append another
    // identical refusal, so a customer who left the tab open would come
    // back to the same sentence a dozen times.
    //
    // Saying it once is also simply the honest amount: nothing changed
    // between reads, so there is nothing new to tell them.
    if (current.messages.at(-1)?.content === content) return current;

    await repo.addMessage(designId, {
      role: "assistant",
      content,
      // Generic metadata for the same reason the conversational gate uses
      // generic metadata: `ProjectSnapshot.messages` is client-visible.
      metadata: { phase: current.conversation.phase, act: "acknowledge" },
    });
    const snapshot = await repo.getProject(designId);
    if (!snapshot) throw new Error("Project not found");
    return snapshot;
  }

  /**
   * Sprint A4 Correction 2: has this job already put a request in front of a
   * paid image provider?
   *
   * Read from `paid_image_intents.dispatches`, which is incremented by the
   * conditional write that AUTHORIZES a dispatch — before the provider is
   * contacted, never after. So a non-zero count means "a request may have
   * reached the provider and may have been billed", which is exactly the
   * fact that must not be retried on the free path, and is deliberately
   * stronger than "a provider call returned successfully".
   *
   * Fails CLOSED: an unreadable ledger is treated as dispatched. The safe
   * direction for a spend question is always the one that does not submit
   * again.
   */
  async function hasDispatchedPaidImage(job: {
    id: string;
    projectId: string;
  }): Promise<boolean> {
    try {
      const intents = await repo.listPaidImageIntentsForJob(
        job.projectId,
        job.id,
      );
      return intents.some((intent) => intent.dispatches > 0);
    } catch {
      return true;
    }
  }

  function buildIdempotencyKey(
    designId: string,
    approvedVersionId: string,
  ): string {
    return `concept-generation:${designId}:${approvedVersionId}`;
  }

  /**
   * Live Acceptance Cleanup (Issue 3): identity for the Nth exploration
   * batch of one approved brief version. `batchOrdinal` is always >= 2 here
   * (the first batch owns the unsuffixed key above), so this can never
   * collide with — or resurrect — the original batch's job.
   */
  function buildAdditionalBatchIdempotencyKey(
    designId: string,
    approvedVersionId: string,
    batchOrdinal: number,
  ): string {
    return `${buildIdempotencyKey(designId, approvedVersionId)}:batch-${batchOrdinal}`;
  }

  /** Exploration jobs (never targeted revisions) for one approved brief version. */
  async function listExplorationJobs(
    designId: string,
    approvedVersionId: string,
  ) {
    const jobs = await repo.listGenerationJobs(designId);
    return jobs.filter(
      (job) =>
        job.designBriefVersionId === approvedVersionId &&
        !job.targetArtworkVersionId,
    );
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
    /**
     * Sprint 2G Live Acceptance Corrective Pass: set only for a targeted
     * single-concept revision — generation produces exactly one concept,
     * tagged back to this source, in its own catalog direction. `null`/
     * omitted for initial exploration and explicit "show me alternatives".
     */
    targetArtworkVersionId: string | null = null,
    /**
     * True Source-Image Targeted Revision: the customer's literal requested
     * delta, durable on the job. Only ever set alongside
     * `targetArtworkVersionId` — see `GenerationJob.revisionInstruction`.
     */
    revisionInstruction: string | null = null,
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

    // Sprint A3: refused BEFORE any job row exists, so a blocked request has
    // nothing for a worker to claim and no paid provider call is reachable.
    const refusal = refuseUnsafeGeneration(
      approvedVersion.content,
      revisionInstruction,
    );
    if (refusal) return announceGenerationRefusal(designId, refusal);

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
      // Sprint 2M Phase 2G (Goal 3/4): defensive mirror of the worker's own
      // regeneration-completion clear — a revision batch for this exact
      // brief version already exists, so any pending-revision authority
      // this call was meant to resolve is already resolved.
      if (kind === "regeneration" && current.project.revisionPending) {
        await repo.updateProject(designId, { revisionPending: false });
        const refreshed = await repo.getProject(designId);
        if (refreshed) return refreshed;
      }
      return current;
    }

    let shouldAnnounce = false;
    let freeConcept = false;

    if (!job) {
      // Sprint A4 — THE ACQUISITION FENCE. Deliberately inside `if (!job)`,
      // because only a genuinely NEW job is a new commitment to spend.
      //
      // A job that already exists was authorized when it was created, and
      // resuming it (reload, second tab, duplicate request, retry after a
      // failure, worker reclaim) must never require a second entitlement
      // and must never produce a second paid attempt — what that job may
      // ever spend is already bounded by its own `paid_image_intents`
      // budget and by `MAX_GENERATION_ATTEMPTS`. Re-authorizing here would
      // instead refuse a customer's legitimate retry of work they have
      // already paid for with their one free concept.
      const authorization = await acquisition.authorizeConceptGeneration(designId);
      if (!authorization.allowed) {
        return announceGenerationRefusal(designId, authorization.customerMessage);
      }
      freeConcept = authorization.grant === "free_concept";

      // Sprint A4 Correction 1: THE INSERT IS THE AUTHORITY.
      //
      // `authorizeConceptGeneration` above is a pre-check that avoids doing
      // work destined to fail; it is not the guarantee. The guarantee is a
      // partial unique index on `generation_jobs.acquisition_session_id`,
      // which refuses a second free-concept job for this session under real
      // concurrency — including in the window where a previous request's
      // consumption marker was never written.
      //
      // Nothing has been spent when it refuses: no job means nothing for a
      // worker to claim.
      try {
        job = await repo.createGenerationJob(designId, {
          designBriefVersionId: approvedVersion.id,
          kind,
          // Sprint A4: the acquisition entitlement is ONE customer-visible
          // concept, not one batch of three. `conceptCount` already carries
          // that meaning end to end (a targeted revision has used it since
          // the Live Acceptance Corrective Pass), so expressing "one free
          // concept" needs no provider change, no new contract, and no
          // second code path — the same worker, the same prompt translation,
          // the same paid-intent checkpointing, one direction instead of
          // three.
          //
          // Sprint 2G Live Acceptance Corrective Pass: a targeted
          // single-concept revision produces exactly one concept, never
          // three unrelated directions.
          conceptCount: freeConcept || targetArtworkVersionId ? 1 : 3,
          providerKey,
          idempotencyKey,
          targetArtworkVersionId,
          revisionInstruction: targetArtworkVersionId
            ? (revisionInstruction?.trim() || null)
            : null,
          // Sprint A4 Correction 1: this is what makes the row the
          // authority, and it is ALSO what caps the job at one paid image
          // dispatch in the worker (`paidIntentBudgetForGenerationJob`) and
          // bars Phase 2C replacement for it. One column, read from durable
          // job state by a background worker that has no request context.
          acquisitionSessionId: freeConcept ? authorization.sessionId : null,
        });
      } catch (error) {
        // The database refused a second free-concept job for this session.
        // An ordinary, expected outcome — a duplicated request, a second
        // project in the same session, or a retry after a lost consumption
        // marker — not an infrastructure fault, and nothing was spent.
        if (error instanceof FreeConceptAlreadyConsumedError) {
          // Re-asked so the customer gets the TRUE refusal (give us an
          // address vs. this is not sold yet) rather than one guessed here.
          // It resolves the same way it will on the next page load, and the
          // job whose insert was just refused is exactly what makes it now
          // report spent — so the two can never disagree.
          const recheck = await acquisition.authorizeConceptGeneration(designId);
          return announceGenerationRefusal(
            designId,
            recheck.allowed
              ? PAID_GENERATION_LOCKED_MESSAGE
              : recheck.customerMessage,
          );
        }
        throw error;
      }

      // Consumption is MARKED only now, against a job that is already
      // durable. Before this line the entitlement was merely ALLOCATED: if
      // the insert above had failed, the customer would still have their
      // free concept and re-requesting would resume the same allocation
      // (Goal 10 / Goal 11 A+B).
      //
      // Sprint A4 Correction 1: this write is no longer load-bearing. The
      // job row it describes already carries the session id and is already
      // unique per session, so losing this marker cannot produce a second
      // free concept — `AcquisitionCapability` reconciles it from the job.
      // It is kept because "when was it spent, and by which job" is a real
      // question that a reconciliation query answers more slowly and less
      // precisely.
      if (freeConcept && authorization.sessionId) {
        await acquisition.recordFreeConceptConsumed(
          authorization.sessionId,
          job.id,
        );
      }
      shouldAnnounce = true;
    } else if (job.status === "failed") {
      if (job.attempts >= MAX_GENERATION_ATTEMPTS) {
        // Gave up — the customer already saw why. Re-queuing endlessly
        // would just retry a provider that has already failed repeatedly;
        // a genuinely new attempt needs a genuinely new approved version.
        return current;
      }
      // Sprint A4 Correction 2: the acquisition free attempt is ONE physical
      // submission. Once that submission has happened, re-queueing this job
      // achieves nothing and confuses everything: the worker would claim it,
      // be refused by the one-dispatch ceiling before contacting any
      // provider, and fail it again — twice more, since the job attempt
      // budget is three. No money is at risk either way (that is the
      // ceiling's job), but the customer would watch a spinner resolve to
      // the same failure three times.
      //
      // The distinction is PRE-dispatch versus POST-dispatch, read from the
      // durable dispatch counter rather than guessed from the failure text:
      // a configuration error, a safety block, or a reservation that never
      // began leaves `dispatches === 0` and is genuinely retryable, and must
      // not cost the customer their free concept (Goal 4).
      if (job.acquisitionSessionId && (await hasDispatchedPaidImage(job))) {
        return current;
      }
      await repo.updateGenerationJob(job.id, { status: "queued" });
      shouldAnnounce = true;
    }
    // Otherwise the job is already queued/running/recoverable — already
    // announced when it was first enqueued; nothing new to say here.

    if (shouldAnnounce) {
      await announceGenerating(
        designId,
        targetArtworkVersionId
          ? TARGETED_REVISION_WAITING_MESSAGE
          : // Sprint A4: the three-direction copy cannot be reused for a
            // free concept. Promising "three concept directions" and
            // producing one reads as a defect, not as a plan.
            freeConcept
            ? FREE_CONCEPT_WAITING_MESSAGE
            : kind === "initial"
              ? INITIAL_CONCEPTS_WAITING_MESSAGE
              : ALTERNATIVE_CONCEPTS_WAITING_MESSAGE,
      );
    }

    const snapshot = await repo.getProject(designId);
    if (!snapshot) throw new Error("Project not found");
    return snapshot;
  }

  async function announceGenerating(
    designId: string,
    content: string,
  ): Promise<void> {
    await repo.setProjectStatus(designId, "generating");
    await repo.updateConversationPhase(designId, "generating");
    await repo.addMessage(designId, {
      role: "assistant",
      content,
      metadata: { phase: "generating" },
    });
  }

  /**
   * Live Acceptance Cleanup (Issue 3). Deliberately a separate path from
   * `enqueue`: that function's central invariant is "one batch per approved
   * brief version, never duplicated", which is exactly the invariant this
   * feature has to relax. Threading an `additionalBatch` flag through it
   * would have made the flag load-bearing on every existing generation
   * path; keeping them apart leaves initial generation, revision, and
   * stale-batch regeneration byte-for-byte unchanged.
   *
   * Idempotency here is per-project-exploration rather than per-version:
   * while any exploration for this brief version is queued/running/
   * recoverable, a second request is a no-op. That is what makes a double
   * click (or a duplicated request) safe without a dedupe token.
   */
  async function enqueueAdditionalBatch(
    designId: string,
    approvedVersionId: string,
  ): Promise<ProjectSnapshot> {
    if (!approvedVersionId) {
      throw new Error("Cannot generate concepts without an approved design brief");
    }
    const approvedVersion =
      await repo.getDesignBriefVersionById(approvedVersionId);
    if (!approvedVersion || approvedVersion.projectId !== designId) {
      throw new Error("Cannot generate concepts without an approved design brief");
    }

    // Sprint A3: "Show Me 3 New Concepts" re-generates from the SAME approved
    // brief version, so it is exactly as capable of reaching a paid provider
    // as initial generation and gets the same fence.
    const refusal = refuseUnsafeGeneration(approvedVersion.content, null);
    if (refusal) return announceGenerationRefusal(designId, refusal);

    const current = await repo.getProject(designId);
    if (!current) throw new Error("Project not found");

    const explorationJobs = await listExplorationJobs(
      designId,
      approvedVersion.id,
    );
    const inFlight = explorationJobs.some(
      (job) =>
        job.status === "queued" ||
        job.status === "running" ||
        job.status === "recoverable",
    );
    // Idempotent no-op — never a second batch, never a second message.
    if (inFlight || current.project.status === "generating") return current;

    const batchOrdinal = explorationJobs.length + 1;
    const idempotencyKey = buildAdditionalBatchIdempotencyKey(
      designId,
      approvedVersion.id,
      batchOrdinal,
    );

    const existing = await repo.getGenerationJobByIdempotencyKey(
      designId,
      idempotencyKey,
    );
    if (existing) {
      // This exact batch was already requested and reached a terminal state
      // (completed, or failed and given up). Re-queuing it here would
      // re-run a batch the customer has already seen the outcome of.
      return current;
    }

    // Sprint A4 — THE ACQUISITION FENCE, same placement rule as `enqueue`:
    // immediately before a genuinely new job would exist. In practice a
    // prospect always reaches this refused (exploration is only offered
    // once concepts exist, which means the free concept is already spent),
    // but the fence is unconditional rather than assumed — this is a
    // directly callable API route (Goal 17).
    const authorization = await acquisition.authorizeConceptGeneration(designId);
    if (!authorization.allowed) {
      return announceGenerationRefusal(designId, authorization.customerMessage);
    }
    const freeConcept = authorization.grant === "free_concept";

    let job;
    try {
      job = await repo.createGenerationJob(designId, {
        designBriefVersionId: approvedVersion.id,
        kind: "regeneration",
        conceptCount: freeConcept ? 1 : 3,
        providerKey,
        idempotencyKey,
        targetArtworkVersionId: null,
        revisionInstruction: null,
        acquisitionSessionId: freeConcept ? authorization.sessionId : null,
      });
    } catch (error) {
      // Same database authority as `enqueue`. In practice unreachable for a
      // prospect (exploration is only offered once concepts exist, so the
      // pre-check has already refused), but the fence is unconditional
      // rather than assumed — this is a directly callable API route.
      if (error instanceof FreeConceptAlreadyConsumedError) {
        const recheck = await acquisition.authorizeConceptGeneration(designId);
        return announceGenerationRefusal(
          designId,
          recheck.allowed ? PAID_GENERATION_LOCKED_MESSAGE : recheck.customerMessage,
        );
      }
      throw error;
    }

    if (freeConcept && authorization.sessionId) {
      await acquisition.recordFreeConceptConsumed(
        authorization.sessionId,
        job.id,
      );
    }

    await announceGenerating(
      designId,
      freeConcept
        ? FREE_CONCEPT_WAITING_MESSAGE
        : NEW_CONCEPT_BATCH_WAITING_MESSAGE,
    );

    const snapshot = await repo.getProject(designId);
    if (!snapshot) throw new Error("Project not found");
    return snapshot;
  }

  return {
    describeProvider() {
      return providerKey;
    },

    reviseSelectedConcept(
      designId,
      approvedVersionId,
      sourceArtworkVersionId,
      revisionInstruction = null,
    ) {
      return enqueue(
        designId,
        approvedVersionId,
        "regeneration",
        sourceArtworkVersionId,
        revisionInstruction,
      );
    },

    generatePlaceholders(designId, approvedVersionId) {
      return enqueue(designId, approvedVersionId, "initial");
    },

    regenerateAfterRevision(designId, approvedVersionId) {
      return enqueue(designId, approvedVersionId, "regeneration");
    },

    exploreNewConceptBatch(designId, approvedVersionId) {
      return enqueueAdditionalBatch(designId, approvedVersionId);
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

  // Live Acceptance Cleanup (Issue 3): one approved brief version can now
  // own more than one batch — "Show Me 3 New Concepts" adds a second batch
  // of three without changing the brief. Only the NEWEST batch is current;
  // the earlier one is a previous batch, kept and still selectable, exactly
  // like a batch superseded by a brief change.
  const latestVersionBatches = groupConceptBatches(
    artworkVersions.filter(
      (artwork) => artwork.designBriefVersionId === latestApproved.id,
    ),
  );
  const currentConcepts = latestVersionBatches.at(-1) ?? [];
  // Newest first, so an older batch of the current brief version sorts
  // ahead of batches from superseded versions.
  const supersededSameVersionBatches = latestVersionBatches
    .slice(0, -1)
    .reverse();

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
  const previousBatches = [
    ...supersededSameVersionBatches,
    ...otherVersionIds.flatMap((id) =>
      groupConceptBatches(
        artworkVersions.filter((artwork) => artwork.designBriefVersionId === id),
      ).reverse(),
    ),
  ];

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
