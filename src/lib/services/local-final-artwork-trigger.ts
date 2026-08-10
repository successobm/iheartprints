import { getCapabilityGraph } from "@/capabilities/composition";
import type { FinalArtworkSchedulerRunResult } from "@/capabilities/worker-scheduler";
import { isAutomatedTestEnvironment } from "@/lib/config/automated-test-safety";
import {
  decideLocalGenerationTrigger,
  type LocalGenerationTriggerDecision,
} from "@/lib/config/local-generation-trigger-policy";
import { getProjectRepository } from "@/lib/db";

/**
 * Interactive-local convenience: after a FinalArtworkJob is durably queued,
 * kick `finalArtworkScheduler.runBatch()` in-process so `next dev` does not
 * wait on a second terminal or a manual `POST /api/worker/final-artwork`.
 *
 * Mirrors `local-generation-trigger.ts` for the final-artwork queue. Not an
 * HTTP self-fetch: localhost origin/port and `WORKER_SECRET` auth are the
 * protected worker route's concern. This helper runs the same scheduler the
 * route would run after auth, inside the web process.
 *
 * Production and automated tests must never take this path — shared
 * suppression policy in `local-generation-trigger-policy.ts` (environment-
 * scoped, not generation-specific). Exceptions are logged and never thrown
 * to the customer request. Worker claim/execution still owns approval
 * staleness, source eligibility, and paid-provider decisions.
 */

/** Bumped when the live helper changes — proves whether `next dev` loaded this file. */
export const LOCAL_FINAL_ARTWORK_TRIGGER_CODE_VERSION =
  "local-final-artwork-trigger-v1";

export type LocalFinalArtworkTriggerReason =
  | "approve_final_direction"
  | "status_poll"
  | "project_reload";

export interface LocalFinalArtworkTriggerInput {
  projectId: string;
  reason: LocalFinalArtworkTriggerReason;
  /**
   * Test-only policy override. When omitted, live `NODE_ENV` +
   * `IHEARTPRINTS_AUTOMATED_TEST` decide. Production callers must not pass
   * this.
   */
  policy?: LocalGenerationTriggerDecision;
}

export interface LocalFinalArtworkTriggerResult {
  attempted: boolean;
  accepted: boolean;
  decision: LocalGenerationTriggerDecision;
  batchAlreadyActive: boolean;
  batchPromise: Promise<FinalArtworkSchedulerRunResult> | null;
  /** Present only when a trigger joined an already-active batch. */
  followUpPromise: Promise<FinalArtworkSchedulerRunResult> | null;
}

