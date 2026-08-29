import { randomUUID } from "crypto";
import { promises as fs } from "fs";
import path from "path";

import {
  OPENING_PROMPT,
  projectNameFromBrief,
} from "@/lib/domain/conversation";
import {
  DEFAULT_PRODUCTION_TREATMENT,
  STANDARD_RASTER_TREATMENT_KEY,
  emptyInterviewState,
  isActiveFinalArtworkJobStatus,
  isOutstandingPaymentTransaction,
  productionIntentMatches,
  readStoredPaymentEventOutcome,
  readStoredPaymentProvider,
  readStoredPaymentTransactionStatus,
  readStoredProductionProfile,
  readStoredProductionUnlockStatus,
} from "@/lib/domain/types";
import type {
  AcquisitionFreeConceptClaim,
  AcquisitionSession,
  ArtworkPreparation,
  ArtworkVersion,
  AssetRecord,
  ConversationMessage,
  ConversationPhase,
  DesignBriefVersion,
  DesignConversation,
  FinalArtworkJob,
  FinalDirectionApproval,
  GenerationJob,
  InterviewStateData,
  PaidImageIntent,
  PaymentEvent,
  PaymentEventApplication,
  PaymentEventOutcome,
  PaymentProviderKey,
  PaymentTransaction,
  PrintProject,
  ProductionAssetValidation,
  ProductionProfile,
  ProductionUnlock,
  ProjectSnapshot,
  ProjectStatus,
  TShirtDesignBrief,
} from "@/lib/domain/types";
import type {
  ApproveDesignBriefInput,
  CaptureAcquisitionEmailInput,
  CreateArtworkPreparationInput,
  CreateArtworkVersionInput,
  CreateAssetInput,
  CreateFinalArtworkJobInput,
  CreateFinalDirectionApprovalInput,
  CreateGenerationJobInput,
  CompletePaidImageIntentInput,
  CreateMessageInput,
  CreateProductionAssetValidationInput,
  ApplyPaymentEventInput,
  BindProviderCheckoutSessionInput,
  CreateProductionUnlockInput,
  FreeConceptAllocation,
  OpenPaymentTransactionInput,
  PaidImageIntentReservation,
  PaymentTransactionOpening,
  ProductionUnlockGrant,
  ProjectRepository,
  RecordPaidImageIntentFailureInput,
  ReservePaidImageIntentInput,
  UpdateArtworkEvaluationInput,
  UpdateArtworkPreparationInput,
  UpdateFinalArtworkJobInput,
  UpdateGenerationJobInput,
} from "./repository";
import {
  FreeConceptAlreadyConsumedError,
  UniqueConstraintViolationError,
} from "./repository";

interface LocalDatabase {
  projects: PrintProject[];
  briefs: TShirtDesignBrief[];
  conversations: DesignConversation[];
  messages: ConversationMessage[];
  artworkVersions: ArtworkVersion[];
  designBriefVersions: DesignBriefVersion[];
  /** Sprint 2H Part 1. */
  generationJobs: GenerationJob[];
  /** Phase 2C0.5. */
  paidImageIntents: PaidImageIntent[];
  /** Sprint A4. */
  acquisitionSessions: AcquisitionSession[];
  /** Sprint A4 Correction 2 — the lifetime free-attempt tombstone. */
  acquisitionFreeConceptClaims: AcquisitionFreeConceptClaim[];
  /** Sprint A5.1 — the commercial entitlement. */
  productionUnlocks: ProductionUnlock[];
  /** Sprint A5.3 — checkout/payment attempts. Never the entitlement. */
  paymentTransactions: PaymentTransaction[];
  /** Sprint A5.4 — verified provider notifications. Digest only, never payloads. */
  paymentEvents: PaymentEvent[];
  assets: AssetRecord[];
  /** Sprint 2M Phase 2B. */
  finalDirectionApprovals: FinalDirectionApproval[];
  finalArtworkJobs: FinalArtworkJob[];
  /** Sprint 2M Phase 2C. */
  productionAssetValidations: ProductionAssetValidation[];
  /** Existing Artwork → Print Ready Phase 1. */
  artworkPreparations: ArtworkPreparation[];
}

/**
 * The on-disk store location, resolved PER CALL and never frozen at module
 * load.
 *
 * These were `const DATA_DIR = path.join(process.cwd(), ".data")` evaluated at
 * import time, and that made the path a function of WHEN this module first
 * entered the graph rather than of where the process is actually working.
 *
 * Automated suites isolate themselves by `mkdtemp` + `process.chdir` inside
 * `before()`. A suite whose STATIC import graph reaches this module — e.g. via
 * `@/capabilities/composition` — evaluates it while cwd is still the repo
 * root, so the constants bound to the developer's real
 * `.data/sprint1-store.json` before the `chdir` ever ran, and every write the
 * suite made landed in it. Nothing in the test was wrong; the path was already
 * decided. `production-treatment-authorization.test.ts` wrote 36 rows into the
 * real local store this way.
 *
 * Resolving per call makes the temp-dir `chdir` authoritative for whoever
 * chdir'd, regardless of import order. Production behaviour is unchanged:
 * `next dev` / `next start` never change cwd, so every call returns exactly
 * what the frozen constant used to hold.
 */
function dataDir(): string {
  return path.join(process.cwd(), ".data");
}

function dataFile(): string {
  return path.join(dataDir(), "sprint1-store.json");
}

function nowIso(): string {
  return new Date().toISOString();
}

function emptyDb(): LocalDatabase {
  return {
    projects: [],
    briefs: [],
    conversations: [],
    messages: [],
    artworkVersions: [],
    designBriefVersions: [],
    generationJobs: [],
    paidImageIntents: [],
    acquisitionSessions: [],
    acquisitionFreeConceptClaims: [],
    productionUnlocks: [],
    paymentTransactions: [],
    paymentEvents: [],
    assets: [],
    finalDirectionApprovals: [],
    finalArtworkJobs: [],
    productionAssetValidations: [],
    artworkPreparations: [],
  };
}

