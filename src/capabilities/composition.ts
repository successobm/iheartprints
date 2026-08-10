import { getProjectRepository } from "@/lib/db";
import type { ProjectRepository } from "@/lib/db/repository";

import { resolveAssetStorageProvider } from "@/capabilities/asset-storage";
import {
  createAssetCapability,
  PngThumbnailGenerator,
} from "@/capabilities/assets";
import { createBriefEvaluationCapability } from "@/capabilities/brief-evaluation";
import {
  createConceptEvaluationCapability,
  resolveConceptEvaluationProvider,
} from "@/capabilities/concept-evaluation";
import { createConceptGenerationCapability } from "@/capabilities/concept-generation";
import { createConversationCapability } from "@/capabilities/conversation";
import type { ConversationCapability } from "@/capabilities/conversation";
import {
  createConversationUnderstandingCapability,
  resolveConversationUnderstandingProvider,
} from "@/capabilities/conversation-understanding";
import { createDesignBriefCapability } from "@/capabilities/design-brief";
import { createDesignIntelligenceCapability } from "@/capabilities/design-intelligence";
import { createDesignSummaryCapability } from "@/capabilities/design-summary";
import {
  createFinalArtworkCapability,
  resolveFinalArtworkProvider,
} from "@/capabilities/final-artwork";
import { createFinalArtworkWorkerCapability } from "@/capabilities/final-artwork-worker";
import { createGenerationWorkerCapability } from "@/capabilities/generation-worker";
import { createIntentExtractionCapability } from "@/capabilities/intent-extraction";
import { createInterviewIntelligenceCapability } from "@/capabilities/interview-intelligence";
import { createOwnershipCapability } from "@/capabilities/ownership";
import { createPrintValidationCapability } from "@/capabilities/print-validation";
import { createPrintVaultCapability } from "@/capabilities/print-vault";
import { createProductIntelligenceCapability } from "@/capabilities/product-intelligence";
import { createPromptTranslationCapability } from "@/capabilities/prompt-translation";
import { resolveConceptGenerationProvider } from "@/capabilities/providers";
import { createRevisionCapability } from "@/capabilities/revision";
import { createRevisionIntelligenceCapability } from "@/capabilities/revision-intelligence";
import {
  createGenerationSchedulerCapability,
  createFinalArtworkSchedulerCapability,
} from "@/capabilities/worker-scheduler";

export interface CapabilityGraph {
  conversation: ConversationCapability;
  // Exposed for future wiring / tests; not all are used by Sprint 1 flow yet.
  designBrief: ReturnType<typeof createDesignBriefCapability>;
  briefEvaluation: ReturnType<typeof createBriefEvaluationCapability>;
  intentExtraction: ReturnType<typeof createIntentExtractionCapability>;
  /** Sprint 2L Phase 1: best-effort semantic interpretation feeding Intent Extraction — see `reconcile-understanding.ts`. */
  conversationUnderstanding: ReturnType<typeof createConversationUnderstandingCapability>;
  designIntelligence: ReturnType<typeof createDesignIntelligenceCapability>;
  interviewIntelligence: ReturnType<typeof createInterviewIntelligenceCapability>;
  revisionIntelligence: ReturnType<typeof createRevisionIntelligenceCapability>;
  productIntelligence: ReturnType<typeof createProductIntelligenceCapability>;
  designSummary: ReturnType<typeof createDesignSummaryCapability>;
  promptTranslation: ReturnType<typeof createPromptTranslationCapability>;
  conceptGeneration: ReturnType<typeof createConceptGenerationCapability>;
  /** Sprint 2I Phase 1: Concept Evaluation — provider-neutral brief alignment. */
  conceptEvaluation: ReturnType<typeof createConceptEvaluationCapability>;
  /** Sprint 2H Part 2A: background job runner — see `generation-worker/`. */
  generationWorker: ReturnType<typeof createGenerationWorkerCapability>;
  /**
   * Sprint 2H Part 2B: provider-neutral scheduler that decides when/how many
   * times to call `generationWorker` — see `worker-scheduler/`. Driven by
   * the protected worker endpoint, a standalone worker process, tests that
   * call it explicitly, or — interactive `next dev` only — the post-enqueue
   * local trigger. Production customer requests never invoke it.
   */
  workerScheduler: ReturnType<typeof createGenerationSchedulerCapability>;
  printValidation: ReturnType<typeof createPrintValidationCapability>;
  /** Sprint 2M Phase 2B: final-direction approval + production orchestration boundary. */
  finalArtwork: ReturnType<typeof createFinalArtworkCapability>;
  /** Sprint 2M Phase 2C: independent worker that claims and runs `FinalArtworkJob`s — see `final-artwork-worker/`. */
  finalArtworkWorker: ReturnType<typeof createFinalArtworkWorkerCapability>;
  /** Sprint 2M Phase 2C: provider-neutral scheduler for `finalArtworkWorker` — mirrors `workerScheduler`. */
  finalArtworkScheduler: ReturnType<typeof createFinalArtworkSchedulerCapability>;
  revision: ReturnType<typeof createRevisionCapability>;
  printVault: ReturnType<typeof createPrintVaultCapability>;
  assets: ReturnType<typeof createAssetCapability>;
  ownership: ReturnType<typeof createOwnershipCapability>;
}

let graph: CapabilityGraph | null = null;

/**
 * Composition root: wires capabilities to interfaces / placeholder providers.
 * UI and API routes should depend on this (or the conversation facade), not concretes.
 */
