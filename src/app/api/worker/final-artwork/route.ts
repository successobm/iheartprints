import { NextResponse } from "next/server";

import { getCapabilityGraph } from "@/capabilities/composition";
import {
  registerWorkerAuthFailure,
  verifyWorkerSecret,
} from "@/capabilities/worker-scheduler";

/**
 * Sprint 2M Phase 2C: the protected final-artwork worker endpoint — mirrors
 * `POST /api/worker/generation` exactly, including its security posture
 * (same `WORKER_SECRET`, same generic response shape, same in-memory
 * auth-failure rate limiting). A separate endpoint (not a shared "run
 * everything" route) so each job queue can be scheduled, observed, and
 * scaled independently, per Goal 21.
 *
 * Server-only, never linked from anywhere customer-facing. Responsibility
 * is deliberately narrow: "run the final-artwork worker once." Never
 * accepts a project id, never returns a job id, an asset id, a validation
 * status, or a stack trace.
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
    await getCapabilityGraph().finalArtworkScheduler.runBatch();
    return NextResponse.json(
      { ok: true },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    // Never forward the error's message/stack — could name a storage path
    // or an internal id.
    console.error("[worker] final-artwork batch failed", error);
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
