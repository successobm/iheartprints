import { NextResponse } from "next/server";

import { getCapabilityGraph } from "@/capabilities/composition";
import { isAutomatedTestEnvironment } from "@/lib/config/automated-test-safety";
import { decideLocalGenerationTrigger } from "@/lib/config/local-generation-trigger-policy";
import { getProjectRepository } from "@/lib/db";
import { LOCAL_GENERATION_TRIGGER_CODE_VERSION } from "@/lib/services/local-generation-trigger";

/**
 * Interactive `next dev` diagnostics only. Proves whether this process
 * loaded the local-generation-trigger helper (HMR / stale singleton).
 * Production and automated tests return 404 — never a customer surface.
 */
export async function GET(request: Request) {
  const decision = decideLocalGenerationTrigger();
  if (!decision.allowed) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const projectId = new URL(request.url).searchParams.get("projectId");
  const graph = getCapabilityGraph();
  const strandedJobs = projectId
    ? (await getProjectRepository().listGenerationJobs(projectId))
        .filter((job) => job.status === "queued" && job.attempts === 0)
        .map((job) => ({ id: job.id, kind: job.kind, attempts: job.attempts }))
    : null;

  return NextResponse.json(
    {
      triggerCodeVersion: LOCAL_GENERATION_TRIGGER_CODE_VERSION,
      policy: decision,
      nodeEnv: process.env.NODE_ENV ?? null,
      automatedTest: isAutomatedTestEnvironment(),
      hasActiveBatch: graph.workerScheduler.hasActiveBatch(),
      projectId,
      strandedJobs,
    },
    { headers: { "cache-control": "no-store" } },
  );
}
