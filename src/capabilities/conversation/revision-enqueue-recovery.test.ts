import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import type { ProjectRepository } from "@/lib/db/repository";
import type { ProjectSnapshot } from "@/lib/domain/types";
import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";
import { runAdaptiveInterviewToSummary } from "@/test-support/run-adaptive-interview";

/**
 * The revision-side twin of `approval-enqueue-recovery.test.ts`, closing the
 * same non-atomic lifecycle window one step later in the flow.
 *
 * `triggerAutomaticRevision` writes the durable pending-revision authority
 * (`PrintProject.revisionPending = true`) and supersedes any active
 * final-direction approval BEFORE the regeneration `GenerationJob` exists.
 * If the enqueue then fails, the project is left permanently barred from
 * finalization — `FinalArtworkCapability.requestFinalArtwork` refuses while
 * `revisionPending` is true, and only a regeneration that actually
 * completes and produces artwork ever clears it. Nothing is running to
 * produce that artwork, and the customer has been told their concept is
 * being updated, so they have no reason to intervene.
 *
 * These tests pin the repair and, just as importantly, its limits: it must
 * never invent a second job, never resurrect a job that already failed and
 * exhausted its retry budget, and never relax the finalization gate while
 * the requested revision is genuinely unresolved.
 */
describe("ConversationCapability — revision interrupted before enqueue", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-revision-recovery-"));
    process.chdir(tempDir);
  });

  after(async () => {
    const { drainCapabilityGraphForTests } = await import(
      "@/capabilities/composition"
    );
    await drainCapabilityGraphForTests();
    await cleanupTempWorkspace(tempDir, previousCwd);
  });

  /** A Supabase/PostgREST rejection: a plain object, never an `Error`. */
  function postgrestRejection(): unknown {
    return {
      code: "PGRST204",
      details: null,
      hint: null,
      message:
        "Could not find the 'target_artwork_version_id' column of 'generation_jobs' in the schema cache",
    };
  }

  /**
   * Lets the initial approval's job through and fails only the revision's,
   * so the failure lands exactly where the hazard is: after
   * `revisionPending` is durable, before the regeneration job exists.
   */
  function withRevisionEnqueueFailing(
    repo: ProjectRepository,
  ): ProjectRepository {
    let created = 0;

    return new Proxy(repo, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver) as unknown;
        if (typeof value !== "function") return value;

        const method = value.bind(target) as (
          ...args: unknown[]
        ) => Promise<unknown>;

        if (property !== "createGenerationJob") return method;

        return async (...args: unknown[]) => {
          created += 1;
          if (created === 2) throw postgrestRejection();
          return method(...args);
        };
      },
    }) as ProjectRepository;
  }

  /**
   * The worker claims the oldest due job across ALL projects, and these
   * tests deliberately leave repaired jobs queued, so "run one job" would
   * run some earlier scenario's leftover instead. Runs jobs until this
   * project reaches the state under test.
   */
  async function runWorkerUntil(
    graph: Awaited<
      ReturnType<
        typeof import("@/capabilities/composition").createCapabilityGraph
      >
    >,
    projectId: string,
    reached: (snapshot: ProjectSnapshot) => boolean,
  ): Promise<ProjectSnapshot> {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const snapshot = await graph.conversation.get(projectId);
      if (snapshot && reached(snapshot)) return snapshot;
      const { processedJobId } = await graph.generationWorker.processNextJob();
      if (!processedJobId) break;
    }
    throw new Error("worker never reached the expected state for this project");
  }

  async function revisionInterruptedBeforeEnqueue() {
    const { resetCapabilityGraphForTests, createCapabilityGraph } =
      await import("@/capabilities/composition");
    resetCapabilityGraphForTests();

    const { getProjectRepository } = await import("@/lib/db");
    const repo = getProjectRepository();
    const graph = createCapabilityGraph(withRevisionEnqueueFailing(repo));

    const { projectId } = await runAdaptiveInterviewToSummary(
      graph.conversation,
    );
    await graph.conversation.submitDesignBriefDecision(projectId, "approve");

    const withConcepts = await runWorkerUntil(
      graph,
      projectId,
      (snapshot) => snapshot.artworkVersions.length === 3,
    );
    const source = withConcepts.artworkVersions[0];
    assert.ok(source);
    const selected = await graph.conversation.selectConcept(projectId, source.id);
    const messagesBeforeRevision = selected.messages.length;

    await assert.rejects(() =>
      graph.conversation.handleUserMessage(projectId, "Actually, make it a hoodie."),
    );

    return {
      graph,
      repo,
      projectId,
      sourceArtworkVersionId: source.id,
      messagesBeforeRevision,
    };
  }

  it("no automated test in this file can reach a paid or networked provider", async () => {
    const { isAutomatedTestEnvironment } = await import(
      "@/lib/config/automated-test-safety"
    );
    const { graph } = await revisionInterruptedBeforeEnqueue();

    assert.equal(isAutomatedTestEnvironment(), true);
    // Every job these tests enqueue is executed by the in-process worker
    // against this provider; "placeholder" is generated locally, so a
    // regression that reached OpenAI/Topaz would change this value rather
    // than silently bill the account.
    assert.equal(graph.conceptGeneration.describeProvider(), "placeholder");
  });

  it("1. leaves revisionPending set with zero regeneration jobs, and never claims the concept is being updated", async () => {
    const { repo, projectId, messagesBeforeRevision } =
      await revisionInterruptedBeforeEnqueue();

    const stranded = await repo.getProject(projectId);
    assert.equal(stranded?.project.revisionPending, true);
    assert.equal(stranded?.artworkVersions.length, 3);
    // The revision's own brief version is durable; its job is not.
    assert.equal(stranded?.designBriefVersions.length, 2);

    const jobs = await repo.listGenerationJobs(projectId);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0]?.kind, "initial");

    // The failed turn must not leave a promise behind: nothing it persisted
    // may claim a revision is under way while nothing is queued. (Earlier
    // messages announcing the initial generation are excluded — that
    // generation really did run.)
    const fromFailedTurn = (stranded?.messages ?? []).slice(
      messagesBeforeRevision,
    );
    assert.ok(fromFailedTurn.length > 0);
    for (const message of fromFailedTurn) {
      assert.doesNotMatch(
        message.content,
        /updating .*concept|generating/i,
        `claimed revision generation with no job queued: ${message.content}`,
      );
    }
  });

  it("2. a project load repairs the missing regeneration job exactly once", async () => {
    const { repo, projectId, sourceArtworkVersionId } =
      await revisionInterruptedBeforeEnqueue();

    const { getConversation } = await import(
      "@/lib/services/conversation-service"
    );
    const reloaded = await getConversation(projectId);

    assert.equal(reloaded?.project.status, "generating");
    // Still pending: only real revised artwork resolves it.
    assert.equal(reloaded?.project.revisionPending, true);

    const jobs = await repo.listGenerationJobs(projectId);
    assert.equal(jobs.length, 2);
    const revision = jobs.find((job) => job.kind === "regeneration");
    assert.ok(revision);
    assert.equal(revision?.status, "queued");
    // A targeted revision of the concept the customer selected — exactly
    // one new concept, in that source's own direction, never three
    // unrelated ones.
    assert.equal(revision?.targetArtworkVersionId, sourceArtworkVersionId);
    assert.equal(revision?.conceptCount, 1);

    // Only now, once the job is durable, is the customer told.
    assert.match(reloaded?.messages.at(-1)?.content ?? "", /updating .*concept/i);
  });

  it("3. repeated loads never duplicate the regeneration job", async () => {
    const { repo, projectId } = await revisionInterruptedBeforeEnqueue();

    const { getConversation } = await import(
      "@/lib/services/conversation-service"
    );
    await getConversation(projectId);
    await getConversation(projectId);
    await getConversation(projectId);

    const jobs = await repo.listGenerationJobs(projectId);
    assert.equal(jobs.length, 2);
    assert.equal(jobs.filter((job) => job.kind === "regeneration").length, 1);

    const keys = new Set(jobs.map((job) => job.idempotencyKey));
    assert.equal(keys.size, jobs.length);
  });

  it("4. never re-queues a regeneration that already failed and exhausted its budget", async () => {
    const { repo, projectId } = await revisionInterruptedBeforeEnqueue();

    const { getConversation } = await import(
      "@/lib/services/conversation-service"
    );
    await getConversation(projectId);

    const revision = (await repo.listGenerationJobs(projectId)).find(
      (job) => job.kind === "regeneration",
    );
    assert.ok(revision);
    await repo.updateGenerationJob(revision.id, {
      status: "failed",
      attempts: 3,
      lastError: "provider unavailable",
    });

    await getConversation(projectId);
    await getConversation(projectId);

    const jobs = await repo.listGenerationJobs(projectId);
    assert.equal(jobs.length, 2);
    const after = jobs.find((job) => job.kind === "regeneration");
    assert.equal(after?.status, "failed");
    assert.equal(after?.attempts, 3);
    // The customer's revision genuinely has not happened, so the pending
    // authority must survive the failure rather than be cleared by it.
    const snapshot = await repo.getProject(projectId);
    assert.equal(snapshot?.project.revisionPending, true);
  });

  it("5. revisionPending stays authoritative — and finalization refuses — until revised artwork exists", async () => {
    const { graph, repo, projectId } = await revisionInterruptedBeforeEnqueue();

    const { getConversation } = await import(
      "@/lib/services/conversation-service"
    );

    const selected = (await repo.getProject(projectId))?.project
      .selectedArtworkVersionId;
    assert.ok(selected);

    // Blocked while stranded...
    await assert.rejects(
      () => graph.finalArtwork.requestFinalArtwork(projectId, selected),
      /revised design needs to be reviewed/i,
    );

    await getConversation(projectId);

    // ...and still blocked once merely enqueued — a queued job is not a
    // revised concept.
    const enqueued = await repo.getProject(projectId);
    assert.equal(enqueued?.project.revisionPending, true);
    await assert.rejects(
      () => graph.finalArtwork.requestFinalArtwork(projectId, selected),
      /revised design needs to be reviewed/i,
    );

    const revised = await runWorkerUntil(
      graph,
      projectId,
      (snapshot) => snapshot.artworkVersions.length === 4,
    );
    assert.equal(revised.project.revisionPending, false);
    const newest = revised.artworkVersions.at(-1);
    assert.equal(newest?.sourceArtworkVersionId, selected);
  });
});
