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
import { createDesignBriefCapability } from "@/capabilities/design-brief";
import { createDesignIntelligenceCapability } from "@/capabilities/design-intelligence";
import { createDesignSummaryCapability } from "@/capabilities/design-summary";
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
import { createGenerationSchedulerCapability } from "@/capabilities/worker-scheduler";

export interface CapabilityGraph {
  conversation: ConversationCapability;
  // Exposed for future wiring / tests; not all are used by Sprint 1 flow yet.
  designBrief: ReturnType<typeof createDesignBriefCapability>;
  briefEvaluation: ReturnType<typeof createBriefEvaluationCapability>;
  intentExtraction: ReturnType<typeof createIntentExtractionCapability>;
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
   * the protected worker endpoint, a standalone worker process, or (in
   * tests) directly; never by a customer request.
   */
  workerScheduler: ReturnType<typeof createGenerationSchedulerCapability>;
  printValidation: ReturnType<typeof createPrintValidationCapability>;
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
  const generationWorker = createGenerationWorkerCapability(
    repo,
    provider,
    promptTranslation,
    assets,
    conceptEvaluation,
  );
  const workerScheduler = createGenerationSchedulerCapability(generationWorker);

  const conversation = createConversationCapability({
    repo,
    intentExtraction,
    designBrief,
    briefEvaluation,
    designIntelligence,
    interviewIntelligence,
    revisionIntelligence,
    designSummary,
    conceptGeneration,
  });

  return {
    conversation,
    designBrief,
    briefEvaluation,
    intentExtraction,
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
    printValidation: createPrintValidationCapability(),
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
