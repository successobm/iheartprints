import { randomUUID } from "crypto";
import { promises as fs } from "fs";
import path from "path";

import {
  OPENING_PROMPT,
  projectNameFromBrief,
} from "@/lib/domain/conversation";
import { emptyInterviewState } from "@/lib/domain/types";
import type {
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
  PrintProject,
  ProductionAssetValidation,
  ProjectSnapshot,
  ProjectStatus,
  TShirtDesignBrief,
} from "@/lib/domain/types";
import type {
  ApproveDesignBriefInput,
  CreateArtworkVersionInput,
  CreateAssetInput,
  CreateFinalArtworkJobInput,
  CreateFinalDirectionApprovalInput,
  CreateGenerationJobInput,
  CreateMessageInput,
  CreateProductionAssetValidationInput,
  ProjectRepository,
  UpdateArtworkEvaluationInput,
  UpdateFinalArtworkJobInput,
  UpdateGenerationJobInput,
} from "./repository";
import { UniqueConstraintViolationError } from "./repository";

interface LocalDatabase {
  projects: PrintProject[];
  briefs: TShirtDesignBrief[];
  conversations: DesignConversation[];
  messages: ConversationMessage[];
  artworkVersions: ArtworkVersion[];
  designBriefVersions: DesignBriefVersion[];
  /** Sprint 2H Part 1. */
  generationJobs: GenerationJob[];
  assets: AssetRecord[];
  /** Sprint 2M Phase 2B. */
  finalDirectionApprovals: FinalDirectionApproval[];
  finalArtworkJobs: FinalArtworkJob[];
  /** Sprint 2M Phase 2C. */
  productionAssetValidations: ProductionAssetValidation[];
}

const DATA_DIR = path.join(process.cwd(), ".data");
const DATA_FILE = path.join(DATA_DIR, "sprint1-store.json");

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
    assets: [],
    finalDirectionApprovals: [],
    finalArtworkJobs: [],
    productionAssetValidations: [],
  };
}

async function readDb(): Promise<LocalDatabase> {
  try {
    const raw = await fs.readFile(DATA_FILE, "utf8");
    const parsed = JSON.parse(raw) as Partial<LocalDatabase>;
    // Normalize Sprint 1/2D local JSON that predates design_brief_versions /
    // artwork designBriefVersionId / Sprint 2F brief fields / interview
    // state so resume does not crash on older on-disk data.
    return {
      projects: parsed.projects ?? [],
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
      })),
      productionAssetValidations: parsed.productionAssetValidations ?? [],
    };
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") return emptyDb();
    throw error;
  }
}

async function writeDb(db: LocalDatabase): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(DATA_FILE, JSON.stringify(db, null, 2), "utf8");
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

  async createProject(): Promise<ProjectSnapshot> {
    const db = await readDb();
    const timestamp = nowIso();
    const projectId = randomUUID();
    const conversationId = randomUUID();

    const project: PrintProject = {
      id: projectId,
      name: "Untitled T-shirt design",
      status: "intake",
      selectedArtworkVersionId: null,
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

  async updateProject(
    projectId: string,
    patch: Partial<
      Pick<PrintProject, "name" | "status" | "selectedArtworkVersionId">
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
      attempts: 0,
      lastError: null,
      startedAt: null,
      completedAt: null,
      heartbeatAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    db.generationJobs.push(job);
    await writeDb(db);
    return job;
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
    const duplicate = db.finalArtworkJobs.find(
      (item) =>
        item.projectId === projectId &&
        item.finalDirectionApprovalId === input.finalDirectionApprovalId,
    );
    if (duplicate) {
      throw new UniqueConstraintViolationError(
        "final_artwork_jobs_project_id_final_direction_approval_id",
      );
    }

    const timestamp = nowIso();
    const job: FinalArtworkJob = {
      id: randomUUID(),
      projectId,
      finalDirectionApprovalId: input.finalDirectionApprovalId,
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
}
