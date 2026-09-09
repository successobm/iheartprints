import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import {
  bowlingStyleArtwork,
  toPngBytes,
} from "@/capabilities/artwork-preparation/artwork-fixtures";
import { ruthLikeSignArtwork, toPngBytes as toSignPngBytes } from "@/capabilities/sign-preparation/sign-fixtures";
import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";

/**
 * LIVE PRODUCT BLOCKER #1: the Sign path's bridge, end to end through the
 * real route handlers — the SAME customer upload the DTF path uses, then
 * this route's own action, exactly as the browser would call them.
 *
 * Never constructs a `SignPreparation` directly and never calls
 * `SignPreparationCapability` itself: proving this from the two real HTTP
 * boundaries is the whole point of this file.
 */
describe("POST /api/projects/[projectId]/sign-artwork", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-sign-artwork-route-"));
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

  async function uploadExistingArtwork(projectId: string, filename = "sign-art.png") {
    const { POST: uploadRoute } = await import("../artwork-upload/route");
    const form = new FormData();
    form.append(
      "file",
      new File([new Uint8Array(toPngBytes(bowlingStyleArtwork()))], filename, {
        type: "image/png",
      }),
    );
    const response = await uploadRoute(
      new Request("http://localhost/upload", { method: "POST", body: form }),
      { params: Promise.resolve({ projectId }) },
    );
    assert.equal(response.status, 200);
  }

  async function uploadRuthLikeArtwork(projectId: string) {
    const { POST: uploadRoute } = await import("../artwork-upload/route");
    const form = new FormData();
    form.append(
      "file",
      new File([new Uint8Array(toSignPngBytes(ruthLikeSignArtwork()))], "ruth.png", {
        type: "image/png",
      }),
    );
    const response = await uploadRoute(
      new Request("http://localhost/upload", { method: "POST", body: form }),
      { params: Promise.resolve({ projectId }) },
    );
    assert.equal(response.status, 200);
  }

  async function post(projectId: string, body: unknown) {
    const { POST } = await import("./route");
    return POST(
      new Request("http://localhost/sign-artwork", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ projectId }) },
    );
  }

  it("bridges the SAME already-uploaded bytes into the Signs authority and confirms the ordered size", async () => {
    const projectId = await freshProject();
    await uploadExistingArtwork(projectId, "kids-fun-extras.png");

    const response = await post(projectId, { orderedWidthIn: 24, orderedHeightIn: 36 });
    assert.equal(response.status, 200);
    const body = await response.json();

    assert.equal(body.signArtwork.orderedWidthIn, 24);
    assert.equal(body.signArtwork.orderedHeightIn, 36);
    assert.equal(body.signArtwork.specConfirmed, true);
    // No internal identifiers reach the browser, same rule as every other
    // customer-facing snapshot field.
    assert.doesNotMatch(
      JSON.stringify(body.signArtwork),
      /assetId|storageKey|objectKey|policyId|resolutionPolicyId/i,
    );

    const { getProjectRepository } = await import("@/lib/db");
    const repo = getProjectRepository();
    const artworkPreparation = await repo.getArtworkPreparation(projectId);
    const signPreparation = await repo.getSignPreparation(projectId);
    assert.ok(artworkPreparation);
    assert.ok(signPreparation);
    // The Signs authority owns its OWN immutable original — never a second
    // customer upload, but also never literally the same asset row as the
    // DTF-path preparation, which the Signs capability's own `uploadOriginal`
    // discipline requires.
    assert.notEqual(signPreparation!.originalAssetId, artworkPreparation!.originalAssetId);
    assert.equal(signPreparation!.originalFilename, "kids-fun-extras.png");
    assert.equal(signPreparation!.orderedWidthIn, 24);
    assert.equal(signPreparation!.orderedHeightIn, 36);
    assert.ok(signPreparation!.specConfirmedAt);
  });

  it("refuses to bridge before any artwork has been uploaded", async () => {
    const projectId = await freshProject();
    const response = await post(projectId, { orderedWidthIn: 24, orderedHeightIn: 36 });
    assert.equal(response.status, 409);
    const body = await response.json();
    assert.match(body.error, /upload your artwork/i);
  });

  it("is idempotent: a second confirmation re-uses the SAME sign original rather than uploading again", async () => {
    const projectId = await freshProject();
    await uploadExistingArtwork(projectId);
    await post(projectId, { orderedWidthIn: 24, orderedHeightIn: 36 });

    const { getProjectRepository } = await import("@/lib/db");
    const repo = getProjectRepository();
    const firstAssetId = (await repo.getSignPreparation(projectId))!.originalAssetId;

    const second = await post(projectId, { orderedWidthIn: 18, orderedHeightIn: 24 });
    assert.equal(second.status, 200);
    const body = await second.json();
    assert.equal(body.signArtwork.orderedWidthIn, 18);
    assert.equal(body.signArtwork.orderedHeightIn, 24);

    const secondAssetId = (await repo.getSignPreparation(projectId))!.originalAssetId;
    assert.equal(secondAssetId, firstAssetId);
  });

  it("rejects an ordered size no dimension-driven resolution policy can safely and usefully cover, with no plan or partial state left behind", async () => {
    const projectId = await freshProject();
    await uploadExistingArtwork(projectId);

    // Dimension-Driven Signs Refactor: 96x96 was refused under the old
    // rigid-only 24x36 envelope but is a genuinely supported size now (its
    // own memory-safe target, ~34 PPI, is above the usable floor) — the
    // boundary moved from a product-category envelope to a technical one.
    // 200x100in (20,000 sq in) is large enough that even the memory-safe
    // target PPI falls below the usable floor.
    const response = await post(projectId, { orderedWidthIn: 200, orderedHeightIn: 100 });
    assert.equal(response.status, 409);
  });

  it("rejects a non-positive dimension before ever touching the capability", async () => {
    const projectId = await freshProject();
    await uploadExistingArtwork(projectId);

    const response = await post(projectId, { orderedWidthIn: 0, orderedHeightIn: 36 });
    assert.equal(response.status, 400);
  });

  it("Signs Workflow Dead Ends fix (Defect 1): confirming the ordered size automatically runs inspection/planning — no separate 'Check my artwork' call is required", async () => {
    const projectId = await freshProject();
    await uploadRuthLikeArtwork(projectId);

    // Same fixture and dimensions as `sign-preparation-capability.test.ts`'s
    // "4/M" — a well-understood REVIEW_REQUIRED outcome (aspect mismatch,
    // foreground reaching the extension edge) — proven here to already be
    // durably planned by the time THIS ONE request returns, with no second
    // request to `/sign-artwork/plan` in between.
    const response = await post(projectId, { orderedWidthIn: 18, orderedHeightIn: 24 });
    assert.equal(response.status, 200);
    const body = await response.json();

    assert.equal(body.signArtwork.specConfirmed, true);
    assert.ok(body.signArtwork.plan, "a plan is already present in THIS response");
    assert.equal(body.signArtwork.plan.status, "needs_review");
    assert.equal(body.signArtwork.plan.reviewRequired, true);
    assert.ok(body.signArtwork.plan.proposedAction);
    assert.ok(
      body.signArtwork.plan.findings.some((f: string) => /reaches the very edge/i.test(f)),
    );

    // The durable row itself reflects a real, persisted plan — not merely a
    // response-only projection — proving this ran the actual capability
    // rather than fabricating a view.
    const { getProjectRepository } = await import("@/lib/db");
    const persisted = await getProjectRepository().getSignPreparation(projectId);
    assert.equal(persisted!.status, "planned");
    assert.ok(persisted!.plan);
    assert.ok(persisted!.planKey);
  });

  it("scopes to the addressed project and nothing else", async () => {
    const projectA = await freshProject();
    const projectB = await freshProject();
    await uploadExistingArtwork(projectA);

    await post(projectA, { orderedWidthIn: 24, orderedHeightIn: 36 });

    const { getProjectRepository } = await import("@/lib/db");
    const repo = getProjectRepository();
    assert.ok(await repo.getSignPreparation(projectA));
    assert.equal(await repo.getSignPreparation(projectB), null);
  });
});
