import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import {
  exactAspectSignArtwork,
  ruthLikeSignArtwork,
  toPngBytes,
} from "@/capabilities/sign-preparation/sign-fixtures";
import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";

/**
 * LIVE PRODUCT BLOCKER #4: the customer's own self-service production-risk
 * authorization, through the real route handler. Local persistence only —
 * never the configured live project.
 */
describe("POST /api/projects/[projectId]/sign-artwork/authorize", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-sign-authorize-customer-"));
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

  async function uploadExistingArtwork(projectId: string, bytes: Buffer) {
    const { POST: uploadRoute } = await import("../../artwork-upload/route");
    const form = new FormData();
    form.append("file", new File([new Uint8Array(bytes)], "sign.png", { type: "image/png" }));
    const response = await uploadRoute(
      new Request("http://localhost/upload", { method: "POST", body: form }),
      { params: Promise.resolve({ projectId }) },
    );
    assert.equal(response.status, 200);
  }

  async function confirmSize(projectId: string, w: number, h: number) {
    const { POST: sizeRoute } = await import("../route");
    const response = await sizeRoute(
      new Request("http://localhost/sign-artwork", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderedWidthIn: w, orderedHeightIn: h }),
      }),
      { params: Promise.resolve({ projectId }) },
    );
    assert.equal(response.status, 200);
  }

  async function plan(projectId: string) {
    const { POST: planRoute } = await import("../plan/route");
    const response = await planRoute(
      new Request("http://localhost/sign-artwork/plan", { method: "POST" }),
      { params: Promise.resolve({ projectId }) },
    );
    assert.equal(response.status, 200);
  }

  async function authorize(projectId: string) {
    const { POST } = await import("./route");
    return POST(new Request("http://localhost/sign-artwork/authorize", { method: "POST" }), {
      params: Promise.resolve({ projectId }),
    });
  }

  it("auto_safe: the customer's own authorization succeeds through the real route", async () => {
    const projectId = await freshProject();
    await uploadExistingArtwork(projectId, toPngBytes(exactAspectSignArtwork(1800, 2400)));
    await confirmSize(projectId, 12, 16);
    await plan(projectId);

    const response = await authorize(projectId);
    assert.equal(response.status, 200);

    const { getProjectRepository } = await import("@/lib/db");
    const preparation = await getProjectRepository().getSignPreparation(projectId);
    assert.equal(preparation!.authorizedBy, "customer");
    assert.ok(preparation!.authorizedAt);
    assert.equal(preparation!.authorizedPlanKey, preparation!.planKey);
  });

  it("review_required: the customer's own click is refused through the real route — never authorizes production on its own", async () => {
    const projectId = await freshProject();
    await uploadExistingArtwork(projectId, toPngBytes(ruthLikeSignArtwork()));
    await confirmSize(projectId, 18, 24);
    await plan(projectId);

    const response = await authorize(projectId);
    assert.equal(response.status, 409);

    const { getProjectRepository } = await import("@/lib/db");
    const preparation = await getProjectRepository().getSignPreparation(projectId);
    assert.equal(preparation!.authorizedBy, null, "no authorization record was written");
  });

  it("returns 404 for a project that does not exist", async () => {
    const response = await authorize("00000000-0000-0000-0000-000000000000");
    assert.equal(response.status, 404);
  });
});
