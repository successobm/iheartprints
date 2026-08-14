import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { DataUriAssetStorageProvider } from "@/capabilities/asset-storage";
import { createAssetCapability, PngThumbnailGenerator } from "@/capabilities/assets";
import { createArtworkPreparationCapability } from "@/capabilities/artwork-preparation";
import {
  bowlingStyleArtwork,
  toPngBytes,
} from "@/capabilities/artwork-preparation/artwork-fixtures";
import { createConceptGenerationCapability } from "@/capabilities/concept-generation";
import { createConversationCapability } from "@/capabilities/conversation";
import type { ConceptGenerationProvider } from "@/capabilities/providers";
import type {
  ConceptGenerationRequest,
  ConceptGenerationResult,
} from "@/capabilities/shared/contracts";
import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";

import { IP_SAFETY_REDIRECT_MESSAGE } from "./customer-response";

/**
 * Sprint A3 — the Existing Artwork boundary.
 *
 * THE DISTINCTION THIS FILE PINS:
 *
 *     TECHNICAL PREPARATION  !=  NEW PROTECTED-IP GENERATION
 *
 * Preparing artwork a customer supplied is local, deterministic pixel work.
 * It generates nothing, calls no provider, and spends nothing — so A3 adds
 * no gate to it whatsoever, and the bowling-style upload → prepare →
 * approve path must be byte-for-byte unaffected by this sprint.
 *
 * Preparation is also NOT an ownership determination. iHeartPrints does not
 * verify who owns an uploaded file and never claims to; it performs a
 * technical operation on bytes the customer supplied. That honesty is why
 * preparation is ungated AND why nothing on this path may ever say "you own
 * this", "this is licensed", or "this is cleared".
 *
 * What IS gated is asking iHeartPrints to REDESIGN supplied artwork into
 * recognizable third-party branding — that is generation, and it meets the
 * same boundary every other generation request meets.
 */

/** Must never be called anywhere in this file. */
class NeverCalledProvider implements ConceptGenerationProvider {
  readonly providerKey = "never-called";
  readonly editsSourceArtwork = false;
  calls: ConceptGenerationRequest[] = [];

  async generate(
    request: ConceptGenerationRequest,
  ): Promise<ConceptGenerationResult> {
    this.calls.push(request);
    throw new Error("the provider must never be called on an Existing Artwork path");
  }
}

