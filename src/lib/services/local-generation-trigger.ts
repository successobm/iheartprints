import { getCapabilityGraph } from "@/capabilities/composition";
import type { GenerationSchedulerRunResult } from "@/capabilities/worker-scheduler";
import { isAutomatedTestEnvironment } from "@/lib/config/automated-test-safety";
import {
  decideLocalGenerationTrigger,
  type LocalGenerationTriggerDecision,
} from "@/lib/config/local-generation-trigger-policy";
import { getProjectRepository } from "@/lib/db";

/**
 * Interactive-local convenience: after a GenerationJob is durably queued,
 * kick `workerScheduler.runBatch()` in-process so `next dev` does not wait
 * on a second terminal or a manual `POST /api/worker/generation`.
 *
 * Not an HTTP self-fetch: localhost origin/port and `WORKER_SECRET` auth
 * are the protected worker route's concern. This helper runs the same
 * scheduler the route would run after auth, inside the web process.
 *
 * Production and automated tests must never take this path — see
 * `local-generation-trigger-policy.ts`. Exceptions are logged and never
 * thrown to the customer request.
 */

/** Bumped when the live helper changes — proves whether `next dev` loaded this file. */
export const LOCAL_GENERATION_TRIGGER_CODE_VERSION =
  "local-generation-trigger-v2-stranded-recovery";

export type LocalGenerationTriggerReason =
  | "approve_brief"
  | "regenerate_concepts"
  | "conversation_message"
  | "status_poll"
  | "project_reload";

export interface LocalGenerationTriggerInput {
  projectId: string;
  reason: LocalGenerationTriggerReason;
  /**
   * Test-only policy override. When omitted, live `NODE_ENV` +
   * `IHEARTPRINTS_AUTOMATED_TEST` decide. Production callers must not pass
   * this.
   */
  policy?: LocalGenerationTriggerDecision;
}

export interface LocalGenerationTriggerResult {
  attempted: boolean;
  accepted: boolean;
  decision: LocalGenerationTriggerDecision;
  batchAlreadyActive: boolean;
  batchPromise: Promise<GenerationSchedulerRunResult> | null;
  /** Present only when a trigger joined an already-active batch. */
  followUpPromise: Promise<GenerationSchedulerRunResult> | null;
}

export function maybeTriggerLocalGenerationWorker(
  input: LocalGenerationTriggerInput,
): LocalGenerationTriggerResult {
  const decision =
    input.policy ?? decideLocalGenerationTrigger();

  logTrigger("generation job queued — local trigger attempted", {
    projectId: input.projectId,
    reason: input.reason,
    decision: describeDecision(decision),
    triggerCodeVersion: LOCAL_GENERATION_TRIGGER_CODE_VERSION,
  });

  if (!decision.allowed) {
    logTrigger("local trigger rejected", {
      projectId: input.projectId,
      reason: input.reason,
      decision: describeDecision(decision),
      batchAlreadyActive: false,
      triggerCodeVersion: LOCAL_GENERATION_TRIGGER_CODE_VERSION,
    });
    return {
      attempted: true,
      accepted: false,
      decision,
      batchAlreadyActive: false,
      batchPromise: null,
      followUpPromise: null,
    };
  }

  try {
    const graph = getCapabilityGraph();
    const batchAlreadyActive = graph.workerScheduler.hasActiveBatch();
    logTrigger("local trigger accepted", {
      projectId: input.projectId,
      reason: input.reason,
      decision: "accepted",
      batchAlreadyActive,
      triggerCodeVersion: LOCAL_GENERATION_TRIGGER_CODE_VERSION,
    });

    const batchPromise = graph.workerScheduler.runBatch();
    void batchPromise
      .then((result) => {
        logTrigger("local trigger batch progressed", {
          projectId: input.projectId,
          reason: input.reason,
          batchAlreadyActive,
          claimedJobIds: result.processedJobIds,
          recoveredCount: result.recoveredCount,
          limitReached: result.limitReached,
          triggerCodeVersion: LOCAL_GENERATION_TRIGGER_CODE_VERSION,
        });
      })
      .catch((error: unknown) => {
        console.error("[local-generation-trigger] batch failed", error);
      });

    // The joined batch may already have finished its claim loop before this
    // job was persisted. One follow-up tick (interactive-dev only) picks up
    // the newly queued job without changing claim order.
    const followUpPromise = batchAlreadyActive
      ? batchPromise.then(() => graph.workerScheduler.runBatch())
      : null;
    if (followUpPromise) {
      void followUpPromise
        .then((followUpResult) => {
          logTrigger("local trigger follow-up batch progressed", {
            projectId: input.projectId,
            reason: input.reason,
            claimedJobIds: followUpResult.processedJobIds,
            triggerCodeVersion: LOCAL_GENERATION_TRIGGER_CODE_VERSION,
          });
        })
        .catch((error: unknown) => {
          console.error(
            "[local-generation-trigger] follow-up batch failed",
            error,
          );
        });
    }

    return {
      attempted: true,
      accepted: true,
      decision,
      batchAlreadyActive,
      batchPromise,
      followUpPromise,
    };
  } catch (error) {
    console.error("[local-generation-trigger] trigger invocation failed", error);
    return {
      attempted: true,
      accepted: false,
      decision,
      batchAlreadyActive: false,
      batchPromise: null,
      followUpPromise: null,
    };
  }
}

