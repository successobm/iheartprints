/**
 * Sprint 2H Part 1: small, pure retry helper shared by anything that talks
 * to an external generation provider. No provider knowledge lives here —
 * callers decide what counts as retryable and how long to wait.
 */

export interface RetryOptions {
  /** Total attempts, including the first — not "retries after the first". */
  attempts: number;
  isRetryable: (error: unknown) => boolean;
  /** 1-indexed attempt number that just failed → delay before the next try. */
  delayMs?: (attempt: number) => number;
  /** Injectable for tests — defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  const { attempts, isRetryable, delayMs = () => 0, sleep = defaultSleep } =
    options;

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      if (attempt === attempts || !isRetryable(error)) {
        throw error;
      }
      await sleep(delayMs(attempt));
    }
  }
  // Unreachable — the loop always either returns or throws — but keeps
  // TypeScript satisfied without an unsafe assertion.
  throw lastError;
}
