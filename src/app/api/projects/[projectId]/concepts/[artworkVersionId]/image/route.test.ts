import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";
import { runAdaptiveInterviewToSummary } from "@/test-support/run-adaptive-interview";

/**
 * Sprint 2K Phase 1: this endpoint is the only path from a browser-visible
 * `artworkVersionId` to a real, renderable image. It must mint a short-lived
 * signed URL through `AssetCapability` and never leak the underlying asset
 * id, storage key, generation job id, or provider name — see
 * ARCHITECTURE.md §16/§17.
 */
describe("GET /api/projects/[projectId]/concepts/[artworkVersionId]/image (Sprint 2K Phase 1)", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-concept-image-route-"));
    process.chdir(tempDir);
  });

  after(async () => {
    await cleanupTempWorkspace(tempDir, previousCwd);
  });

  it("returns 404 for a project that doesn't exist", async () => {
    const { resetCapabilityGraphForTests } = await import("@/capabilities/composition");
    resetCapabilityGraphForTests();

    const { GET } = await import("./route");
    const response = await GET(new Request("http://localhost/x"), {
      params: Promise.resolve({
        projectId: "00000000-0000-0000-0000-000000000000",
        artworkVersionId: "00000000-0000-0000-0000-000000000001",
      }),
    });

    assert.equal(response.status, 404);
    assert.deepEqual(Object.keys(await response.json()), ["error"]);
  });

  it("returns 404 when the concept has no generated image yet (placeholder provider)", async () => {
    const { resetCapabilityGraphForTests, getCapabilityGraph } = await import(
      "@/capabilities/composition"
    );
    resetCapabilityGraphForTests();
    const { startConversation, handleUserMessage, submitDesignBriefDecision, getConversation } =
      await import("@/lib/services/conversation-service");

    const { projectId } = await runAdaptiveInterviewToSummary({
      start: startConversation,
      handleUserMessage,
    });
    await submitDesignBriefDecision(projectId, "approve");
    await getCapabilityGraph().generationWorker.processNextJob();

    const afterGeneration = await getConversation(projectId);
    const concept = afterGeneration!.artworkVersions[0]!;
    // The default test/dev provider is the placeholder — it never produces
    // real image bytes, so this concept has no image to sign a URL for.
    assert.equal(concept.hasImage, false);

    const { GET } = await import("./route");
    const response = await GET(new Request("http://localhost/x"), {
      params: Promise.resolve({ projectId, artworkVersionId: concept.id }),
    });

    assert.equal(response.status, 404);
  });

  it("mints a signed URL for a concept with a real generated image, the customer-facing snapshot never carries the underlying asset id, job id, or provider name, and a different project can't look it up", async () => {
    const { resetCapabilityGraphForTests, getCapabilityGraph } = await import(
      "@/capabilities/composition"
    );
    resetCapabilityGraphForTests();
    const { startConversation, handleUserMessage, submitDesignBriefDecision, getConversation } =
      await import("@/lib/services/conversation-service");

    const { projectId } = await runAdaptiveInterviewToSummary({
      start: startConversation,
      handleUserMessage,
    });
    const approved = await submitDesignBriefDecision(projectId, "approve");
    const approvedVersionId = approved.designBriefVersions.at(-1)!.id;

    const graph = getCapabilityGraph();
    const { PNG } = await import("pngjs");
    const png = new PNG({ width: 8, height: 8 });
    png.data.fill(50);
    const { primary } = await graph.assets.uploadConceptImage(projectId, {
      conceptId: "concept-test",
      bytes: PNG.sync.write(png),
      contentType: "image/png",
      widthPx: 8,
      heightPx: 8,
      hasTransparency: false,
      providerKey: "openai",
      generationJobId: null,
      metadata: {},
    });

    const { getProjectRepository } = await import("@/lib/db");
    const repo = getProjectRepository();
    const [artwork] = await repo.addArtworkVersions(projectId, [
      {
        versionNumber: 1,
        kind: "concept",
        title: "Concept A",
        summary: "A test concept",
        placeholderLabel: "Concept A",
        accentColor: "#173F35",
        designBriefVersionId: approvedVersionId,
        generationJobId: "job-test",
        primaryAssetId: primary.id,
        thumbnailAssetId: null,
        providerKey: "openai",
        evaluationStatus: "passed",
        evaluationEvaluatedAt: new Date().toISOString(),
        evaluationProviderKey: "openai",
      },
    ]);

    // Security check: the customer-facing snapshot must not carry any
    // internal provenance for this concept, only whether an image exists.
    const snapshot = await getConversation(projectId);
    const customerArtwork = snapshot!.artworkVersions.find((a) => a.id === artwork!.id)!;
    assert.equal(customerArtwork.hasImage, true);
    assert.equal(customerArtwork.primaryAssetId, null);
    assert.equal(customerArtwork.thumbnailAssetId, null);
    assert.equal(customerArtwork.generationJobId, null);
    assert.equal(customerArtwork.providerKey, null);
    assert.equal(customerArtwork.evaluationStatus, null);
    assert.equal(customerArtwork.evaluation, null);
    assert.equal(customerArtwork.evaluationProviderKey, null);
    assert.equal(JSON.stringify(customerArtwork).includes(primary.id), false);
    assert.equal(JSON.stringify(customerArtwork).includes("openai"), false);

    const { GET } = await import("./route");
    const response = await GET(new Request("http://localhost/x"), {
      params: Promise.resolve({ projectId, artworkVersionId: artwork!.id }),
    });

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(Object.keys(body), ["url"]);
    assert.equal(typeof body.url, "string");
    assert.ok(body.url.length > 0);
    // Never the raw asset id as a discoverable identifier in the response.
    assert.equal(body.url.includes(primary.id), false);

    // A different project's browser session can't use this concept's
    // artworkVersionId to look up its image, even though the id itself is
    // just a UUID with no inherent project scoping.
    const { projectId: otherProjectId } = await runAdaptiveInterviewToSummary({
      start: startConversation,
      handleUserMessage,
    });
    const crossProjectResponse = await GET(new Request("http://localhost/x"), {
      params: Promise.resolve({ projectId: otherProjectId, artworkVersionId: artwork!.id }),
    });
    assert.equal(crossProjectResponse.status, 404);
  });
});
