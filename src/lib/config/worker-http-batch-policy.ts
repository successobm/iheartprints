import { isAutomatedTestEnvironment } from "./automated-test-safety";

export interface GenerationWorkerHttpBatchPolicyInput {
  nodeEnv: string | undefined;
  automatedTest: boolean;
}

/**
 * Pure policy: whether `POST /api/worker/generation` must `await runBatch()`
 * before returning `{ ok: true }`.
 *
 * - Production: always await (DigitalOcean/Next request lifecycle).
 * - Automated tests: always await so teardown does not rmdir a temp cwd
 *   while the local store is still being written (Windows EBUSY).
 * - Interactive `next dev` only: may detach for a fast manual HTTP response.
 */
export function resolveAwaitGenerationWorkerBatch(
  input: GenerationWorkerHttpBatchPolicyInput,
): boolean {
  return input.nodeEnv === "production" || input.automatedTest;
}

/**
 * Live policy from `NODE_ENV` + existing `IHEARTPRINTS_AUTOMATED_TEST`.
 * No extra env var.
 */
export function shouldAwaitGenerationWorkerBatch(): boolean {
  return resolveAwaitGenerationWorkerBatch({
    nodeEnv: process.env.NODE_ENV,
    automatedTest: isAutomatedTestEnvironment(),
  });
}
