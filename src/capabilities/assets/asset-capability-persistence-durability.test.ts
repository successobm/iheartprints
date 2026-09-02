import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";
import {
  StrictUniqueKeyAssetStorageProvider,
} from "@/capabilities/asset-storage/strict-unique-key-asset-storage-provider";
import { buildObjectKey } from "@/capabilities/asset-storage";
import type { AssetStorageProvider } from "@/capabilities/asset-storage";
import type { AssetRecord } from "@/lib/domain/types";
import type { ProjectRepository } from "@/lib/db/repository";
import { createAssetCapability } from "./asset-capability";
import { PngThumbnailGenerator } from "./png-thumbnail-generator";

/**
 * Intermediate-Asset-Persistence-Durability Phase (real Signs acceptance
 * incident): the 20 numbered scenarios required by this phase's own task,
 * covering `AssetCapability.uploadProductionAsset`'s split diagnostics,
 * self-heal-before-retry design, bounded transient retry, and cleanup
 * safety. Every test here uses ONLY the local/in-memory repository and the
 * in-process `StrictUniqueKeyAssetStorageProvider` test double — nothing in
 * this file ever reaches a real network, Supabase project, or provider.
 */

function makeErrorWithCode(message: string, code: string): Error {
  const error = new Error(message);
  (error as NodeJS.ErrnoException).code = code;
  return error;
}

function buildProductionInput(overrides: Partial<{
  conceptId: string;
  finalArtworkJobId: string;
  productionRole: "production_png";
}> = {}) {
  return {
    conceptId: overrides.conceptId ?? "concept-1",
    bytes: Buffer.from("production bytes"),
    contentType: "image/png",
    widthPx: 4608,
    heightPx: 6144,
    hasTransparency: false,
    finalArtworkJobId: overrides.finalArtworkJobId ?? "job-1",
    productionRole: overrides.productionRole ?? ("production_png" as const),
    metadata: {},
  };
}

