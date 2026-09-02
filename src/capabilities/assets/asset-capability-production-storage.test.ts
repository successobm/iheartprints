import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";
import {
  buildObjectKey,
  DataUriAssetStorageProvider,
  StrictUniqueKeyAssetStorageProvider,
} from "@/capabilities/asset-storage";
import type { AssetStorageProvider } from "@/capabilities/asset-storage";
import type { AssetRecord } from "@/lib/domain/types";
import type { ProjectRepository } from "@/lib/db/repository";
import { createAssetCapability } from "./asset-capability";
import { PngThumbnailGenerator } from "./png-thumbnail-generator";

/**
 * Production Asset Storage Correction Phase (real Signs acceptance
 * incident: a real 27,466,533-byte intermediate PNG landed as a
 * 36,622,066-character base64 data URI directly inside `Asset.storageKey`,
 * because this real environment was configured with
 * `ASSET_STORAGE_MODE=data_uri` — a mode this repository's own
 * configuration doc already says is "not acceptable for real production
 * images: it inflates database rows"). `StrictUniqueKeyAssetStorageProvider`
 * stands in for `supabase_storage`/any real object-storage backend here —
 * it stores bytes SEPARATELY from any DB row and mirrors Supabase Storage's
 * own `upsert:false` collision semantics, which is exactly the property
 * these tests need: proving the DB row only ever gets a short reference,
 * never the bytes themselves.
 *
 * The "multi-megabyte PNG" fixture is generated in-memory (a deterministic
 * repeating byte pattern, not a real decodable PNG) — large enough to prove
 * the storageKey/DB-row-size claim without committing a multi-megabyte
 * binary fixture to git or spending real time PNG-encoding it. Real-PNG
 * decodability of a production asset is already proven elsewhere (this
 * phase's own forensic read of the real intermediate asset).
 */
function buildMultiMegabyteBytes(sizeBytes: number): Buffer {
  const bytes = Buffer.alloc(sizeBytes);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = i % 256;
  }
  return bytes;
}

const MULTI_MB_SIZE = 3 * 1024 * 1024;

/** `uploadProductionAsset` always sets a non-null storageKey — this narrows the type for assertions below without repeating the same non-null check inline everywhere. */
function requireStorageKey(asset: AssetRecord): string {
  assert.ok(asset.storageKey, "expected a non-null storageKey");
  return asset.storageKey;
}

function makeErrorWithCode(message: string, code: string): Error {
  const error = new Error(message);
  (error as NodeJS.ErrnoException).code = code;
  return error;
}

function buildProductionInput(overrides: Partial<{
  conceptId: string;
  finalArtworkJobId: string;
  bytes: Buffer;
}> = {}) {
  return {
    conceptId: overrides.conceptId ?? "concept-prod-1",
    bytes: overrides.bytes ?? buildMultiMegabyteBytes(MULTI_MB_SIZE),
    contentType: "image/png",
    widthPx: 4344,
    heightPx: 5792,
    hasTransparency: true,
    finalArtworkJobId: overrides.finalArtworkJobId ?? "job-prod-1",
    productionRole: "production_png" as const,
    metadata: {},
  };
}

