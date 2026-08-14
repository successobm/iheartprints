import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { PNG } from "pngjs";

import { DataUriAssetStorageProvider } from "@/capabilities/asset-storage";
import { createAssetCapability, PngThumbnailGenerator } from "@/capabilities/assets";
import { createConceptGenerationCapability } from "@/capabilities/concept-generation";
import { createConversationCapability } from "@/capabilities/conversation";
import { createGenerationWorkerCapability } from "@/capabilities/generation-worker";
import type { ConceptGenerationProvider } from "@/capabilities/providers";
import type {
  ConceptGenerationRequest,
  ConceptGenerationResult,
} from "@/capabilities/shared/contracts";
import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";
import { runAdaptiveInterviewToSummary } from "@/test-support/run-adaptive-interview";

import { IP_SAFETY_REDIRECT_MESSAGE } from "./customer-response";

/**
 * Sprint A3 — THE PROVIDER FENCE, proved with a counting provider.
 *
 * The claim under test is narrow and expensive to get wrong: a blocked
 * request must never reach a PAID concept-generation provider. Not "fails
 * gracefully after the call", not "the provider refuses it" — zero
 * dispatches, counted.
 *
 * There are three fences, and this file exercises all of them:
 *
 *   1. the conversational gate  (the message never becomes design content)
 *   2. the enqueue fence        (no `GenerationJob` is ever created)
 *   3. the worker fence         (a job that exists anyway is refused before
 *                                a single provider call)
 *
 * It also pins the two lifecycle transitions Goal 9 requires — unsafe →
 * revised → generating, and safe → unsafe → fenced — and Goal Q: a project
 * is never permanently poisoned by one blocked request.
 */

function tinyPng(): Buffer {
  const png = new PNG({ width: 4, height: 4 });
  png.data.fill(128);
  return PNG.sync.write(png);
}

/** A provider that exists only to be counted. It must never be called on a blocked path. */
class CountingConceptProvider implements ConceptGenerationProvider {
  readonly providerKey = "counting";
  readonly editsSourceArtwork = false;
  calls: ConceptGenerationRequest[] = [];

  async generate(
    request: ConceptGenerationRequest,
  ): Promise<ConceptGenerationResult> {
    this.calls.push(request);
    return {
      jobId: request.idempotencyKey,
      providerKey: this.providerKey,
      concepts: Array.from({ length: request.conceptCount }, (_, index) => ({
        versionNumber: index + 1,
        title: `Concept ${index + 1}`,
        summary: `Concept ${index + 1}`,
        placeholderLabel: `Concept ${String.fromCharCode(65 + index)}`,
        accentColor: "#123456",
        kind: "concept" as const,
        asset: {
          imageBytes: tinyPng(),
          contentType: "image/png",
          widthPx: 4,
          heightPx: 4,
          hasTransparency: true,
          providerMetadata: {},
        },
      })),
    };
  }
}

