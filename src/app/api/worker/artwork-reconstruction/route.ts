import { NextResponse } from "next/server";

import { getCapabilityGraph } from "@/capabilities/composition";
import {
  registerWorkerAuthFailure,
  verifyWorkerSecret,
} from "@/capabilities/worker-scheduler";

/**
 * Phase R5: the protected artwork-reconstruction worker endpoint — mirrors
 * `POST /api/worker/final-artwork` exactly, including its security posture
 * (same `WORKER_SECRET`, same generic response shape, same in-memory
 * auth-failure rate limiting).
 *
 * Server-only, never linked from anywhere customer-facing. Responsibility
 * is deliberately narrow: "run the artwork-reconstruction worker once."
 * Never accepts a project id, never returns a job id or an asset id.
 *
 * Note: the customer-facing "request reconstruction" action
 * (`artwork-reconstruction-service.ts`) already runs one batch inline so
 * the candidate is ready without the customer needing to poll — this
 * scheduled endpoint exists for the same reason every other worker has
 * one: to sweep abandoned/recoverable jobs (a crashed worker mid-request,
 * a retryable provider failure) independent of any particular customer
 * request being in flight.
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
    await getCapabilityGraph().artworkReconstructionScheduler.runBatch();
    return NextResponse.json(
      { ok: true },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    console.error("[worker] artwork-reconstruction batch failed", error);
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
