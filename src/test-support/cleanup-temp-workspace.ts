import { removeTempDir } from "./remove-temp-dir";

/**
 * Shared `after` lifecycle for suites that `mkdtemp` + `process.chdir` into
 * an isolated workspace. Order matters on Windows:
 *
 * 1. Drain fire-and-forget generation workers (may still be writing).
 * 2. Drain the local-store mutex (queued read/write of sprint1-store.json).
 * 3. Restore `process.cwd()` so the temp dir is no longer the process cwd.
 * 4. Drop capability-graph + repository singletons that reference that store.
 * 5. `removeTempDir` with bounded EBUSY/EPERM/ENOTEMPTY retries.
 *
 * Does not swallow persistent cleanup failures.
 */
export async function cleanupTempWorkspace(
  tempDir: string,
  previousCwd: string,
): Promise<void> {
  const { drainGenerationWorkersForTests } = await import(
    "@/lib/services/conversation-service"
  );
  await drainGenerationWorkersForTests();

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