describe("Sprint A3 — Existing Artwork: preparation is untouched, redesign is fenced", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-ip-upload-"));
    process.chdir(tempDir);
  });

  after(async () => {
    await cleanupTempWorkspace(tempDir, previousCwd);
  });

  async function buildHarness() {
    const { LocalProjectRepository } = await import("@/lib/db/local-store");
    const { createCapabilityGraph } = await import("@/capabilities/composition");

    const repo = new LocalProjectRepository();
    const graph = createCapabilityGraph(repo);
    const provider = new NeverCalledProvider();
    const assets = createAssetCapability(
      repo,
      new DataUriAssetStorageProvider(),
      new PngThumbnailGenerator(),
    );
    const preparation = createArtworkPreparationCapability(
      repo,
      assets,
      graph.designBrief,
    );
    const conceptGeneration = createConceptGenerationCapability(
      repo,
      provider.providerKey,
      graph.ipSafety,
    );
    const conversation = createConversationCapability({
      repo,
      intentExtraction: graph.intentExtraction,
      conversationUnderstanding: graph.conversationUnderstanding,
      designBrief: graph.designBrief,
      briefEvaluation: graph.briefEvaluation,
      designIntelligence: graph.designIntelligence,
      interviewIntelligence: graph.interviewIntelligence,
      revisionIntelligence: graph.revisionIntelligence,
      designSummary: graph.designSummary,
      conceptGeneration,
      finalArtwork: graph.finalArtwork,
      ipSafety: graph.ipSafety,
    });

    return { repo, provider, preparation, conversation };
  }

  async function uploadedProject(
    harness: Awaited<ReturnType<typeof buildHarness>>,
  ): Promise<string> {
    const projectId = (await harness.repo.createProject()).project.id;
    await harness.preparation.uploadOriginal(projectId, {
      bytes: toPngBytes(bowlingStyleArtwork()),
      declaredContentType: "image/png",
      filename: "split disturbers.png",
    });
    return projectId;
  }

  /* ---- N: technical preparation is unaffected -------------------------- */

  it("N: upload → context → prepare → approve still completes, with no generation and no provider call", async () => {
    const harness = await buildHarness();
    const projectId = await uploadedProject(harness);

    await harness.preparation.setProductionContext(projectId, {
      productSummary: "T-shirts for our bowling team",
      productColor: "Black",
      printPlacement: "full_back",
    });
    await harness.preparation.prepareBackground(projectId);
    const approved = await harness.preparation.approvePreparedArtwork(projectId);

    assert.equal(approved.approved, true);
    const row = await harness.repo.getArtworkPreparation(projectId);
    assert.ok(row?.preparedAssetId);
    assert.ok(row?.preparedArtworkVersionId);

    // A3 inserted no generation-safety gate into pure technical preparation.
    assert.equal(harness.provider.calls.length, 0);
    assert.equal((await harness.repo.listGenerationJobs(projectId)).length, 0);
  });

  it("N: an ordinary conversational turn about uploaded artwork is not blocked", async () => {
    const harness = await buildHarness();
    const projectId = await uploadedProject(harness);

    const snapshot = await harness.conversation.handleUserMessage(
      projectId,
      "This is our bowling team artwork — clean up the background and center it.",
    );

    assert.notEqual(snapshot.messages.at(-1)?.content, IP_SAFETY_REDIRECT_MESSAGE);
    assert.equal(harness.provider.calls.length, 0);
  });

  it("N: preparing supplied artwork never claims ownership, licensing, or legal clearance", async () => {
    const harness = await buildHarness();
    const projectId = await uploadedProject(harness);

    await harness.preparation.setProductionContext(projectId, {
      productSummary: "T-shirts for our bowling team",
      productColor: "Black",
      printPlacement: "full_back",
    });
    await harness.preparation.prepareBackground(projectId);
    const approved = await harness.preparation.approvePreparedArtwork(projectId);

    const customerFacingText = [
      JSON.stringify(approved.customer),
      ...(await harness.conversation.get(projectId))!.messages.map((m) => m.content),
    ].join("\n");

    assert.doesNotMatch(
      customerFacingText,
      /you own|your rights|licensed|license to|legally cleared|trademark[\s-]cleared|copyright[\s-]cleared|cleared for use/i,
    );
  });

  /* ---- O: a protected-brand redesign request is fenced ------------------ */

  it("O: asking to redesign uploaded artwork into a protected mark is blocked before generation", async () => {
    const harness = await buildHarness();
    const projectId = await uploadedProject(harness);

    const blocked = await harness.conversation.handleUserMessage(
      projectId,
      "Take this and make it the Raiders logo instead.",
    );

    assert.equal(blocked.messages.at(-1)?.content, IP_SAFETY_REDIRECT_MESSAGE);
    assert.equal(harness.provider.calls.length, 0);
    assert.equal((await harness.repo.listGenerationJobs(projectId)).length, 0);

    // The upload itself is untouched — a blocked redesign request never
    // costs the customer the artwork they already gave us.
    const row = await harness.repo.getArtworkPreparation(projectId);
    assert.ok(row?.originalAssetId);
  });

  it("O: preparation still completes normally on the same project after a blocked redesign request", async () => {
    const harness = await buildHarness();
    const projectId = await uploadedProject(harness);

    await harness.conversation.handleUserMessage(
      projectId,
      "Take this and make it the Raiders logo instead.",
    );

    await harness.preparation.setProductionContext(projectId, {
      productSummary: "T-shirts for our bowling team",
      productColor: "Black",
      printPlacement: "full_back",
    });
    await harness.preparation.prepareBackground(projectId);
    const approved = await harness.preparation.approvePreparedArtwork(projectId);

    assert.equal(approved.approved, true);
    assert.equal(harness.provider.calls.length, 0);
  });
});