export function maybeTriggerLocalFinalArtworkWorker(
  input: LocalFinalArtworkTriggerInput,
): LocalFinalArtworkTriggerResult {
  const decision = input.policy ?? decideLocalGenerationTrigger();

  logTrigger("final artwork job queued — local trigger attempted", {
    projectId: input.projectId,
    reason: input.reason,
    decision: describeDecision(decision),
    triggerCodeVersion: LOCAL_FINAL_ARTWORK_TRIGGER_CODE_VERSION,
  });

  if (!decision.allowed) {
    logTrigger("local trigger rejected", {
      projectId: input.projectId,
      reason: input.reason,
      decision: describeDecision(decision),
      batchAlreadyActive: false,
      triggerCodeVersion: LOCAL_FINAL_ARTWORK_TRIGGER_CODE_VERSION,
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
    const batchAlreadyActive = graph.finalArtworkScheduler.hasActiveBatch();
    logTrigger("local trigger accepted", {
      projectId: input.projectId,
      reason: input.reason,
      decision: "accepted",
      batchAlreadyActive,
      triggerCodeVersion: LOCAL_FINAL_ARTWORK_TRIGGER_CODE_VERSION,
    });

    const batchPromise = graph.finalArtworkScheduler.runBatch();
    void batchPromise
      .then((result) => {
        logTrigger("local trigger batch progressed", {
          projectId: input.projectId,
          reason: input.reason,
          batchAlreadyActive,
          claimedJobIds: result.processedJobIds,
          recoveredCount: result.recoveredCount,
          limitReached: result.limitReached,
          triggerCodeVersion: LOCAL_FINAL_ARTWORK_TRIGGER_CODE_VERSION,
        });
      })
      .catch((error: unknown) => {
        console.error("[local-final-artwork-trigger] batch failed", error);
      });

    // The joined batch may already have finished its claim loop before this
    // job was persisted. One follow-up tick (interactive-dev only) picks up
    // the newly queued job without changing claim order.
    const followUpPromise = batchAlreadyActive
      ? batchPromise.then(() => graph.finalArtworkScheduler.runBatch())
      : null;
    if (followUpPromise) {
      void followUpPromise
        .then((followUpResult) => {
          logTrigger("local trigger follow-up batch progressed", {
            projectId: input.projectId,
            reason: input.reason,
            claimedJobIds: followUpResult.processedJobIds,
            triggerCodeVersion: LOCAL_FINAL_ARTWORK_TRIGGER_CODE_VERSION,
          });
        })
        .catch((error: unknown) => {
          console.error(
            "[local-final-artwork-trigger] follow-up batch failed",
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
    console.error(
      "[local-final-artwork-trigger] trigger invocation failed",
      error,
    );
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
 * Interactive `next dev` only: if this project is still `finalizing` with a
 * never-claimed FinalArtworkJob (`queued`, `attempts=0`) behind an active
 * FinalDirectionApproval, kick the in-process final-artwork scheduler.
 * Covers a missed post-enqueue trigger or a stale `next dev` module after
 * hot reload. Production and automated tests no-op. Does not change claim
 * order, does not revive failed/cancelled/completed jobs, and never
 * increments attempts itself — `claimNextQueuedFinalArtworkJob` owns that.
 * Never throws.
 */
export async function maybeRecoverStrandedLocalFinalArtworkJobs(
  projectId: string,
  reason: Extract<
    LocalFinalArtworkTriggerReason,
    "status_poll" | "project_reload"
  >,
  policy?: LocalGenerationTriggerDecision,
): Promise<LocalFinalArtworkTriggerResult | null> {
  const decision = policy ?? decideLocalGenerationTrigger();
  if (!decision.allowed) {
    logTrigger("stranded recovery skipped by policy", {
      projectId,
      reason,
      decision: describeDecision(decision),
      triggerCodeVersion: LOCAL_FINAL_ARTWORK_TRIGGER_CODE_VERSION,
    });
    return null;
  }

  try {
    const repo = getProjectRepository();
    const snapshot = await repo.getProject(projectId);
    if (!snapshot || snapshot.project.status !== "finalizing") {
      return null;
    }

    const approval = await repo.getActiveFinalDirectionApproval(projectId);
    if (!approval) return null;

    const job = await repo.getFinalArtworkJobByApprovalId(
      projectId,
      approval.id,
    );
    if (!job || job.status !== "queued" || job.attempts !== 0) {
      return null;
    }

    logTrigger("stranded queued final-artwork job recovery considered", {
      projectId,
      reason,
      jobId: job.id,
      attempts: job.attempts,
      triggerCodeVersion: LOCAL_FINAL_ARTWORK_TRIGGER_CODE_VERSION,
    });

    return maybeTriggerLocalFinalArtworkWorker({
      projectId,
      reason,
      policy: decision,
    });
  } catch (error) {
    console.error(
      "[local-final-artwork-trigger] stranded recovery failed",
      error,
    );
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
  console.info(`[local-final-artwork-trigger] ${message}`, details);
}

function shouldLogTrigger(): boolean {
  if (process.env.LOCAL_FINAL_ARTWORK_TRIGGER_LOG === "1") return true;
  return (
    process.env.NODE_ENV === "development" && !isAutomatedTestEnvironment()
  );
}
