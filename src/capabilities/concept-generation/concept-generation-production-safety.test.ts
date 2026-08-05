import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";

import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";
import { DataUriAssetStorageProvider } from "@/capabilities/asset-storage";
import { createAssetCapability, PngThumbnailGenerator } from "@/capabilities/assets";
import { createDesignBriefCapability } from "@/capabilities/design-brief";
import { createGenerationWorkerCapability } from "@/capabilities/generation-worker";
import { createPromptTranslationCapability } from "@/capabilities/prompt-translation";
import {
  resolveConceptGenerationProvider,
  type ConceptGenerationProvider,
} from "@/capabilities/providers";
import { createConceptGenerationCapability } from "./concept-generation-capability";

/**
 * Sprint 2H Part 1B/2A — end-to-end proof of the production generation
 * safety gates, driven the same way a real deploy would be: environment
 * variables → `getConceptGenerationConfig` → `resolveConceptGenerationProvider`
 * → `ConceptGenerationCapability` + `GenerationWorkerCapability`. Unlike
 * `concept-generation-unavailable.test.ts` (which hand-builds an
 * `UnavailableConceptGenerationProvider`), this file never constructs a
 * provider directly — it proves the guard exists at every real layer, not
 * just in a unit test of one piece.
 *
 * `global.fetch` is replaced with a spy for every test here that throws if
 * ever called. If a future change accidentally let production reach the
 * real `OpenAIConceptGenerationProvider` when it shouldn't, these tests
 * fail on the network call itself — not just on a downstream assertion.
 */

const ENV_KEYS = [
  "CONCEPT_GENERATION_PROVIDER",
  "OPENAI_API_KEY",
  "OPENAI_IMAGE_MODEL",
  "NODE_ENV",
  "ASSET_STORAGE_MODE",
  "CONCEPT_GENERATION_ENABLE_REAL",
] as const;

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

// Customer-facing copy must never leak provider identity, storage
// mechanics, or environment-variable names — regardless of which safe
// error code caused the failure.
const FORBIDDEN_CUSTOMER_TERMS =
  /openai|api[_-]?key|data.?uri|supabase|object.?storage|s3|ASSET_STORAGE_MODE|CONCEPT_GENERATION_PROVIDER|PRODUCTION_ASSET_STORAGE_NOT_CONFIGURED|GENERATION_PROVIDER_NOT_CONFIGURED|REAL_GENERATION_NOT_YET_ENABLED|placeholder/i;

