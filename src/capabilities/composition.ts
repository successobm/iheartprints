import { getProjectRepository } from "@/lib/db";
import type { ProjectRepository } from "@/lib/db/repository";

import { resolveAssetStorageProvider } from "@/capabilities/asset-storage";
import {
  createAssetCapability,
  PngThumbnailGenerator,
} from "@/capabilities/assets";
import { createBriefEvaluationCapability } from "@/capabilities/brief-evaluation";
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
  /** Sprint 2H Part 2A: background job runner — see `generation-worker/`. */
  generationWorker: ReturnType<typeof createGenerationWorkerCapability>;
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
  const generationWorker = createGenerationWorkerCapability(
    repo,
    provider,
    promptTranslation,
    assets,
  );

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
    generationWorker,
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
