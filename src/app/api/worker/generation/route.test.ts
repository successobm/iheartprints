import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, afterEach, before, describe, it } from "node:test";

import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";
import { runAdaptiveInterviewToSummary } from "@/test-support/run-adaptive-interview";

const DEV_FALLBACK_SECRET =
  "iheartprints-local-dev-worker-secret-do-not-use-in-production";

const ENV_KEYS = ["WORKER_SECRET", "NODE_ENV"] as const;

function snapshotEnv(): Record<string, string | undefined> {
  const snapshot: Record<string, string | undefined> = {};
  for (const key of ENV_KEYS) snapshot[key] = process.env[key];
  return snapshot;
}

function restoreEnv(snapshot: Record<string, string | undefined>): void {
  for (const key of ENV_KEYS) {
    if (snapshot[key] === undefined) delete process.env[key];
    else process.env[key] = snapshot[key];
  }
}

describe("POST /api/worker/generation (Sprint 2H Part 2B)", () => {
  let tempDir = "";
  let previousCwd = "";
  const originalEnv = snapshotEnv();

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-worker-route-"));
    process.chdir(tempDir);
  });

  after(async () => {
    restoreEnv(originalEnv);
    const { drainCapabilityGraphForTests } = await import(
      "@/capabilities/composition"
    );
    await drainCapabilityGraphForTests();
    await cleanupTempWorkspace(tempDir, previousCwd);
  });

  afterEach(async () => {
    restoreEnv(originalEnv);
    const { resetWorkerAuthRateLimiterForTests } = await import(
      "@/capabilities/worker-scheduler"
    );
    resetWorkerAuthRateLimiterForTests();
  });

  function post(headers: Record<string, string> = {}): Promise<Response> {
    return import("./route").then(({ POST }) =>
      POST(
        new Request("http://localhost/api/worker/generation", {
          method: "POST",
          headers,
        }),
      ),
    );
  }

  async function installBlockedScheduler(): Promise<{
    releaseProvider: () => void;
    inFlight: Promise<unknown>;
    hasActiveBatch: () => boolean;
  }> {
    const { createGenerationSchedulerCapability } = await import(
      "@/capabilities/worker-scheduler"
    );
    let releaseProvider: (() => void) | undefined;
    const slowWorker = {
      async processNextJob() {
        await new Promise<void>((resolve) => {
          releaseProvider = resolve;
        });
        return { processedJobId: "slow-job" };
      },
      async recoverAbandonedJobs() {
        return { recoveredCount: 0 };
      },
    };
    const scheduler = createGenerationSchedulerCapability(slowWorker, {
      maxJobsPerRun: 1,
    });

    const { resetCapabilityGraphForTests, getCapabilityGraph } = await import(
      "@/capabilities/composition"
    );
    resetCapabilityGraphForTests();
    const graph = getCapabilityGraph();
    (graph as { workerScheduler: typeof scheduler }).workerScheduler = scheduler;

    const inFlight = scheduler.runBatch();
    await new Promise<void>((resolve) => {
      queueMicrotask(resolve);
    });
    assert.equal(scheduler.hasActiveBatch(), true);

    return {
      releaseProvider: () => releaseProvider?.(),
      inFlight,
      hasActiveBatch: () => scheduler.hasActiveBatch(),
    };
  }

  it("rejects a request with no secret header", async () => {
    process.env.WORKER_SECRET = "configured-secret";
    const response = await post();
    assert.equal(response.status, 401);
    const body = await response.json();
    assert.deepEqual(Object.keys(body), ["error"]);
    assert.equal(body.error, "Unauthorized");
  });

  it("rejects a request with the wrong secret", async () => {
    process.env.WORKER_SECRET = "configured-secret";
    const response = await post({ "x-worker-secret": "wrong" });
    assert.equal(response.status, 401);
  });

  it("accepts the correct secret via the X-Worker-Secret header", async () => {
    process.env.WORKER_SECRET = "configured-secret";
    const response = await post({ "x-worker-secret": "configured-secret" });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body, { ok: true });
  });

  it("accepts the correct secret via Authorization: Bearer", async () => {
    process.env.WORKER_SECRET = "configured-secret";
    const response = await post({ authorization: "Bearer configured-secret" });
    assert.equal(response.status, 200);
  });

  it("in development, accepts the well-known dev fallback secret when WORKER_SECRET is unset", async () => {
    delete process.env.WORKER_SECRET;
    process.env.NODE_ENV = "development";
    const response = await post({ "x-worker-secret": DEV_FALLBACK_SECRET });
    assert.equal(response.status, 200);
  });

  it("fails closed in production when WORKER_SECRET is unset, even with the dev fallback secret", async () => {
    delete process.env.WORKER_SECRET;
    process.env.NODE_ENV = "production";
    const response = await post({ "x-worker-secret": DEV_FALLBACK_SECRET });
    assert.equal(response.status, 401);
  });

  it("response body never includes a job id, provider name, or queue detail", async () => {
    process.env.WORKER_SECRET = "configured-secret";
    process.env.NODE_ENV = "development";

    const { resetCapabilityGraphForTests } = await import(
      "@/capabilities/composition"
    );
    resetCapabilityGraphForTests();
    const { startConversation, handleUserMessage, submitDesignBriefDecision } =
      await import("@/lib/services/conversation-service");
    await runAdaptiveInterviewToSummary({ start: startConversation, handleUserMessage }).then(
      ({ projectId }) => submitDesignBriefDecision(projectId, "approve"),
    );

    const response = await post({ "x-worker-secret": "configured-secret" });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(Object.keys(body), ["ok"]);
  });

  it("actually processes a queued job when authenticated", async () => {
    process.env.WORKER_SECRET = "configured-secret";
    process.env.NODE_ENV = "development";

    const { resetCapabilityGraphForTests, getCapabilityGraph } = await import(
      "@/capabilities/composition"
    );
    resetCapabilityGraphForTests();
    const { startConversation, handleUserMessage, submitDesignBriefDecision } =
      await import("@/lib/services/conversation-service");
    const { projectId } = await runAdaptiveInterviewToSummary({
      start: startConversation,
      handleUserMessage,
    });
    await submitDesignBriefDecision(projectId, "approve");

    const before = await getCapabilityGraph().conversation.get(projectId);
    assert.equal(before?.project.status, "generating");

    const response = await post({ "x-worker-secret": "configured-secret" });
    assert.equal(response.status, 200);

    // Automated tests await the batch — placeholder provider only (no paid calls).
    const after = await getCapabilityGraph().conversation.get(projectId);
    assert.equal(after?.project.status, "concepts_ready");
  });

  it("automated-test route awaits runBatch even when NODE_ENV is development", async () => {
    process.env.WORKER_SECRET = "configured-secret";
    process.env.NODE_ENV = "development";

    const { shouldAwaitGenerationWorkerBatch } = await import("./route");
    assert.equal(shouldAwaitGenerationWorkerBatch(), true);

    const blocked = await installBlockedScheduler();
    let responded = false;
    const responsePromise = post({ "x-worker-secret": "configured-secret" }).then(
      (response) => {
        responded = true;
        return response;
      },
    );

    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(
      responded,
      false,
      "automated tests must await the batch — must not detach",
    );

    blocked.releaseProvider();
    const response = await responsePromise;
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
    await blocked.inFlight;
    assert.equal(blocked.hasActiveBatch(), false);
  });

  it("B/C: production route awaits runBatch completion and does not detach", async () => {
    process.env.WORKER_SECRET = "configured-secret";
    process.env.NODE_ENV = "production";

    const { shouldAwaitGenerationWorkerBatch } = await import("./route");
    assert.equal(shouldAwaitGenerationWorkerBatch(), true);

    const blocked = await installBlockedScheduler();
    let responded = false;
    const responsePromise = post({ "x-worker-secret": "configured-secret" }).then(
      (response) => {
        responded = true;
        return response;
      },
    );

    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(
      responded,
      false,
      "production must still be awaiting the blocked batch — must not detach",
    );
    assert.equal(blocked.hasActiveBatch(), true);

    blocked.releaseProvider();
    const response = await responsePromise;
    assert.equal(responded, true);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
    await blocked.inFlight;
    assert.equal(blocked.hasActiveBatch(), false);
  });

  it("no detached batch remains after an automated worker-route POST (teardown-safe)", async () => {
    process.env.WORKER_SECRET = "configured-secret";
    process.env.NODE_ENV = "development";

    const { resetCapabilityGraphForTests, getCapabilityGraph } = await import(
      "@/capabilities/composition"
    );
    resetCapabilityGraphForTests();
    const { startConversation, handleUserMessage, submitDesignBriefDecision } =
      await import("@/lib/services/conversation-service");
    const { projectId } = await runAdaptiveInterviewToSummary({
      start: startConversation,
      handleUserMessage,
    });
    await submitDesignBriefDecision(projectId, "approve");

    const response = await post({ "x-worker-secret": "configured-secret" });
    assert.equal(response.status, 200);
    assert.equal(getCapabilityGraph().workerScheduler.hasActiveBatch(), false);
    const after = await getCapabilityGraph().conversation.get(projectId);
    assert.equal(after?.project.status, "concepts_ready");
  });

  it("GET is not an allowed method", async () => {
    const routeModule = await import("./route");
    assert.equal("GET" in routeModule, false);
  });

  it("rate-limits repeated failed-auth attempts from the same instance", async () => {
    process.env.WORKER_SECRET = "configured-secret";

    let sawRateLimited = false;
    for (let i = 0; i < 25; i += 1) {
      const response = await post({ "x-worker-secret": "wrong" });
      if (response.status === 429) {
        sawRateLimited = true;
        const body = await response.json();
        assert.deepEqual(Object.keys(body), ["error"]);
        break;
      }
      assert.equal(response.status, 401);
    }
    assert.equal(sawRateLimited, true, "expected repeated failures to eventually be rate-limited");
  });
});
