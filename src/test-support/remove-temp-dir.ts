import { rm } from "node:fs/promises";

/**
 * Windows can briefly keep a temp directory locked after Node closes file
 * handles (AV scanners, directory indexing). Retry only those transient
 * codes with short exponential backoff — never swallow a persistent failure.
 */
const RETRYABLE_CODES = new Set(["EBUSY", "EPERM", "ENOTEMPTY"]);
// Sprint 2F's adaptive interview — and Sprint 2G Part 2's revision loop on
// top of it — drive many more read/write cycles per test (each turn
// rewrites the whole local JSON store several times), which made the
// original, tighter retry budget insufficient against transient Windows
// locks (AV scanners, indexing) on the temp directory right after a test
// finishes writing to it.
const MAX_ATTEMPTS = 40;
const INITIAL_DELAY_MS = 25;
const MAX_DELAY_MS = 600;

function isRetryable(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" && RETRYABLE_CODES.has(code);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Asynchronously remove a temp directory with bounded retries for Windows races. */
export async function removeTempDir(dirPath: string): Promise<void> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await rm(dirPath, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      if (!isRetryable(error) || attempt === MAX_ATTEMPTS) {
        throw error;
      }
      const waitMs = Math.min(
        INITIAL_DELAY_MS * 2 ** (attempt - 1),
        MAX_DELAY_MS,
      );
      await delay(waitMs);
    }
  }

  throw lastError;
}
