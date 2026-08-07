/**
 * Release-blocker hotfix (Sprint 2M Phase 2E follow-up): a single,
 * centralized signal that the current process is an automated test run —
 * checked by every provider-RESOLUTION function capable of handing back a
 * real, paid, network-backed provider instance (Topaz final-artwork
 * reconstruction, OpenAI concept generation, OpenAI concept evaluation,
 * OpenAI conversation understanding).
 *
 * Why this exists: `resolveFinalArtworkProvider()` /
 * `resolveConceptGenerationProvider()` / etc. read live `process.env` by
 * design when called with no argument — that is correct and required for
 * real runtime traffic (composition must be configuration-driven, never
 * hardcoded; see `capability-boundaries.ts`). It is also exactly how
 * `composition.ts`'s `createCapabilityGraph()` builds the REAL capability
 * graph `getCapabilityGraph()` exposes as a process-wide singleton. A
 * handful of route/service tests legitimately exercise that real singleton
 * to prove route wiring (e.g.
 * `src/app/api/projects/[projectId]/production-artwork/image/route.test.ts`
 * calls `graph.finalArtworkWorker.processNextJob()` directly). If
 * `.env.local` — or any ambient shell/CI environment the developer's
 * terminal happens to carry — has live paid-provider credentials configured
 * at that moment (as this repository's own `.env.local` does today, for
 * legitimate manual/live-acceptance testing), those tests would silently
 * make a REAL, PAID, NETWORK call. This is exactly what happened: two real
 * Topaz Transparency Upscale calls were made by `npm run verify` because
 * `FINAL_ARTWORK_PROVIDER=topaz` + a real `TOPAZ_API_KEY` were present in
 * the ambient environment when those two tests ran.
 *
 * The fix is not "remember to unset paid-provider env vars before testing"
 * — that is exactly the failure mode this module exists to make
 * impossible. Instead: every provider-resolution function's *implicit,
 * no-argument, live-environment* path is guarded by
 * `isAutomatedTestEnvironment()`. When true, the resolver returns its safe
 * local/placeholder/none provider unconditionally — regardless of what
 * `process.env` says. A caller that passes an EXPLICIT config (as this
 * codebase's own resolver unit tests do, to test the resolution logic
 * itself in isolation) is completely unaffected — nothing about how those
 * functions decide between `"topaz"`/`"openai"`/`"placeholder"` changed.
 *
 * `isAutomatedTestEnvironment()` is `true` only when
 * `IHEARTPRINTS_AUTOMATED_TEST=1` is set. That variable is set exactly
 * once, as early as possible, by `test-support/test-safety-bootstrap.ts` —
 * registered as a Node `--import` preload ahead of every test file in
 * `package.json`'s `test` script. No individual test file sets it, no
 * developer has to remember it, and it cannot be omitted by forgetting to
 * edit `.env.local` — it is baked into the test *invocation* itself.
 */
const AUTOMATED_TEST_ENV_VAR = "IHEARTPRINTS_AUTOMATED_TEST";

export function isAutomatedTestEnvironment(): boolean {
  return process.env[AUTOMATED_TEST_ENV_VAR] === "1";
}

/** Exported for the bootstrap module and this module's own regression test only — never read directly by application code, which should call `isAutomatedTestEnvironment()` instead. */
export const AUTOMATED_TEST_SAFETY_ENV_VAR = AUTOMATED_TEST_ENV_VAR;
