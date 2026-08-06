import { NextResponse } from "next/server";

import { getCapabilityGraph } from "@/capabilities/composition";
import {
  registerWorkerAuthFailure,
  verifyWorkerSecret,
} from "@/capabilities/worker-scheduler";

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
 * a queue length, or a stack trace — an authenticated caller learns only
 * whether the run itself succeeded.
 */
export async function POST(request: Request) {
  const provided = extractWorkerSecret(request);
  const auth = verifyWorkerSecret(provided);

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

  try {
    await getCapabilityGraph().workerScheduler.runBatch();
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

function extractWorkerSecret(request: Request): string | null {
  const authorization = request.headers.get("authorization");
  if (authorization?.startsWith("Bearer ")) {
    const token = authorization.slice("Bearer ".length).trim();
    if (token) return token;
  }
  return request.headers.get("x-worker-secret");
}
