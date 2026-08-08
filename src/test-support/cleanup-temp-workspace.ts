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
 * Automated tests must await worker batches (see
 * `shouldAwaitGenerationWorkerBatch` + `IHEARTPRINTS_AUTOMATED_TEST`).
 * Interactive `next dev` may detach `runBatch()`; tests must not, or
 * Windows teardown hits EBUSY on the temp cwd while the local store is
 * still being written.
 *
 * This helper does not import `composition` — that module graph is heavy
 * and evaluating it from unrelated suite teardowns (while cwd is a temp
 * dir) can leave extra Windows handles. Worker-route tests drain the
 * graph explicitly before calling this.
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