async function readDb(): Promise<LocalDatabase> {
  try {
    const raw = await fs.readFile(dataFile(), "utf8");
    const parsed = JSON.parse(raw) as Partial<LocalDatabase>;
    // Normalize Sprint 1/2D local JSON that predates design_brief_versions /
    // artwork designBriefVersionId / Sprint 2F brief fields / interview
    // state so resume does not crash on older on-disk data.
    return {
      // Sprint 2M Phase 2G / Live Acceptance Corrective Pass: default the
      // new lifecycle markers for on-disk data written before they existed,
      // so resume never crashes.
      projects: (parsed.projects ?? []).map((project) => ({
        ...project,
        revisionPending: project.revisionPending ?? false,
        finalDirectionConfirmed: project.finalDirectionConfirmed ?? false,
        // Sprint A4: on-disk projects written before acquisition sessions
        // existed are legacy — grandfathered, never "unentitled".
        acquisitionSessionId: project.acquisitionSessionId ?? null,
      })),
      briefs: (parsed.briefs ?? []).map((brief) => ({
        ...brief,
        audience: brief.audience ?? null,
        purpose: brief.purpose ?? null,
        exclusions: brief.exclusions ?? null,
        deferredSections: brief.deferredSections ?? [],
      })),
      conversations: (parsed.conversations ?? []).map((conversation) => ({
        ...conversation,
        // Spread onto the full default shape (not just `??`) so a partial
        // interviewState from before a new field existed (e.g. Sprint 2G
        // Part 3's `lastRevision`) still gets a default instead of ending
        // up `undefined`.
        interviewState: {
          ...emptyInterviewState(),
          ...conversation.interviewState,
        },
      })),
      messages: parsed.messages ?? [],
      // Sprint 2H Part 1: default new provenance/reserved fields for
      // on-disk data written before they existed, so resume never crashes.
      artworkVersions: (parsed.artworkVersions ?? []).map((artwork) => ({
        ...artwork,
        designBriefVersionId: artwork.designBriefVersionId ?? null,
        generationJobId: artwork.generationJobId ?? null,
        primaryAssetId: artwork.primaryAssetId ?? null,
        thumbnailAssetId: artwork.thumbnailAssetId ?? null,
        providerKey: artwork.providerKey ?? null,
        customerRating: artwork.customerRating ?? null,
        evaluationStatus: artwork.evaluationStatus ?? null,
        evaluation: artwork.evaluation ?? null,
        evaluationEvaluatedAt: artwork.evaluationEvaluatedAt ?? null,
        evaluationProviderKey: artwork.evaluationProviderKey ?? null,
        printValidationStatus: artwork.printValidationStatus ?? null,
        // Sprint 2G Live Acceptance Corrective Pass.
        sourceArtworkVersionId: artwork.sourceArtworkVersionId ?? null,
        conceptDirectionKey: artwork.conceptDirectionKey ?? null,
      })),
      designBriefVersions: parsed.designBriefVersions ?? [],
      // Sprint 2H Part 2A: default new job fields for on-disk data written
      // before they existed, so resume never crashes.
      generationJobs: (parsed.generationJobs ?? []).map((job) => ({
        ...job,
        kind: job.kind ?? "initial",
        startedAt: job.startedAt ?? null,
        completedAt: job.completedAt ?? null,
        heartbeatAt: job.heartbeatAt ?? null,
        targetArtworkVersionId: job.targetArtworkVersionId ?? null,
        revisionInstruction: job.revisionInstruction ?? null,
        // Sprint A4 Correction 1: every job written before the acquisition
        // funnel existed is an ordinary job, never a free-concept one.
        acquisitionSessionId: job.acquisitionSessionId ?? null,
      })),
      // Phase 2C0.5: absent in every store written before paid image
      // intents existed. A pre-existing completed job simply has no
      // intents, which is exactly right — it has nothing left to pay for.
      paidImageIntents: parsed.paidImageIntents ?? [],
      // Sprint A4: absent in every store written before acquisition
      // sessions existed. No sessions means every pre-existing project is
      // legacy/grandfathered, which is exactly the intended reading.
      acquisitionSessions: parsed.acquisitionSessions ?? [],
      // Sprint A4 Correction 2: absent in every store written before the
      // free-attempt claim existed. No claims means no session has spent a
      // free concept, which is exactly right for pre-A4 data.
      acquisitionFreeConceptClaims: parsed.acquisitionFreeConceptClaims ?? [],
      // Sprint A5.1: absent in every store written before production unlocks
      // existed — no unlocks means nothing is commercially entitled, which is
      // exactly right for pre-A5 data.
      //
      // Both narrowings FAIL CLOSED and are the local store's equivalent of
      // the Postgres CHECK constraints. An on-disk row carrying a profile or
      // status this build has never heard of — a newer deploy's data, a
      // hand-edited file, a partially-written record — resolves to an
      // unrecognized sentinel rather than being coerced to the one value this
      // build implements. NULL is never `"active"`.
      productionUnlocks: (parsed.productionUnlocks ?? []).map((unlock) => ({
        ...unlock,
        productionProfile: readStoredProductionProfile(
          unlock.productionProfile as string | null | undefined,
        ),
        status: readStoredProductionUnlockStatus(
          unlock.status as string | null | undefined,
        ),
        revokedAt: unlock.revokedAt ?? null,
        revokedReason: unlock.revokedReason ?? null,
      })),
      // Sprint A5.3: absent in every store written before payment
      // transactions existed. Both narrowings FAIL CLOSED — an on-disk row
      // carrying a provider or status this build has never heard of (a newer
      // deploy's data, a hand-edited file) resolves to an unrecognized
      // sentinel. Nothing reads an unknown status as `paid`, and nothing
      // reads it as outstanding either, so a corrupt row can neither
      // authorize a purchase nor permanently block one.
      paymentTransactions: (parsed.paymentTransactions ?? []).map(
        (transaction) => ({
          ...transaction,
          provider: readStoredPaymentProvider(
            transaction.provider as string | null | undefined,
          ),
          status: readStoredPaymentTransactionStatus(
            transaction.status as string | null | undefined,
          ),
          productionProfile: readStoredProductionProfile(
            transaction.productionProfile as string | null | undefined,
          ),
          providerCheckoutSessionId: transaction.providerCheckoutSessionId ?? null,
          providerCheckoutUrl: transaction.providerCheckoutUrl ?? null,
          providerPaymentIntentId: transaction.providerPaymentIntentId ?? null,
        }),
      ),
      // Sprint A5.4: absent in every store written before payment events
      // existed. The outcome narrows FAIL CLOSED — an on-disk row carrying a
      // value this build has never heard of never reads as `processed`, so a
      // hand-edited or newer-deploy row cannot claim a payment succeeded.
      paymentEvents: (parsed.paymentEvents ?? []).map((event) => ({
        ...event,
        provider: readStoredPaymentProvider(
          event.provider as string | null | undefined,
        ),
        outcome: readStoredPaymentEventOutcome(
          event.outcome as string | null | undefined,
        ),
        processedAt: event.processedAt ?? null,
      })),
      // Sprint 2M Phase 2B/2C: default the new reserved fields for on-disk
      // data written before they existed, so resume never crashes.
      assets: (parsed.assets ?? []).map((asset) => ({
        ...asset,
        finalArtworkJobId: asset.finalArtworkJobId ?? null,
        productionRole: asset.productionRole ?? null,
      })),
      finalDirectionApprovals: parsed.finalDirectionApprovals ?? [],
      // Sprint 2M Phase 2C: default new worker-lifecycle fields for on-disk
      // data written before they existed, so resume never crashes.
      finalArtworkJobs: (parsed.finalArtworkJobs ?? []).map((job) => ({
        ...job,
        attempts: job.attempts ?? 0,
        startedAt: job.startedAt ?? null,
        completedAt: job.completedAt ?? null,
        heartbeatAt: job.heartbeatAt ?? null,
        // Sprint 2M Phase 2E: default the new paid-call idempotency fields
        // for on-disk data written before they existed.
        providerKey: job.providerKey ?? null,
        providerRequestId: job.providerRequestId ?? null,
        providerStatus: job.providerStatus ?? null,
        // Existing Artwork → Print Ready Phase 2: every job written before
        // the upload workflow existed is, by definition, a generated-concept
        // job — its authority is the approval id it already carries.
        finalDirectionApprovalId: job.finalDirectionApprovalId ?? null,
        artworkPreparationId: job.artworkPreparationId ?? null,
        productionWidthIn: job.productionWidthIn ?? null,
        sourceKind:
          job.artworkPreparationId != null ? "prepared_upload" : "generated_concept",
      })),
      productionAssetValidations: parsed.productionAssetValidations ?? [],
      // Existing Artwork → Print Ready Phase 1: absent in every store
      // written before uploaded-artwork preparation existed.
      artworkPreparations: parsed.artworkPreparations ?? [],
    };
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") return emptyDb();
    throw error;
  }
}

async function writeDb(db: LocalDatabase): Promise<void> {
  await fs.mkdir(dataDir(), { recursive: true });
  await fs.writeFile(dataFile(), JSON.stringify(db, null, 2), "utf8");
}

