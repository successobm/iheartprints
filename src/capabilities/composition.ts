import { getProjectRepository } from "@/lib/db";
import type { ProjectRepository } from "@/lib/db/repository";

import { createAcquisitionCapability } from "@/capabilities/acquisition";
import { createArtworkPreparationCapability } from "@/capabilities/artwork-preparation";
import { createSignPreparationCapability } from "@/capabilities/sign-preparation";
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
import { createIpSafetyCapability } from "@/capabilities/ip-safety";
import { createOwnershipCapability } from "@/capabilities/ownership";
import {
  createPaymentCapability,
  resolvePaymentProvider,
} from "@/capabilities/payment";
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
  /**
   * Sprint A3: the IP / trademark product safety boundary. Pure and
   * synchronous. Deliberately separate from `ownership` below — ownership is
   * future provenance/licensing architecture, this is a generation-time use
   * policy, and merging them would turn a stub into a fake legal-rights
   * verification system.
   */
  ipSafety: ReturnType<typeof createIpSafetyCapability>;
  /**
   * Sprint A4: the acquisition entitlement boundary — one free concept,
   * email to continue, paid access still to come (Sprint A5). Deliberately
   * separate from `ownership` and from any future authentication: it is
   * spend control over an anonymous session, not an identity model.
   */
  acquisition: ReturnType<typeof createAcquisitionCapability>;
  /**
   * Sprint A5.3: the checkout boundary. Creates payment ATTEMPTS; never
   * creates, activates, or reads a `ProductionUnlock`, and never authorizes
   * finalization or generation.
   *
   * Deliberately NOT a dependency of `acquisition` — the entitlement gate
   * reads the durable unlock through the repository and does not know a
   * payment provider exists (ARCHITECTURE.md §23d).
   */
  payment: ReturnType<typeof createPaymentCapability>;
  ownership: ReturnType<typeof createOwnershipCapability>;
  /**
   * Existing Artwork → Print Ready Phase 1: the Upload Existing Artwork
   * workflow. Deliberately has NO provider dependency of any kind — every
   * operation is local, deterministic pixel math.
   */
  artworkPreparation: ReturnType<typeof createArtworkPreparationCapability>;
  /**
   * Signs Phase S1: rigid-sign inspection/diagnosis/planning
   * (Constitution §16A). Operator/internal only — no route exposes it —
   * and like artworkPreparation it has NO provider dependency: every
   * operation is local, deterministic measurement and planning. It never
   * executes a repair or changes a pixel.
   */
  signPreparation: ReturnType<typeof createSignPreparationCapability>;
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

  // Sprint A3: one shared, pure instance. The same boundary decides the
  // conversational gate, the enqueue fence, and the pre-provider fence, so
  // the three can never drift into disagreeing about the same request.
  const ipSafety = createIpSafetyCapability();

  // Sprint A4: one shared instance, for the same reason `ipSafety` is
  // shared — the generation fence, the finalization fence, the email gate,
  // and the customer-facing state view all have to agree about the same
  // session, and three independently constructed instances would be three
  // opportunities to drift.
  const acquisition = createAcquisitionCapability(repo);

  const provider = resolveConceptGenerationProvider();
  const conceptGeneration = createConceptGenerationCapability(
    repo,
    provider.providerKey,
    ipSafety,
    acquisition,
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
    ipSafety,
  );
  const workerScheduler = createGenerationSchedulerCapability(generationWorker);

  // Sprint 2M Phase 2B: pure repository-backed capability, no provider/I-O
  // dependency beyond the repository itself — mirrors DesignBriefCapability's
  // shape ("sole mutation path" for its own record).
  const finalArtwork = createFinalArtworkCapability(repo, acquisition);
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

  // Sprint A5.3: the checkout boundary. Resolves to `provider: null` in every
  // environment that has not explicitly configured `PAYMENT_PROVIDER=stripe`
  // with a credential and a public base URL — which is all of them today, and
  // is a clean refusal rather than a failure.
  //
  // Deliberately NOT passed `acquisition`. The payment capability resolves the
  // project's acquisition session from the repository itself, exactly as
  // `AcquisitionCapability` does, so the spend boundary stays a leaf and never
  // gains a dependency on commerce.
  const resolvedPayment = resolvePaymentProvider();
  const payment = createPaymentCapability(
    repo,
    resolvedPayment.provider,
    resolvedPayment.publicBaseUrl,
  );

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
    ipSafety,
    acquisition,
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
    ipSafety,
    acquisition,
    payment,
    ownership: createOwnershipCapability(),
    // Existing Artwork → Print Ready Phase 1: repository + assets + the one
    // brief-mutation boundary. No provider is resolved here, and none exists
    // to resolve — preparation is local and deterministic by construction.
    artworkPreparation: createArtworkPreparationCapability(
      repo,
      assets,
      designBrief,
    ),
    // Signs Phase S1: repository + assets only. No provider is resolved
    // here, and none exists to resolve — sign inspection and planning are
    // local and deterministic by construction.
    signPreparation: createSignPreparationCapability(repo, assets),
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