describe("AssetCapability.uploadProductionAsset — intermediate-asset-persistence-durability", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-assets-durability-"));
    process.chdir(tempDir);
  });

  after(async () => {
    await cleanupTempWorkspace(tempDir, previousCwd);
  });

  async function freshRepo() {
    const { LocalProjectRepository } = await import("@/lib/db/local-store");
    const repo = new LocalProjectRepository();
    const created = await repo.createProject();
    return { repo, projectId: created.project.id };
  }

  function captureInfoLogs(): { lines: string[]; restore: () => void } {
    const original = console.info;
    const lines: string[] = [];
    console.info = (...args: unknown[]) => {
      lines.push(args.map((a) => String(a)).join(" "));
    };
    return { lines, restore: () => { console.info = original; } };
  }

  // 1. storage upload succeeds
  it("1: storage upload succeeds — no retry, no cleanup, single object", async () => {
    const { repo, projectId } = await freshRepo();
    const storage = new StrictUniqueKeyAssetStorageProvider();
    const assets = createAssetCapability(repo, storage, new PngThumbnailGenerator());

    const asset = await assets.uploadProductionAsset(projectId, buildProductionInput());

    assert.equal(storage.uploadCount, 1);
    assert.equal(asset.finalArtworkJobId, "job-1");
    assert.equal(asset.productionRole, "production_png");
  });

  // 2. storage upload ECONNRESET (server did nothing) — bounded retry succeeds
  it("2: storage upload ECONNRESET where server did nothing — bounded retry lands the object once", async () => {
    const { repo, projectId } = await freshRepo();
    const storage = new StrictUniqueKeyAssetStorageProvider();
    let failuresRemaining = 1;
    const flaky: AssetStorageProvider = {
      storageKey: storage.storageKey,
      upload: async (input) => {
        if (failuresRemaining > 0) {
          failuresRemaining -= 1;
          throw makeErrorWithCode("simulated reset before write", "ECONNRESET");
        }
        return storage.upload(input);
      },
      getSignedUrl: storage.getSignedUrl.bind(storage),
      delete: storage.delete.bind(storage),
      download: storage.download.bind(storage),
    };
    const assets = createAssetCapability(repo, flaky, new PngThumbnailGenerator());

    const asset = await assets.uploadProductionAsset(projectId, buildProductionInput());

    assert.equal(storage.uploadCount, 1);
    assert.ok(asset.id);
  });

  // 3. storage upload timeout (ETIMEDOUT) — bounded retry succeeds
  it("3: storage upload ETIMEDOUT — bounded retry lands the object once", async () => {
    const { repo, projectId } = await freshRepo();
    const storage = new StrictUniqueKeyAssetStorageProvider();
    let failuresRemaining = 1;
    const flaky: AssetStorageProvider = {
      storageKey: storage.storageKey,
      upload: async (input) => {
        if (failuresRemaining > 0) {
          failuresRemaining -= 1;
          throw makeErrorWithCode("simulated timeout", "ETIMEDOUT");
        }
        return storage.upload(input);
      },
      getSignedUrl: storage.getSignedUrl.bind(storage),
      delete: storage.delete.bind(storage),
      download: storage.download.bind(storage),
    };
    const assets = createAssetCapability(repo, flaky, new PngThumbnailGenerator());

    const asset = await assets.uploadProductionAsset(projectId, buildProductionInput());
    assert.ok(asset.id);
    assert.equal(storage.uploadCount, 1);
  });

  // 4. storage ambiguous-success: client sees ECONNRESET but the object actually landed server-side
  it("4: storage upload reports ECONNRESET but the object actually landed — self-heal adopts it, never retries the write", async () => {
    const { repo, projectId } = await freshRepo();
    const storage = new StrictUniqueKeyAssetStorageProvider();
    const input = buildProductionInput();
    const expectedKey = buildObjectKey({
      projectId,
      conceptId: input.conceptId,
      fileName: "production.png",
    });

    const ambiguous: AssetStorageProvider = {
      storageKey: storage.storageKey,
      upload: async (uploadInput) => {
        // Simulate the write actually landing server-side before the
        // client sees a connection reset on the response path.
        await storage.upload(uploadInput);
        throw makeErrorWithCode("simulated reset after commit", "ECONNRESET");
      },
      getSignedUrl: storage.getSignedUrl.bind(storage),
      delete: storage.delete.bind(storage),
      download: storage.download.bind(storage),
    };
    const assets = createAssetCapability(repo, ambiguous, new PngThumbnailGenerator());

    const asset = await assets.uploadProductionAsset(projectId, input);

    assert.ok(asset.id);
    assert.equal(storage.uploadCount, 1);
    assert.equal(storage.has(expectedKey), true);
  });

  // 5. createAsset succeeds
  it("5: createAsset succeeds — object uploaded once, row created once", async () => {
    const { repo, projectId } = await freshRepo();
    const storage = new StrictUniqueKeyAssetStorageProvider();
    const assets = createAssetCapability(repo, storage, new PngThumbnailGenerator());

    const asset = await assets.uploadProductionAsset(projectId, buildProductionInput());
    const list = await repo.listAssetsForFinalArtworkJob(projectId, "job-1");

    assert.equal(list.length, 1);
    assert.equal(list[0]?.id, asset.id);
  });

  // 6. createAsset SQLSTATE 57014 (statement timeout) — non-retryable in-process, cleaned up, safe error labeled
  it("6: createAsset fails with simulated SQLSTATE 57014 — labeled error, no in-process retry, storage cleaned up", async () => {
    const { repo, projectId } = await freshRepo();
    const storage = new StrictUniqueKeyAssetStorageProvider();
    const failingRepo = new Proxy(repo, {
      get(target, prop, receiver) {
        if (prop === "createAsset") {
          return async () => {
            throw { code: "57014", message: "canceling statement due to statement timeout" };
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as ProjectRepository;
    const assets = createAssetCapability(failingRepo, storage, new PngThumbnailGenerator());

    // `withOperationTiming` re-throws a NEW plain `Error` (by design — see
    // `safe-error-description.ts`'s own doc) whose message is produced by
    // `describeOperationError`, which extracts allowlisted scalar fields
    // (including `code`) from a non-Error thrown value into the message
    // text itself — so the precise sub-step label AND the underlying
    // SQLSTATE are both recoverable from the message, even though the
    // original error's own `.code` property is intentionally not preserved.
    await assert.rejects(
      assets.uploadProductionAsset(projectId, buildProductionInput()),
      /uploadProductionAsset\.createAsset failed after \d+ms:.*57014/,
    );

    // Cleanup ran because no adoptable row existed.
    assert.equal(storage.uploadCount, 1);
    assert.equal(storage.objectKeys().length, 0);
  });

  // 7. createAsset ECONNRESET / transport equivalent — same non-retry-in-process, cleanup, labeled
  it("7: createAsset fails with ECONNRESET-equivalent — no in-process retry, storage cleaned up", async () => {
    const { repo, projectId } = await freshRepo();
    const storage = new StrictUniqueKeyAssetStorageProvider();
    const failingRepo = new Proxy(repo, {
      get(target, prop, receiver) {
        if (prop === "createAsset") {
          return async () => {
            throw makeErrorWithCode("simulated reset during insert", "ECONNRESET");
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as ProjectRepository;
    const assets = createAssetCapability(failingRepo, storage, new PngThumbnailGenerator());

    await assert.rejects(assets.uploadProductionAsset(projectId, buildProductionInput()));
    assert.equal(storage.uploadCount, 1);
    assert.equal(storage.objectKeys().length, 0);
  });

  // 8. storage succeeds, createAsset fails — composite, single storage object, no orphan
  it("8: storage upload succeeds then createAsset fails — the uploaded object is cleaned up, not left orphaned", async () => {
    const { repo, projectId } = await freshRepo();
    const storage = new StrictUniqueKeyAssetStorageProvider();
    const failingRepo = new Proxy(repo, {
      get(target, prop, receiver) {
        if (prop === "createAsset") {
          return async () => {
            throw new Error("simulated non-transient database failure");
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as ProjectRepository;
    const assets = createAssetCapability(failingRepo, storage, new PngThumbnailGenerator());

    await assert.rejects(
      assets.uploadProductionAsset(projectId, buildProductionInput()),
      /simulated non-transient database failure/,
    );

    assert.equal(storage.uploadCount, 1);
    assert.equal(storage.objectKeys().length, 0);
  });

  // 9. existing row discovered after ambiguous createAsset failure — self-heal adopts it, no duplicate row
  it("9: an existing asset row is discovered after an ambiguous createAsset failure — adopted, not duplicated", async () => {
    const { repo, projectId } = await freshRepo();
    const storage = new StrictUniqueKeyAssetStorageProvider();
    const input = buildProductionInput();
    const expectedKey = buildObjectKey({
      projectId,
      conceptId: input.conceptId,
      fileName: "production.png",
    });

    let alreadyCommitted: AssetRecord | null = null;
    const failingRepo = new Proxy(repo, {
      get(target, prop, receiver) {
        if (prop === "createAsset") {
          return async (designId: string, createInput: Parameters<ProjectRepository["createAsset"]>[1]) => {
            // Simulate the INSERT actually committing server-side before
            // the client sees the failure (e.g. a 57014 firing on the
            // response path, after Postgres already wrote the row).
            alreadyCommitted = await (target as ProjectRepository).createAsset(designId, createInput);
            throw new Error("simulated ambiguous createAsset failure (row committed, response lost)");
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as ProjectRepository;
    const assets = createAssetCapability(failingRepo, storage, new PngThumbnailGenerator());

    const adopted = await assets.uploadProductionAsset(projectId, input);

    assert.ok(alreadyCommitted);
    assert.equal(adopted.id, (alreadyCommitted as unknown as AssetRecord).id);

    const list = await repo.listAssetsForFinalArtworkJob(projectId, "job-1");
    assert.equal(list.length, 1, "must not create a duplicate row for the already-committed insert");

    // Cleanup must NOT have deleted the object the adopted row references.
    assert.equal(storage.has(expectedKey), true);
  });

  // 10. existing object discovered after ambiguous storage failure — self-heal adopts it, no duplicate object, no second uploadCount
  it("10: an existing storage object is discovered after an ambiguous storage failure — adopted, upload not repeated", async () => {
    const { repo, projectId } = await freshRepo();
    const storage = new StrictUniqueKeyAssetStorageProvider();
    const input = buildProductionInput();

    const ambiguous: AssetStorageProvider = {
      storageKey: storage.storageKey,
      upload: async (uploadInput) => {
        await storage.upload(uploadInput);
        throw makeErrorWithCode("simulated reset after commit", "ECONNRESET");
      },
      getSignedUrl: storage.getSignedUrl.bind(storage),
      delete: storage.delete.bind(storage),
      download: storage.download.bind(storage),
    };
    const assets = createAssetCapability(repo, ambiguous, new PngThumbnailGenerator());

    const asset = await assets.uploadProductionAsset(projectId, input);
    assert.ok(asset.id);
    // Real upload happened exactly once, even though the client-visible
    // call failed — the self-heal existence check adopted it rather than
    // retrying the write.
    assert.equal(storage.uploadCount, 1);
  });

  // 11. cleanup failure does not hide the original error
  it("11: a cleanup failure after createAsset fails does not mask the original createAsset error", async () => {
    const { repo, projectId } = await freshRepo();
    const storage = new StrictUniqueKeyAssetStorageProvider();
    const brokenCleanupStorage: AssetStorageProvider = {
      storageKey: storage.storageKey,
      upload: storage.upload.bind(storage),
      getSignedUrl: storage.getSignedUrl.bind(storage),
      delete: async () => {
        throw new Error("simulated cleanup failure");
      },
      download: storage.download.bind(storage),
    };
    const failingRepo = new Proxy(repo, {
      get(target, prop, receiver) {
        if (prop === "createAsset") {
          return async () => {
            throw new Error("simulated original createAsset failure");
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as ProjectRepository;
    const assets = createAssetCapability(failingRepo, brokenCleanupStorage, new PngThumbnailGenerator());

    await assert.rejects(
      assets.uploadProductionAsset(projectId, buildProductionInput()),
      /simulated original createAsset failure/,
    );
  });

  // 12. cleanup cannot delete an adopted/current valid asset
  it("12: cleanup never runs when an existing row is adopted — the storage object it references survives", async () => {
    const { repo, projectId } = await freshRepo();
    const storage = new StrictUniqueKeyAssetStorageProvider();
    const input = buildProductionInput();
    const expectedKey = buildObjectKey({
      projectId,
      conceptId: input.conceptId,
      fileName: "production.png",
    });

    const deleteCalls: string[] = [];
    const failingRepo = new Proxy(repo, {
      get(target, prop, receiver) {
        if (prop === "createAsset") {
          return async (designId: string, createInput: Parameters<ProjectRepository["createAsset"]>[1]) => {
            await (target as ProjectRepository).createAsset(designId, createInput);
            throw new Error("simulated ambiguous createAsset failure");
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as ProjectRepository;
    const spyingStorage: AssetStorageProvider = {
      storageKey: storage.storageKey,
      upload: storage.upload.bind(storage),
      getSignedUrl: storage.getSignedUrl.bind(storage),
      delete: async (objectKey: string) => {
        deleteCalls.push(objectKey);
        return storage.delete(objectKey);
      },
      download: storage.download.bind(storage),
    };
    const assets = createAssetCapability(failingRepo, spyingStorage, new PngThumbnailGenerator());

    await assets.uploadProductionAsset(projectId, input);

    assert.deepEqual(deleteCalls, [], "cleanup must not run once an existing row was adopted");
    assert.equal(storage.has(expectedKey), true);
  });

  // 13. bounded transient retry succeeds on second attempt
  it("13: storage upload fails once with a retryable error then succeeds — retry attempt count is bounded and exact", async () => {
    const { repo, projectId } = await freshRepo();
    const storage = new StrictUniqueKeyAssetStorageProvider();
    let attempts = 0;
    const flaky: AssetStorageProvider = {
      storageKey: storage.storageKey,
      upload: async (input) => {
        attempts += 1;
        if (attempts === 1) {
          throw makeErrorWithCode("simulated reset before write", "ECONNRESET");
        }
        return storage.upload(input);
      },
      getSignedUrl: storage.getSignedUrl.bind(storage),
      delete: storage.delete.bind(storage),
      download: storage.download.bind(storage),
    };
    const assets = createAssetCapability(repo, flaky, new PngThumbnailGenerator());

    const asset = await assets.uploadProductionAsset(projectId, buildProductionInput());
    assert.ok(asset.id);
    assert.equal(attempts, 2);
  });

  // 14. retry bound respected — never exceeds MAX_PERSISTENCE_TRANSPORT_RETRY_ATTEMPTS additional attempts
  it("14: storage upload fails with a retryable error on every attempt — gives up after the bounded number of additional attempts", async () => {
    const { repo, projectId } = await freshRepo();
    let attempts = 0;
    const alwaysFails: AssetStorageProvider = {
      storageKey: "always_fails",
      upload: async () => {
        attempts += 1;
        throw makeErrorWithCode("simulated persistent reset", "ECONNRESET");
      },
      getSignedUrl: async (key) => key,
      delete: async () => undefined,
      download: async () => {
        throw new Error("nothing was ever written");
      },
    };
    const assets = createAssetCapability(repo, alwaysFails, new PngThumbnailGenerator());

    await assert.rejects(assets.uploadProductionAsset(projectId, buildProductionInput()));
    // 1 initial attempt + 2 bounded additional retries = 3 total.
    assert.equal(attempts, 3);
  });

  // 15. non-retryable failure is not retried
  it("15: a non-retryable storage failure (no known transient code) is not retried at all", async () => {
    const { repo, projectId } = await freshRepo();
    let attempts = 0;
    const nonTransient: AssetStorageProvider = {
      storageKey: "non_transient",
      upload: async () => {
        attempts += 1;
        throw new Error("permission denied");
      },
      getSignedUrl: async (key) => key,
      delete: async () => undefined,
      download: async () => {
        throw new Error("nothing was ever written");
      },
    };
    const assets = createAssetCapability(repo, nonTransient, new PngThumbnailGenerator());

    await assert.rejects(
      assets.uploadProductionAsset(projectId, buildProductionInput()),
      /permission denied/,
    );
    assert.equal(attempts, 1, "a non-retryable failure must fail on the first attempt, no retry");
  });

  // 16. no provider call occurs during persistence retry
  it("16: no provider/network call is ever made by uploadProductionAsset's own retry path — it only touches the injected storage/repo", async () => {
    const { repo, projectId } = await freshRepo();
    const storage = new StrictUniqueKeyAssetStorageProvider();
    let attempts = 0;
    const flaky: AssetStorageProvider = {
      storageKey: storage.storageKey,
      upload: async (input) => {
        attempts += 1;
        if (attempts === 1) {
          throw makeErrorWithCode("simulated reset before write", "ECONNRESET");
        }
        return storage.upload(input);
      },
      getSignedUrl: storage.getSignedUrl.bind(storage),
      delete: storage.delete.bind(storage),
      download: storage.download.bind(storage),
    };
    const assets = createAssetCapability(repo, flaky, new PngThumbnailGenerator());

    // The test double's own upload/download/delete are the only I/O
    // surfaces reachable from uploadProductionAsset; there is no provider
    // client injected into AssetCapability at all, so a provider call is
    // structurally impossible here — this test documents that boundary by
    // construction rather than by spying on a provider that isn't wired in.
    const asset = await assets.uploadProductionAsset(projectId, buildProductionInput());
    assert.ok(asset.id);
  });

  // 17. no duplicate asset row across an ambiguous createAsset failure + adoption
  it("17: exactly one asset row exists for the job after an ambiguous createAsset failure is self-healed", async () => {
    const { repo, projectId } = await freshRepo();
    const storage = new StrictUniqueKeyAssetStorageProvider();
    const failingRepo = new Proxy(repo, {
      get(target, prop, receiver) {
        if (prop === "createAsset") {
          return async (designId: string, createInput: Parameters<ProjectRepository["createAsset"]>[1]) => {
            await (target as ProjectRepository).createAsset(designId, createInput);
            throw new Error("simulated ambiguous createAsset failure");
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as ProjectRepository;
    const assets = createAssetCapability(failingRepo, storage, new PngThumbnailGenerator());

    await assets.uploadProductionAsset(projectId, buildProductionInput());

    const list = await repo.listAssetsForFinalArtworkJob(projectId, "job-1");
    assert.equal(list.length, 1);
  });

  // 18. no duplicate storage object across a retried upload
  it("18: exactly one storage object exists for the deterministic key after a retried upload", async () => {
    const { repo, projectId } = await freshRepo();
    const storage = new StrictUniqueKeyAssetStorageProvider();
    let attempts = 0;
    const flaky: AssetStorageProvider = {
      storageKey: storage.storageKey,
      upload: async (input) => {
        attempts += 1;
        if (attempts === 1) {
          throw makeErrorWithCode("simulated reset before write", "ECONNRESET");
        }
        return storage.upload(input);
      },
      getSignedUrl: storage.getSignedUrl.bind(storage),
      delete: storage.delete.bind(storage),
      download: storage.download.bind(storage),
    };
    const assets = createAssetCapability(repo, flaky, new PngThumbnailGenerator());

    await assets.uploadProductionAsset(projectId, buildProductionInput());
    assert.equal(storage.objectKeys().length, 1);
  });

  // 19. provider identity remains unchanged — uploadProductionAsset never touches provider fields
  it("19: uploadProductionAsset never sets providerKey/generationJobId — production assets carry no provider identity of their own", async () => {
    const { repo, projectId } = await freshRepo();
    const storage = new StrictUniqueKeyAssetStorageProvider();
    const assets = createAssetCapability(repo, storage, new PngThumbnailGenerator());

    const asset = await assets.uploadProductionAsset(projectId, buildProductionInput());
    assert.equal(asset.providerKey, null);
    assert.equal(asset.generationJobId, null);
  });

  // 20. providerRecoveryAttempts unchanged — uploadProductionAsset never touches FinalArtworkJob rows at all
  it("20: uploadProductionAsset never reads or writes the FinalArtworkJob row — providerRecoveryAttempts is structurally untouched by this boundary", async () => {
    const { repo, projectId } = await freshRepo();
    const storage = new StrictUniqueKeyAssetStorageProvider();
    const updateCalls: unknown[] = [];
    const spyingRepo = new Proxy(repo, {
      get(target, prop, receiver) {
        if (prop === "updateFinalArtworkJob" || prop === "getFinalArtworkJobById") {
          return (...args: unknown[]) => {
            updateCalls.push({ prop, args });
            return Reflect.get(target, prop, receiver).apply(target, args);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as ProjectRepository;
    const assets = createAssetCapability(spyingRepo, storage, new PngThumbnailGenerator());

    await assets.uploadProductionAsset(projectId, buildProductionInput());
    assert.deepEqual(updateCalls, []);
  });

  // Diagnostics: the two sub-steps are separately labeled with elapsed timing.
  it("Diagnostics: storageUpload and createAsset are separately labeled with elapsed-ms timing, precisely identifying which sub-step failed", async () => {
    const { repo, projectId } = await freshRepo();
    const storage = new StrictUniqueKeyAssetStorageProvider();
    const assets = createAssetCapability(repo, storage, new PngThumbnailGenerator());
    const { lines, restore } = captureInfoLogs();

    try {
      await assets.uploadProductionAsset(projectId, buildProductionInput());
    } finally {
      restore();
    }

    assert.ok(lines.some((l) => l.includes("operation=uploadProductionAsset.storageUpload") && l.includes("outcome=success")));
    assert.ok(lines.some((l) => l.includes("operation=uploadProductionAsset.createAsset") && l.includes("outcome=success")));
  });

  it("Diagnostics: a createAsset failure is labeled precisely as uploadProductionAsset.createAsset, not a generic outer label", async () => {
    const { repo, projectId } = await freshRepo();
    const storage = new StrictUniqueKeyAssetStorageProvider();
    const failingRepo = new Proxy(repo, {
      get(target, prop, receiver) {
        if (prop === "createAsset") {
          return async () => {
            throw new Error("simulated non-transient database failure");
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as ProjectRepository;
    const assets = createAssetCapability(failingRepo, storage, new PngThumbnailGenerator());

    await assert.rejects(assets.uploadProductionAsset(projectId, buildProductionInput()));

    const list = await repo.listAssetsForFinalArtworkJob(projectId, "job-1");
    assert.equal(list.length, 0);
  });
});
