/**
 * Phase R5 live-acceptance repair: a tiny single-flight guard for the
 * customer's "Rebuild my artwork" request.
 *
 * WHY THIS EXISTS. The request is synchronous (the route runs one worker
 * batch inline before answering — deliberately unchanged), so it can take a
 * minute or more, and every click is a potentially paid provider call. The
 * `sending` state in `ChatApp` already disables buttons, but React state is
 * read at render time: two clicks landing in the same tick both observe
 * `sending === false`. This guard is a plain closure flag set synchronously
 * BEFORE the first await, so a second `run` while one is in flight never
 * starts a second request at all. (The server independently refuses a
 * duplicate active job for the same source/contract binding — this only
 * stops the customer's browser from sending it.)
 */
export interface SingleFlightGuard {
  /** Runs `task` unless one is already in flight, in which case resolves to `null` without invoking it. */
  run<T>(task: () => Promise<T>): Promise<T | null>;
  readonly inFlight: boolean;
}

export function createSingleFlightGuard(): SingleFlightGuard {
  let inFlight = false;
  return {
    async run<T>(task: () => Promise<T>): Promise<T | null> {
      if (inFlight) return null;
      inFlight = true;
      try {
        return await task();
      } finally {
        inFlight = false;
      }
    },
    get inFlight() {
      return inFlight;
    },
  };
}