describe("Production generation safety gate — end to end (Sprint 2H Part 1B/2A)", () => {
  let tempDir = "";
  let previousCwd = "";
  const originalEnv = snapshotEnv();
  const originalFetch = global.fetch;
  let fetchCalls = 0;

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-prod-safety-"));
    process.chdir(tempDir);
  });

  after(async () => {
    await cleanupTempWorkspace(tempDir, previousCwd);
  });

  beforeEach(() => {
    fetchCalls = 0;
    global.fetch = (async () => {
      fetchCalls += 1;
      throw new Error(
        "no network access expected in this test — the safety gate must block before any provider call",
      );
    }) as typeof fetch;
  });

  afterEach(() => {
    restoreEnv(originalEnv);
    global.fetch = originalFetch;
  });

  async function freshRepo() {
    const { LocalProjectRepository } = await import("@/lib/db/local-store");
    return new LocalProjectRepository();
  }

  async function approvedProject(repo: Awaited<ReturnType<typeof freshRepo>>) {
    const created = await repo.createProject();
    await repo.updateBrief(created.project.id, {
      productSummary: "Camp t-shirts",
      designDescription: "A friendly bear mascot",
    });
    const designBrief = createDesignBriefCapability(repo);
    const version = await designBrief.approveWorkingBrief(created.project.id);
    return { projectId: created.project.id, version };
  }

  function buildPipeline(
    repo: Awaited<ReturnType<typeof freshRepo>>,
    provider: ConceptGenerationProvider,
  ) {
    const promptTranslation = createPromptTranslationCapability();
    const assets = createAssetCapability(
      repo,
      new DataUriAssetStorageProvider(),
      new PngThumbnailGenerator(),
    );
    const capability = createConceptGenerationCapability(repo, provider.providerKey);
    const worker = createGenerationWorkerCapability(
      repo,
      provider,
      promptTranslation,
      assets,
    );
    return { capability, worker, assets };
  }

  it("Production + CONCEPT_GENERATION_PROVIDER=openai + ASSET_STORAGE_MODE=data_uri: blocked before any provider call — no OpenAI request, no concepts, no assets, safe messaging", async () => {
    process.env.CONCEPT_GENERATION_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "sk-would-be-a-real-key";
    process.env.NODE_ENV = "production";
    process.env.ASSET_STORAGE_MODE = "data_uri";
    process.env.CONCEPT_GENERATION_ENABLE_REAL = "true";

    const { getConceptGenerationConfig } = await import(
      "@/lib/config/generation-provider-config"
    );
    const config = getConceptGenerationConfig();
    assert.equal(config.mode, "unavailable");
    assert.equal(
      config.mode === "unavailable" && config.safeErrorCode,
      "PRODUCTION_ASSET_STORAGE_NOT_CONFIGURED",
    );

    const provider = resolveConceptGenerationProvider(config);
    assert.equal(provider.providerKey, "unavailable");

    const repo = await freshRepo();
    const { capability, worker, assets } = buildPipeline(repo, provider);
    const { projectId, version } = await approvedProject(repo);

    await capability.generatePlaceholders(projectId, version.id);
    await worker.processNextJob();
    const snapshot = await repo.getProject(projectId);

    assert.equal(fetchCalls, 0, "no OpenAI HTTP request should ever be attempted");
    assert.equal(snapshot?.artworkVersions.length, 0);
    assert.equal(snapshot?.project.status, "failed");
    assert.deepEqual(await assets.listAssets(projectId), []);

    const jobs = await repo.listGenerationJobs(projectId);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0]?.status, "failed");
    assert.match(jobs[0]?.lastError ?? "", /PRODUCTION_ASSET_STORAGE_NOT_CONFIGURED/);

    const lastMessage = snapshot?.messages.at(-1);
    assert.equal(
      lastMessage?.content,
      "Concept generation is temporarily unavailable. Please try again shortly.",
    );
    for (const message of snapshot?.messages ?? []) {
      assert.doesNotMatch(message.content, FORBIDDEN_CUSTOMER_TERMS);
    }
  });

  it("Production + CONCEPT_GENERATION_PROVIDER=openai + ASSET_STORAGE_MODE=data_uri: a regeneration attempt is blocked the same way and preserves existing concepts", async () => {
    // First generate with a working (placeholder) provider so a batch
    // already exists — mirrors a real project's history.
    process.env.CONCEPT_GENERATION_PROVIDER = "placeholder";
    process.env.NODE_ENV = "production";
    process.env.ASSET_STORAGE_MODE = "data_uri";

    const { getConceptGenerationConfig: getConfigInitial } = await import(
      "@/lib/config/generation-provider-config"
    );
    const repo = await freshRepo();
    const working = buildPipeline(repo, resolveConceptGenerationProvider(getConfigInitial()));
    const { projectId, version: v1 } = await approvedProject(repo);
    await working.capability.generatePlaceholders(projectId, v1.id);
    await working.worker.processNextJob();

    await repo.updateBrief(projectId, { designDescription: "A revised bear mascot" });
    const designBrief = createDesignBriefCapability(repo);
    const v2 = await designBrief.approveWorkingBrief(projectId);

    // Now flip to the unsafe production combination for the regeneration.
    process.env.CONCEPT_GENERATION_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "sk-would-be-a-real-key";
    process.env.CONCEPT_GENERATION_ENABLE_REAL = "true";
    const { getConceptGenerationConfig: getConfigBlocked } = await import(
      "@/lib/config/generation-provider-config"
    );
    const blocked = buildPipeline(
      repo,
      resolveConceptGenerationProvider(getConfigBlocked()),
    );

    await blocked.capability.regenerateAfterRevision(projectId, v2.id);
    await blocked.worker.processNextJob();
    const snapshot = await repo.getProject(projectId);

    assert.equal(fetchCalls, 0);
    assert.equal(snapshot?.artworkVersions.length, 3); // original batch intact
    assert.equal(snapshot?.project.status, "concepts_ready");
    for (const message of snapshot?.messages ?? []) {
      assert.doesNotMatch(message.content, FORBIDDEN_CUSTOMER_TERMS);
    }
  });

  it("Production + CONCEPT_GENERATION_PROVIDER=openai + a production-safe ASSET_STORAGE_MODE + the real-generation kill switch enabled: readiness passes and the real adapter resolves (never actually called)", async () => {
    process.env.CONCEPT_GENERATION_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "sk-would-be-a-real-key";
    process.env.NODE_ENV = "production";
    process.env.ASSET_STORAGE_MODE = "s3";
    process.env.CONCEPT_GENERATION_ENABLE_REAL = "true";

    const { getConceptGenerationConfig, evaluateGenerationReadiness } = await import(
      "@/lib/config/generation-provider-config"
    );
    const config = getConceptGenerationConfig();
    assert.equal(config.mode, "openai");
    assert.deepEqual(evaluateGenerationReadiness(config), { ready: true });

    // Resolving constructs the real provider instance (proving the
    // configuration layer would allow it to run), but this test
    // deliberately never calls `.generate()` — actually reaching OpenAI is
    // out of scope for this task, and the fetch spy would fail the test if
    // it ever happened.
    const provider = resolveConceptGenerationProvider(config);
    assert.equal(provider.providerKey, "openai");
    assert.equal(fetchCalls, 0);
  });

  it("Production + CONCEPT_GENERATION_PROVIDER=openai + valid credentials + production-safe storage, but the real-generation kill switch is NOT enabled: still blocked (Sprint 2H Part 2A)", async () => {
    process.env.CONCEPT_GENERATION_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "sk-would-be-a-real-key";
    process.env.NODE_ENV = "production";
    process.env.ASSET_STORAGE_MODE = "supabase_storage";
    delete process.env.CONCEPT_GENERATION_ENABLE_REAL;

    const { getConceptGenerationConfig, evaluateGenerationReadiness } = await import(
      "@/lib/config/generation-provider-config"
    );
    const config = getConceptGenerationConfig();
    // Configuration-layer readiness is unaffected by the kill switch — it
    // answers "is this configured correctly", not "is it currently live".
    assert.equal(config.mode, "openai");
    assert.deepEqual(evaluateGenerationReadiness(config), { ready: true });

    // The kill switch is enforced one layer down, at resolution.
    const provider = resolveConceptGenerationProvider(config);
    assert.equal(provider.providerKey, "unavailable");
    assert.equal(fetchCalls, 0);
  });

  it("Production + CONCEPT_GENERATION_PROVIDER=placeholder + ASSET_STORAGE_MODE=data_uri: allowed end to end because no real image payload is ever produced", async () => {
    process.env.CONCEPT_GENERATION_PROVIDER = "placeholder";
    process.env.NODE_ENV = "production";
    process.env.ASSET_STORAGE_MODE = "data_uri";

    const { getConceptGenerationConfig } = await import(
      "@/lib/config/generation-provider-config"
    );
    const config = getConceptGenerationConfig();
    assert.equal(config.mode, "placeholder");

    const provider = resolveConceptGenerationProvider(config);
    assert.equal(provider.providerKey, "placeholder");

    const repo = await freshRepo();
    const { capability, worker } = buildPipeline(repo, provider);
    const { projectId, version } = await approvedProject(repo);

    await capability.generatePlaceholders(projectId, version.id);
    await worker.processNextJob();
    const snapshot = await repo.getProject(projectId);

    assert.equal(fetchCalls, 0);
    assert.equal(snapshot?.artworkVersions.length, 3);
    assert.equal(snapshot?.project.status, "concepts_ready");
  });

  it("Development + CONCEPT_GENERATION_PROVIDER=openai + ASSET_STORAGE_MODE=data_uri + kill switch enabled: allowed for controlled development (readiness at the configuration layer only)", async () => {
    process.env.CONCEPT_GENERATION_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "sk-dev-key";
    process.env.NODE_ENV = "development";
    process.env.ASSET_STORAGE_MODE = "data_uri";
    process.env.CONCEPT_GENERATION_ENABLE_REAL = "true";

    const { getConceptGenerationConfig, evaluateGenerationReadiness } = await import(
      "@/lib/config/generation-provider-config"
    );
    const config = getConceptGenerationConfig();
    assert.equal(config.mode, "openai");
    assert.deepEqual(evaluateGenerationReadiness(config), { ready: true });

    const provider = resolveConceptGenerationProvider(config);
    assert.equal(provider.providerKey, "openai");
    assert.equal(fetchCalls, 0); // resolution alone never calls the network
  });

  it("Test environment + CONCEPT_GENERATION_PROVIDER=placeholder + ASSET_STORAGE_MODE=data_uri: allowed", async () => {
    process.env.CONCEPT_GENERATION_PROVIDER = "placeholder";
    process.env.NODE_ENV = "test";
    process.env.ASSET_STORAGE_MODE = "data_uri";

    const { getConceptGenerationConfig } = await import(
      "@/lib/config/generation-provider-config"
    );
    assert.equal(getConceptGenerationConfig().mode, "placeholder");
  });
});