/**
 * Interactive `next dev` only: if this project has a never-claimed queued
 * job (`status=queued`, `attempts=0`), kick the in-process scheduler.
 * Covers a missed post-enqueue trigger or a stale `next dev` module after
 * hot reload. Production and automated tests no-op. Does not change claim
 * order — `claimNextQueuedJob` still takes the oldest queued/recoverable
 * job globally. Never throws.
 */
export async function maybeRecoverStrandedLocalGenerationJobs(
  projectId: string,
  reason: Extract<LocalGenerationTriggerReason, "status_poll" | "project_reload">,
  policy?: LocalGenerationTriggerDecision,
): Promise<LocalGenerationTriggerResult | null> {
  const decision = policy ?? decideLocalGenerationTrigger();
  if (!decision.allowed) {
    logTrigger("stranded recovery skipped by policy", {
      projectId,
      reason,
      decision: describeDecision(decision),
      triggerCodeVersion: LOCAL_GENERATION_TRIGGER_CODE_VERSION,
    });
    return null;
  }

  try {
    const jobs = await getProjectRepository().listGenerationJobs(projectId);
    const stranded = jobs.filter(
      (job) => job.status === "queued" && job.attempts === 0,
    );
    if (stranded.length === 0) return null;

    logTrigger("stranded queued job recovery considered", {
      projectId,
      reason,
      jobIds: stranded.map((job) => job.id),
      attempts: stranded.map((job) => job.attempts),
      triggerCodeVersion: LOCAL_GENERATION_TRIGGER_CODE_VERSION,
    });

    return maybeTriggerLocalGenerationWorker({
      projectId,
      reason,
      policy: decision,
    });
  } catch (error) {
    console.error("[local-generation-trigger] stranded recovery failed", error);
    return null;
  }
}

function describeDecision(decision: LocalGenerationTriggerDecision): string {
  return decision.allowed ? "accepted" : `rejected:${decision.reason}`;
}

function logTrigger(
  message: string,
  details: Record<string, unknown>,
): void {
  if (!shouldLogTrigger()) return;
  console.info(`[local-generation-trigger] ${message}`, details);
}

function shouldLogTrigger(): boolean {
  if (process.env.LOCAL_GENERATION_TRIGGER_LOG === "1") return true;
  return (
    process.env.NODE_ENV === "development" && !isAutomatedTestEnvironment()
  );
}
