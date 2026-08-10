import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import type { ProjectRepository } from "@/lib/db/repository";
import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";
import { runAdaptiveInterviewToSummary } from "@/test-support/run-adaptive-interview";

/**
 * Live acceptance failure, 2026-08-08 (project aa1fd354): approving a
 * design brief persisted `DesignBriefVersion` v1, moved the conversation to
 * `brief_approved`, and set the project to `approved` — then failed before
 * any `GenerationJob` existed. Approval and enqueue are separate writes
 * with no shared transaction, and the repository exposes no transaction
 * primitive, so that intermediate state is durable.
 *
 * The state it left behind was terminal. Nothing polls a project that never
 * reached `generating`, so no recovery path could ever run, and pressing
 * Approve again took the "already approved" branch — which inferred
 * "generation was requested" from "a brief version exists" and returned a
 * snapshot without enqueueing anything.
 *
 * These tests pin the two properties that make that unrecoverable state
 * impossible: a retry completes the interrupted approval exactly once, and
 * no message ever promises generation that was not actually requested.
 */
describe("ConversationCapability — approval interrupted before enqueue", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-enqueue-recovery-"));
    process.chdir(tempDir);
  });

  after(async () => {
    const { drainCapabilityGraphForTests } = await import(
      "@/capabilities/composition"
    );
    await drainCapabilityGraphForTests();
    await cleanupTempWorkspace(tempDir, previousCwd);
  });

  /**
   * Mimics a Supabase/PostgREST rejection precisely: a plain object, not an
   * `Error`. The original incident was `PGRST204` — `createGenerationJob`
   * writing a column that did not exist in the database.
   */
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
   * Fails the first `createGenerationJob` call and passes every other call
   * through untouched, so the failure lands exactly where it did live:
   * after the brief version is durable, before the job exists.
   */
  function withEnqueueFailingOnce(repo: ProjectRepository): ProjectRepository {
    let shouldFail = true;

    return new Proxy(repo, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver) as unknown;
        if (typeof value !== "function") return value;

        const method = value.bind(target) as (
          ...args: unknown[]
        ) => Promise<unknown>;

        if (property !== "createGenerationJob") return method;

        return async (...args: unknown[]) => {
          if (shouldFail) {
            shouldFail = false;
            throw postgrestRejection();
          }
          return method(...args);
        };
      },
    }) as ProjectRepository;
  }

  async function approvalInterruptedBeforeEnqueue() {
    const { resetCapabilityGraphForTests, createCapabilityGraph } =
      await import("@/capabilities/composition");
    resetCapabilityGraphForTests();

    const { getProjectRepository } = await import("@/lib/db");
    const repo = getProjectRepository();
    const graph = createCapabilityGraph(withEnqueueFailingOnce(repo));

    const { projectId } = await runAdaptiveInterviewToSummary(
      graph.conversation,
    );

    await assert.rejects(() =>
      graph.conversation.submitDesignBriefDecision(projectId, "approve"),
    );

    return { graph, conversation: graph.conversation, repo, projectId };
  }

  it("leaves an approved brief with no generation job — the state the retry has to repair", async () => {
    const { repo, projectId } = await approvalInterruptedBeforeEnqueue();

    const stranded = await repo.getProject(projectId);
    assert.equal(stranded?.designBriefVersions.length, 1);
    assert.equal(stranded?.artworkVersions.length, 0);
    assert.equal(stranded?.conversation.phase, "brief_approved");
    assert.equal((await repo.listGenerationJobs(projectId)).length, 0);
  });

  it("never acknowledges generation that was not requested", async () => {
    const { repo, projectId } = await approvalInterruptedBeforeEnqueue();

    // The failed request must not leave a durable promise behind. Any such
    // message survives the error and is replayed on every later read, so
    // the customer is told concepts are coming while nothing is queued.
    const stranded = await repo.getProject(projectId);
    for (const message of stranded?.messages ?? []) {
      assert.doesNotMatch(
        message.content,
        /creating|generating/i,
        `acknowledged generation with no job queued: ${message.content}`,
      );
    }
  });

  it("recovers on retry: exactly one job, and repeated approvals never add another", async () => {
    const { graph, conversation, repo, projectId } =
      await approvalInterruptedBeforeEnqueue();

    const retried = await conversation.submitDesignBriefDecision(
      projectId,
      "approve",
    );

    assert.equal(retried.conversation.phase, "generating");
    assert.equal(retried.project.status, "generating");
    // The interrupted approval is completed, never redone.
    assert.equal(retried.designBriefVersions.length, 1);

    const [job, ...extraJobs] = await repo.listGenerationJobs(projectId);
    assert.equal(extraJobs.length, 0);
    assert.equal(job?.status, "queued");
    assert.equal(job?.kind, "initial");
    assert.equal(job?.conceptCount, 3);

    // Now that a job exists, the customer is told so.
    const announcement = retried.messages.at(-1);
    assert.equal(announcement?.role, "assistant");
    assert.match(announcement?.content ?? "", /generating three concept/i);

    // An impatient customer pressing Approve again must not queue a second
    // batch against the same approved brief version.
    await conversation.submitDesignBriefDecision(projectId, "approve");
    await conversation.submitDesignBriefDecision(projectId, "approve");

    const jobsAfterRepeats = await repo.listGenerationJobs(projectId);
    assert.equal(jobsAfterRepeats.length, 1);
    assert.equal(jobsAfterRepeats[0]?.id, job?.id);

    // Recovery enqueues; it never runs generation inside the request.
    assert.equal(graph.workerScheduler.hasActiveBatch(), false);
  });

  it("repairs itself on snapshot load, since the Approve control is gone once the phase moves past the summary", async () => {
    const { repo, projectId } = await approvalInterruptedBeforeEnqueue();

    const { getConversation } = await import(
      "@/lib/services/conversation-service"
    );
    const reloaded = await getConversation(projectId);

    assert.equal(reloaded?.project.status, "generating");
    assert.equal(reloaded?.conversation.phase, "generating");

    const jobs = await repo.listGenerationJobs(projectId);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0]?.status, "queued");

    // Reloading again must not queue a second batch.
    await getConversation(projectId);
    assert.equal((await repo.listGenerationJobs(projectId)).length, 1);
  });

  it("never re-queues a job that already failed and gave up, however often the project is loaded", async () => {
    const { repo, projectId } = await approvalInterruptedBeforeEnqueue();

    const { getConversation } = await import(
      "@/lib/services/conversation-service"
    );
    await getConversation(projectId);

    const [job] = await repo.listGenerationJobs(projectId);
    assert.ok(job);
    await repo.updateGenerationJob(job.id, {
      status: "failed",
      attempts: 3,
      lastError: "provider unavailable",
    });

    // Recovery keys off "no job at all", not "no running job" — otherwise a
    // burned-out job would restart generation on every page load.
    await getConversation(projectId);
    await getConversation(projectId);

    const jobs = await repo.listGenerationJobs(projectId);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0]?.status, "failed");
    assert.equal(jobs[0]?.attempts, 3);
  });

  it("a project can never hold an approved brief, no concepts, and no job after a successful decision", async () => {
    const { conversation, repo, projectId } =
      await approvalInterruptedBeforeEnqueue();

    await conversation.submitDesignBriefDecision(projectId, "approve");

    const snapshot = await repo.getProject(projectId);
    const jobs = await repo.listGenerationJobs(projectId);
    const approvedWithNothingInFlight =
      (snapshot?.designBriefVersions.length ?? 0) > 0 &&
      snapshot?.artworkVersions.length === 0 &&
      jobs.length === 0;

    assert.equal(approvedWithNothingInFlight, false);
  });
});
