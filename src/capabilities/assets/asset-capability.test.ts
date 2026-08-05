import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";
import { DataUriAssetStorageProvider } from "@/capabilities/asset-storage";
import type { AssetStorageProvider } from "@/capabilities/asset-storage";
import type { ProjectRepository } from "@/lib/db/repository";
import { createAssetCapability } from "./asset-capability";
import { PngThumbnailGenerator } from "./png-thumbnail-generator";

function buildAssets(repo: ProjectRepository) {
  return createAssetCapability(
    repo,
    new DataUriAssetStorageProvider(),
    new PngThumbnailGenerator(),
  );
}

describe("AssetCapability", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-assets-"));
    process.chdir(tempDir);
  });

  after(async () => {
    await cleanupTempWorkspace(tempDir, previousCwd);
  });

  it("returns an empty list for a design with no assets", async () => {
    const { LocalProjectRepository } = await import("@/lib/db/local-store");
    const assets = buildAssets(new LocalProjectRepository());
    const list = await assets.listAssets("no-such-project");
    assert.deepEqual(list, []);
  });

  it("registers an asset and can list it back with all fields intact", async () => {
    const { LocalProjectRepository } = await import("@/lib/db/local-store");
    const repo = new LocalProjectRepository();
    const created = await repo.createProject();
    const assets = buildAssets(repo);

    const registered = await assets.registerAsset(created.project.id, {
      kind: "generated_artwork",
      storageKey: "data:image/png;base64,AAAA",
      contentType: "image/png",
      isThumbnail: false,
      widthPx: 1024,
      heightPx: 1024,
      hasTransparency: true,
      providerKey: "openai",
      generationJobId: null,
      metadata: { generatedAt: "2026-08-05T00:00:00.000Z" },
      vectorAssetId: null,
      printAssetId: null,
    });

    assert.ok(registered);
    assert.equal(registered?.projectId, created.project.id);
    assert.equal(registered?.kind, "generated_artwork");
    assert.equal(registered?.widthPx, 1024);
    assert.equal(registered?.hasTransparency, true);

    const list = await assets.listAssets(created.project.id);
    assert.equal(list.length, 1);
    assert.equal(list[0]?.id, registered?.id);
  });

  it("scopes listing to the requested design only", async () => {
    const { LocalProjectRepository } = await import("@/lib/db/local-store");
    const repo = new LocalProjectRepository();
    const assets = buildAssets(repo);
    const first = await repo.createProject();
    const second = await repo.createProject();

    await assets.registerAsset(first.project.id, {
      kind: "generated_artwork",
      storageKey: "data:image/png;base64,AAAA",
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
    });

    const listForSecond = await assets.listAssets(second.project.id);
    assert.deepEqual(listForSecond, []);
  });

  it("never persists prompt text or credentials in asset metadata by construction", async () => {
    const { LocalProjectRepository } = await import("@/lib/db/local-store");
    const repo = new LocalProjectRepository();
    const created = await repo.createProject();
    const assets = buildAssets(repo);

    const registered = await assets.registerAsset(created.project.id, {
      kind: "generated_artwork",
      storageKey: "data:image/png;base64,AAAA",
      contentType: "image/png",
      isThumbnail: false,
      widthPx: 1024,
      heightPx: 1024,
      hasTransparency: true,
      providerKey: "openai",
      generationJobId: null,
      metadata: { generatedAt: "2026-08-05T00:00:00.000Z", sizeRequested: "1024x1024" },
      vectorAssetId: null,
      printAssetId: null,
    });

    const serialized = JSON.stringify(registered?.metadata ?? {});
    assert.doesNotMatch(serialized, /sk-|api[_-]?key|revised_prompt/i);
  });

  describe("uploadConceptImage (Sprint 2H Part 2A)", () => {
    it("uploads the original, generates a thumbnail, and persists both as linked records", async () => {
      const { LocalProjectRepository } = await import("@/lib/db/local-store");
      const repo = new LocalProjectRepository();
      const created = await repo.createProject();
      const assets = buildAssets(repo);

      const { PNG } = await import("pngjs");
      const png = new PNG({ width: 64, height: 64 });
      png.data.fill(120);

      const { primary, thumbnail } = await assets.uploadConceptImage(created.project.id, {
        conceptId: "concept-1",
        bytes: PNG.sync.write(png),
        contentType: "image/png",
        widthPx: 64,
        heightPx: 64,
        hasTransparency: true,
        providerKey: "openai",
        generationJobId: "job-1",
        metadata: { generatedAt: "2026-08-05T00:00:00.000Z" },
      });

      assert.equal(primary.isThumbnail, false);
      assert.equal(primary.projectId, created.project.id);
      assert.ok(primary.storageKey);
      assert.ok(thumbnail);
      assert.equal(thumbnail?.isThumbnail, true);
      assert.notEqual(thumbnail?.id, primary.id);

      const list = await assets.listAssets(created.project.id);
      assert.equal(list.length, 2);
    });

    it("still persists the primary asset when thumbnail generation isn't possible (non-fatal)", async () => {
      const { LocalProjectRepository } = await import("@/lib/db/local-store");
      const repo = new LocalProjectRepository();
      const created = await repo.createProject();
      const assets = buildAssets(repo);

      const { primary, thumbnail } = await assets.uploadConceptImage(created.project.id, {
        conceptId: "concept-1",
        bytes: Buffer.from("not a real png"),
        contentType: "image/png",
        widthPx: null,
        heightPx: null,
        hasTransparency: null,
        providerKey: "openai",
        generationJobId: null,
        metadata: {},
      });

      assert.ok(primary);
      assert.equal(thumbnail, null);
      const list = await assets.listAssets(created.project.id);
      assert.equal(list.length, 1);
    });

    it("cleans up the orphaned upload if persisting the primary asset record fails", async () => {
      const { LocalProjectRepository } = await import("@/lib/db/local-store");
      const repo = new LocalProjectRepository();
      const created = await repo.createProject();

      const storage: AssetStorageProvider = new DataUriAssetStorageProvider();
      const deleted: string[] = [];
      const spyingStorage: AssetStorageProvider = {
        storageKey: storage.storageKey,
        upload: storage.upload.bind(storage),
        getSignedUrl: storage.getSignedUrl.bind(storage),
        delete: async (objectKey: string) => {
          deleted.push(objectKey);
          return storage.delete(objectKey);
        },
      };

      const failingRepo = new Proxy(repo, {
        get(target, prop, receiver) {
          if (prop === "createAsset") {
            return async () => {
              throw new Error("simulated database failure");
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      }) as ProjectRepository;

      const assets = createAssetCapability(
        failingRepo,
        spyingStorage,
        new PngThumbnailGenerator(),
      );

      await assert.rejects(
        assets.uploadConceptImage(created.project.id, {
          conceptId: "concept-1",
          bytes: Buffer.from("bytes"),
          contentType: "image/png",
          widthPx: null,
          heightPx: null,
          hasTransparency: null,
          providerKey: "openai",
          generationJobId: null,
          metadata: {},
        }),
        /simulated database failure/,
      );

      // Asset Cleanup: the upload that already landed in storage must not
      // be left orphaned when the database write that would reference it
      // fails.
      assert.equal(deleted.length, 1);
    });

    it("logs cleanup failures internally without throwing further", async () => {
      const { LocalProjectRepository } = await import("@/lib/db/local-store");
      const repo = new LocalProjectRepository();
      const created = await repo.createProject();

      const originalError = console.error;
      const errorCalls: unknown[][] = [];
      console.error = (...args: unknown[]) => {
        errorCalls.push(args);
      };

      try {
        const brokenStorage = {
          storageKey: "broken",
          upload: async () => ({ objectKey: "projects/x/concepts/y/original.png" }),
          getSignedUrl: async (objectKey: string) => objectKey,
          delete: async () => {
            throw new Error("cleanup also failed");
          },
        };
        const failingRepo = new Proxy(repo, {
          get(target, prop, receiver) {
            if (prop === "createAsset") {
              return async () => {
                throw new Error("simulated database failure");
              };
            }
            return Reflect.get(target, prop, receiver);
          },
        }) as ProjectRepository;
        const assets = createAssetCapability(
          failingRepo,
          brokenStorage,
          new PngThumbnailGenerator(),
        );

        await assert.rejects(
          assets.uploadConceptImage(created.project.id, {
            conceptId: "concept-1",
            bytes: Buffer.from("bytes"),
            contentType: "image/png",
            widthPx: null,
            heightPx: null,
            hasTransparency: null,
            providerKey: null,
            generationJobId: null,
            metadata: {},
          }),
        );

        assert.ok(errorCalls.length >= 1);
      } finally {
        console.error = originalError;
      }
    });
  });

  describe("getSignedUrl / deleteAsset (Sprint 2H Part 2A)", () => {
    it("returns a signed URL for an existing asset and null for one that doesn't exist", async () => {
      const { LocalProjectRepository } = await import("@/lib/db/local-store");
      const repo = new LocalProjectRepository();
      const created = await repo.createProject();
      const assets = buildAssets(repo);

      const registered = await assets.registerAsset(created.project.id, {
        kind: "generated_artwork",
        storageKey: "data:image/png;base64,AAAA",
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
      });
      assert.ok(registered);

      const url = await assets.getSignedUrl(registered.id);
      assert.ok(url);

      const missing = await assets.getSignedUrl("00000000-0000-0000-0000-000000000000");
      assert.equal(missing, null);
    });

    it("clamps signed URL expiry to the bounded maximum", async () => {
      const { LocalProjectRepository } = await import("@/lib/db/local-store");
      const {
        DEFAULT_SIGNED_URL_EXPIRY_SECONDS,
        MAX_SIGNED_URL_EXPIRY_SECONDS,
      } = await import("./asset-capability");

      assert.equal(DEFAULT_SIGNED_URL_EXPIRY_SECONDS, 300);
      assert.equal(MAX_SIGNED_URL_EXPIRY_SECONDS, 900);
      assert.ok(MAX_SIGNED_URL_EXPIRY_SECONDS >= DEFAULT_SIGNED_URL_EXPIRY_SECONDS);

      const repo = new LocalProjectRepository();
      const created = await repo.createProject();

      const seenExpiries: number[] = [];
      const storage: AssetStorageProvider = {
        storageKey: "probe",
        upload: async () => ({ objectKey: "projects/p/concepts/c/original.png" }),
        getSignedUrl: async (_key, expiresInSeconds) => {
          seenExpiries.push(expiresInSeconds);
          return `signed://${expiresInSeconds}`;
        },
        delete: async () => undefined,
      };

      const assets = createAssetCapability(repo, storage, new PngThumbnailGenerator());
      const registered = await assets.registerAsset(created.project.id, {
        kind: "generated_artwork",
        storageKey: "projects/p/concepts/c/original.png",
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
      });
      assert.ok(registered);

      await assets.getSignedUrl(registered.id);
      await assets.getSignedUrl(registered.id, 60);
      await assets.getSignedUrl(registered.id, 60_000);
      await assets.getSignedUrl(registered.id, -5);

      assert.deepEqual(seenExpiries, [
        DEFAULT_SIGNED_URL_EXPIRY_SECONDS,
        60,
        MAX_SIGNED_URL_EXPIRY_SECONDS,
        DEFAULT_SIGNED_URL_EXPIRY_SECONDS,
      ]);
    });

    it("deleteAsset removes both the stored bytes and the record", async () => {
      const { LocalProjectRepository } = await import("@/lib/db/local-store");
      const repo = new LocalProjectRepository();
      const created = await repo.createProject();
      const assets = buildAssets(repo);

      const { primary } = await assets.uploadConceptImage(created.project.id, {
        conceptId: "concept-1",
        bytes: Buffer.from("bytes"),
        contentType: "image/png",
        widthPx: null,
        heightPx: null,
        hasTransparency: null,
        providerKey: null,
        generationJobId: null,
        metadata: {},
      });

      await assets.deleteAsset(primary.id);

      const list = await assets.listAssets(created.project.id);
      assert.equal(list.find((a) => a.id === primary.id), undefined);
      assert.equal(await repo.getAssetById(primary.id), null);
    });
  });
});
