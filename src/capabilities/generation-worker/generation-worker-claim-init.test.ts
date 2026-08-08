import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";

/**
 * Regression: POST /api/worker/generation must be able to reach
 * `claimNextQueuedJob` without unrelated Final Artwork / Topaz (or other
 * paid-provider) network I/O during capability-graph composition.
 *
 * Phase 2E wires `resolveFinalArtworkProvider()` into the same
 * `createCapabilityGraph()` the generation worker route uses. Provider
 * construction must stay synchronous and side-effect-free — a hang before
 * claim is a composition/init bug, not something to paper over with an
 * HTTP timeout.
 */
describe("Generation worker claim path vs unrelated provider init", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-claim-init-"));
    process.chdir(tempDir);
  });

  after(async () => {
    await cleanupTempWorkspace(tempDir, previousCwd);
  });

  it("createCapabilityGraph + claimNextQueuedJob performs no Topaz/OpenAI network I/O", async () => {
    const originalFetch = globalThis.fetch;
    const fetchUrls: string[] = [];
    globalThis.fetch = async (input) => {
      fetchUrls.push(String(input));
      throw new Error(
        `Unexpected network call during composition/claim: ${String(input)}`,
      );
    };

    const envKeys = [
      "FINAL_ARTWORK_PROVIDER",
      "TOPAZ_API_KEY",
      "CONCEPT_GENERATION_PROVIDER",
      "CONCEPT_GENERATION_ENABLE_REAL",
      "OPENAI_API_KEY",
      "CONCEPT_EVALUATION_PROVIDER",
      "CONVERSATION_UNDERSTANDING_PROVIDER",
    ] as const;
    const previousEnv: Record<string, string | undefined> = {};
    for (const key of envKeys) previousEnv[key] = process.env[key];

    try {
      // Dangerous ambient config — composition must still not touch the network
      // on the generation claim path (automated-test safety forces local/
      // placeholder resolvers; this test also proves create+claim stays
      // fetch-free even when those env vars look "live").
      process.env.FINAL_ARTWORK_PROVIDER = "topaz";
      process.env.TOPAZ_API_KEY = "fake-but-present";
      process.env.CONCEPT_GENERATION_PROVIDER = "openai";
      process.env.CONCEPT_GENERATION_ENABLE_REAL = "true";
      process.env.OPENAI_API_KEY = "fake-but-present";
      process.env.CONCEPT_EVALUATION_PROVIDER = "openai";
      process.env.CONVERSATION_UNDERSTANDING_PROVIDER = "openai";

      const { resetCapabilityGraphForTests, createCapabilityGraph } = await import(
        "@/capabilities/composition"
      );
      const { resetProjectRepositoryForTests, getProjectRepository } = await import(
        "@/lib/db"
      );
      resetProjectRepositoryForTests();
      resetCapabilityGraphForTests();

      const startedAt = performance.now();
      const graph = createCapabilityGraph(getProjectRepository());
      const composedMs = performance.now() - startedAt;

      const claimStartedAt = performance.now();
      const { processedJobId } = await graph.generationWorker.processNextJob();
      const claimMs = performance.now() - claimStartedAt;

      assert.equal(processedJobId, null);
      assert.deepEqual(fetchUrls, []);
      assert.ok(
        composedMs < 2_000,
        `composition took ${composedMs.toFixed(1)}ms — expected sync local init`,
      );
      assert.ok(
        claimMs < 2_000,
        `claim took ${claimMs.toFixed(1)}ms — expected fast empty-queue claim`,
      );
    } finally {
      globalThis.fetch = originalFetch;
      for (const key of envKeys) {
        if (previousEnv[key] === undefined) delete process.env[key];
        else process.env[key] = previousEnv[key];
      }
    }
  });
});
