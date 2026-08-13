import { isAutomatedTestEnvironment } from "./automated-test-safety";

export interface LocalGenerationTriggerPolicyInput {
  nodeEnv: string | undefined;
  automatedTest: boolean;
}

export type LocalGenerationTriggerSuppressionReason =
  | "production"
  | "automated_test";

export type LocalGenerationTriggerDecision =
  | { allowed: true }
  | { allowed: false; reason: LocalGenerationTriggerSuppressionReason };

/**
 * Pure policy: whether interactive local `next dev` may kick an in-process
 * worker scheduler after a durable job enqueue (GenerationJob →
 * `workerScheduler`, FinalArtworkJob → `finalArtworkScheduler`).
 *
 * - Production: never. Scheduler/cron or standalone worker only.
 * - Automated tests (`IHEARTPRINTS_AUTOMATED_TEST=1`): never. Tests stay
 *   isolated from paid/network providers and must await `processNextJob` /
 *   `runBatch` / the worker route explicitly.
 * - Interactive `next dev` only: yes, so Approve/Create Concepts and
 *   Prepare Print-Ready can progress without a second terminal or a
 *   manual PowerShell POST.
 *
 * Environment-scoped, not queue-specific — both local trigger helpers
 * share this decision. Independent of `shouldAwaitGenerationWorkerBatch`
 * (HTTP route lifecycle). No extra env var.
 */
export function resolveLocalGenerationTriggerDecision(
  input: LocalGenerationTriggerPolicyInput,
): LocalGenerationTriggerDecision {
  if (input.nodeEnv === "production") {
    return { allowed: false, reason: "production" };
  }
  if (input.automatedTest) {
    return { allowed: false, reason: "automated_test" };
  }
  return { allowed: true };
}

export function resolveShouldAutoTriggerLocalGenerationWorker(
  input: LocalGenerationTriggerPolicyInput,
): boolean {
  return resolveLocalGenerationTriggerDecision(input).allowed;
}

/** Live policy from `NODE_ENV` + existing `IHEARTPRINTS_AUTOMATED_TEST`. */
export function shouldAutoTriggerLocalGenerationWorker(): boolean {
  return resolveShouldAutoTriggerLocalGenerationWorker({
    nodeEnv: process.env.NODE_ENV,
    automatedTest: isAutomatedTestEnvironment(),
  });
}

export function decideLocalGenerationTrigger(): LocalGenerationTriggerDecision {
  return resolveLocalGenerationTriggerDecision({
    nodeEnv: process.env.NODE_ENV,
    automatedTest: isAutomatedTestEnvironment(),
  });
}
