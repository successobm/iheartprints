/**
 * Sprint 2H Part 2B: provider-neutral configuration for the independent
 * generation worker — the scheduler layer and the protected worker
 * endpoint, never the generation business logic itself (that stays in
 * `GenerationWorkerCapability`, config-free).
 *
 * Pure and side-effect-free (no logging, no process access beyond reading
 * `process.env`), mirroring `generation-provider-config.ts` and
 * `asset-storage-config.ts` — trivially testable, and every unrecognized or
 * invalid value falls back to a safe default rather than throwing.
 */

const DEFAULT_MAX_GENERATION_JOBS_PER_RUN = 5;
const DEFAULT_WORKER_HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * Raw `WORKER_SECRET` value, trimmed. `null` when unset/blank — callers
 * decide what that means (see `capabilities/worker-scheduler/worker-auth`).
 * Never logged, never echoed back in a response.
 */
export function getWorkerSecret(): string | null {
  const raw = process.env.WORKER_SECRET?.trim();
  return raw ? raw : null;
}

/**
 * Production must never run the worker endpoint without a real configured
 * secret — mirrors `getConceptGenerationConfig`'s "outside production is
 * lenient, production fails closed" split.
 */
export function isWorkerSecretRequired(): boolean {
  return process.env.NODE_ENV === "production";
}

/**
 * How many jobs a single worker run (one HTTP call, one scheduler tick, one
 * standalone-process loop iteration) processes before stopping — even if
 * more are still queued. Keeps one run bounded and fast rather than an
 * unbounded drain that could starve concurrent invocations or run past a
 * request timeout.
 */
export function getMaxGenerationJobsPerRun(): number {
  return parsePositiveInt(
    process.env.MAX_GENERATION_JOBS_PER_RUN,
    DEFAULT_MAX_GENERATION_JOBS_PER_RUN,
  );
}

/**
 * Interval, in milliseconds, at which a worker actively running a job
 * touches that job's heartbeat — independent of how long any single
 * provider call takes, so a long-running generation never looks abandoned
 * to a recovery sweep. Also used as the default wake interval for the
 * in-process scheduler tick (`GenerationSchedulerCapability.start`).
 */
export function getWorkerHeartbeatIntervalMs(): number {
  return parsePositiveInt(
    process.env.WORKER_HEARTBEAT_INTERVAL,
    DEFAULT_WORKER_HEARTBEAT_INTERVAL_MS,
  );
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const trimmed = raw?.trim();
  if (!trimmed) return fallback;
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}
