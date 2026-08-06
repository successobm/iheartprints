import { removeTempDir } from "./remove-temp-dir";

/**
 * Shared `after` lifecycle for suites that `mkdtemp` + `process.chdir` into
 * an isolated workspace. Order matters on Windows:
 *
 * 1. Drain the local-store mutex (queued read/write of sprint1-store.json).
 * 2. Restore `process.cwd()` so the temp dir is no longer the process cwd.
 * 3. Drop capability-graph + repository singletons that reference that store.
 * 4. `removeTempDir` with bounded EBUSY/EPERM/ENOTEMPTY retries.
 *
 * Sprint 2H Part 2B: generation no longer runs as an in-process
 * fire-and-forget task (see `capabilities/worker-scheduler/`), so there is
 * nothing background left to drain before the local store is touched —
 * every test that needs a job to run now awaits it directly (a worker's
 * `processNextJob`/`runBatch`, or the worker route).
 *
 * Does not swallow persistent cleanup failures.
 */
export async function cleanupTempWorkspace(
  tempDir: string,
  previousCwd: string,
): Promise<void> {
  const { drainLocalStoreMutexForTests } = await import("@/lib/db/local-store");
  await drainLocalStoreMutexForTests();

  process.chdir(previousCwd);

  const { resetCapabilityGraphForTests } = await import(
    "@/capabilities/composition"
  );
  resetCapabilityGraphForTests();

  const { resetProjectRepositoryForTests } = await import("@/lib/db");
  resetProjectRepositoryForTests();

  await removeTempDir(tempDir);
}
