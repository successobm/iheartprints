import { randomUUID } from "crypto";
import { promises as fs } from "fs";
import path from "path";

import {
  OPENING_PROMPT,
  projectNameFromBrief,
} from "@/lib/domain/conversation";
import type {
  ArtworkVersion,
  ConversationMessage,
  ConversationPhase,
  DesignConversation,
  PrintProject,
  ProjectSnapshot,
  ProjectStatus,
  TShirtDesignBrief,
} from "@/lib/domain/types";
import type {
  CreateArtworkVersionInput,
  CreateMessageInput,
  ProjectRepository,
} from "./repository";

interface LocalDatabase {
  projects: PrintProject[];
  briefs: TShirtDesignBrief[];
  conversations: DesignConversation[];
  messages: ConversationMessage[];
  artworkVersions: ArtworkVersion[];
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
  };
}

async function readDb(): Promise<LocalDatabase> {
  try {
    const raw = await fs.readFile(DATA_FILE, "utf8");
    return JSON.parse(raw) as LocalDatabase;
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
      printPlacement: "full_front",
      intendedPrintWidthIn: null,
      preferredColors: [],
      designStyle: null,
      additionalInstructions: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    const conversation: DesignConversation = {
      id: conversationId,
      projectId,
      phase: "ask_product",
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    const opening: ConversationMessage = {
      id: randomUUID(),
      conversationId,
      projectId,
      role: "assistant",
      content: OPENING_PROMPT,
      metadata: { phase: "ask_product" },
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
}