export function createCapabilityGraph(
  repo: ProjectRepository = getProjectRepository(),
): CapabilityGraph {
  const designBrief = createDesignBriefCapability(repo);
  const briefEvaluation = createBriefEvaluationCapability();
  const intentExtraction = createIntentExtractionCapability();
  // Sprint 2L Phase 1: resolves to a real (OpenAI) semantic interpreter
  // when configured, otherwise a deterministic-only no-op — composition
  // owns selection; conversation/UI never inspect env vars. Independent of
  // `resolveConceptGenerationProvider` / `CONCEPT_GENERATION_ENABLE_REAL`.
  const conversationUnderstanding = createConversationUnderstandingCapability(
    resolveConversationUnderstandingProvider(),
  );
  const productIntelligence = createProductIntelligenceCapability();
  const designIntelligence =
    createDesignIntelligenceCapability(productIntelligence);
  const interviewIntelligence = createInterviewIntelligenceCapability();
  const revisionIntelligence = createRevisionIntelligenceCapability();
  const designSummary = createDesignSummaryCapability();
  const promptTranslation = createPromptTranslationCapability();

  const assetStorage = resolveAssetStorageProvider();
  const thumbnails = new PngThumbnailGenerator();
  const assets = createAssetCapability(repo, assetStorage, thumbnails);

  const provider = resolveConceptGenerationProvider();
  const conceptGeneration = createConceptGenerationCapability(
    repo,
    provider.providerKey,
  );
  // Sprint 2I Phase 2: resolves to a real (OpenAI vision) evaluator when
  // configured, otherwise the deterministic placeholder. Composition owns
  // selection; conversation/UI never inspect env vars.
  const conceptEvaluation = createConceptEvaluationCapability(
    resolveConceptEvaluationProvider(),
  );
  // Sprint 2M Phase 1: pure, zero-dependency capability. Sprint 2M Phase 2A:
  // shared with GenerationWorkerCapability so provisional print-readiness
  // intelligence runs right after Concept Evaluation completes — see
  // `runProvisionalPrintValidation` and ARCHITECTURE.md's "Provisional
  // Print Readiness" section. Never authoritative; never persisted.
  const printValidation = createPrintValidationCapability();
  const generationWorker = createGenerationWorkerCapability(
    repo,
    provider,
    promptTranslation,
    assets,
    conceptEvaluation,
    revisionIntelligence,
    printValidation,
  );
  const workerScheduler = createGenerationSchedulerCapability(generationWorker);

  // Sprint 2M Phase 2B: pure repository-backed capability, no provider/I-O
  // dependency beyond the repository itself — mirrors DesignBriefCapability's
  // shape ("sole mutation path" for its own record).
  const finalArtwork = createFinalArtworkCapability(repo);
  // Sprint 2M Phase 2C: the independent worker that actually claims and
  // runs FinalArtworkJob rows — never invoked from a customer route (same
  // rule as generationWorker/workerScheduler below).
  const finalArtworkProvider = resolveFinalArtworkProvider();
  // Sprint 2M Phase 2E: shared with the concept-generation pipeline's own
  // Concept Evaluation wiring — a reconstruction provider that cannot
  // declare `preservesApprovedContent: true` (Topaz never does) needs the
  // exact same OCR/evaluation infrastructure to independently re-verify the
  // production asset (Goal 7/9), never a bespoke second implementation.
  const finalArtworkWorker = createFinalArtworkWorkerCapability(
    repo,
    assets,
    finalArtworkProvider,
    printValidation,
    conceptEvaluation,
  );
  const finalArtworkScheduler = createFinalArtworkSchedulerCapability(finalArtworkWorker);

  const conversation = createConversationCapability({
    repo,
    intentExtraction,
    conversationUnderstanding,
    designBrief,
    briefEvaluation,
    designIntelligence,
    interviewIntelligence,
    revisionIntelligence,
    designSummary,
    conceptGeneration,
    finalArtwork,
  });

  return {
    conversation,
    designBrief,
    briefEvaluation,
    intentExtraction,
    conversationUnderstanding,
    designIntelligence,
    interviewIntelligence,
    revisionIntelligence,
    productIntelligence,
    designSummary,
    promptTranslation,
    conceptGeneration,
    conceptEvaluation,
    generationWorker,
    workerScheduler,
    printValidation,
    finalArtwork,
    finalArtworkWorker,
    finalArtworkScheduler,
    revision: createRevisionCapability(),
    printVault: createPrintVaultCapability(),
    assets,
    ownership: createOwnershipCapability(),
  };
}

export function getCapabilityGraph(): CapabilityGraph {
  if (!graph) {
    graph = createCapabilityGraph();
  }
  return graph;
}

/** Test helper — reset singleton between isolated runs if needed. */
export function resetCapabilityGraphForTests(): void {
  graph = null;
}

/**
 * Test teardown for the generation worker HTTP route: stop scheduler timers
 * and await any in-flight `runBatch()` before dropping the singleton.
 * Automated tests must not leave detached store writes running while
 * `cleanupTempWorkspace` rmdirs a temp cwd (Windows EBUSY).
 */
export async function drainCapabilityGraphForTests(): Promise<void> {
  if (!graph) return;
  graph.workerScheduler.stop();
  graph.finalArtworkScheduler.stop();
  if (graph.workerScheduler.hasActiveBatch()) {
    try {
      await graph.workerScheduler.runBatch();
    } catch {
      /* batch already failed; still drop the singleton */
    }
  }
  if (graph.finalArtworkScheduler.hasActiveBatch()) {
    try {
      await graph.finalArtworkScheduler.runBatch();
    } catch {
      /* batch already failed; still drop the singleton */
    }
  }
  graph = null;
}
