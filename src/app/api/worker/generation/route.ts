import { NextResponse } from "next/server";

import { getCapabilityGraph } from "@/capabilities/composition";
import {
  registerWorkerAuthFailure,
  verifyWorkerSecret,
} from "@/capabilities/worker-scheduler";
import { shouldAwaitGenerationWorkerBatch } from "@/lib/config/worker-http-batch-policy";

/**
 * Sprint 2H Part 2B: the protected worker endpoint. Server-only, never
 * linked from anywhere customer-facing, and reachable from any of the
 * three supported worker topologies:
 *   - hit on a schedule by an external cron (e.g. a DigitalOcean Scheduled
 *     Job) — the primary production path;
 *   - hit manually/locally during development;
 *   - never used by the standalone worker process, which calls
 *     `GenerationSchedulerCapability` directly with no HTTP layer at all
 *     (see `scripts/run-generation-worker.ts`).
 *
 * Responsibility is deliberately narrow: "run the generation worker once."
 * It never accepts a project id, never returns a job id, a provider name,
 * a queue length, or a stack trace.
 *
 * Production (`NODE_ENV === "production"`): awaits `runBatch()` and returns
 * `{ ok: true }` only after the batch finishes. Detached Promises are not
 * a reliable request lifecycle on DigitalOcean/Next — production must not
 * depend on fire-and-forget work after the response.
 *
 * Automated tests (`IHEARTPRINTS_AUTOMATED_TEST=1`, via test-safety
 * bootstrap): also await `runBatch()`. Detach during `node --test` left
 * local-store writes running after teardown/`process.chdir`, which on
 * Windows locked temp dirs (`EBUSY rmdir`) across parallel suites.
 *
 * Interactive local/`next dev` only: may return after starting/joining the
 * batch without awaiting provider-duration work, so a short manual curl
 * does not look hung while OpenAI runs. Job status remains the source of
 * truth for completion.
 */
export async function POST(request: Request) {
  const timing = createWorkerRouteTiming();
  timing.mark("route entered");

  const provided = extractWorkerSecret(request);
  const auth = verifyWorkerSecret(provided);
  timing.mark("auth checked");

  if (!auth.authorized) {
    const rateLimited = registerWorkerAuthFailure();
    return NextResponse.json(
      { error: rateLimited ? "Too many requests" : "Unauthorized" },
      {
        status: rateLimited ? 429 : 401,
        headers: { "cache-control": "no-store" },
      },
    );
  }
  timing.mark("auth passed");

  try {
    timing.mark("before getCapabilityGraph");
    const graph = getCapabilityGraph();
    timing.mark("after getCapabilityGraph");

    timing.mark("before scheduler/worker invocation");
    const batchAlreadyInFlight = graph.workerScheduler.hasActiveBatch();
    const batchPromise = graph.workerScheduler.runBatch();

    if (shouldAwaitGenerationWorkerBatch()) {
      timing.mark(
        batchAlreadyInFlight
          ? "awaiting joined in-flight batch"
          : "awaiting batch to completion",
      );
      await batchPromise;
      timing.mark("batch completed");
    } else {
      timing.mark(
        batchAlreadyInFlight
          ? "joined in-flight batch (interactive dev: not awaited)"
          : "started batch (interactive dev: not awaited)",
      );
      void batchPromise.catch((error: unknown) => {
        console.error("[worker] generation batch failed", error);
      });
    }

    return NextResponse.json(
      { ok: true },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    // Never forward the error's message/stack — could name a provider,
    // a storage path, or an internal id.
    console.error("[worker] generation batch failed", error);
    return NextResponse.json(
      { error: "Worker run failed" },
      { status: 500, headers: { "cache-control": "no-store" } },
    );
  }
}

export { shouldAwaitGenerationWorkerBatch } from "@/lib/config/worker-http-batch-policy";

function extractWorkerSecret(request: Request): string | null {
  const authorization = request.headers.get("authorization");
  if (authorization?.startsWith("Bearer ")) {
    const token = authorization.slice("Bearer ".length).trim();
    if (token) return token;
  }
  return request.headers.get("x-worker-secret");
}

/**
 * Opt-in local diagnostics (`WORKER_ROUTE_TIMING=1` in development only).
 * Off by default so production logs stay clean.
 */
function createWorkerRouteTiming() {
  const enabled =
    process.env.NODE_ENV === "development" &&
    process.env.WORKER_ROUTE_TIMING === "1";
  const startedAt = performance.now();
  return {
    mark(label: string) {
      if (!enabled) return;
      const elapsedMs = (performance.now() - startedAt).toFixed(1);
      console.info(`[worker/generation timing] ${label} +${elapsedMs}ms`);
    },
  };
}
