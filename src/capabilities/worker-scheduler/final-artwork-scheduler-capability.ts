import type { FinalArtworkWorkerCapability } from "@/capabilities/final-artwork-worker";
import { DEFAULT_FINAL_ARTWORK_STALE_JOB_MS } from "@/capabilities/final-artwork-worker";
import { getMaxGenerationJobsPerRun } from "@/lib/config/worker-config";

/**
 * Sprint 2M Phase 2C: provider-neutral scheduler layer for `FinalArtworkJob`
 * — mirrors `GenerationSchedulerCapability` exactly (recover, then claim in
 * a bounded loop, then stop), a deliberate near-duplicate rather than a
 * shared generic scheduler, since the two job queues (`generation_jobs`,
 * `final_artwork_jobs`) are independent tables with independent claim
 * methods and independent worker capabilities. Reuses
 * `MAX_GENERATION_JOBS_PER_RUN`/`getMaxGenerationJobsPerRun` — one shared
 * "how many jobs per invocation" knob is enough; the two worker types are
 * never mixed in the same batch.
 */

export interface FinalArtworkSchedulerRunResult {
  /** IDs of jobs actually claimed and run during this batch — internal only, never returned by the HTTP endpoint. */
  processedJobIds: string[];
  /** How many previously-abandoned jobs this batch's recovery sweep flipped back to recoverable. */
  recoveredCount: number;
  /** `true` if the batch stopped because it hit the per-run job limit, not because the queue was empty. */
  limitReached: boolean;
}

export interface FinalArtworkSchedulerOptions {
  /** Defaults to `getMaxGenerationJobsPerRun()` — override only for tests. */
  maxJobsPerRun?: number;
  /** Defaults to `DEFAULT_FINAL_ARTWORK_STALE_JOB_MS` — override only for tests. */
  staleAfterMs?: number;
}

export interface FinalArtworkSchedulerCapability {
  /**
   * Recovers abandoned jobs, then claims and runs up to `maxJobsPerRun`
   * queued/recoverable jobs, stopping early the moment the queue is empty.
   * Safe to call concurrently with itself — an overlapping call joins the
   * batch already in flight rather than starting a second one.
   */
  runBatch(): Promise<FinalArtworkSchedulerRunResult>;
  /** Wakes the worker on a fixed interval until `stop()` is called. Idempotent. */
  start(intervalMs?: number): void;
  /** Stops the interval cleanly. Safe to call even if not running. */
  stop(): void;
  isRunning(): boolean;
}

const DEFAULT_SCHEDULER_TICK_MS = 5_000;

export function createFinalArtworkSchedulerCapability(
  worker: FinalArtworkWorkerCapability,
  options: FinalArtworkSchedulerOptions = {},
): FinalArtworkSchedulerCapability {
  const maxJobsPerRun = options.maxJobsPerRun ?? getMaxGenerationJobsPerRun();
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_FINAL_ARTWORK_STALE_JOB_MS;

  let activeBatch: Promise<FinalArtworkSchedulerRunResult> | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  async function doRunBatch(): Promise<FinalArtworkSchedulerRunResult> {
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

  function runBatch(): Promise<FinalArtworkSchedulerRunResult> {
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
        console.error("[final-artwork-scheduler] batch tick failed", error);
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
