import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";

/**
 * Release-blocker regression (post Sprint 2M Phase 2E): `npm run verify`
 * made TWO real, paid Topaz Transparency Upscale calls because
 * `src/app/api/projects/[projectId]/production-artwork/image/route.test.ts`
 * exercises the REAL `getCapabilityGraph()` singleton's
 * `finalArtworkWorker.processNextJob()`, and `resolveFinalArtworkProvider()`
 * — called with no arguments by `composition.ts` — reads live
 * `process.env.FINAL_ARTWORK_PROVIDER`/`TOPAZ_API_KEY`. This repository's
 * own `.env.local` has both configured for legitimate manual/live-
 * acceptance testing, and nothing stopped that same ambient configuration
 * from reaching an automated test.
 *
 * This file proves the fix at three levels:
 *   1. The safety signal (`isAutomatedTestEnvironment()`) is actually true
 *      during a real `npm test` run — proof the bootstrap wiring works,
 *      not just the guard logic in isolation.
 *   2. Every provider-resolution function's no-argument (live-environment)
 *      path is neutralized to its safe provider even when the dangerous
 *      env vars are set to values indistinguishable from a real
 *      configuration (`FINAL_ARTWORK_PROVIDER=topaz` +
 *      `TOPAZ_API_KEY=fake-but-present`, `CONCEPT_GENERATION_PROVIDER=openai`
 *      + `CONCEPT_GENERATION_ENABLE_REAL=true` + a fake `OPENAI_API_KEY`,
 *      etc.).
 *   3. The EXACT exploit path — `createCapabilityGraph()` (mirroring
 *      `getCapabilityGraph()`) → `finalArtworkWorker.processNextJob()` — is
 *      re-run end to end with the same dangerous env and proves the
 *      resulting production asset was produced locally (never
 *      `"reconstructed"` provenance, never a `providerRequestId`), which is
 *      only possible if no network call was made.
 *
 * No real network call is made anywhere in this file — `fake-but-present`
 * is never a valid Topaz/OpenAI credential, and if the guard ever regressed,
 * `LocalRasterInterpolationProvider`/`PlaceholderConceptProvider` would
 * never be selected in the first place, so any accidental real call would
 * fail immediately on auth rather than silently succeed — but the whole
 * point is that call must never be attempted at all.
 */
