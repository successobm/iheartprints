import type { RasterReconstructionWorkerCapability } from "@/capabilities/artwork-reconstruction";
import { DEFAULT_ARTWORK_RECONSTRUCTION_STALE_JOB_MS } from "@/capabilities/artwork-reconstruction";
import { getMaxGenerationJobsPerRun } from "@/lib/config/worker-config";

/**
 * Phase R5: provider-neutral scheduler layer for `ArtworkReconstructionJob`
 * — mirrors `FinalArtworkSchedulerCapability` exactly (recover, then claim
 * in a bounded loop, then stop), the same deliberate near-duplicate this
 * codebase already prefers over one shared generic scheduler (independent
 * job table, independent claim method, independent worker capability).
 */

export interface ArtworkReconstructionSchedulerRunResult {
  processedJobIds: string[];
  recoveredCount: number;
  limitReached: boolean;
}

export interface ArtworkReconstructionSchedulerOptions {
  maxJobsPerRun?: number;
  staleAfterMs?: number;
}

export interface ArtworkReconstructionSchedulerCapability {
  runBatch(): Promise<ArtworkReconstructionSchedulerRunResult>;
  hasActiveBatch(): boolean;
  start(intervalMs?: number): void;
  stop(): void;
  isRunning(): boolean;
}

const DEFAULT_SCHEDULER_TICK_MS = 5_000;

export function createArtworkReconstructionSchedulerCapability(
  worker: RasterReconstructionWorkerCapability,
  options: ArtworkReconstructionSchedulerOptions = {},
): ArtworkReconstructionSchedulerCapability {
  const maxJobsPerRun = options.maxJobsPerRun ?? getMaxGenerationJobsPerRun();
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_ARTWORK_RECONSTRUCTION_STALE_JOB_MS;

  let activeBatch: Promise<ArtworkReconstructionSchedulerRunResult> | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  async function doRunBatch(): Promise<ArtworkReconstructionSchedulerRunResult> {
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

  function runBatch(): Promise<ArtworkReconstructionSchedulerRunResult> {
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
        console.error("[artwork-reconstruction-scheduler] batch tick failed", error);
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
