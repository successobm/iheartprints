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
 * Sprint A3, Correction 1 — WORKER-FENCE LIFECYCLE.
 *
 * The detector tests prove what the boundary decides. This file proves what
 * the PRODUCT does once it decides to refuse at the last fence, which is a
 * different question and the one that strands customers when it is wrong.
 *
 * For every refused worker path the same eight properties must hold:
 *
 *   1. the provider was dispatched zero times
 *   2. the job reached a terminal state (nothing re-claims it forever)
 *   3. the project left `generating`, so browser polling terminates
 *   4. the project is in a state the customer can act from
 *   5. `revisionPending` is correct — never a bar nothing can ever lift
 *   6. the existing concept selection is intact
 *   7. the existing concepts are intact and uncorrupted
 *   8. a later safe request still works, and safe generation still proceeds
 *
 * These jobs are created directly against the repository on purpose. The
 * enqueue fence would normally refuse them first, so bypassing it is the
 * only way to exercise the fence that has to hold when a job exists anyway:
 * enqueued before a brief changed, recovered, or created by a future path.
 */

function tinyPng(): Buffer {
  const png = new PNG({ width: 4, height: 4 });
  png.data.fill(128);
  return PNG.sync.write(png);
}

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

describe("Sprint A3 — worker-fence refusal leaves a usable project", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-ip-lifecycle-"));
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

  type Harness = Awaited<ReturnType<typeof buildHarness>>;

  /** A safe project driven all the way to three concepts. */
  async function runToConcepts(harness: Harness): Promise<string> {
    const { projectId } = await runAdaptiveInterviewToSummary(harness.conversation);
    await harness.conversation.submitDesignBriefDecision(projectId, "approve");
    await harness.worker.processNextJob();
    return projectId;
  }

  /** A project whose APPROVED brief content would be refused by the fences. */
  async function approvedUnsafeProject(harness: Harness) {
    const projectId = (await harness.repo.createProject()).project.id;
    await harness.repo.updateBrief(projectId, {
      productSummary: "T-shirts",
      designDescription: "The Raiders logo, centered",
      shirtColor: "Black",
    });
    const approved = await harness.graph.designBrief.approveWorkingBrief(projectId);
    return { projectId, approvedVersionId: approved.id };
  }

  /* ---- initial generation ---------------------------------------------- */

  it("initial: zero dispatches, terminal job, polling stops, project usable", async () => {
    const harness = await buildHarness();
    const { projectId, approvedVersionId } = await approvedUnsafeProject(harness);

    await harness.repo.createGenerationJob(projectId, {
      designBriefVersionId: approvedVersionId,
      kind: "initial",
      conceptCount: 3,
      providerKey: "counting",
      idempotencyKey: `bypass-initial:${projectId}`,
      targetArtworkVersionId: null,
      revisionInstruction: null,
    });

    await harness.worker.processNextJob();

    assert.equal(harness.provider.calls.length, 0);

    const jobs = await harness.repo.listGenerationJobs(projectId);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0]?.status, "failed", "the job must reach a terminal state");

    const snapshot = await harness.conversation.get(projectId);
    assert.ok(snapshot);
    assert.notEqual(snapshot.project.status, "generating", "polling must terminate");
    assert.equal(snapshot.project.revisionPending, false);
    assert.equal(snapshot.artworkVersions.length, 0);
    assert.equal(snapshot.messages.at(-1)?.content, IP_SAFETY_REDIRECT_MESSAGE);

    // The customer can act from here: chat is open and a later safe request
    // is accepted rather than throwing.
    const afterReply = await harness.conversation.handleUserMessage(
      projectId,
      "Let's do a black and silver pirate skull instead.",
    );
    assert.notEqual(afterReply.messages.at(-1)?.content, IP_SAFETY_REDIRECT_MESSAGE);

    // ...and a genuinely safe generation still proceeds on the same project.
    const safeProjectId = await runToConcepts(harness);
    assert.equal(harness.provider.calls.length, 1);
    const safeSnapshot = await harness.conversation.get(safeProjectId);
    assert.equal(safeSnapshot?.artworkVersions.length, 3);
  });

  /* ---- targeted revision ------------------------------------------------ */

  it("targeted revision: concepts and selection survive intact, revisionPending is cleared", async () => {
    const harness = await buildHarness();
    const projectId = await runToConcepts(harness);
    const callsAfterInitial = harness.provider.calls.length;

    const before = await harness.conversation.get(projectId);
    const concept = before!.artworkVersions[0]!;
    await harness.conversation.selectConcept(projectId, concept.id);
    const conceptIdsBefore = before!.artworkVersions.map((artwork) => artwork.id);

    // Simulate the durable authority a revision creates, then a job that
    // carries an unsafe instruction.
    await harness.repo.updateProject(projectId, { revisionPending: true });
    const approved = await harness.graph.designBrief.approveWorkingBrief(projectId);
    await harness.repo.createGenerationJob(projectId, {
      designBriefVersionId: approved.id,
      kind: "regeneration",
      conceptCount: 1,
      providerKey: "counting",
      idempotencyKey: `bypass-revision:${projectId}`,
      targetArtworkVersionId: concept.id,
      revisionInstruction: "Now put the Raiders logo on it.",
    });

    await harness.worker.processNextJob();

    assert.equal(harness.provider.calls.length, callsAfterInitial);

    const jobs = await harness.repo.listGenerationJobs(projectId);
    const revisionJob = jobs.find((job) => job.targetArtworkVersionId === concept.id);
    assert.equal(revisionJob?.status, "failed");

    const after = await harness.conversation.get(projectId);
    assert.ok(after);
    assert.notEqual(after.project.status, "generating", "polling must terminate");
    // A revision that will never happen must not leave a permanent bar on
    // finalizing the artwork the customer already has and still wants.
    assert.equal(after.project.revisionPending, false);
    assert.equal(after.project.selectedArtworkVersionId, concept.id);
    assert.deepEqual(
      after.artworkVersions.map((artwork) => artwork.id),
      conceptIdsBefore,
      "existing concepts must be neither replaced nor removed",
    );
    assert.equal(after.messages.at(-1)?.content, IP_SAFETY_REDIRECT_MESSAGE);
    assert.equal(after.conversation.phase, "ask_revisions");

    // The customer stays in the revision loop and a later safe change works.
    const afterSafeChange = await harness.conversation.handleUserMessage(
      projectId,
      "Actually, make it a hoodie.",
    );
    assert.notEqual(
      afterSafeChange.messages.at(-1)?.content,
      IP_SAFETY_REDIRECT_MESSAGE,
    );
    await harness.worker.processNextJob();
    assert.equal(harness.provider.calls.length, callsAfterInitial + 1);
  });

  /* ---- three-direction regeneration / exploration ----------------------- */

  for (const label of ["regeneration", "exploration"] as const) {
    it(`${label}: existing concepts survive and the customer keeps working`, async () => {
      const harness = await buildHarness();
      const projectId = await runToConcepts(harness);
      const callsAfterInitial = harness.provider.calls.length;
      const before = await harness.conversation.get(projectId);
      const conceptIdsBefore = before!.artworkVersions.map((artwork) => artwork.id);

      // An approved version whose design content is unsafe — the shape a
      // stale-but-still-queued batch job would have.
      await harness.repo.updateBrief(projectId, {
        designDescription: "Recreate the Lakers logo",
      });
      const approved = await harness.graph.designBrief.approveWorkingBrief(projectId);
      await harness.repo.createGenerationJob(projectId, {
        designBriefVersionId: approved.id,
        kind: "regeneration",
        conceptCount: 3,
        providerKey: "counting",
        idempotencyKey: `bypass-${label}:${projectId}`,
        targetArtworkVersionId: null,
        revisionInstruction: null,
      });

      await harness.worker.processNextJob();

      assert.equal(harness.provider.calls.length, callsAfterInitial);

      const jobs = await harness.repo.listGenerationJobs(projectId);
      assert.equal(jobs.at(-1)?.status, "failed");

      const after = await harness.conversation.get(projectId);
      assert.ok(after);
      assert.notEqual(after.project.status, "generating");
      assert.equal(after.project.revisionPending, false);
      assert.deepEqual(
        after.artworkVersions.map((artwork) => artwork.id),
        conceptIdsBefore,
      );
      assert.equal(after.messages.at(-1)?.content, IP_SAFETY_REDIRECT_MESSAGE);
      assert.equal(after.conversation.phase, "concepts_ready");

      // Concepts stay selectable — the customer is not stranded.
      const afterSelect = await harness.conversation.selectConcept(
        projectId,
        conceptIdsBefore[0]!,
      );
      assert.equal(afterSelect.conversation.phase, "ask_revisions");
      assert.equal(afterSelect.project.selectedArtworkVersionId, conceptIdsBefore[0]);
    });
  }

  /* ---- recovery / resume ------------------------------------------------ */

  it("recovery: a reclaimed job is refused again with no dispatch and no extra work", async () => {
    const harness = await buildHarness();
    const { projectId, approvedVersionId } = await approvedUnsafeProject(harness);

    const job = await harness.repo.createGenerationJob(projectId, {
      designBriefVersionId: approvedVersionId,
      kind: "initial",
      conceptCount: 3,
      providerKey: "counting",
      idempotencyKey: `bypass-recovery:${projectId}`,
      targetArtworkVersionId: null,
      revisionInstruction: null,
    });

    await harness.worker.processNextJob();
    assert.equal(harness.provider.calls.length, 0);

    // A recovery sweep revives it (the shape a crashed worker leaves behind).
    await harness.repo.updateGenerationJob(job.id, { status: "queued" });
    const processed = await harness.worker.processNextJob();
    assert.ok(processed.processedJobId);

    assert.equal(harness.provider.calls.length, 0, "recovery must not spend either");
    const jobs = await harness.repo.listGenerationJobs(projectId);
    assert.equal(jobs.length, 1, "recovery must not fork a second job");
    assert.equal(jobs[0]?.status, "failed");

    const snapshot = await harness.conversation.get(projectId);
    assert.notEqual(snapshot?.project.status, "generating");
    assert.equal(snapshot?.artworkVersions.length, 0);
  });

  /* ---- the enqueue fence and the worker fence agree --------------------- */

  it("both fences reach the same verdict on the same canonical subject", async () => {
    const harness = await buildHarness();
    const { projectId, approvedVersionId } = await approvedUnsafeProject(harness);

    // Enqueue fence: refuses, creates nothing.
    await harness.conceptGeneration.generatePlaceholders(projectId, approvedVersionId);
    assert.equal((await harness.repo.listGenerationJobs(projectId)).length, 0);

    // Worker fence: refuses the identical intent when a job exists anyway.
    await harness.repo.createGenerationJob(projectId, {
      designBriefVersionId: approvedVersionId,
      kind: "initial",
      conceptCount: 3,
      providerKey: "counting",
      idempotencyKey: `bypass-agreement:${projectId}`,
      targetArtworkVersionId: null,
      revisionInstruction: null,
    });
    await harness.worker.processNextJob();

    assert.equal(harness.provider.calls.length, 0);
    assert.equal(
      (await harness.repo.listGenerationJobs(projectId))[0]?.status,
      "failed",
    );
  });

  /* ---- cross-field composition reaches the fences ----------------------- */

  it("cross-field: a referent in the description and the instruction in the notes is refused at both fences", async () => {
    const harness = await buildHarness();
    const projectId = (await harness.repo.createProject()).project.id;

    await harness.repo.updateBrief(projectId, {
      productSummary: "T-shirts",
      designDescription: "Raiders",
      additionalInstructions: "use the exact shield",
      shirtColor: "Black",
    });
    const approved = await harness.graph.designBrief.approveWorkingBrief(projectId);

    await harness.conceptGeneration.generatePlaceholders(projectId, approved.id);
    assert.equal((await harness.repo.listGenerationJobs(projectId)).length, 0);
    assert.equal(harness.provider.calls.length, 0);

    await harness.repo.createGenerationJob(projectId, {
      designBriefVersionId: approved.id,
      kind: "initial",
      conceptCount: 3,
      providerKey: "counting",
      idempotencyKey: `bypass-crossfield:${projectId}`,
      targetArtworkVersionId: null,
      revisionInstruction: null,
    });
    await harness.worker.processNextJob();
    assert.equal(harness.provider.calls.length, 0);
  });

  it("cross-field safe correction: a removal instruction over prior context still generates", async () => {
    const harness = await buildHarness();
    const projectId = await runToConcepts(harness);
    const callsAfterInitial = harness.provider.calls.length;

    const concept = (await harness.conversation.get(projectId))!.artworkVersions[0]!;
    await harness.conversation.selectConcept(projectId, concept.id);

    await harness.repo.updateBrief(projectId, {
      designDescription: "Raiders themed football design",
    });
    const approved = await harness.graph.designBrief.approveWorkingBrief(projectId);

    const snapshot = await harness.conceptGeneration.reviseSelectedConcept(
      projectId,
      approved.id,
      concept.id,
      "remove the logo and make it original",
    );
    assert.equal(snapshot.project.status, "generating");

    await harness.worker.processNextJob();
    assert.equal(harness.provider.calls.length, callsAfterInitial + 1);
  });
});