describe("Release-blocker regression: automated tests never reach a real paid provider", () => {
  it("isAutomatedTestEnvironment() is true during this real test run (proves the --import bootstrap actually ran)", async () => {
    const { isAutomatedTestEnvironment } = await import(
      "@/lib/config/automated-test-safety"
    );
    assert.equal(
      isAutomatedTestEnvironment(),
      true,
      "IHEARTPRINTS_AUTOMATED_TEST was not set — the test-safety-bootstrap --import is not wired into the test invocation",
    );
  });

  async function withEnv(vars: Record<string, string | undefined>, fn: () => Promise<void>) {
    const original: Record<string, string | undefined> = {};
    for (const key of Object.keys(vars)) original[key] = process.env[key];
    try {
      for (const [key, value] of Object.entries(vars)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await fn();
    } finally {
      for (const [key, value] of Object.entries(original)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }

  it("resolveFinalArtworkProvider() with no explicit config forces Local even with FINAL_ARTWORK_PROVIDER=topaz + a real-looking TOPAZ_API_KEY", async () => {
    await withEnv(
      { FINAL_ARTWORK_PROVIDER: "topaz", TOPAZ_API_KEY: "fake-but-present" },
      async () => {
        const { resolveFinalArtworkProvider, LocalRasterInterpolationProvider } = await import(
          "@/capabilities/final-artwork"
        );
        const provider = resolveFinalArtworkProvider();
        assert.ok(provider instanceof LocalRasterInterpolationProvider);
        assert.equal(provider.providerKey, "local_raster_interpolation");
      },
    );
  });

  it("resolveConceptGenerationProvider() with no explicit config forces the placeholder even with CONCEPT_GENERATION_PROVIDER=openai + ENABLE_REAL=true + a real-looking OPENAI_API_KEY", async () => {
    await withEnv(
      {
        CONCEPT_GENERATION_PROVIDER: "openai",
        CONCEPT_GENERATION_ENABLE_REAL: "true",
        OPENAI_API_KEY: "fake-but-present",
      },
      async () => {
        const { resolveConceptGenerationProvider } = await import(
          "@/capabilities/providers/resolve-concept-provider"
        );
        const { PlaceholderConceptProvider } = await import(
          "@/capabilities/providers/placeholder-concept-provider"
        );
        const provider = resolveConceptGenerationProvider();
        assert.ok(provider instanceof PlaceholderConceptProvider);
      },
    );
  });

  it("resolveConceptEvaluationProvider() with no explicit config forces the placeholder even with CONCEPT_EVALUATION_PROVIDER=openai + a real-looking OPENAI_API_KEY", async () => {
    await withEnv(
      { CONCEPT_EVALUATION_PROVIDER: "openai", OPENAI_API_KEY: "fake-but-present" },
      async () => {
        const { resolveConceptEvaluationProvider } = await import(
          "@/capabilities/concept-evaluation/resolve-concept-evaluation-provider"
        );
        const { PlaceholderConceptEvaluationProvider } = await import(
          "@/capabilities/concept-evaluation/placeholder-concept-evaluation-provider"
        );
        const provider = resolveConceptEvaluationProvider();
        assert.ok(provider instanceof PlaceholderConceptEvaluationProvider);
      },
    );
  });

  it("resolveConversationUnderstandingProvider() with no explicit config forces 'none' even with CONVERSATION_UNDERSTANDING_PROVIDER=openai + a real-looking OPENAI_API_KEY", async () => {
    await withEnv(
      { CONVERSATION_UNDERSTANDING_PROVIDER: "openai", OPENAI_API_KEY: "fake-but-present" },
      async () => {
        const { resolveConversationUnderstandingProvider } = await import(
          "@/capabilities/conversation-understanding/resolve-conversation-understanding-provider"
        );
        const { NoneConversationUnderstandingProvider } = await import(
          "@/capabilities/conversation-understanding/none-conversation-understanding-provider"
        );
        const provider = resolveConversationUnderstandingProvider();
        assert.ok(provider instanceof NoneConversationUnderstandingProvider);
      },
    );
  });

  describe("the exact incident path: the REAL capability graph's finalArtworkWorker", () => {
    let tempDir = "";
    let previousCwd = "";

    before(() => {
      previousCwd = process.cwd();
      tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-composition-test-safety-"));
      process.chdir(tempDir);
    });

    after(async () => {
      await cleanupTempWorkspace(tempDir, previousCwd);
    });

    it("createCapabilityGraph().finalArtworkWorker.processNextJob() never uses Topaz, even with FINAL_ARTWORK_PROVIDER=topaz + a real-looking TOPAZ_API_KEY live in the environment", async () => {
      await withEnv(
        { FINAL_ARTWORK_PROVIDER: "topaz", TOPAZ_API_KEY: "fake-but-present" },
        async () => {
          const { randomUUID } = await import("node:crypto");
          const { PNG } = await import("pngjs");
          const { LocalProjectRepository } = await import("@/lib/db/local-store");
          const { createCapabilityGraph } = await import("@/capabilities/composition");
          const { createDesignBriefCapability } = await import("@/capabilities/design-brief");

          const repo = new LocalProjectRepository();
          // Mirrors `createCapabilityGraph`'s own default (`getProjectRepository()`)
          // shape but with an explicit, temp-dir-isolated repo instance — this
          // is the SAME composition-root function `getCapabilityGraph()` calls,
          // exercised directly so the test controls repo isolation without
          // needing to touch the process-wide singleton.
          const graph = createCapabilityGraph(repo);

          const created = await repo.createProject();
          const projectId = created.project.id;
          await repo.updateBrief(projectId, {
            productSummary: "T-shirt",
            designDescription: "A bear mascot",
            exactText: "Camp Wildwood 2026",
            shirtColor: "Navy",
            // full_back forces an upscale/reconstruction decision — if the
            // real Topaz provider were ever selected, this is exactly the
            // placement that would trigger a paid call.
            printPlacement: "full_back",
          });
          const designBrief = createDesignBriefCapability(repo);
          const version = await designBrief.approveWorkingBrief(projectId);

          function buildFixturePng(size: number) {
            const png = new PNG({ width: size, height: size });
            for (let i = 0; i < png.data.length; i += 4) {
              png.data[i] = 5;
              png.data[i + 1] = 5;
              png.data[i + 2] = 5;
              png.data[i + 3] = 255;
            }
            return PNG.sync.write(png);
          }

          const { primary } = await graph.assets.uploadConceptImage(projectId, {
            conceptId: randomUUID(),
            bytes: buildFixturePng(1024),
            contentType: "image/png",
            widthPx: 1024,
            heightPx: 1024,
            hasTransparency: true,
            providerKey: "test",
            generationJobId: null,
            metadata: {},
          });

          const [artwork] = await repo.addArtworkVersions(projectId, [
            {
              versionNumber: 1,
              kind: "concept",
              title: "Concept 1",
              summary: "A bear mascot design",
              placeholderLabel: "Concept 1",
              accentColor: "#000000",
              designBriefVersionId: version.id,
              generationJobId: null,
              primaryAssetId: primary.id,
              thumbnailAssetId: null,
              providerKey: "test",
              evaluationStatus: "passed",
              evaluation: {
                overallScore: 90,
                passed: true,
                confidence: 90,
                criteria: [
                  { key: "required_wording", score: 100, passed: true, confidence: 90, notes: null },
                ],
                warnings: [],
                recommendations: [],
                missingRequirements: [],
                matchedRequirements: [],
                providerMetadata: {},
              },
              evaluationEvaluatedAt: new Date().toISOString(),
              evaluationProviderKey: "test",
            },
          ]);
          await repo.selectArtworkVersion(projectId, artwork!.id);
          // Live Acceptance Corrective Pass (Section 2): selection alone
          // is never final approval — confirm explicitly first.
          await repo.updateProject(projectId, { finalDirectionConfirmed: true });

          await graph.finalArtwork.requestFinalArtwork(projectId, artwork!.id);
          await graph.finalArtworkWorker.processNextJob();

          const productionAsset = (await repo.listAssets(projectId)).find(
            (a) => a.productionRole === "production_png",
          );
          assert.ok(productionAsset, "the job should still complete honestly via the local provider");
          const meta = productionAsset!.metadata as Record<string, unknown>;
          // The unmistakable signature of a real Topaz call would be
          // resolutionProvenance "reconstructed" and a non-null
          // providerRequestId. Neither may ever appear here.
          assert.notEqual(meta.resolutionProvenance, "reconstructed");
          assert.equal(meta.providerRequestId, null);
          assert.equal(meta.providerKey, "local_raster_interpolation");
        },
      );
    });
  });
});