describe("Sprint A3 — IP safety fences every path to a paid provider", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-ip-safety-"));
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
    const provider = new CountingConceptProvider();
    const assets = createAssetCapability(
      repo,
      new DataUriAssetStorageProvider(),
      new PngThumbnailGenerator(),
    );

    const conceptGeneration = createConceptGenerationCapability(
      repo,
      provider.providerKey,
      graph.ipSafety,
    );
    const worker = createGenerationWorkerCapability(
      repo,
      provider,
      graph.promptTranslation,
      assets,
      graph.conceptEvaluation,
      graph.revisionIntelligence,
      graph.printValidation,
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

    return { repo, graph, provider, conceptGeneration, worker, conversation };
  }

  /** Interview → Design Summary → approve → worker, with a counting provider. */
  async function runToConcepts(
    harness: Awaited<ReturnType<typeof buildHarness>>,
  ): Promise<string> {
    const { projectId } = await runAdaptiveInterviewToSummary(harness.conversation);
    await harness.conversation.submitDesignBriefDecision(projectId, "approve");
    await harness.worker.processNextJob();
    return projectId;
  }

  /* ---- J: safe initial generation reaches the provider normally -------- */

  it("J: a safe project generates normally — the provider is dispatched exactly once", async () => {
    const harness = await buildHarness();
    const projectId = await runToConcepts(harness);

    assert.equal(harness.provider.calls.length, 1);
    const snapshot = await harness.conversation.get(projectId);
    assert.equal(snapshot?.artworkVersions.length, 3);
    assert.equal(snapshot?.project.status, "concepts_ready");
  });

  /* ---- K: blocked initial generation dispatches nothing ---------------- */

  it("K: the conversational gate blocks before the brief changes, and no job or provider call happens", async () => {
    const harness = await buildHarness();
    const started = await harness.conversation.start();
    const projectId = started.project.id;

    const before = await harness.conversation.get(projectId);
    const blocked = await harness.conversation.handleUserMessage(
      projectId,
      "Make me the Raiders logo on a black t-shirt.",
    );

    assert.equal(harness.provider.calls.length, 0);
    assert.equal((await harness.repo.listGenerationJobs(projectId)).length, 0);
    assert.equal(blocked.messages.at(-1)?.content, IP_SAFETY_REDIRECT_MESSAGE);

    // Nothing durable moved: the brief, the phase, and the interview state
    // are exactly as they were.
    assert.deepEqual(
      { ...blocked.brief, updatedAt: null },
      { ...before!.brief, updatedAt: null },
    );
    assert.equal(blocked.conversation.phase, before!.conversation.phase);
    assert.deepEqual(
      blocked.conversation.interviewState,
      before!.conversation.interviewState,
    );
  });

  it("K: the enqueue fence refuses an approved brief whose design content is a protected mark — zero jobs, zero calls", async () => {
    const harness = await buildHarness();
    const created = await harness.repo.createProject();
    const projectId = created.project.id;

    await harness.repo.updateBrief(projectId, {
      productSummary: "T-shirts",
      designDescription: "The Raiders logo, centered",
      shirtColor: "Black",
    });
    const approved = await harness.graph.designBrief.approveWorkingBrief(projectId);

    const snapshot = await harness.conceptGeneration.generatePlaceholders(
      projectId,
      approved.id,
    );

    assert.equal(harness.provider.calls.length, 0);
    assert.equal((await harness.repo.listGenerationJobs(projectId)).length, 0);
    assert.notEqual(snapshot.project.status, "generating");
    assert.equal(snapshot.messages.at(-1)?.content, IP_SAFETY_REDIRECT_MESSAGE);
  });

  it("K: the worker fence refuses a job that already exists — the provider is still never dispatched", async () => {
    const harness = await buildHarness();
    const created = await harness.repo.createProject();
    const projectId = created.project.id;

    await harness.repo.updateBrief(projectId, {
      productSummary: "T-shirts",
      designDescription: "The Raiders logo, centered",
      shirtColor: "Black",
    });
    const approved = await harness.graph.designBrief.approveWorkingBrief(projectId);

    // Deliberately bypasses `ConceptGenerationCapability` to prove the
    // worker's own fence, not the enqueue fence, is what stops the spend.
    await harness.repo.createGenerationJob(projectId, {
      designBriefVersionId: approved.id,
      kind: "initial",
      conceptCount: 3,
      providerKey: "counting",
      idempotencyKey: `bypass:${projectId}`,
      targetArtworkVersionId: null,
      revisionInstruction: null,
    });

    await harness.worker.processNextJob();

    assert.equal(harness.provider.calls.length, 0);
    const snapshot = await harness.conversation.get(projectId);
    assert.equal(snapshot?.artworkVersions.length, 0);
    assert.equal(snapshot?.messages.at(-1)?.content, IP_SAFETY_REDIRECT_MESSAGE);
    // Never stranded mid-"generating" — the customer can act from here.
    assert.notEqual(snapshot?.project.status, "generating");
    assert.equal(snapshot?.project.revisionPending, false);
  });

  /* ---- L: a safe project turned unsafe by a revision ------------------- */

  it("L: a protected-mark revision of a safe project dispatches nothing further", async () => {
    const harness = await buildHarness();
    const projectId = await runToConcepts(harness);
    const callsAfterInitial = harness.provider.calls.length;

    const concept = (await harness.conversation.get(projectId))!.artworkVersions[0]!;
    await harness.conversation.selectConcept(projectId, concept.id);
    const jobsBefore = (await harness.repo.listGenerationJobs(projectId)).length;

    const blocked = await harness.conversation.handleUserMessage(
      projectId,
      "Now put the Raiders logo on it.",
    );
    await harness.worker.processNextJob();

    assert.equal(harness.provider.calls.length, callsAfterInitial);
    assert.equal(
      (await harness.repo.listGenerationJobs(projectId)).length,
      jobsBefore,
    );
    assert.equal(blocked.messages.at(-1)?.content, IP_SAFETY_REDIRECT_MESSAGE);
    // The customer keeps the concept they already had, and nothing about the
    // project's finalization lifecycle was touched.
    assert.equal(blocked.project.selectedArtworkVersionId, concept.id);
    assert.equal(blocked.project.revisionPending, false);
  });

  /* ---- Q: one blocked request never poisons the project ---------------- */

  it("Q: an ordinary revision still works immediately after a blocked one", async () => {
    const harness = await buildHarness();
    const projectId = await runToConcepts(harness);
    const concept = (await harness.conversation.get(projectId))!.artworkVersions[0]!;
    await harness.conversation.selectConcept(projectId, concept.id);

    await harness.conversation.handleUserMessage(
      projectId,
      "Now put the Raiders logo on it.",
    );
    const callsAfterBlock = harness.provider.calls.length;

    const afterRevision = await harness.conversation.handleUserMessage(
      projectId,
      "Actually, make it a hoodie.",
    );

    assert.equal(afterRevision.project.revisionPending, true);
    assert.match(afterRevision.brief.productSummary ?? "", /hoodie/i);
    await harness.worker.processNextJob();
    assert.equal(harness.provider.calls.length, callsAfterBlock + 1);
  });

  /* ---- M: unsafe → safe rewrite → generation becomes available --------- */

  it("M: a customer who rewrites an unsafe request reaches generation on the same project", async () => {
    const harness = await buildHarness();
    const started = await harness.conversation.start();
    const projectId = started.project.id;

    const blocked = await harness.conversation.handleUserMessage(
      projectId,
      "Make me the Raiders logo.",
    );
    assert.equal(blocked.messages.at(-1)?.content, IP_SAFETY_REDIRECT_MESSAGE);
    assert.equal(harness.provider.calls.length, 0);

    // Same project, no reset, no new conversation — just a different request.
    let snapshot = blocked;
    for (let turn = 0; turn < 20; turn += 1) {
      if (snapshot.conversation.phase === "awaiting_summary_confirmation") break;
      const pending = snapshot.conversation.interviewState.pendingSection;
      const reply =
        pending === "product"
          ? "T-shirts"
          : pending === "graphics"
            ? "A black and silver pirate skull with crossed swords"
            : pending === "productColor"
              ? "Black"
              : pending === "requiredWording"
                ? "Las Vegas"
                : "You choose.";
      snapshot = await harness.conversation.handleUserMessage(projectId, reply);
    }

    assert.equal(snapshot.conversation.phase, "awaiting_summary_confirmation");
    await harness.conversation.submitDesignBriefDecision(projectId, "approve");
    await harness.worker.processNextJob();

    assert.equal(harness.provider.calls.length, 1);
    const finished = await harness.conversation.get(projectId);
    assert.equal(finished?.artworkVersions.length, 3);
  });

  /* ---- regeneration / alternatives paths are fenced too ---------------- */

  it("the three-direction exploration path is fenced by the same authority", async () => {
    const harness = await buildHarness();
    const created = await harness.repo.createProject();
    const projectId = created.project.id;

    await harness.repo.updateBrief(projectId, {
      productSummary: "T-shirts",
      designDescription: "Recreate the Lakers logo",
      shirtColor: "Purple",
    });
    const approved = await harness.graph.designBrief.approveWorkingBrief(projectId);

    await harness.conceptGeneration.regenerateAfterRevision(projectId, approved.id);
    await harness.conceptGeneration.exploreNewConceptBatch(projectId, approved.id);

    assert.equal(harness.provider.calls.length, 0);
    assert.equal((await harness.repo.listGenerationJobs(projectId)).length, 0);
  });
});
