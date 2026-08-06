/**
 * Sprint 2H Part 2B: best-effort defense against secret-guessing against
 * the protected worker endpoint.
 *
 * Single-instance, in-memory only — a horizontally-scaled deployment would
 * need a shared store (e.g. a database row, Redis) for a real cross-instance
 * guarantee. This still meaningfully slows a single attacker hitting one
 * instance, which is the realistic threat model for a worker endpoint that
 * is never linked from anywhere customer-facing. Kept in its own module
 * (rather than inline in the route) so the route file only exports the
 * HTTP methods Next.js expects from a `route.ts`.
 */
const WINDOW_MS = 60_000;
const MAX_FAILURES_PER_WINDOW = 20;

let windowStart = Date.now();
let failureCount = 0;

/**
 * Records one failed-auth attempt against the current window. Returns
 * `true` once the window's failure budget is exhausted — the caller should
 * respond `429` instead of `401` for the rest of the window.
 */
export function registerWorkerAuthFailure(): boolean {
  const now = Date.now();
  if (now - windowStart >= WINDOW_MS) {
    windowStart = now;
    failureCount = 0;
  }
  failureCount += 1;
  return failureCount > MAX_FAILURES_PER_WINDOW;
}

/** Test-only: reset rate-limiter state between isolated test runs. */
export function resetWorkerAuthRateLimiterForTests(): void {
  windowStart = Date.now();
  failureCount = 0;
}
