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
  GenerationJob,
  InterviewStateData,
  PrintProject,
  ProjectSnapshot,
  ProjectStatus,
  TShirtDesignBrief,
} from "@/lib/domain/types";
import type {
  ApproveDesignBriefInput,
  CreateArtworkVersionInput,
  CreateAssetInput,
  CreateGenerationJobInput,
  CreateMessageInput,
  ProjectRepository,
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
        printValidationStatus: artwork.printValidationStatus ?? null,
      })),
      designBriefVersions: parsed.designBriefVersions ?? [],
      generationJobs: parsed.generationJobs ?? [],
      assets: parsed.assets ?? [],
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

export class LocalProjectRepository implements ProjectRepository {
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
      // Reserved for future sprints — always null until implemented.
      customerRating: null,
      evaluationStatus: null,
      printValidationStatus: null,
      createdAt: timestamp,
    }));

    db.artworkVersions.push(...created);
    await writeDb(db);
    return created;
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
      conceptCount: input.conceptCount,
      providerKey: input.providerKey,
      idempotencyKey: input.idempotencyKey,
      attempts: 0,
      lastError: null,
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
}
