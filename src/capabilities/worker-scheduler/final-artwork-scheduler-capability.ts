import type { FinalArtworkWorkerCapability } from "@/capabilities/final-artwork-worker";
import { DEFAULT_FINAL_ARTWORK_STALE_JOB_MS } from "@/capabilities/final-artwork-worker";

/**
 * Sprint 2M Phase 2C: provider-neutral scheduler layer for `FinalArtworkJob`
 * — mirrors `GenerationSchedulerCapability`'s OVERALL shape (recover, then
 * claim), a deliberate near-duplicate rather than a shared generic
 * scheduler, since the two job queues (`generation_jobs`,
 * `final_artwork_jobs`) are independent tables with independent claim
 * methods and independent worker capabilities.
 *
 * One-Job-Per-Invocation Repair (independent-review finding, Bounded
 * FinalArtwork Production-Execution Repair's short-step follow-up): this
 * scheduler DELIBERATELY DIVERGES from `GenerationSchedulerCapability`'s own
 * "claim up to `maxJobsPerRun` jobs in a bounded loop" shape and no longer
 * takes a `maxJobsPerRun` option at all. Audit finding: even after every
 * individual bounded provider step was made short, `runBatch()`'s own loop
 * could still claim and advance SEVERAL DIFFERENT jobs sequentially within
 * ONE HTTP worker invocation (`maxJobsPerRun` defaulted to 5) — each an
 * independent, provider-touching bounded step — reintroducing exactly the
 * "one HTTP request can still run long" risk the short-step split exists to
 * eliminate, just spread across jobs instead of within one. The structural
 * fix is not a smaller configured limit (a knob can always be turned back
 * up, silently reintroducing the risk) but removing the loop itself: one
 * `runBatch()` call recovers abandoned jobs (cheap, no provider I/O), then
 * claims and advances AT MOST ONE eligible job, then returns. A second
 * eligible job waits for a SEPARATE invocation — the immediate wake fired
 * for THAT job's own enqueue, or the next recovery-scheduler tick — never
 * this same HTTP request.
 */

export interface FinalArtworkSchedulerRunResult {
  /** IDs of jobs actually claimed and run during this batch — internal only, never returned by the HTTP endpoint. At most one entry — see this module's own "One-Job-Per-Invocation Repair" doc comment. */
  processedJobIds: string[];
  /** How many previously-abandoned jobs this batch's recovery sweep flipped back to recoverable. */
  recoveredCount: number;
  /**
   * `true` whenever this call actually claimed and advanced a job (i.e.
   * `processedJobIds.length === 1`) — kept, with this adjusted meaning, so
   * existing diagnostic/log call sites (`local-final-artwork-trigger.ts`)
   * that already read this field for logging purposes keep working
   * unchanged. Never gates control flow anywhere in this codebase.
   */
  limitReached: boolean;
}

export interface FinalArtworkSchedulerOptions {
  /** Defaults to `DEFAULT_FINAL_ARTWORK_STALE_JOB_MS` — override only for tests. */
  staleAfterMs?: number;
}

export interface FinalArtworkSchedulerCapability {
  /**
   * Recovers abandoned jobs, then claims and advances AT MOST ONE
   * queued/recoverable job — see this module's own "One-Job-Per-Invocation
   * Repair" doc comment. Safe to call concurrently with itself — an
   * overlapping call joins the batch already in flight rather than
   * starting a second one.
   */
  runBatch(): Promise<FinalArtworkSchedulerRunResult>;
  /**
   * `true` while a `runBatch()` is in flight **in this process**. Process-
   * local dedupe/observability only — mirrors
   * `GenerationSchedulerCapability.hasActiveBatch`. Cross-instance
   * concurrency remains `claimNextQueuedFinalArtworkJob`.
   */
  hasActiveBatch(): boolean;
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
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_FINAL_ARTWORK_STALE_JOB_MS;

  let activeBatch: Promise<FinalArtworkSchedulerRunResult> | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  async function doRunBatch(): Promise<FinalArtworkSchedulerRunResult> {
    const { recoveredCount } = await worker.recoverAbandonedJobs(staleAfterMs);

    // One-Job-Per-Invocation Repair: exactly one claim, never a loop. The
    // pre-existing liveness mechanism this claim's own `excludeJobIds`
    // argument feeds (`claimNextQueuedFinalArtworkJob`'s exclusion of a job
    // this SAME batch already found bounded-pending) has nothing left to do
    // with only one claim per batch — no exclusion list is needed when
    // there is no second claim in this same call to skip a stuck job for —
    // so it is always empty here.
    //
    // Queue Starvation Repair (independent-review finding — CORRECTS a
    // claim this comment used to make): one-job-per-invocation ALONE does
    // NOT guarantee liveness across invocations. Claiming "oldest due" by
    // `createdAt` meant a genuinely provider-pending job (repeatedly
    // reclaimed, its `heartbeatAt` bumped every time, but its `createdAt`
    // frozen at creation forever) stayed the oldest-due candidate on
    // EVERY subsequent invocation — a newer job's own immediate wake would
    // still just reclaim the SAME pending job, never its own, because
    // "oldest due" never changed. Reproduced: 10 consecutive invocations
    // all reclaiming one pending job while a second, newer job never got
    // claimed once. Fairness now lives in `claimNextQueuedFinalArtworkJob`
    // itself: claim order is by LEAST-RECENTLY-TOUCHED (`heartbeatAt`),
    // not literally oldest-created, so claiming a job makes IT the
    // freshest and the next invocation naturally prefers whichever OTHER
    // eligible job has gone longest untouched — see that method's own doc
    // comment for the full reasoning. This scheduler needed no change of
    // its own for that repair; it inherits the fix purely by calling the
    // same claim method it always did.
    const { processedJobId, pending } = await worker.processNextJob([]);
    const processedJobIds = processedJobId ? [processedJobId] : [];
    void pending; // no exclusion list to feed on a later claim within this same batch — see the doc comment above.

    return {
      processedJobIds,
      recoveredCount,
      limitReached: processedJobIds.length > 0,
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

  function hasActiveBatch(): boolean {
    return activeBatch !== null;
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

  return { runBatch, hasActiveBatch, start, stop, isRunning };
}
