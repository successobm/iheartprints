import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import {
  bowlingStyleArtwork,
  solidBlackExteriorArtwork,
  toPngBytes,
} from "@/capabilities/artwork-preparation/artwork-fixtures";
import { MAX_UPLOAD_BYTES } from "@/capabilities/artwork-preparation";
import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";

/**
 * The upload ingress boundary end to end, through the real route handler.
 *
 * Every case here is a rejection or an authorization property — the pixel
 * behaviour lives in the capability's own suites. What this file proves is
 * that a hostile or malformed request never reaches them.
 */
describe("POST /api/projects/[projectId]/artwork-upload", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-artwork-upload-route-"));
    process.chdir(tempDir);
  });

  after(async () => {
    await cleanupTempWorkspace(tempDir, previousCwd);
  });

  async function freshProject() {
    const { resetCapabilityGraphForTests } = await import("@/capabilities/composition");
    resetCapabilityGraphForTests();
    const { getProjectRepository } = await import("@/lib/db");
    const created = await getProjectRepository().createProject();
    return created.project.id;
  }

  function uploadRequest(
    bytes: Buffer,
    options: { filename?: string; contentType?: string } = {},
  ): Request {
    const form = new FormData();
    form.append(
      "file",
      new File([new Uint8Array(bytes)], options.filename ?? "artwork.png", {
        type: options.contentType ?? "image/png",
      }),
    );
    return new Request("http://localhost/upload", { method: "POST", body: form });
  }

  async function post(projectId: string, request: Request) {
    const { POST } = await import("./route");
    return POST(request, { params: Promise.resolve({ projectId }) });
  }

  it("accepts a real PNG and returns the project snapshot with the preparation attached", async () => {
    const projectId = await freshProject();
    const response = await post(
      projectId,
      uploadRequest(toPngBytes(solidBlackExteriorArtwork()), {
        filename: "bowling-logo.png",
      }),
    );

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.artworkPreparation.status, "analyzed");
    assert.equal(body.artworkPreparation.originalFilename, "bowling-logo.png");
    // No internal identifiers of any kind reach the browser.
    const serialized = JSON.stringify(body.artworkPreparation);
    assert.doesNotMatch(serialized, /storageKey|objectKey|assetId|providerKey/i);
  });

  it("rejects an unsupported format with a customer-safe message", async () => {
    const projectId = await freshProject();
    const response = await post(
      projectId,
      uploadRequest(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]), {
        filename: "photo.jpg",
        contentType: "image/jpeg",
      }),
    );

    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.code, "unsupported_format");
    assert.match(body.error, /PNG/);
  });

  it("rejects SVG", async () => {
    const projectId = await freshProject();
    const response = await post(
      projectId,
      uploadRequest(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), {
        filename: "logo.svg",
        contentType: "image/svg+xml",
      }),
    );

    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, "svg_not_supported");
  });

  it("rejects a JPEG masquerading as a PNG by filename and content type", async () => {
    const projectId = await freshProject();
    const response = await post(
      projectId,
      uploadRequest(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]), {
        filename: "totally-a.png",
        contentType: "image/png",
      }),
    );

    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, "unsupported_format");
  });

  it("rejects a real PNG whose declared content type disagrees with its bytes", async () => {
    const projectId = await freshProject();
    const response = await post(
      projectId,
      uploadRequest(toPngBytes(solidBlackExteriorArtwork()), {
        filename: "logo.png",
        contentType: "image/webp",
      }),
    );

    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, "format_mismatch");
  });

  it("rejects a truncated PNG cleanly rather than as a server error", async () => {
    const projectId = await freshProject();
    const full = toPngBytes(bowlingStyleArtwork());
    const response = await post(
      projectId,
      uploadRequest(full.subarray(0, 2048), { filename: "truncated.png" }),
    );

    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, "malformed_image");
  });

  it("rejects an oversized encoded upload", async () => {
    const projectId = await freshProject();
    const oversized = Buffer.alloc(MAX_UPLOAD_BYTES + 1024);
    toPngBytes(solidBlackExteriorArtwork()).copy(oversized);

    const response = await post(projectId, uploadRequest(oversized));
    assert.equal(response.status, 413);
  });

  it("rejects a decompression bomb at the header, before any bitmap is allocated", async () => {
    const projectId = await freshProject();
    const bomb = Buffer.from(toPngBytes(solidBlackExteriorArtwork()));
    // Forge the IHDR to declare 30000x30000 (~3.6 GB decoded) in a file that
    // is only a few hundred bytes on the wire.
    bomb.writeUInt32BE(30_000, 16);
    bomb.writeUInt32BE(30_000, 20);

    const response = await post(projectId, uploadRequest(bomb, { filename: "bomb.png" }));
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, "image_too_large");
  });

  it("rejects a request with no file at all", async () => {
    const projectId = await freshProject();
    const response = await post(
      projectId,
      new Request("http://localhost/upload", {
        method: "POST",
        body: new FormData(),
      }),
    );

    assert.equal(response.status, 400);
  });

  it("sanitizes a traversal-shaped filename and never uses it as a storage path", async () => {
    const projectId = await freshProject();
    const response = await post(
      projectId,
      uploadRequest(toPngBytes(solidBlackExteriorArtwork()), {
        filename: "../../../etc/passwd.png",
      }),
    );

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.artworkPreparation.originalFilename, "passwd.png");

    const { getProjectRepository } = await import("@/lib/db");
    const assets = await getProjectRepository().listAssets(projectId);
    assert.ok(assets.length > 0);
    for (const asset of assets) {
      assert.ok(asset.storageKey);
      // The customer's filename is DISPLAY metadata. Whatever storage backend
      // is configured, no part of it may end up in the stored reference.
      assert.doesNotMatch(asset.storageKey!, /passwd/);
      assert.doesNotMatch(asset.storageKey!, /\.\./);
      // Object-key backends (filesystem, Supabase Storage) are always
      // project-scoped; the dev/test data-URI backend has no key at all.
      if (!asset.storageKey!.startsWith("data:")) {
        assert.ok(
          asset.storageKey!.startsWith(`projects/${projectId}/`),
          `object key must stay project-scoped, got ${asset.storageKey}`,
        );
      }
    }
  });

  it("scopes the upload to the addressed project and nothing else", async () => {
    const projectA = await freshProject();
    const projectB = await freshProject();

    await post(
      projectA,
      uploadRequest(toPngBytes(solidBlackExteriorArtwork()), { filename: "a.png" }),
    );

    const { getProjectRepository } = await import("@/lib/db");
    const repo = getProjectRepository();
    assert.ok(await repo.getArtworkPreparation(projectA));
    assert.equal(await repo.getArtworkPreparation(projectB), null);
    assert.equal((await repo.listAssets(projectB)).length, 0);
  });

  it("returns 404 for a project that does not exist", async () => {
    const response = await post(
      "00000000-0000-0000-0000-000000000000",
      uploadRequest(toPngBytes(solidBlackExteriorArtwork())),
    );
    assert.equal(response.status, 404);
  });
});