function snapshot(db: LocalDatabase, projectId: string): ProjectSnapshot | null {
  const project = db.projects.find((item) => item.id === projectId);
  if (!project) return null;

  const brief = db.briefs.find((item) => item.projectId === projectId);
  const conversation = db.conversations.find(
    (item) => item.projectId === projectId,
  );
  if (!brief || !conversation) return null;

  return {
    project,
    brief,
    conversation,
    messages: db.messages
      .filter((item) => item.projectId === projectId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    artworkVersions: db.artworkVersions
      .filter((item) => item.projectId === projectId)
      .sort((a, b) => a.versionNumber - b.versionNumber),
    designBriefVersions: db.designBriefVersions
      .filter((item) => item.projectId === projectId)
      .sort((a, b) => a.versionNumber - b.versionNumber),
  };
}

/**
 * Sprint 2H Part 2A: the local JSON store has no real transactions — every
 * method here is a read-modify-write over one file. That was safe as long
 * as nothing called it concurrently, but the background worker breaks that
 * assumption on purpose (a fire-and-forget dispatch racing an explicit
 * caller, or two poll-triggered recovery sweeps overlapping). Without
 * serialization, two concurrent calls can both read the same stale state,
 * or worse, interleave their writes into a truncated/corrupt JSON file
 * ("Unexpected end of JSON input" on the next read). A simple in-process
 * mutex — every call queues behind the previous one — makes every method
 * atomic relative to every other, which is exactly what
 * `claimNextQueuedJob`'s "only one caller ever wins" contract requires.
 * (Supabase's implementation gets this from real row-level conditional
 * updates instead — see its `claimNextQueuedJob`.)
 */
let mutex: Promise<unknown> = Promise.resolve();
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = mutex.then(fn, fn);
  mutex = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * Test-only: wait until every queued local-store read/write has settled.
 * Needed before deleting a temp cwd on Windows — an in-flight `writeFile`
 * keeps the directory locked (`EBUSY`) even after assertions finish.
 */
export async function drainLocalStoreMutexForTests(): Promise<void> {
  await mutex;
}

export class LocalProjectRepository implements ProjectRepository {
  constructor() {
    // Every method on this class is a read-modify-write over one shared
    // JSON file — wrapping the instance in a Proxy that serializes every
    // call through `withLock` makes each one atomic relative to the
    // others, without having to repeat that wrapping in each method body.
    // See `withLock`'s doc comment for why this is necessary.
    return new Proxy(this, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (typeof value !== "function" || prop === "constructor") {
          return value;
        }
        return (...args: unknown[]) => withLock(() => value.apply(target, args));
      },
    });
  }

  async createProject(
    acquisitionSessionId: string | null = null,
  ): Promise<ProjectSnapshot> {
    const db = await readDb();
    const timestamp = nowIso();
    const projectId = randomUUID();
    const conversationId = randomUUID();

    const project: PrintProject = {
      id: projectId,
      name: "Untitled T-shirt design",
      status: "intake",
      selectedArtworkVersionId: null,
      revisionPending: false,
      finalDirectionConfirmed: false,
      acquisitionSessionId,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    const brief: TShirtDesignBrief = {
      id: randomUUID(),
      projectId,
      customerName: null,
      projectName: null,
      productSummary: null,
      designDescription: null,
      exactText: null,
      shirtColor: null,
      // Sprint 2F: unset until the customer actually confirms a location —
      // no longer defaulted to "full_front" at creation.
      printPlacement: null,
      intendedPrintWidthIn: null,
      // Print'em All Phase 1: no garment sizing context stated, and — the
      // load-bearing one — no production size confirmed by anybody. A brand
      // new project cannot authorize paid provider work until a human
      // confirms a physical size.
      garmentSizeClass: null,
      productionSizeConfirmedAt: null,
      productionSizeConfirmedWidthIn: null,
      productionSizeConfirmedMaxHeightIn: null,
      // Print'em All Phase 2: no treatment chosen, which IS standard raster —
      // the representation whose validation nothing was relaxed for. Never a
      // halftone by default, and never a halftone because something else
      // failed.
      productionTreatment: DEFAULT_PRODUCTION_TREATMENT,
      halftoneSettings: null,
      productionTreatmentSelectedAt: null,
      // Sprint A2: unspecified — the customer has not asked for a particular
      // production artifact, which is the supported Production PNG path.
      requestedProductionOutput: null,
      preferredColors: [],
      designStyle: null,
      additionalInstructions: null,
      audience: null,
      purpose: null,
      exclusions: null,
      deferredSections: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    // Sprint 2F: new projects start in the adaptive interview lifecycle.
    // "product" is always the first question — nothing can be known yet.
    const conversation: DesignConversation = {
      id: conversationId,
      projectId,
      phase: "interviewing",
      interviewState: {
        ...emptyInterviewState(),
        pendingSection: "product",
        askCounts: { product: 1 },
      },
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    const opening: ConversationMessage = {
      id: randomUUID(),
      conversationId,
      projectId,
      role: "assistant",
      content: OPENING_PROMPT,
      metadata: { phase: "interviewing", act: "ask", section: "product" },
      createdAt: timestamp,
    };

    db.projects.push(project);
    db.briefs.push(brief);
    db.conversations.push(conversation);
    db.messages.push(opening);
    await writeDb(db);

    return {
      project,
      brief,
      conversation,
      messages: [opening],
      artworkVersions: [],
      designBriefVersions: [],
    };
  }

  async getProject(projectId: string): Promise<ProjectSnapshot | null> {
    const db = await readDb();
    return snapshot(db, projectId);
  }

  async listProjects(): Promise<PrintProject[]> {
    const db = await readDb();
    return db.projects.map((project) => ({ ...project }));
  }

  async updateProject(
    projectId: string,
    patch: Partial<
      Pick<
        PrintProject,
        | "name"
        | "status"
        | "selectedArtworkVersionId"
        | "revisionPending"
        | "finalDirectionConfirmed"
      >
    >,
  ): Promise<PrintProject> {
    const db = await readDb();
    const project = db.projects.find((item) => item.id === projectId);
    if (!project) throw new Error("Project not found");

    Object.assign(project, patch, { updatedAt: nowIso() });
    await writeDb(db);
    return project;
  }

  async updateBrief(
    projectId: string,
    patch: Partial<
      Omit<TShirtDesignBrief, "id" | "projectId" | "createdAt" | "updatedAt">
    >,
  ): Promise<TShirtDesignBrief> {
    const db = await readDb();
    const brief = db.briefs.find((item) => item.projectId === projectId);
    if (!brief) throw new Error("Brief not found");

    Object.assign(brief, patch, { updatedAt: nowIso() });

    const project = db.projects.find((item) => item.id === projectId);
    if (project) {
      project.name = projectNameFromBrief(brief);
      project.updatedAt = nowIso();
    }

    await writeDb(db);
    return brief;
  }

  async updateConversationPhase(
    projectId: string,
    phase: ConversationPhase,
  ): Promise<DesignConversation> {
    const db = await readDb();
    const conversation = db.conversations.find(
      (item) => item.projectId === projectId,
    );
    if (!conversation) throw new Error("Conversation not found");

    conversation.phase = phase;
    conversation.updatedAt = nowIso();
    await writeDb(db);
    return conversation;
  }

  async updateConversationInterviewState(
    projectId: string,
    interviewState: InterviewStateData,
  ): Promise<DesignConversation> {
    const db = await readDb();
    const conversation = db.conversations.find(
      (item) => item.projectId === projectId,
    );
    if (!conversation) throw new Error("Conversation not found");

    conversation.interviewState = interviewState;
    conversation.updatedAt = nowIso();
    await writeDb(db);
    return conversation;
  }

  async addMessage(
    projectId: string,
    input: CreateMessageInput,
  ): Promise<ConversationMessage> {
    const db = await readDb();
    const conversation = db.conversations.find(
      (item) => item.projectId === projectId,
    );
    if (!conversation) throw new Error("Conversation not found");

    const message: ConversationMessage = {
      id: randomUUID(),
      conversationId: conversation.id,
      projectId,
      role: input.role,
      content: input.content,
      metadata: input.metadata ?? {},
      createdAt: nowIso(),
    };

    db.messages.push(message);
    await writeDb(db);
    return message;
  }

  async addArtworkVersions(
    projectId: string,
    versions: CreateArtworkVersionInput[],
  ): Promise<ArtworkVersion[]> {
    const db = await readDb();
    const timestamp = nowIso();
    const created = versions.map((version) => ({
      id: randomUUID(),
      projectId,
      versionNumber: version.versionNumber,
      kind: version.kind,
      title: version.title,
      summary: version.summary,
      placeholderLabel: version.placeholderLabel,
      accentColor: version.accentColor,
      isSelected: false,
      designBriefVersionId: version.designBriefVersionId,
      generationJobId: version.generationJobId ?? null,
      primaryAssetId: version.primaryAssetId ?? null,
      thumbnailAssetId: version.thumbnailAssetId ?? null,
      providerKey: version.providerKey ?? null,
      customerRating: null,
      evaluationStatus: version.evaluationStatus ?? null,
      evaluation: version.evaluation ?? null,
      evaluationEvaluatedAt: version.evaluationEvaluatedAt ?? null,
      evaluationProviderKey: version.evaluationProviderKey ?? null,
      printValidationStatus: null,
      sourceArtworkVersionId: version.sourceArtworkVersionId ?? null,
      conceptDirectionKey: version.conceptDirectionKey ?? null,
      createdAt: timestamp,
    }));

    db.artworkVersions.push(...created);
    await writeDb(db);
    return created;
  }

  async updateArtworkEvaluation(
    artworkVersionId: string,
    input: UpdateArtworkEvaluationInput,
  ): Promise<ArtworkVersion> {
    const db = await readDb();
    const artwork = db.artworkVersions.find((item) => item.id === artworkVersionId);
    if (!artwork) throw new Error("Artwork version not found");

    artwork.evaluationStatus = input.evaluationStatus;
    artwork.evaluation = input.evaluation;
    artwork.evaluationEvaluatedAt = input.evaluationEvaluatedAt;
    artwork.evaluationProviderKey = input.evaluationProviderKey;

    await writeDb(db);
    return artwork;
  }

  async selectArtworkVersion(
    projectId: string,
    artworkVersionId: string,
  ): Promise<ProjectSnapshot> {
    const db = await readDb();
    const project = db.projects.find((item) => item.id === projectId);
    if (!project) throw new Error("Project not found");

    const versions = db.artworkVersions.filter(
      (item) => item.projectId === projectId,
    );
    const selected = versions.find((item) => item.id === artworkVersionId);
    if (!selected) throw new Error("Artwork version not found");

    for (const version of versions) {
      version.isSelected = version.id === artworkVersionId;
    }

    project.selectedArtworkVersionId = artworkVersionId;
    project.status = "revision_requested";
    project.updatedAt = nowIso();
    await writeDb(db);

    const result = snapshot(db, projectId);
    if (!result) throw new Error("Project not found");
    return result;
  }

  async clearArtworkSelection(projectId: string): Promise<ProjectSnapshot> {
    const db = await readDb();
    const project = db.projects.find((item) => item.id === projectId);
    if (!project) throw new Error("Project not found");

    for (const version of db.artworkVersions) {
      if (version.projectId === projectId) version.isSelected = false;
    }

    project.selectedArtworkVersionId = null;
    // Selection is a prerequisite for final-direction confirmation, so
    // dropping the selection necessarily drops the confirmation with it —
    // never leave a project "confirmed" with nothing selected.
    project.finalDirectionConfirmed = false;
    project.status = "concepts_ready";
    project.updatedAt = nowIso();
    await writeDb(db);

    const result = snapshot(db, projectId);
    if (!result) throw new Error("Project not found");
    return result;
  }

  async setProjectStatus(
    projectId: string,
    status: ProjectStatus,
  ): Promise<PrintProject> {
    return this.updateProject(projectId, { status });
  }

  async approveDesignBrief(
    projectId: string,
    input: ApproveDesignBriefInput,
  ): Promise<DesignBriefVersion> {
    const db = await readDb();
    const project = db.projects.find((item) => item.id === projectId);
    if (!project) throw new Error("Project not found");

    const duplicate = db.designBriefVersions.find(
      (item) =>
        item.projectId === projectId &&
        item.versionNumber === input.versionNumber,
    );
    if (duplicate) {
      throw new UniqueConstraintViolationError(
        "design_brief_versions_project_id_version_number",
      );
    }

    const timestamp = nowIso();
    const version: DesignBriefVersion = {
      id: randomUUID(),
      projectId,
      briefId: input.briefId,
      versionNumber: input.versionNumber,
      status: "approved",
      content: input.content,
      approvedAt: timestamp,
      createdAt: timestamp,
    };

    db.designBriefVersions.push(version);
    await writeDb(db);
    return version;
  }

  async getLatestDesignBriefVersion(
    projectId: string,
  ): Promise<DesignBriefVersion | null> {
    const db = await readDb();
    const versions = db.designBriefVersions
      .filter((item) => item.projectId === projectId)
      .sort((a, b) => b.versionNumber - a.versionNumber);
    return versions[0] ?? null;
  }

  async getDesignBriefVersionById(
    versionId: string,
  ): Promise<DesignBriefVersion | null> {
    const db = await readDb();
    return (
      db.designBriefVersions.find((item) => item.id === versionId) ?? null
    );
  }

  // --- Sprint 2H Part 1: generation jobs -----------------------------

  async createGenerationJob(
    projectId: string,
    input: CreateGenerationJobInput,
  ): Promise<GenerationJob> {
    const db = await readDb();

    // Sprint A4: mirrors the `unique (project_id, idempotency_key)`
    // constraint `generation_jobs` has had since 20260805130000, and the
    // Supabase store's handling of it — a duplicate returns the WINNER'S
    // row rather than creating a second job.
    //
    // Without this the local store silently allowed something the database
    // refuses, so two concurrent approvals (two tabs, a duplicated request)
    // produced two jobs locally and one in production. Since a job is the
    // unit that authorizes paid generation, that divergence meant the local
    // store could not be used to prove a spend property at all.
    const duplicate = db.generationJobs.find(
      (existing) =>
        existing.projectId === projectId &&
        existing.idempotencyKey === input.idempotencyKey,
    );
    if (duplicate) return duplicate;

    // Sprint A4 Correction 2: mirrors the `acquisition_free_concept_claims`
    // PRIMARY KEY and the BEFORE INSERT trigger that takes it — the LIFETIME
    // entitlement authority.
    //
    // Correction 1 checked the jobs list instead, mirroring the partial
    // unique index. That index only constrains rows that EXIST, so deleting
    // the free job freed the slot for another. The claim is owned by the
    // session and holds no reference back to the job, so it keeps refusing
    // after the job is gone.
    //
    // Checked AFTER the idempotency-key match on purpose, and in that order
    // for the same reason the Supabase store re-reads before deciding: the
    // two rules mean different things. The same logical job coming back is a
    // RESUME and must succeed; a different job for a session that already has
    // one is a SECOND FREE CONCEPT and must not. Reversing the order would
    // refuse every legitimate retry.
    //
    // Deliberately NOT scoped to `projectId`. The bypass this closes is a
    // second PROJECT in the same session, so it is session-wide exactly as
    // the database's is.
    //
    // The claim is written in the SAME locked call that writes the job (this
    // whole method runs behind `withLock`), which is the local equivalent of
    // the trigger firing inside the insert's transaction. There is no window
    // in which one exists without the other.
    if (input.acquisitionSessionId) {
      const claimed = db.acquisitionFreeConceptClaims.some(
        (claim) => claim.acquisitionSessionId === input.acquisitionSessionId,
      );
      if (claimed) throw new FreeConceptAlreadyConsumedError();
    }

    const timestamp = nowIso();
    const job: GenerationJob = {
      id: randomUUID(),
      projectId,
      designBriefVersionId: input.designBriefVersionId,
      status: "queued",
      kind: input.kind,
      conceptCount: input.conceptCount,
      providerKey: input.providerKey,
      idempotencyKey: input.idempotencyKey,
      targetArtworkVersionId: input.targetArtworkVersionId ?? null,
      revisionInstruction: input.revisionInstruction ?? null,
      acquisitionSessionId: input.acquisitionSessionId ?? null,
      attempts: 0,
      lastError: null,
      startedAt: null,
      completedAt: null,
      heartbeatAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    db.generationJobs.push(job);
    if (input.acquisitionSessionId) {
      db.acquisitionFreeConceptClaims.push({
        acquisitionSessionId: input.acquisitionSessionId,
        generationJobId: job.id,
        claimedAt: timestamp,
      });
    }
    await writeDb(db);
    return job;
  }

  async getFreeConceptClaim(
    acquisitionSessionId: string,
  ): Promise<AcquisitionFreeConceptClaim | null> {
    const db = await readDb();
    return (
      db.acquisitionFreeConceptClaims.find(
        (claim) => claim.acquisitionSessionId === acquisitionSessionId,
      ) ?? null
    );
  }

  async getGenerationJobByIdempotencyKey(
    projectId: string,
    idempotencyKey: string,
  ): Promise<GenerationJob | null> {
    const db = await readDb();
    return (
      db.generationJobs.find(
        (job) =>
          job.projectId === projectId &&
          job.idempotencyKey === idempotencyKey,
      ) ?? null
    );
  }

  async getGenerationJob(jobId: string): Promise<GenerationJob | null> {
    const db = await readDb();
    return db.generationJobs.find((job) => job.id === jobId) ?? null;
  }

  async listGenerationJobs(projectId: string): Promise<GenerationJob[]> {
    const db = await readDb();
    return db.generationJobs
      .filter((job) => job.projectId === projectId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async updateGenerationJob(
    jobId: string,
    patch: UpdateGenerationJobInput,
  ): Promise<GenerationJob> {
    const db = await readDb();
    const job = db.generationJobs.find((item) => item.id === jobId);
    if (!job) throw new Error("Generation job not found");

    Object.assign(job, patch, { updatedAt: nowIso() });
    await writeDb(db);
    return job;
  }

  // --- Sprint 2H Part 2A: background worker ---------------------------

  async claimNextQueuedJob(): Promise<GenerationJob | null> {
    const db = await readDb();
    const candidates = db.generationJobs
      .filter((job) => job.status === "queued" || job.status === "recoverable")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const job = candidates[0];
    if (!job) return null;

    // A single-process local store has no real concurrent-claim race, but
    // the shape mirrors the Supabase optimistic-claim contract exactly:
    // read the candidate, then only commit if it's still in the status we
    // read it in.
    const timestamp = nowIso();
    job.status = "running";
    job.attempts += 1;
    job.startedAt = timestamp;
    job.heartbeatAt = timestamp;
    job.updatedAt = timestamp;
    await writeDb(db);
    return job;
  }

  async touchGenerationJobHeartbeat(jobId: string): Promise<void> {
    const db = await readDb();
    const job = db.generationJobs.find((item) => item.id === jobId);
    if (!job) return;
    job.heartbeatAt = nowIso();
    await writeDb(db);
  }

  async recoverAbandonedJobs(staleAfterMs: number): Promise<GenerationJob[]> {
    const db = await readDb();
    const now = Date.now();
    const recovered: GenerationJob[] = [];

    for (const job of db.generationJobs) {
      if (job.status !== "running") continue;
      const lastHeartbeat = job.heartbeatAt
        ? Date.parse(job.heartbeatAt)
        : Date.parse(job.startedAt ?? job.updatedAt);
      if (now - lastHeartbeat < staleAfterMs) continue;

      job.status = "recoverable";
      job.updatedAt = nowIso();
      recovered.push(job);
    }

    if (recovered.length > 0) await writeDb(db);
    return recovered;
  }

  // --- Sprint A4: acquisition sessions ---------------------------------
  //
  // Every method on this store already runs behind `withLock` (see the
  // constructor's Proxy), so each read-modify-write below is atomic
  // relative to every other one. That is what gives `allocateFreeConcept`
  // the same "only one caller ever wins" guarantee Supabase gets from a
  // single row-conditional UPDATE.

  async createAcquisitionSession(
    sessionToken: string,
  ): Promise<AcquisitionSession> {
    const db = await readDb();
    const timestamp = nowIso();
    const session: AcquisitionSession = {
      id: randomUUID(),
      sessionToken,
      entitlement: "prospect",
      freeConceptProjectId: null,
      freeConceptAllocatedAt: null,
      freeConceptGenerationJobId: null,
      freeConceptConsumedAt: null,
      email: null,
      emailCapturedAt: null,
      internalGrantedAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    db.acquisitionSessions.push(session);
    await writeDb(db);
    return session;
  }

  async getAcquisitionSessionByToken(
    sessionToken: string,
  ): Promise<AcquisitionSession | null> {
    const db = await readDb();
    return (
      db.acquisitionSessions.find(
        (item) => item.sessionToken === sessionToken,
      ) ?? null
    );
  }

  async getAcquisitionSession(
    sessionId: string,
  ): Promise<AcquisitionSession | null> {
    const db = await readDb();
    return db.acquisitionSessions.find((item) => item.id === sessionId) ?? null;
  }

  async getFreeConceptGenerationJob(
    acquisitionSessionId: string,
  ): Promise<GenerationJob | null> {
    const db = await readDb();
    return (
      db.generationJobs.find(
        (job) => job.acquisitionSessionId === acquisitionSessionId,
      ) ?? null
    );
  }

  async allocateFreeConcept(
    sessionId: string,
    projectId: string,
  ): Promise<FreeConceptAllocation> {
    const db = await readDb();
    const session = db.acquisitionSessions.find(
      (item) => item.id === sessionId,
    );
    if (!session) throw new Error("Acquisition session not found");

    // Consumption is checked FIRST and is unconditional. A session whose
    // free concept was already spent by a durable job is exhausted even for
    // the very project it was spent on — otherwise the second generation
    // request on that project would resume an allocation that has nothing
    // left in it.
    //
    // Sprint A4 Correction 1: consumption is now read from TWO sources, and
    // either one alone is sufficient. `freeConceptConsumedAt` is the marker
    // written right after the job insert; the free-concept job's existence
    // is the fact the database itself guarantees. A crash between the two
    // writes leaves the second true and the first false, and this must
    // report exhausted in that state — otherwise the crash window is exactly
    // the bypass.
    //
    // Sprint A4 Correction 2: the claim is consulted first and is the one
    // that survives deletion of the job — mirroring the Postgres primary key
    // the insert is actually checked against.
    if (
      db.acquisitionFreeConceptClaims.some(
        (claim) => claim.acquisitionSessionId === sessionId,
      ) ||
      session.freeConceptConsumedAt ||
      session.freeConceptGenerationJobId ||
      db.generationJobs.some((job) => job.acquisitionSessionId === sessionId)
    ) {
      return { outcome: "exhausted", session };
    }
    if (session.freeConceptProjectId === projectId) {
      return { outcome: "resumed", session };
    }
    if (session.freeConceptProjectId !== null) {
      return { outcome: "exhausted", session };
    }

    session.freeConceptProjectId = projectId;
    session.freeConceptAllocatedAt = nowIso();
    session.updatedAt = session.freeConceptAllocatedAt;
    await writeDb(db);
    return { outcome: "allocated", session };
  }

  async recordFreeConceptConsumed(
    sessionId: string,
    generationJobId: string,
  ): Promise<AcquisitionSession | null> {
    const db = await readDb();
    const session = db.acquisitionSessions.find(
      (item) => item.id === sessionId,
    );
    if (!session) return null;
    // Conditional: consumption is written once and never re-pointed.
    if (session.freeConceptGenerationJobId) return session;

    session.freeConceptGenerationJobId = generationJobId;
    session.freeConceptConsumedAt = nowIso();
    session.updatedAt = session.freeConceptConsumedAt;
    await writeDb(db);
    return session;
  }

  async captureAcquisitionEmail(
    sessionId: string,
    input: CaptureAcquisitionEmailInput,
  ): Promise<AcquisitionSession | null> {
    const db = await readDb();
    const session = db.acquisitionSessions.find(
      (item) => item.id === sessionId,
    );
    if (!session) return null;

    const timestamp = nowIso();
    session.email = input.email;
    // Stamped on first capture only — a correction is not a new capture.
    session.emailCapturedAt = session.emailCapturedAt ?? timestamp;
    session.updatedAt = timestamp;
    await writeDb(db);
    return session;
  }

  async grantInternalEntitlement(
    sessionId: string,
  ): Promise<AcquisitionSession | null> {
    const db = await readDb();
    const session = db.acquisitionSessions.find(
      (item) => item.id === sessionId,
    );
    if (!session) return null;

    const timestamp = nowIso();
    session.entitlement = "internal";
    session.internalGrantedAt = session.internalGrantedAt ?? timestamp;
    session.updatedAt = timestamp;
    await writeDb(db);
    return session;
  }

  // --- Sprint A5.1: production unlocks (commercial entitlement) --------

  async getActiveProductionUnlock(
    projectId: string,
    productionProfile: ProductionProfile,
  ): Promise<ProductionUnlock | null> {
    const db = await readDb();
    // Mirrors the Supabase query's `.eq("status", "active")` exactly. The
    // status compared here has already been narrowed fail-closed by
    // `readDb`, so a row carrying an uninterpretable value can never match
    // — the same outcome the Postgres CHECK constraint produces by refusing
    // to store one in the first place.
    return (
      db.productionUnlocks.find(
        (unlock) =>
          unlock.projectId === projectId &&
          unlock.productionProfile === productionProfile &&
          unlock.status === "active",
      ) ?? null
    );
  }

  async createProductionUnlock(
    projectId: string,
    input: CreateProductionUnlockInput,
  ): Promise<ProductionUnlockGrant> {
    const db = await readDb();

    // The local store's equivalent of the partial unique index
    // `production_unlocks_active_per_project_profile_idx`. Every method on
    // this class runs under the process-wide `withLock` mutex, so this
    // check-then-insert is atomic relative to every other call — which is
    // what makes "two concurrent grants resolve to one active row" a real
    // guarantee here rather than a hope, matching what Postgres gives the
    // Supabase implementation for free.
    const existing = db.productionUnlocks.find(
      (unlock) =>
        unlock.projectId === projectId &&
        unlock.productionProfile === input.productionProfile &&
        unlock.status === "active",
    );
    if (existing) return { outcome: "existing", unlock: existing };

    const timestamp = nowIso();
    const unlock: ProductionUnlock = {
      id: randomUUID(),
      projectId,
      acquisitionSessionId: input.acquisitionSessionId,
      productionProfile: input.productionProfile,
      // Always "active". A record inserted already-revoked would carry a
      // `grantedAt` nobody ever granted.
      status: "active",
      grantedAt: timestamp,
      revokedAt: null,
      revokedReason: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    db.productionUnlocks.push(unlock);
    await writeDb(db);
    return { outcome: "granted", unlock };
  }

  async revokeProductionUnlock(
    projectId: string,
    productionProfile: ProductionProfile,
    reason: string | null,
  ): Promise<ProductionUnlock | null> {
    const db = await readDb();
    const unlock = db.productionUnlocks.find(
      (item) =>
        item.projectId === projectId &&
        item.productionProfile === productionProfile &&
        item.status === "active",
    );
    // Nothing active to revoke. Deliberately not an error: revoking twice,
    // or revoking something that was never granted, both leave the world in
    // the state the caller wanted.
    if (!unlock) return null;

    const timestamp = nowIso();
    // The row is mutated in place and NEVER removed — it is the audit trail
    // a refund depends on. Nothing about `final_artwork_jobs`, assets, or
    // production validations is touched: artwork that was produced genuinely
    // was produced, and revocation only stops FUTURE finalization.
    unlock.status = "revoked";
    unlock.revokedAt = timestamp;
    unlock.revokedReason = reason;
    unlock.updatedAt = timestamp;
    await writeDb(db);
    return unlock;
  }

  // --- Sprint A5.3: payment transactions (checkout attempts) -----------

  async getOutstandingPaymentTransaction(
    projectId: string,
    productionProfile: ProductionProfile,
  ): Promise<PaymentTransaction | null> {
    const db = await readDb();
    // Mirrors the Supabase query's status filter exactly. Terminal rows are
    // deliberately invisible here: a `failed` attempt must not strand a
    // customer entitled to try again, and a `paid` one must not be put back
    // in front of them.
    return (
      db.paymentTransactions.find(
        (transaction) =>
          transaction.projectId === projectId &&
          transaction.productionProfile === productionProfile &&
          isOutstandingPaymentTransaction(transaction),
      ) ?? null
    );
  }

  async getPaymentTransaction(id: string): Promise<PaymentTransaction | null> {
    const db = await readDb();
    return db.paymentTransactions.find((item) => item.id === id) ?? null;
  }

  async openPaymentTransaction(
    projectId: string,
    input: OpenPaymentTransactionInput,
  ): Promise<PaymentTransactionOpening> {
    const db = await readDb();

    // The local store's equivalent of the partial unique index
    // `payment_transactions_outstanding_per_project_profile_idx`. Every
    // method here runs behind the process-wide `withLock` mutex, so this
    // check-then-insert is atomic relative to every other call — which is
    // what makes "two tabs converge on one payment page" a guarantee rather
    // than a hope, matching what Postgres gives the Supabase store for free.
    const existing = db.paymentTransactions.find(
      (transaction) =>
        transaction.projectId === projectId &&
        transaction.productionProfile === input.productionProfile &&
        isOutstandingPaymentTransaction(transaction),
    );
    if (existing) return { outcome: "existing", transaction: existing };

    const timestamp = nowIso();
    const transaction: PaymentTransaction = {
      id: randomUUID(),
      projectId,
      acquisitionSessionId: input.acquisitionSessionId,
      productionProfile: input.productionProfile,
      provider: input.provider,
      // Nothing exists at the provider yet, and the state is named for that
      // rather than pretending a checkout was created.
      providerCheckoutSessionId: null,
      providerCheckoutUrl: null,
      providerPaymentIntentId: null,
      amountMinor: input.amountMinor,
      currency: input.currency,
      status: "pending_provider",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    db.paymentTransactions.push(transaction);
    await writeDb(db);
    return { outcome: "opened", transaction };
  }

  async bindProviderCheckoutSession(
    id: string,
    input: BindProviderCheckoutSessionInput,
  ): Promise<PaymentTransaction | null> {
    const db = await readDb();
    const transaction = db.paymentTransactions.find((item) => item.id === id);
    if (!transaction) return null;
    // Conditional, mirroring the Supabase `.eq("status", "pending_provider")`:
    // a late or duplicated bind must never re-point a transaction at a
    // different session or resurrect a terminal one. The caller receives the
    // row as it genuinely stands, which is the fact it needs.
    if (transaction.status !== "pending_provider") return transaction;

    // Mirrors the Supabase UNIQUE constraints: one provider session belongs
    // to exactly one attempt, so a webhook can never resolve to two rows.
    const sessionTaken = db.paymentTransactions.some(
      (item) =>
        item.id !== id &&
        item.providerCheckoutSessionId === input.providerCheckoutSessionId,
    );
    if (sessionTaken) {
      throw new UniqueConstraintViolationError(
        "payment_transactions_provider_checkout_session_id_key",
      );
    }

    const timestamp = nowIso();
    transaction.providerCheckoutSessionId = input.providerCheckoutSessionId;
    transaction.providerCheckoutUrl = input.providerCheckoutUrl;
    transaction.providerPaymentIntentId = input.providerPaymentIntentId ?? null;
    transaction.status = "created";
    transaction.updatedAt = timestamp;
    await writeDb(db);
    return transaction;
  }

  // --- Sprint A5.4: verified payment events + atomic activation --------

  async getPaymentEventByProviderId(
    provider: PaymentProviderKey,
    providerEventId: string,
  ): Promise<PaymentEvent | null> {
    const db = await readDb();
    return (
      db.paymentEvents.find(
        (event) =>
          event.provider === provider &&
          event.providerEventId === providerEventId,
      ) ?? null
    );
  }

  /**
   * THE ATOMIC PAYMENT-TO-ENTITLEMENT TRANSITION.
   *
   * This is a line-by-line mirror of the `apply_payment_event` PostgreSQL
   * function (`20260817180000_payment_events.sql`), and the two must not
   * drift — every decision below exists there in the same order and with the
   * same outcome. Atomicity comes from the process-wide `withLock` mutex every
   * method on this class runs behind; the Supabase implementation gets it from
   * a real database transaction.
   *
   * The ordering is the design: the event insert (the idempotency fence) is
   * taken FIRST, so a duplicate delivery can never read-then-act.
   */
  async applyPaymentEvent(
    input: ApplyPaymentEventInput,
  ): Promise<PaymentEventApplication> {
    const db = await readDb();

    // (1) The idempotency fence.
    const alreadySeen = db.paymentEvents.some(
      (event) => event.providerEventId === input.providerEventId,
    );
    if (alreadySeen) return "duplicate";

    const timestamp = nowIso();
    const event: PaymentEvent = {
      id: randomUUID(),
      provider: input.provider,
      providerEventId: input.providerEventId,
      eventType: input.eventType,
      payloadDigest: input.payloadDigest,
      receivedAt: timestamp,
      outcome: "ignored",
      processedAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    db.paymentEvents.push(event);

    const settle = async (
      outcome: PaymentEventOutcome,
    ): Promise<PaymentEventApplication> => {
      event.outcome = outcome;
      event.processedAt = nowIso();
      event.updatedAt = event.processedAt;
      await writeDb(db);
      return outcome;
    };

    if (input.action === "ignore") return settle("ignored");

    // (2) Resolve the transaction. Provider metadata never bootstraps one.
    const transaction = input.paymentTransactionId
      ? db.paymentTransactions.find(
          (item) => item.id === input.paymentTransactionId,
        )
      : undefined;
    if (!transaction) return settle("unmatched");

    // (3) The checkout session must match. Trusting the metadata handle while
    // ignoring the session id would let one mislabelled value pay off a
    // different transaction.
    if (
      transaction.providerCheckoutSessionId !== input.providerCheckoutSessionId
    ) {
      return settle("rejected_mismatch");
    }

    if (input.action === "expire") {
      // A PAID transaction is never downgraded by a lapse notification. Money
      // that arrived does not un-arrive because a session object expired.
      if (
        transaction.status === "pending_provider" ||
        transaction.status === "created"
      ) {
        transaction.status = "expired";
        transaction.updatedAt = nowIso();
        return settle("processed");
      }
      return settle("ignored");
    }

    // (4) The money path. Amount and currency must match EXACTLY.
    if (
      transaction.amountMinor !== input.amountMinor ||
      transaction.currency !== input.currency
    ) {
      return settle("rejected_mismatch");
    }

    // Stated positively so a status this build has never heard of can never
    // pass. `expired` is included because an out-of-order lapse does not make
    // real money unreal; `paid` because a second distinct event for the same
    // payment must converge rather than fail.
    if (
      transaction.status !== "created" &&
      transaction.status !== "expired" &&
      transaction.status !== "paid"
    ) {
      return settle("rejected_mismatch");
    }

    // Mirrors the UNIQUE constraint on `provider_payment_intent_id`: one
    // provider payment intent can never pay off two transactions.
    if (input.providerPaymentIntentId) {
      const boundElsewhere = db.paymentTransactions.some(
        (item) =>
          item.id !== transaction.id &&
          item.providerPaymentIntentId === input.providerPaymentIntentId,
      );
      if (boundElsewhere) return settle("rejected_mismatch");
      if (
        transaction.providerPaymentIntentId &&
        transaction.providerPaymentIntentId !== input.providerPaymentIntentId
      ) {
        return settle("rejected_mismatch");
      }
      transaction.providerPaymentIntentId = input.providerPaymentIntentId;
    }

    transaction.status = "paid";
    transaction.updatedAt = nowIso();

    // THE ENTITLEMENT, derived entirely from the transaction row — the webhook
    // never supplied a project, a session, or a profile. Reused rather than
    // duplicated, mirroring the partial unique index.
    const activeUnlock = db.productionUnlocks.find(
      (unlock) =>
        unlock.projectId === transaction.projectId &&
        unlock.productionProfile === transaction.productionProfile &&
        unlock.status === "active",
    );
    if (!activeUnlock) {
      const grantedAt = nowIso();
      db.productionUnlocks.push({
        id: randomUUID(),
        projectId: transaction.projectId,
        acquisitionSessionId: transaction.acquisitionSessionId,
        productionProfile: transaction.productionProfile,
        status: "active",
        grantedAt,
        revokedAt: null,
        revokedReason: null,
        createdAt: grantedAt,
        updatedAt: grantedAt,
      });
    }

    return settle("processed");
  }

  async failPendingPaymentTransaction(
    id: string,
    reason: string | null,
  ): Promise<PaymentTransaction | null> {
    const db = await readDb();
    const transaction = db.paymentTransactions.find((item) => item.id === id);
    if (!transaction) return null;
    // Only a pre-provider attempt may be failed. A `created` row describes a
    // real provider session and a terminal row is already history; rewriting
    // either would destroy the record rather than close it.
    if (transaction.status !== "pending_provider") return transaction;

    const timestamp = nowIso();
    transaction.status = "failed";
    transaction.updatedAt = timestamp;
    await writeDb(db);
    // `reason` is deliberately not persisted: there is no column for it, and
    // adding one to carry a provider's error text is how provider dialect
    // leaks into the durable domain. The caller logs it server-side.
    void reason;
    return transaction;
  }

  // --- Phase 2C0.5: durable paid image intents -------------------------

  async reservePaidImageIntent(
    projectId: string,
    input: ReservePaidImageIntentInput,
  ): Promise<PaidImageIntentReservation> {
    const db = await readDb();

    const existing = db.paidImageIntents.find(
      (intent) =>
        intent.projectId === projectId && intent.intentKey === input.intentKey,
    );
    if (existing) return { outcome: "existing", intent: existing };

    // Mirrors the Supabase unique (generation_job_id, paid_intent_ordinal)
    // constraint: a slot another worker already took is a lost race, not an
    // error, and no paid call has happened.
    const ordinalTaken = db.paidImageIntents.some(
      (intent) =>
        intent.generationJobId === input.generationJobId &&
        intent.paidIntentOrdinal === input.paidIntentOrdinal,
    );
    if (ordinalTaken) return { outcome: "ordinal_taken" };

    const timestamp = nowIso();
    const intent: PaidImageIntent = {
      id: randomUUID(),
      projectId,
      generationJobId: input.generationJobId,
      intentKey: input.intentKey,
      intentKind: input.intentKind,
      directionKey: input.directionKey,
      paidIntentOrdinal: input.paidIntentOrdinal,
      status: "reserved",
      dispatches: 0,
      claimToken: null,
      providerKey: input.providerKey,
      providerRequestId: null,
      result: null,
      lastError: null,
      succeededAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    db.paidImageIntents.push(intent);
    await writeDb(db);
    return { outcome: "created", intent };
  }

  async beginPaidImageIntentDispatch(
    intentId: string,
    claimToken: string,
    maxDispatches: number,
  ): Promise<PaidImageIntent | null> {
    const db = await readDb();
    const intent = db.paidImageIntents.find((item) => item.id === intentId);
    if (!intent) return null;
    // Exactly the Supabase conditional update's WHERE clause: still
    // reserved, and dispatches remaining. Anything else refuses the paid
    // call rather than making it.
    if (intent.status !== "reserved") return null;
    if (intent.dispatches >= maxDispatches) return null;

    intent.dispatches += 1;
    intent.claimToken = claimToken;
    intent.updatedAt = nowIso();
    await writeDb(db);
    return intent;
  }

  async completePaidImageIntent(
    intentId: string,
    claimToken: string,
    input: CompletePaidImageIntentInput,
  ): Promise<PaidImageIntent | null> {
    const db = await readDb();
    const intent = db.paidImageIntents.find((item) => item.id === intentId);
    if (!intent) return null;
    // Fencing: a zombie worker holding the previous token is refused.
    if (intent.claimToken !== claimToken) return null;

    intent.status = input.status;
    if (input.result !== undefined) intent.result = input.result;
    if (input.providerRequestId !== undefined) {
      intent.providerRequestId = input.providerRequestId;
    }
    if (input.lastError !== undefined) intent.lastError = input.lastError;
    if (input.status === "succeeded") intent.succeededAt = nowIso();
    intent.updatedAt = nowIso();
    await writeDb(db);
    return intent;
  }

  async recordPaidImageIntentFailure(
    intentId: string,
    claimToken: string,
    input: RecordPaidImageIntentFailureInput,
  ): Promise<PaidImageIntent | null> {
    const db = await readDb();
    const intent = db.paidImageIntents.find((item) => item.id === intentId);
    if (!intent) return null;
    // Same fencing as `completePaidImageIntent`: a zombie worker holding the
    // previous token is refused.
    if (intent.claimToken !== claimToken) return null;
    // A durable success is never downgraded by a late failure write — the
    // bytes exist and are reusable, whatever this worker went on to hit.
    if (intent.status === "succeeded") return null;

    intent.lastError = input.lastError;
    // Only ever written, never cleared: the id of a request we already know
    // was billed is the single most valuable field on this row.
    if (input.providerRequestId) {
      intent.providerRequestId = input.providerRequestId;
    }
    if (input.terminal === true) intent.status = "failed";
    intent.updatedAt = nowIso();
    await writeDb(db);
    return intent;
  }

  async getPaidImageIntentByKey(
    projectId: string,
    intentKey: string,
  ): Promise<PaidImageIntent | null> {
    const db = await readDb();
    return (
      db.paidImageIntents.find(
        (intent) =>
          intent.projectId === projectId && intent.intentKey === intentKey,
      ) ?? null
    );
  }

  async listPaidImageIntentsForJob(
    projectId: string,
    generationJobId: string,
  ): Promise<PaidImageIntent[]> {
    const db = await readDb();
    return db.paidImageIntents
      .filter(
        (intent) =>
          intent.projectId === projectId &&
          intent.generationJobId === generationJobId,
      )
      .sort((a, b) => a.paidIntentOrdinal - b.paidIntentOrdinal);
  }

  // --- Sprint 2H Part 1: assets ---------------------------------------

  async createAsset(
    projectId: string,
    input: CreateAssetInput,
  ): Promise<AssetRecord> {
    const db = await readDb();
    const asset: AssetRecord = {
      id: randomUUID(),
      projectId,
      ...input,
      createdAt: nowIso(),
    };
    db.assets.push(asset);
    await writeDb(db);
    return asset;
  }

  async listAssets(projectId: string): Promise<AssetRecord[]> {
    const db = await readDb();
    return db.assets
      .filter((asset) => asset.projectId === projectId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async getAssetById(assetId: string): Promise<AssetRecord | null> {
    const db = await readDb();
    return db.assets.find((asset) => asset.id === assetId) ?? null;
  }

  async deleteAsset(assetId: string): Promise<void> {
    const db = await readDb();
    const index = db.assets.findIndex((asset) => asset.id === assetId);
    if (index === -1) return;
    db.assets.splice(index, 1);
    await writeDb(db);
  }

  // --- Sprint 2M Phase 2B: final direction approval + final artwork job ---

  async createFinalDirectionApproval(
    projectId: string,
    input: CreateFinalDirectionApprovalInput,
  ): Promise<FinalDirectionApproval> {
    const db = await readDb();
    const existingActive = db.finalDirectionApprovals.find(
      (item) => item.projectId === projectId && item.status === "active",
    );
    if (existingActive) {
      // Every method on this store already runs behind `withLock`, so a
      // second active row for the same project can only happen if a caller
      // skipped `supersedeActiveFinalDirectionApproval` first — mirror the
      // Supabase unique-partial-index behavior rather than silently
      // allowing two active rows.
      throw new UniqueConstraintViolationError(
        "final_direction_approvals_active_per_project",
      );
    }

    const timestamp = nowIso();
    const approval: FinalDirectionApproval = {
      id: randomUUID(),
      projectId,
      artworkVersionId: input.artworkVersionId,
      designBriefVersionId: input.designBriefVersionId,
      status: "active",
      approvedAt: timestamp,
      supersededAt: null,
      createdAt: timestamp,
    };
    db.finalDirectionApprovals.push(approval);
    await writeDb(db);
    return approval;
  }

  async getActiveFinalDirectionApproval(
    projectId: string,
  ): Promise<FinalDirectionApproval | null> {
    const db = await readDb();
    return (
      db.finalDirectionApprovals.find(
        (item) => item.projectId === projectId && item.status === "active",
      ) ?? null
    );
  }

  async supersedeActiveFinalDirectionApproval(
    projectId: string,
  ): Promise<FinalDirectionApproval | null> {
    const db = await readDb();
    const active = db.finalDirectionApprovals.find(
      (item) => item.projectId === projectId && item.status === "active",
    );
    if (!active) return null;

    active.status = "superseded";
    active.supersededAt = nowIso();
    await writeDb(db);
    return active;
  }

  async createFinalArtworkJob(
    projectId: string,
    input: CreateFinalArtworkJobInput,
  ): Promise<FinalArtworkJob> {
    const db = await readDb();
    if (input.sourceKind === "generated_concept") {
      const duplicate = db.finalArtworkJobs.find(
        (item) =>
          item.projectId === projectId &&
          item.finalDirectionApprovalId === input.finalDirectionApprovalId &&
          // Sprint A2 Correction 2: intent is part of job identity, mirroring
          // the migration's coalesced unique index. A PNG job and a
          // separations job for the same approval are different jobs.
          productionIntentMatches(
            item.requestedProductionOutput,
            input.requestedProductionOutput,
          ) &&
          // Print'em All Phase 1: production width joins create_new job
          // identity, mirroring this migration's
          // `coalesce(production_width_in, -1)`. A 12in plate is not a 10.5in
          // plate, so a newly confirmed size gets its OWN job rather than
          // re-targeting one that may already be with a paid provider.
          // Legacy rows (width NULL) collapse to the same `-1` bucket the
          // coalesced index puts them in, so they keep deduplicating against
          // each other exactly as before.
          Math.abs(
            (item.productionWidthIn ?? -1) - (input.productionWidthIn ?? -1),
          ) < 1e-6 &&
          // Print'em All Phase 2: production treatment joins job identity,
          // mirroring the migration's
          // `coalesce(production_treatment_key, 'standard_raster')`. Legacy
          // rows collapse to the same bucket a newly written standard-raster
          // job lands in, which is correct: they are the same production
          // intent.
          (item.productionTreatmentKey ?? STANDARD_RASTER_TREATMENT_KEY) ===
            input.productionTreatmentKey,
      );
      if (duplicate) {
        throw new UniqueConstraintViolationError(
          "final_artwork_jobs_project_id_final_direction_approval_id",
        );
      }
    } else {
      // Existing Artwork → Print Ready Phase 2: the upload workflow's
      // idempotency key is (project, preparation, production width) — the
      // local-store equivalent of the partial unique index the migration
      // adds. Widths are compared with the same explicit tolerance the
      // capability uses rather than float equality.
      const duplicate = db.finalArtworkJobs.find(
        (item) =>
          item.projectId === projectId &&
          item.artworkPreparationId === input.artworkPreparationId &&
          item.productionWidthIn !== null &&
          Math.abs(item.productionWidthIn - input.productionWidthIn) < 1e-6 &&
          productionIntentMatches(
            item.requestedProductionOutput,
            input.requestedProductionOutput,
          ) &&
          // Print'em All Phase 2: see the create_new branch above — same key,
          // same coalesced legacy bucket.
          (item.productionTreatmentKey ?? STANDARD_RASTER_TREATMENT_KEY) ===
            input.productionTreatmentKey,
      );
      if (duplicate) {
        throw new UniqueConstraintViolationError(
          "final_artwork_jobs_project_id_artwork_preparation_id_width",
        );
      }
    }

    const timestamp = nowIso();
    const job: FinalArtworkJob = {
      id: randomUUID(),
      projectId,
      sourceKind: input.sourceKind,
      finalDirectionApprovalId:
        input.sourceKind === "generated_concept"
          ? input.finalDirectionApprovalId
          : null,
      artworkPreparationId:
        input.sourceKind === "prepared_upload" ? input.artworkPreparationId : null,
      // Print'em All Phase 1: written for BOTH workflows now — a create_new
      // job is bound to the confirmed size it was enqueued for, exactly as a
      // prepared_upload job already was.
      productionWidthIn: input.productionWidthIn,
      // Print'em All Phase 2: frozen at enqueue and never re-read, exactly
      // like the width above.
      productionTreatmentKey: input.productionTreatmentKey,
      requestedProductionOutput: input.requestedProductionOutput,
      artworkVersionId: input.artworkVersionId,
      status: "queued",
      attempts: 0,
      lastError: null,
      startedAt: null,
      completedAt: null,
      heartbeatAt: null,
      providerKey: null,
      providerRequestId: null,
      providerStatus: null,
      providerRecoveryAttempts: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    db.finalArtworkJobs.push(job);
    await writeDb(db);
    return job;
  }

  async getFinalArtworkJobByApprovalId(
    projectId: string,
    finalDirectionApprovalId: string,
  ): Promise<FinalArtworkJob | null> {
    const db = await readDb();
    return (
      db.finalArtworkJobs.find(
        (item) =>
          item.projectId === projectId &&
          item.finalDirectionApprovalId === finalDirectionApprovalId,
      ) ?? null
    );
  }

  async listActiveFinalArtworkJobs(projectId: string): Promise<FinalArtworkJob[]> {
    const db = await readDb();
    return db.finalArtworkJobs.filter(
      (item) =>
        item.projectId === projectId && isActiveFinalArtworkJobStatus(item.status),
    );
  }

  async listFinalArtworkJobsForApproval(
    projectId: string,
    finalDirectionApprovalId: string,
  ): Promise<FinalArtworkJob[]> {
    const db = await readDb();
    return db.finalArtworkJobs.filter(
      (item) =>
        item.projectId === projectId &&
        item.finalDirectionApprovalId === finalDirectionApprovalId,
    );
  }

  async listFinalArtworkJobsForPreparation(
    projectId: string,
    artworkPreparationId: string,
  ): Promise<FinalArtworkJob[]> {
    const db = await readDb();
    return db.finalArtworkJobs
      .filter(
        (item) =>
          item.projectId === projectId &&
          item.artworkPreparationId === artworkPreparationId,
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async getFinalDirectionApprovalById(
    id: string,
  ): Promise<FinalDirectionApproval | null> {
    const db = await readDb();
    return db.finalDirectionApprovals.find((item) => item.id === id) ?? null;
  }

  // --- Sprint 2M Phase 2C: final artwork worker ------------------------

  async getFinalArtworkJob(jobId: string): Promise<FinalArtworkJob | null> {
    const db = await readDb();
    return db.finalArtworkJobs.find((job) => job.id === jobId) ?? null;
  }

  async updateFinalArtworkJob(
    jobId: string,
    patch: UpdateFinalArtworkJobInput,
  ): Promise<FinalArtworkJob> {
    const db = await readDb();
    const job = db.finalArtworkJobs.find((item) => item.id === jobId);
    if (!job) throw new Error("Final artwork job not found");

    Object.assign(job, patch, { updatedAt: nowIso() });
    await writeDb(db);
    return job;
  }

  async claimNextQueuedFinalArtworkJob(): Promise<FinalArtworkJob | null> {
    const db = await readDb();
    const candidates = db.finalArtworkJobs
      .filter((job) => job.status === "queued" || job.status === "recoverable")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const job = candidates[0];
    if (!job) return null;

    // Mirrors `claimNextQueuedJob`'s comment: a single-process local store
    // has no real concurrent-claim race, but the shape mirrors the Supabase
    // optimistic-claim contract exactly.
    const timestamp = nowIso();
    job.status = "running";
    job.attempts += 1;
    job.startedAt = timestamp;
    job.heartbeatAt = timestamp;
    job.updatedAt = timestamp;
    await writeDb(db);
    return job;
  }

  async touchFinalArtworkJobHeartbeat(jobId: string): Promise<void> {
    const db = await readDb();
    const job = db.finalArtworkJobs.find((item) => item.id === jobId);
    if (!job) return;
    job.heartbeatAt = nowIso();
    await writeDb(db);
  }

  async recoverAbandonedFinalArtworkJobs(
    staleAfterMs: number,
  ): Promise<FinalArtworkJob[]> {
    const db = await readDb();
    const now = Date.now();
    const recovered: FinalArtworkJob[] = [];

    for (const job of db.finalArtworkJobs) {
      if (job.status !== "running") continue;
      const lastHeartbeat = job.heartbeatAt
        ? Date.parse(job.heartbeatAt)
        : Date.parse(job.startedAt ?? job.updatedAt);
      if (now - lastHeartbeat < staleAfterMs) continue;

      job.status = "recoverable";
      job.updatedAt = nowIso();
      recovered.push(job);
    }

    if (recovered.length > 0) await writeDb(db);
    return recovered;
  }

  async createProductionAssetValidation(
    projectId: string,
    input: CreateProductionAssetValidationInput,
  ): Promise<ProductionAssetValidation> {
    const db = await readDb();
    const timestamp = nowIso();
    const validation: ProductionAssetValidation = {
      id: randomUUID(),
      projectId,
      finalArtworkJobId: input.finalArtworkJobId,
      assetId: input.assetId,
      status: input.status,
      report: input.report,
      validatedAt: timestamp,
      createdAt: timestamp,
    };
    db.productionAssetValidations.push(validation);
    await writeDb(db);
    return validation;
  }

  async getLatestProductionAssetValidationForJob(
    projectId: string,
    finalArtworkJobId: string,
  ): Promise<ProductionAssetValidation | null> {
    const db = await readDb();
    const matches = db.productionAssetValidations
      .filter(
        (item) =>
          item.projectId === projectId &&
          item.finalArtworkJobId === finalArtworkJobId,
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return matches.at(-1) ?? null;
  }

  async createArtworkPreparation(
    projectId: string,
    input: CreateArtworkPreparationInput,
  ): Promise<ArtworkPreparation> {
    const db = await readDb();
    const timestamp = nowIso();
    const preparation: ArtworkPreparation = {
      id: randomUUID(),
      projectId,
      status: "analyzed",
      originalAssetId: input.originalAssetId,
      preparedAssetId: null,
      preparedArtworkVersionId: null,
      originalFilename: input.originalFilename,
      analysis: input.analysis,
      preparation: null,
      guidedCleanup: null,
      separation: null,
      approvedAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    db.artworkPreparations.push(preparation);
    await writeDb(db);
    return preparation;
  }

  async getArtworkPreparation(
    projectId: string,
  ): Promise<ArtworkPreparation | null> {
    const db = await readDb();
    const matches = db.artworkPreparations
      .filter((item) => item.projectId === projectId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return matches.at(-1) ?? null;
  }

  async getArtworkPreparationById(
    id: string,
  ): Promise<ArtworkPreparation | null> {
    const db = await readDb();
    return db.artworkPreparations.find((item) => item.id === id) ?? null;
  }

  async updateArtworkPreparation(
    id: string,
    patch: UpdateArtworkPreparationInput,
  ): Promise<ArtworkPreparation> {
    const db = await readDb();
    const preparation = db.artworkPreparations.find((item) => item.id === id);
    if (!preparation) throw new Error("Artwork preparation not found");

    Object.assign(preparation, patch, { updatedAt: nowIso() });
    await writeDb(db);
    return preparation;
  }
}
