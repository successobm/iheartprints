import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { DataUriAssetStorageProvider } from "@/capabilities/asset-storage";
import { createAssetCapability, PngThumbnailGenerator } from "@/capabilities/assets";
import { createDesignBriefCapability } from "@/capabilities/design-brief";
import type { ProjectRepository } from "@/lib/db/repository";
import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";

import {
  alreadyTransparentArtwork,
  complexPhotographicBackgroundArtwork,
  getPixel,
  solidBlackExteriorArtwork,
  toPngBytes,
} from "./artwork-fixtures";
import {
  ArtworkPreparationStateError,
  createArtworkPreparationCapability,
} from "./artwork-preparation-capability";
import { decodePngUpload } from "./image-decode";
import { ArtworkUploadRejectedError } from "./upload-limits";

/**
 * End-to-end preparation against the real local repository and a real asset
 * storage provider — no mocks of persistence, and (by construction) no
 * provider of any kind to mock: nothing in this pipeline can make a network
 * call.
 */
describe("ArtworkPreparationCapability", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-artwork-prep-"));
    process.chdir(tempDir);
  });

  after(async () => {
    await cleanupTempWorkspace(tempDir, previousCwd);
  });

  async function freshRepo(): Promise<ProjectRepository> {
    const { LocalProjectRepository } = await import("@/lib/db/local-store");
    return new LocalProjectRepository();
  }

  async function build() {
    const repo = await freshRepo();
    const assets = createAssetCapability(
      repo,
      new DataUriAssetStorageProvider(),
      new PngThumbnailGenerator(),
    );
    const designBrief = createDesignBriefCapability(repo);
    const capability = createArtworkPreparationCapability(repo, assets, designBrief);
    const project = await repo.createProject();
    return { repo, assets, capability, projectId: project.project.id };
  }

  it("persists the original as an immutable customer_upload asset", async () => {
    const { repo, capability, projectId } = await build();
    const bytes = toPngBytes(solidBlackExteriorArtwork());

    const view = await capability.uploadOriginal(projectId, {
      bytes,
      declaredContentType: "image/png",
      filename: "bowling-logo.png",
    });

    assert.equal(view.status, "analyzed");
    assert.equal(view.originalFilename, "bowling-logo.png");
    assert.equal(view.widthPx, 120);

    const preparation = await repo.getArtworkPreparation(projectId);
    assert.ok(preparation);
    const stored = await repo.getAssetById(preparation!.originalAssetId);
    assert.equal(stored!.kind, "customer_upload");
    assert.equal(stored!.projectId, projectId);
    // Nothing generated these pixels.
    assert.equal(stored!.providerKey, null);
    assert.equal(stored!.generationJobId, null);
    assert.equal(stored!.finalArtworkJobId, null);
    assert.equal(stored!.productionRole, null);
  });

  it("J: the original bytes are byte-identical before and after preparation", async () => {
    const { repo, assets, capability, projectId } = await build();
    const bytes = toPngBytes(solidBlackExteriorArtwork());
    const uploadedHash = createHash("sha256").update(bytes).digest("hex");

    await capability.uploadOriginal(projectId, {
      bytes,
      declaredContentType: "image/png",
      filename: "logo.png",
    });
    const preparation = await repo.getArtworkPreparation(projectId);
    const originalAssetId = preparation!.originalAssetId;

    const before = await assets.downloadAssetBytes(originalAssetId);
    assert.equal(
      createHash("sha256").update(before!.bytes).digest("hex"),
      uploadedHash,
    );

    await capability.setProductionContext(projectId, { printPlacement: "full_front" });
    await capability.prepareBackground(projectId);
    await capability.approvePreparedArtwork(projectId);

    const after = await assets.downloadAssetBytes(originalAssetId);
    assert.equal(
      createHash("sha256").update(after!.bytes).digest("hex"),
      uploadedHash,
      "the customer's uploaded bytes must never change",
    );

    // The original asset ROW is untouched too, and the prepared asset is a
    // separate row rather than an overwrite.
    const reloaded = await repo.getArtworkPreparation(projectId);
    assert.equal(reloaded!.originalAssetId, originalAssetId);
    assert.notEqual(reloaded!.preparedAssetId, originalAssetId);
  });

  it("produces a NEW transparent PNG with lineage back to the original", async () => {
    const { repo, assets, capability, projectId } = await build();

    await capability.uploadOriginal(projectId, {
      bytes: toPngBytes(solidBlackExteriorArtwork()),
      declaredContentType: "image/png",
      filename: "logo.png",
    });
    await capability.prepareBackground(projectId);

    const preparation = await repo.getArtworkPreparation(projectId);
    assert.equal(preparation!.status, "prepared");
    assert.ok(preparation!.preparedAssetId);

    const prepared = await repo.getAssetById(preparation!.preparedAssetId!);
    assert.equal(prepared!.kind, "png");
    assert.equal(prepared!.hasTransparency, true);
    assert.equal(
      prepared!.metadata.derivedFromAssetId,
      preparation!.originalAssetId,
    );
    assert.equal(prepared!.metadata.artworkPreparationId, preparation!.id);

    const bytes = await assets.downloadAssetBytes(preparation!.preparedAssetId!);
    const decoded = decodePngUpload(bytes!.bytes);
    assert.equal(decoded.image.width, 120);
    assert.equal(decoded.image.height, 120);
    assert.equal(getPixel(decoded.image, 0, 0).a, 0);
    assert.equal(getPixel(decoded.image, 60, 60).a, 255);
  });

  it("is idempotent — preparing twice never creates a second prepared asset", async () => {
    const { repo, capability, projectId } = await build();
    await capability.uploadOriginal(projectId, {
      bytes: toPngBytes(solidBlackExteriorArtwork()),
      declaredContentType: "image/png",
      filename: "logo.png",
    });

    await capability.prepareBackground(projectId);
    const first = await repo.getArtworkPreparation(projectId);
    await capability.prepareBackground(projectId);
    const second = await repo.getArtworkPreparation(projectId);

    assert.equal(first!.preparedAssetId, second!.preparedAssetId);
    const preparedAssets = (await repo.listAssets(projectId)).filter(
      (asset) => asset.kind === "png",
    );
    assert.equal(preparedAssets.length, 1);
  });

  it("F: an already-transparent upload is re-encoded, never stripped", async () => {
    const { repo, assets, capability, projectId } = await build();
    const source = alreadyTransparentArtwork();

    await capability.uploadOriginal(projectId, {
      bytes: toPngBytes(source),
      declaredContentType: "image/png",
      filename: "transparent.png",
    });
    const view = await capability.prepareBackground(projectId);
    assert.equal(view.hasPreparedArtwork, true);

    const preparation = await repo.getArtworkPreparation(projectId);
    assert.equal(preparation!.preparation!.backgroundRemoved, false);
    assert.equal(preparation!.preparation!.exteriorPixelsRemoved, 0);

    const bytes = await assets.downloadAssetBytes(preparation!.preparedAssetId!);
    const decoded = decodePngUpload(bytes!.bytes);
    assert.ok(
      decoded.image.data.equals(source.data),
      "an already-transparent upload must survive preparation pixel for pixel",
    );
  });

  it("refuses to prepare artwork the analyzer flagged for review", async () => {
    const { capability, projectId } = await build();
    await capability.uploadOriginal(projectId, {
      bytes: toPngBytes(complexPhotographicBackgroundArtwork()),
      declaredContentType: "image/png",
      filename: "photo.png",
    });

    await assert.rejects(
      () => capability.prepareBackground(projectId),
      (error: unknown) => {
        assert.ok(error instanceof ArtworkPreparationStateError);
        assert.match(error.message, /designer needs to look at it/);
        return true;
      },
    );
  });

  it("creates a prepared_upload ArtworkVersion on approval — never a concept", async () => {
    const { repo, capability, projectId } = await build();
    await capability.uploadOriginal(projectId, {
      bytes: toPngBytes(solidBlackExteriorArtwork()),
      declaredContentType: "image/png",
      filename: "logo.png",
    });
    await capability.prepareBackground(projectId);

    const view = await capability.approvePreparedArtwork(projectId);
    assert.equal(view.approved, true);
    assert.equal(view.status, "approved");

    const preparation = await repo.getArtworkPreparation(projectId);
    assert.ok(preparation!.preparedArtworkVersionId);
    assert.ok(preparation!.approvedAt);

    const snapshot = await repo.getProject(projectId);
    const version = snapshot!.artworkVersions.find(
      (item) => item.id === preparation!.preparedArtworkVersionId,
    );
    assert.ok(version);
    assert.equal(version!.kind, "prepared_upload");
    assert.equal(version!.primaryAssetId, preparation!.preparedAssetId);
    // Provenance is never fabricated: no generation job, no provider, no
    // approved brief version authorized these pixels — the customer did.
    assert.equal(version!.generationJobId, null);
    assert.equal(version!.providerKey, null);
    assert.equal(version!.designBriefVersionId, null);
    assert.equal(version!.sourceArtworkVersionId ?? null, null);

    // Approval is NOT a production or print-readiness claim. Phase 2 does move
    // the project off "intake" — a customer who has uploaded artwork, given
    // production context, and approved a prepared file is plainly not sitting
    // in a brand-new, nothing-said-yet project — but "approved" means only
    // "the creative decision is settled", never that production ran.
    assert.equal(snapshot!.project.status, "approved");
    assert.notEqual(snapshot!.project.status, "print_ready");
    assert.notEqual(snapshot!.project.status, "finalizing");
    assert.equal(snapshot!.project.finalDirectionConfirmed, false);
    // Phase 1 must never enqueue generation work by approving preparation.
    assert.equal((await repo.listGenerationJobs(projectId)).length, 0);
    assert.equal(version!.generationJobId, null);
    const preparedAsset = (await repo.listAssets(projectId)).find(
      (asset) => asset.id === preparation!.preparedAssetId,
    );
    assert.ok(preparedAsset);
    assert.equal(preparedAsset!.finalArtworkJobId, null);
    assert.equal(preparedAsset!.productionRole, null);
  });

  it("approval is idempotent", async () => {
    const { repo, capability, projectId } = await build();
    await capability.uploadOriginal(projectId, {
      bytes: toPngBytes(solidBlackExteriorArtwork()),
      declaredContentType: "image/png",
      filename: "logo.png",
    });
    await capability.prepareBackground(projectId);
    await capability.approvePreparedArtwork(projectId);
    await capability.approvePreparedArtwork(projectId);

    const snapshot = await repo.getProject(projectId);
    assert.equal(snapshot!.artworkVersions.length, 1);
  });

  it("refuses to approve before anything has been prepared", async () => {
    const { capability, projectId } = await build();
    await capability.uploadOriginal(projectId, {
      bytes: toPngBytes(solidBlackExteriorArtwork()),
      declaredContentType: "image/png",
      filename: "logo.png",
    });

    await assert.rejects(
      () => capability.approvePreparedArtwork(projectId),
      /prepare the artwork first/,
    );
  });

  it("records production context on the brief without inventing creative content", async () => {
    const { repo, capability, projectId } = await build();
    await capability.uploadOriginal(projectId, {
      bytes: toPngBytes(solidBlackExteriorArtwork()),
      declaredContentType: "image/png",
      filename: "logo.png",
    });

    const view = await capability.setProductionContext(projectId, {
      productSummary: "T-shirts for our bowling team",
      productColor: "Black",
      printPlacement: "full_front",
    });

    assert.equal(view.productSummary, "T-shirts for our bowling team");
    assert.equal(view.printPlacement, "full_front");
    // The placement is what makes a print-size statement possible at all.
    assert.ok(view.customer.resolutionMessage);

    const snapshot = await repo.getProject(projectId);
    assert.equal(snapshot!.brief.shirtColor, "Black");
    // The pixels are the design: nothing writes a written description of them.
    assert.equal(snapshot!.brief.designDescription, null);
    assert.equal(snapshot!.brief.exactText, null);
    assert.equal(snapshot!.brief.designStyle, null);
  });

  it("re-analyzes when the placement changes, so the verdict never goes stale", async () => {
    const { capability, projectId } = await build();
    await capability.uploadOriginal(projectId, {
      bytes: toPngBytes(solidBlackExteriorArtwork()),
      declaredContentType: "image/png",
      filename: "logo.png",
    });

    const fullFront = await capability.setProductionContext(projectId, {
      printPlacement: "full_front",
    });
    assert.equal(fullFront.classification, "REQUIRES_ENHANCEMENT");
    assert.match(fullFront.customer.resolutionMessage!, /full front/);

    const sleeve = await capability.setProductionContext(projectId, {
      printPlacement: "sleeve",
    });
    assert.match(sleeve.customer.resolutionMessage!, /sleeve/);
    assert.doesNotMatch(sleeve.customer.resolutionMessage!, /full front/);
  });

  it("rejects an upload whose bytes are not a PNG", async () => {
    const { capability, projectId } = await build();
    await assert.rejects(
      () =>
        capability.uploadOriginal(projectId, {
          bytes: Buffer.from('<svg xmlns="x"></svg>'),
          declaredContentType: "image/png",
          filename: "logo.png",
        }),
      (error: unknown) => {
        assert.ok(error instanceof ArtworkUploadRejectedError);
        assert.equal(error.code, "svg_not_supported");
        return true;
      },
    );
  });

  it("never persists anything when an upload is rejected", async () => {
    const { repo, capability, projectId } = await build();
    await assert.rejects(() =>
      capability.uploadOriginal(projectId, {
        bytes: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]),
        declaredContentType: "image/jpeg",
        filename: "photo.jpg",
      }),
    );

    assert.equal(await repo.getArtworkPreparation(projectId), null);
    assert.equal((await repo.listAssets(projectId)).length, 0);
  });

  describe("cross-project ownership", () => {
    it("never resolves one project's preparation from another project", async () => {
      const { repo, capability, projectId } = await build();
      const otherProject = (await repo.createProject()).project.id;

      await capability.uploadOriginal(projectId, {
        bytes: toPngBytes(solidBlackExteriorArtwork()),
        declaredContentType: "image/png",
        filename: "logo.png",
      });
      await capability.prepareBackground(projectId);

      assert.ok(await capability.getPreparation(projectId));
      assert.equal(await capability.getPreparation(otherProject), null);
      assert.equal(
        await capability.resolveImageAssetId(otherProject, "original"),
        null,
      );
      assert.equal(
        await capability.resolveImageAssetId(otherProject, "prepared"),
        null,
      );

      await assert.rejects(
        () => capability.prepareBackground(otherProject),
        /no uploaded artwork/,
      );
      await assert.rejects(
        () => capability.approvePreparedArtwork(otherProject),
        /no uploaded artwork/,
      );
    });

    it("resolves image asset ids only for the owning project", async () => {
      const { capability, projectId } = await build();
      await capability.uploadOriginal(projectId, {
        bytes: toPngBytes(solidBlackExteriorArtwork()),
        declaredContentType: "image/png",
        filename: "logo.png",
      });

      assert.ok(await capability.resolveImageAssetId(projectId, "original"));
      // Nothing prepared yet — a role with no asset resolves to null rather
      // than falling back to a different image.
      assert.equal(await capability.resolveImageAssetId(projectId, "prepared"), null);
    });

    it("builds a project-scoped object key that never contains the customer's filename", async () => {
      // Against a REAL object-key backend (the data-URI store used elsewhere
      // in this suite has no key to inspect), so the path convention itself
      // is verified rather than assumed.
      const { FilesystemAssetStorageProvider } = await import(
        "@/capabilities/asset-storage"
      );
      const repo = await freshRepo();
      const assets = createAssetCapability(
        repo,
        new FilesystemAssetStorageProvider(),
        new PngThumbnailGenerator(),
      );
      const capability = createArtworkPreparationCapability(
        repo,
        assets,
        createDesignBriefCapability(repo),
      );
      const projectId = (await repo.createProject()).project.id;

      await capability.uploadOriginal(projectId, {
        bytes: toPngBytes(solidBlackExteriorArtwork()),
        declaredContentType: "image/png",
        filename: "../../../etc/passwd.png",
      });
      await capability.prepareBackground(projectId);

      const stored = await repo.listAssets(projectId);
      assert.ok(stored.length >= 2);
      for (const asset of stored) {
        assert.ok(
          asset.storageKey!.startsWith(`projects/${projectId}/`),
          `object key must stay project-scoped, got ${asset.storageKey}`,
        );
        assert.doesNotMatch(asset.storageKey!, /passwd/);
        assert.doesNotMatch(asset.storageKey!, /\.\./);
      }
    });

    it("refuses a second upload once artwork has been approved", async () => {
      const { capability, projectId } = await build();
      await capability.uploadOriginal(projectId, {
        bytes: toPngBytes(solidBlackExteriorArtwork()),
        declaredContentType: "image/png",
        filename: "logo.png",
      });
      await capability.prepareBackground(projectId);
      await capability.approvePreparedArtwork(projectId);

      await assert.rejects(
        () =>
          capability.uploadOriginal(projectId, {
            bytes: toPngBytes(solidBlackExteriorArtwork()),
            declaredContentType: "image/png",
            filename: "another.png",
          }),
        /already approved artwork/,
      );
    });
  });
});
