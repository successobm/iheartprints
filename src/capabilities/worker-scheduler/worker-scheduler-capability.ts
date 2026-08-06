import type { GenerationWorkerCapability } from "@/capabilities/generation-worker";
import { DEFAULT_STALE_JOB_MS } from "@/capabilities/generation-worker";
import { getMaxGenerationJobsPerRun } from "@/lib/config/worker-config";

/**
 * Sprint 2H Part 2B: provider-neutral scheduler layer.
 *
 * Deliberately thin — every line here is orchestration (recover, claim in a
 * bounded loop, stop) never generation. `GenerationWorkerCapability`
 * remains the single place that knows how to actually run a job; this
 * module only decides *when* and *how many times* to ask it to.
 *
 * The same instance works unmodified across all three deployment
 * topologies:
 *   - inside the web process: `runBatch()` invoked once per call to the
 *     protected worker endpoint (`POST /api/worker/generation`).
 *   - from a scheduled endpoint: identical — the caller is just an external
 *     cron (e.g. a DigitalOcean Scheduled Job) instead of a person.
 *   - from a standalone worker process: `start()` runs `runBatch()` on a
 *     timer with no HTTP layer at all (see `scripts/run-generation-worker.ts`).
 */

export interface GenerationSchedulerRunResult {
  /** IDs of jobs actually claimed and run during this batch — internal only, never returned by the HTTP endpoint. */
  processedJobIds: string[];
  /** How many previously-abandoned jobs this batch's recovery sweep flipped back to recoverable. */
  recoveredCount: number;
  /** `true` if the batch stopped because it hit `MAX_GENERATION_JOBS_PER_RUN`, not because the queue was empty. */
  limitReached: boolean;
}

export interface GenerationSchedulerOptions {
  /** Defaults to `getMaxGenerationJobsPerRun()` — override only for tests. */
  maxJobsPerRun?: number;
  /** Defaults to `DEFAULT_STALE_JOB_MS` — override only for tests. */
  staleAfterMs?: number;
}

export interface GenerationSchedulerCapability {
  /**
   * Recovers abandoned jobs, then claims and runs up to `maxJobsPerRun`
   * queued/recoverable jobs, stopping early the moment the queue is empty.
   * Safe to call concurrently with itself — an overlapping call joins the
   * batch already in flight rather than starting a second one, which is
   * the scheduler's concurrency limit within one process (the cross-process
   * limit comes from `ProjectRepository.claimNextQueuedJob`'s atomic
   * claim — see that module).
   */
  runBatch(): Promise<GenerationSchedulerRunResult>;
  /**
   * Wakes the worker on a fixed interval (default: `DEFAULT_SCHEDULER_TICK_MS`)
   * until `stop()` is called. Idempotent — calling `start()` while already
   * running is a no-op. Deliberately keeps the process alive (no `unref`)
   * — this is the standalone-worker-process topology's entire job (see
   * `scripts/run-generation-worker.ts`); the protected worker endpoint and
   * tests never call `start()`, they call `runBatch()` once and are
   * responsible for calling `stop()` if they ever do use it.
   */
  start(intervalMs?: number): void;
  /** Stops the interval cleanly. Safe to call even if not running. */
  stop(): void;
  isRunning(): boolean;
}

const DEFAULT_SCHEDULER_TICK_MS = 5_000;

export function createGenerationSchedulerCapability(
  worker: GenerationWorkerCapability,
  options: GenerationSchedulerOptions = {},
): GenerationSchedulerCapability {
  const maxJobsPerRun = options.maxJobsPerRun ?? getMaxGenerationJobsPerRun();
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_JOB_MS;

  let activeBatch: Promise<GenerationSchedulerRunResult> | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  async function doRunBatch(): Promise<GenerationSchedulerRunResult> {
    const { recoveredCount } = await worker.recoverAbandonedJobs(staleAfterMs);

    const processedJobIds: string[] = [];
    for (let i = 0; i < maxJobsPerRun; i += 1) {
      const { processedJobId } = await worker.processNextJob();
      if (!processedJobId) break;
      processedJobIds.push(processedJobId);
    }

    return {
      processedJobIds,
      recoveredCount,
      limitReached: processedJobIds.length >= maxJobsPerRun,
    };
  }

  function runBatch(): Promise<GenerationSchedulerRunResult> {
    if (!activeBatch) {
      activeBatch = doRunBatch().finally(() => {
        activeBatch = null;
      });
    }
    return activeBatch;
  }

  function start(intervalMs: number = DEFAULT_SCHEDULER_TICK_MS): void {
    if (timer) return;
    timer = setInterval(() => {
      void runBatch().catch((error: unknown) => {
        console.error("[worker-scheduler] batch tick failed", error);
      });
    }, intervalMs);
  }

  function stop(): void {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  function isRunning(): boolean {
    return timer !== null;
  }

  return { runBatch, start, stop, isRunning };
}