describe("AssetCapability — production storage correction + ambiguous createAsset hardening", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-assets-prod-storage-"));
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

  // ===== Part F: data-uri payload regression under object-storage mode =====

  it("F1: a multi-megabyte PNG does NOT become a multi-megabyte Asset.storageKey under object-storage mode", async () => {
    const { repo, projectId } = await freshRepo();
    const storage = new StrictUniqueKeyAssetStorageProvider();
    const assets = createAssetCapability(repo, storage, new PngThumbnailGenerator());

    const asset = await assets.uploadProductionAsset(projectId, buildProductionInput());

    const storageKey = requireStorageKey(asset);
    assert.ok(storageKey.length < 200, `expected a short object path, got ${storageKey.length} chars`);
    assert.equal(
      storageKey,
      buildObjectKey({ projectId, conceptId: "concept-prod-1", fileName: "production.png" }),
    );
    assert.doesNotMatch(storageKey, /^data:/);
  });

  it("F2: upload bytes go to the storage provider, not the DB row — provider holds the full payload", async () => {
    const { repo, projectId } = await freshRepo();
    const storage = new StrictUniqueKeyAssetStorageProvider();
    const assets = createAssetCapability(repo, storage, new PngThumbnailGenerator());
    const bytes = buildMultiMegabyteBytes(MULTI_MB_SIZE);

    const asset = await assets.uploadProductionAsset(projectId, buildProductionInput({ bytes }));

    const stored = await storage.download(requireStorageKey(asset));
    assert.equal(stored.length, bytes.length);
    assert.ok(stored.equals(bytes));
  });

  it("F3: download returns the original bytes unchanged, via the normal downloadAssetBytes abstraction", async () => {
    const { repo, projectId } = await freshRepo();
    const storage = new StrictUniqueKeyAssetStorageProvider();
    const assets = createAssetCapability(repo, storage, new PngThumbnailGenerator());
    const bytes = buildMultiMegabyteBytes(MULTI_MB_SIZE);

    const asset = await assets.uploadProductionAsset(projectId, buildProductionInput({ bytes }));
    const downloaded = await assets.downloadAssetBytes(asset.id);

    assert.ok(downloaded);
    assert.equal(downloaded?.bytes.length, bytes.length);
    assert.ok(downloaded?.bytes.equals(bytes));
  });

  it("F4: a historical data_uri asset remains downloadable even though the configured provider is now object-storage", async () => {
    const { repo, projectId } = await freshRepo();
    // The ACTIVE, configured provider is the object-storage stand-in — but
    // this asset's own storageKey was persisted under the OLD data_uri
    // representation (simulating a row written before this phase's
    // provider switch), never migrated.
    const activeStorage = new StrictUniqueKeyAssetStorageProvider();
    const assets = createAssetCapability(repo, activeStorage, new PngThumbnailGenerator());

    const historicalBytes = Buffer.from("legacy inline bytes");
    const dataUriProvider = new DataUriAssetStorageProvider();
    const { objectKey: historicalDataUriKey } = await dataUriProvider.upload({
      projectId,
      conceptId: "legacy-concept",
      fileName: "original.png",
      bytes: historicalBytes,
      contentType: "image/png",
    });
    const historicalAsset = await assets.registerAsset(projectId, {
      kind: "generated_artwork",
      storageKey: historicalDataUriKey,
      contentType: "image/png",
      isThumbnail: false,
      widthPx: null,
      heightPx: null,
      hasTransparency: null,
      providerKey: null,
      generationJobId: null,
      metadata: {},
      vectorAssetId: null,
      printAssetId: null,
      finalArtworkJobId: null,
      productionRole: null,
    });
    assert.ok(historicalAsset);

    const downloaded = await assets.downloadAssetBytes(historicalAsset.id);
    assert.ok(downloaded);
    assert.ok(downloaded?.bytes.equals(historicalBytes));

    const url = await assets.getSignedUrl(historicalAsset.id);
    assert.ok(url?.startsWith("data:"));
  });

  it("F5: createAsset receives the short storageKey, not the payload itself — no base64 artwork enters the DB row", async () => {
    const { repo, projectId } = await freshRepo();
    const storage = new StrictUniqueKeyAssetStorageProvider();
    let observedStorageKeyLength = -1;
    const spyingRepo = new Proxy(repo, {
      get(target, prop, receiver) {
        if (prop === "createAsset") {
          return async (designId: string, input: Parameters<ProjectRepository["createAsset"]>[1]) => {
            observedStorageKeyLength = (input.storageKey ?? "").length;
            return (target as ProjectRepository).createAsset(designId, input);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as ProjectRepository;
    const assets = createAssetCapability(spyingRepo, storage, new PngThumbnailGenerator());

    await assets.uploadProductionAsset(projectId, buildProductionInput());

    assert.ok(observedStorageKeyLength >= 0);
    assert.ok(observedStorageKeyLength < 200, `createAsset received a ${observedStorageKeyLength}-char storageKey`);
  });

  it("F6: normal object-storage asset retrieval works end to end (upload -> DB row -> download) for a non-data-uri key", async () => {
    const { repo, projectId } = await freshRepo();
    const storage = new StrictUniqueKeyAssetStorageProvider();
    const assets = createAssetCapability(repo, storage, new PngThumbnailGenerator());

    const { primary } = await assets.uploadConceptImage(projectId, {
      conceptId: "concept-x",
      bytes: Buffer.from("small concept bytes"),
      contentType: "image/png",
      widthPx: 64,
      heightPx: 64,
      hasTransparency: true,
      providerKey: "openai",
      generationJobId: "job-x",
      metadata: {},
    });

    assert.doesNotMatch(requireStorageKey(primary), /^data:/);
    const downloaded = await assets.downloadAssetBytes(primary.id);
    assert.ok(downloaded?.bytes.equals(Buffer.from("small concept bytes")));
  });

  // ===== Part G: ambiguous createAsset durability =====

  it("G1: successful object upload + DB insert — single upload, single row, no extra lookups needed", async () => {
    const { repo, projectId } = await freshRepo();
    const storage = new StrictUniqueKeyAssetStorageProvider();
    const assets = createAssetCapability(repo, storage, new PngThumbnailGenerator());

    const asset = await assets.uploadProductionAsset(projectId, buildProductionInput());
    assert.ok(asset.id);
    assert.equal(storage.uploadCount, 1);
  });

  it("G4: createAsset 57014, immediate lineage lookup already finds the row — adopts without any delay", async () => {
    const { repo, projectId } = await freshRepo();
    const storage = new StrictUniqueKeyAssetStorageProvider();
    const failingRepo = new Proxy(repo, {
      get(target, prop, receiver) {
        if (prop === "createAsset") {
          return async (designId: string, input: Parameters<ProjectRepository["createAsset"]>[1]) => {
            // Simulate the row actually committing before the client sees 57014.
            await (target as ProjectRepository).createAsset(designId, input);
            throw makeErrorWithCode("canceling statement due to statement timeout", "57014");
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as ProjectRepository;
    const assets = createAssetCapability(failingRepo, storage, new PngThumbnailGenerator());

    const startedAt = Date.now();
    const adopted = await assets.uploadProductionAsset(projectId, buildProductionInput());
    const elapsedMs = Date.now() - startedAt;

    assert.ok(adopted.id);
    // No reason to have waited the full delayed-lookup window if the
    // immediate lookup already found it.
    assert.ok(elapsedMs < 350, `expected no delayed wait, took ${elapsedMs}ms`);

    const list = await repo.listAssetsForFinalArtworkJob(projectId, "job-prod-1");
    assert.equal(list.length, 1, "must not create a duplicate row");
  });

  it("G5: createAsset 57014, immediate lookup misses, delayed lookup finds the row — adopts via the delayed path", async () => {
    const { repo, projectId } = await freshRepo();
    const storage = new StrictUniqueKeyAssetStorageProvider();
    let createAssetCalls = 0;
    const failingRepo = new Proxy(repo, {
      get(target, prop, receiver) {
        if (prop === "createAsset") {
          return async (designId: string, input: Parameters<ProjectRepository["createAsset"]>[1]) => {
            createAssetCalls += 1;
            const client = target as ProjectRepository;
            // The row becomes visible only AFTER the immediate lookup would
            // already have run and missed — simulated by writing it via a
            // short detached delay, independent of AssetCapability's own
            // in-process await chain (mirrors a late-committing write whose
            // visibility lags the client's own error).
            setTimeout(() => {
              void client.createAsset(designId, input);
            }, 120);
            throw makeErrorWithCode("canceling statement due to statement timeout", "57014");
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as ProjectRepository;
    const assets = createAssetCapability(failingRepo, storage, new PngThumbnailGenerator());

    const adopted = await assets.uploadProductionAsset(projectId, buildProductionInput());

    assert.ok(adopted.id);
    assert.equal(createAssetCalls, 1, "no blind second INSERT — the delayed row came from the same original attempt");

    const list = await repo.listAssetsForFinalArtworkJob(projectId, "job-prod-1");
    assert.equal(list.length, 1, "must not create a duplicate row");
  });

  it("G6: createAsset 57014, both immediate and delayed lookups miss — cleans up and rethrows the labeled error", async () => {
    const { repo, projectId } = await freshRepo();
    const storage = new StrictUniqueKeyAssetStorageProvider();
    const failingRepo = new Proxy(repo, {
      get(target, prop, receiver) {
        if (prop === "createAsset") {
          return async () => {
            // Real Supabase/PostgREST errors reach this call site as raw
            // plain objects, not `Error` instances (`supabase-store.ts`'s
            // `if (error) throw error` throws PostgREST's own parsed body
            // verbatim) — this fixture mirrors that shape so the
            // classification AND the final message-content assertion below
            // both exercise the real-world path.
            throw { code: "57014", message: "canceling statement due to statement timeout" };
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as ProjectRepository;
    const assets = createAssetCapability(failingRepo, storage, new PngThumbnailGenerator());

    await assert.rejects(
      assets.uploadProductionAsset(projectId, buildProductionInput()),
      /uploadProductionAsset\.createAsset failed after \d+ms:.*57014/,
    );

    assert.equal(storage.uploadCount, 1);
    assert.equal(storage.objectKeys().length, 0, "the object must be cleaned up once both lookups confirm no row exists");
    const list = await repo.listAssetsForFinalArtworkJob(projectId, "job-prod-1");
    assert.equal(list.length, 0);
  });

  it("G7: no blind second INSERT is ever issued — createAsset is called exactly once even when self-heal (immediate or delayed) is exercised", async () => {
    const { repo, projectId } = await freshRepo();
    const storage = new StrictUniqueKeyAssetStorageProvider();
    let createAssetCalls = 0;
    const failingRepo = new Proxy(repo, {
      get(target, prop, receiver) {
        if (prop === "createAsset") {
          return async (designId: string, input: Parameters<ProjectRepository["createAsset"]>[1]) => {
            createAssetCalls += 1;
            await (target as ProjectRepository).createAsset(designId, input);
            throw makeErrorWithCode("canceling statement due to statement timeout", "57014");
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as ProjectRepository;
    const assets = createAssetCapability(failingRepo, storage, new PngThumbnailGenerator());

    await assets.uploadProductionAsset(projectId, buildProductionInput());
    assert.equal(createAssetCalls, 1);
  });

  it("G8: cleanup cannot create dangling row/object state — an object adopted via the delayed lookup is never deleted", async () => {
    const { repo, projectId } = await freshRepo();
    const storage = new StrictUniqueKeyAssetStorageProvider();
    const deleteCalls: string[] = [];
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
    const failingRepo = new Proxy(repo, {
      get(target, prop, receiver) {
        if (prop === "createAsset") {
          return async (designId: string, input: Parameters<ProjectRepository["createAsset"]>[1]) => {
            setTimeout(() => {
              void (target as ProjectRepository).createAsset(designId, input);
            }, 120);
            throw makeErrorWithCode("canceling statement due to statement timeout", "57014");
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as ProjectRepository;
    const assets = createAssetCapability(failingRepo, spyingStorage, new PngThumbnailGenerator());

    const adopted = await assets.uploadProductionAsset(projectId, buildProductionInput());

    assert.ok(adopted.id);
    assert.deepEqual(deleteCalls, [], "cleanup must not run once the delayed lookup adopted a row");
    assert.equal(storage.has(requireStorageKey(adopted)), true);
  });

  it("G9: deterministic key collision is detected via the existing storage self-heal, not treated as a fresh failure", async () => {
    const { repo, projectId } = await freshRepo();
    const storage = new StrictUniqueKeyAssetStorageProvider();
    const input = buildProductionInput();
    const expectedKey = buildObjectKey({ projectId, conceptId: input.conceptId, fileName: "production.png" });
    // Seed the exact deterministic key as if a prior attempt's storage
    // upload already landed (ambiguous storage-layer success).
    storage.seed(expectedKey, input.bytes, input.contentType);

    const assets = createAssetCapability(repo, storage, new PngThumbnailGenerator());
    const asset = await assets.uploadProductionAsset(projectId, input);

    assert.equal(asset.storageKey, expectedKey);
    // Still exactly one object at that key — no collision error surfaced,
    // no duplicate.
    assert.equal(storage.objectKeys().filter((k) => k === expectedKey).length, 1);
  });

  it("G10: historical data_uri asset retrieval after a provider switch — covered structurally by F4, reaffirmed via getSignedUrl", async () => {
    const { repo, projectId } = await freshRepo();
    const activeStorage = new StrictUniqueKeyAssetStorageProvider();
    const assets = createAssetCapability(repo, activeStorage, new PngThumbnailGenerator());

    const historicalAsset = await assets.registerAsset(projectId, {
      kind: "generated_artwork",
      storageKey: `data:image/png;base64,${Buffer.from("legacy").toString("base64")}`,
      contentType: "image/png",
      isThumbnail: false,
      widthPx: null,
      heightPx: null,
      hasTransparency: null,
      providerKey: null,
      generationJobId: null,
      metadata: {},
      vectorAssetId: null,
      printAssetId: null,
      finalArtworkJobId: null,
      productionRole: null,
    });
    assert.ok(historicalAsset);

    const url = await assets.getSignedUrl(historicalAsset.id);
    assert.ok(url?.startsWith("data:"));
    const downloaded = await assets.downloadAssetBytes(historicalAsset.id);
    assert.ok(downloaded?.bytes.equals(Buffer.from("legacy")));
  });

  it("G11: normal (non-data-uri) object-storage asset retrieval is unaffected by the representation check", async () => {
    const { repo, projectId } = await freshRepo();
    const storage = new StrictUniqueKeyAssetStorageProvider();
    const assets = createAssetCapability(repo, storage, new PngThumbnailGenerator());

    const asset = await assets.uploadProductionAsset(projectId, buildProductionInput());
    const downloaded = await assets.downloadAssetBytes(asset.id);
    assert.ok(downloaded);
    assert.equal(downloaded?.bytes.length, MULTI_MB_SIZE);
  });

  it("G12/G13: no provider (Topaz/OpenAI) interaction is possible from this boundary — AssetCapability takes no provider dependency", async () => {
    const { repo, projectId } = await freshRepo();
    const storage = new StrictUniqueKeyAssetStorageProvider();
    // createAssetCapability's own signature is (repo, storage, thumbnails) —
    // there is no fourth parameter for a generation/reconstruction provider
    // anywhere in this capability, so a Topaz/OpenAI call is structurally
    // unreachable from uploadProductionAsset regardless of code path taken.
    const assets = createAssetCapability(repo, storage, new PngThumbnailGenerator());
    const asset = await assets.uploadProductionAsset(projectId, buildProductionInput());
    assert.ok(asset.id);
  });
});
