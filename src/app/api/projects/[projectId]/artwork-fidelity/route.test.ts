/**
 * Universal Raster Reconstruction Phase R4A-R (independent-review repair,
 * Blocker 2 + Section 12/24): the real route handler, in-process — proves
 * the route itself cannot be used to bypass `confirmArtworkFidelity`'s own
 * server-side completeness validation. Mirrors
 * `sign-artwork/authorize/route.test.ts`'s own "call POST directly, real
 * Request object, local persistence only" pattern.
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { PNG } from "pngjs";

import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";

function pngBytes(): Buffer {
  const png = new PNG({ width: 20, height: 20 });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = 10;
    png.data[i + 1] = 20;
    png.data[i + 2] = 30;
    png.data[i + 3] = 255;
  }
  return PNG.sync.write(png);
}

describe("POST /api/projects/[projectId]/artwork-fidelity", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-fidelity-route-"));
    process.chdir(tempDir);
  });

  after(async () => {
    await cleanupTempWorkspace(tempDir, previousCwd);
  });

  async function freshProjectWithUpload() {
    const { resetCapabilityGraphForTests } = await import("@/capabilities/composition");
    resetCapabilityGraphForTests();
    const { getProjectRepository } = await import("@/lib/db");
    const created = await getProjectRepository().createProject();
    const projectId = created.project.id;

    const { POST: uploadRoute } = await import("../artwork-upload/route");
    const form = new FormData();
    form.append("file", new File([new Uint8Array(pngBytes())], "logo.png", { type: "image/png" }));
    const uploadResponse = await uploadRoute(
      new Request("http://localhost/upload", { method: "POST", body: form }),
      { params: Promise.resolve({ projectId }) },
    );
    assert.equal(uploadResponse.status, 200);
    return projectId;
  }

  async function post(projectId: string, body: unknown) {
    const { POST } = await import("./route");
    return POST(
      new Request("http://localhost/artwork-fidelity", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ projectId }) },
    );
  }

  it("propose succeeds and returns an artworkFidelity view with proposalStatus", async () => {
    const projectId = await freshProjectWithUpload();
    const response = await post(projectId, { action: "propose" });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { artworkFidelity?: { status: string; proposalStatus: string } };
    assert.equal(body.artworkFidelity?.status, "proposed");
    assert.ok(body.artworkFidelity?.proposalStatus === "analyzed" || body.artworkFidelity?.proposalStatus === "unavailable");
  });

  it("REPAIR: a malformed confirm request (unknown enum shape) is rejected with 400 by the request-shape schema", async () => {
    const projectId = await freshProjectWithUpload();
    await post(projectId, { action: "propose" });

    const response = await post(projectId, {
      action: "confirm",
      wordingResolutions: "not-an-array",
      markResolutions: [],
    });
    assert.equal(response.status, 400);
  });

  it("REPAIR: an invalid mark token (including NOT_SURE) is rejected with 400 by the request-shape schema, never reaching the validator", async () => {
    const projectId = await freshProjectWithUpload();
    await post(projectId, { action: "propose" });

    const response = await post(projectId, {
      action: "confirm",
      wordingResolutions: [],
      markResolutions: [{ id: "m0", mark: "NOT_SURE" }],
    });
    assert.equal(response.status, 400);
  });

  it("REPAIR: an incomplete confirm (proposal's catch-all mark region left unresolved) is rejected with 400 by the service-level validator", async () => {
    const projectId = await freshProjectWithUpload();
    await post(projectId, { action: "propose" });

    // Well-formed per the wire schema, but omits the required catch-all
    // mark resolution entirely -- exactly the "server accepted an
    // incomplete confirmation" scenario the independent review proved.
    const response = await post(projectId, {
      action: "confirm",
      wordingResolutions: [],
      markResolutions: [],
    });
    assert.equal(response.status, 400);
    const body = (await response.json()) as { error?: string };
    assert.match(body.error ?? "", /region/i);

    // No partial mutation -- still proposed, not confirmed.
    const { getCapabilityGraph } = await import("@/capabilities/composition");
    const stored = await getCapabilityGraph().artworkFidelity.getContract(projectId);
    assert.equal(stored!.status, "proposed");
  });

  it("a valid, complete confirmation (resolving the catch-all mark to None) is accepted and creates confirmed authority", async () => {
    const projectId = await freshProjectWithUpload();
    await post(projectId, { action: "propose" });

    const response = await post(projectId, {
      action: "confirm",
      wordingResolutions: [],
      markResolutions: [{ id: "m0", mark: "NONE" }],
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { artworkFidelity?: { status: string; confirmedMarks: string[] | null } };
    assert.equal(body.artworkFidelity?.status, "confirmed");
    assert.deepEqual(body.artworkFidelity?.confirmedMarks, []);
  });

  it("REPAIR: an unknown/invented proposal region id is rejected with 400, never silently accepted", async () => {
    const projectId = await freshProjectWithUpload();
    await post(projectId, { action: "propose" });

    const response = await post(projectId, {
      action: "confirm",
      wordingResolutions: [{ id: "w99-invented", text: "SOMETHING" }],
      markResolutions: [{ id: "m0", mark: "NONE" }],
    });
    assert.equal(response.status, 400);
  });

  it("REPAIR: confirm before any propose call is rejected, never silently treated as zero-completeness", async () => {
    const projectId = await freshProjectWithUpload();
    const response = await post(projectId, {
      action: "confirm",
      wordingResolutions: [],
      markResolutions: [],
    });
    assert.equal(response.status, 409);
  });

  it("PROJECT ISOLATION: the route accepts no contract/asset id in the payload -- a project can only ever act on its OWN latest contract", async () => {
    const projectA = await freshProjectWithUpload();
    const projectB = await freshProjectWithUpload();
    await post(projectA, { action: "propose" });
    await post(projectB, { action: "propose" });

    // Confirming project B's own proposal cannot be steered toward project
    // A's contract -- there is no field in the payload that could even
    // attempt to name it.
    const response = await post(projectB, {
      action: "confirm",
      wordingResolutions: [],
      markResolutions: [{ id: "m0", mark: "NONE" }],
    });
    assert.equal(response.status, 200);

    const { getCapabilityGraph } = await import("@/capabilities/composition");
    const contractA = await getCapabilityGraph().artworkFidelity.getContract(projectA);
    const contractB = await getCapabilityGraph().artworkFidelity.getContract(projectB);
    assert.equal(contractA!.status, "proposed");
    assert.equal(contractB!.status, "confirmed");
    assert.notEqual(contractA!.id, contractB!.id);
  });
});
