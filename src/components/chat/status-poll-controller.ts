/**
 * Shared read-only background-status poller used by ChatApp for both
 * concept generation (Sprint 2H) and print-ready finalization.
 *
 * Extracted so the mount → cleanup → mount Strict Mode sequence, project
 * changes, terminal-state stop, and error budget can be unit-tested without
 * a DOM renderer (this repo's tests are `node:test` + `renderToString`).
 *
 * Purely a timer + fetch coordinator. It never enqueues work, never claims
 * jobs, and never calls a provider — polling only answers "what should the
 * customer see right now".
 */

export const DEFAULT_STATUS_POLL_INTERVAL_MS = 3000;
export const DEFAULT_STATUS_POLL_MAX_CONSECUTIVE_ERRORS = 10;

export interface StatusPollControllerOptions<TStatus extends string> {
  /** Keep polling while the lightweight status endpoint reports this value. */
  inProgressStatus: TStatus;
  pollStatus: () => Promise<TStatus | null>;
  refreshSnapshot: () => Promise<void>;
  intervalMs?: number;
  maxConsecutiveErrors?: number;
}

export interface StatusPollController {
  /**
   * Call once per effect invocation. Returns the cleanup for that same
   * invocation — return it directly from `useEffect`.
   */
  start(): () => void;
}

export function createStatusPollController<TStatus extends string>(
  options: StatusPollControllerOptions<TStatus>,
): StatusPollController {
  const intervalMs = options.intervalMs ?? DEFAULT_STATUS_POLL_INTERVAL_MS;
  const maxConsecutiveErrors =
    options.maxConsecutiveErrors ?? DEFAULT_STATUS_POLL_MAX_CONSECUTIVE_ERRORS;

  return {
    start() {
      let cancelled = false;
      let inFlight = false;
      let consecutiveErrors = 0;

      const stop = () => {
        cancelled = true;
        clearInterval(interval);
      };

      const tick = async () => {
        if (cancelled || inFlight) return;
        inFlight = true;
        try {
          const status = await options.pollStatus();
          if (cancelled) return;
          consecutiveErrors = 0;
          if (status === null) {
            stop();
            return;
          }
          if (status !== options.inProgressStatus) {
            await options.refreshSnapshot();
            if (!cancelled) stop();
          }
        } catch {
          consecutiveErrors += 1;
          if (!cancelled && consecutiveErrors >= maxConsecutiveErrors) {
            stop();
          }
        } finally {
          inFlight = false;
        }
      };

      const interval = setInterval(() => {
        void tick();
      }, intervalMs);

      return stop;
    },
  };
}
