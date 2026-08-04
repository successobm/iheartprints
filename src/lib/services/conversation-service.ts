import { buildPlaceholderConcepts } from "@/lib/domain/concepts";
import {
  applyUserReplyToBrief,
  nextPhaseAfterUserReply,
  promptForPhase,
} from "@/lib/domain/conversation";
import type {
  ConversationPhase,
  ProjectSnapshot,
} from "@/lib/domain/types";
import { getProjectRepository } from "@/lib/db";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function appendAssistantPrompt(
  projectId: string,
  phase: ConversationPhase,
): Promise<void> {
  const prompt = promptForPhase(phase);
  if (!prompt) return;

  const repo = getProjectRepository();
  await repo.addMessage(projectId, {
    role: "assistant",
    content: prompt,
    metadata: { phase },
  });
}

async function generateConcepts(projectId: string): Promise<ProjectSnapshot> {
  const repo = getProjectRepository();
  await repo.setProjectStatus(projectId, "generating");
  await repo.updateConversationPhase(projectId, "generating");
  await appendAssistantPrompt(projectId, "generating");

  // Simulated generation latency for UX validation.
  await sleep(1400);

  const current = await repo.getProject(projectId);
  if (!current) throw new Error("Project not found");

  if (current.artworkVersions.length === 0) {
    const seeds = buildPlaceholderConcepts(current.brief);
    await repo.addArtworkVersions(
      projectId,
      seeds.map((seed) => ({
        ...seed,
        kind: "concept" as const,
      })),
    );
  }

  await repo.setProjectStatus(projectId, "concepts_ready");
  await repo.updateConversationPhase(projectId, "concepts_ready");
  await appendAssistantPrompt(projectId, "concepts_ready");

  const snapshot = await repo.getProject(projectId);
  if (!snapshot) throw new Error("Project not found");
  return snapshot;
}

export async function startConversation(): Promise<ProjectSnapshot> {
  return getProjectRepository().createProject();
}

export async function getConversation(
  projectId: string,
): Promise<ProjectSnapshot | null> {
  return getProjectRepository().getProject(projectId);
}

export async function handleUserMessage(
  projectId: string,
  content: string,
): Promise<ProjectSnapshot> {
  const repo = getProjectRepository();
  const trimmed = content.trim();
  if (!trimmed) throw new Error("Message cannot be empty");

  const current = await repo.getProject(projectId);
  if (!current) throw new Error("Project not found");

  const phase = current.conversation.phase;

  if (
    phase === "generating" ||
    phase === "skip_references" ||
    phase === "concepts_ready"
  ) {
    throw new Error("Please wait for the current step to finish");
  }

  await repo.addMessage(projectId, {
    role: "user",
    content: trimmed,
    metadata: { phase },
  });

  const briefPatch = applyUserReplyToBrief(current.brief, phase, trimmed);
  if (Object.keys(briefPatch).length > 0) {
    await repo.updateBrief(projectId, briefPatch);
  }

  if (phase === "ask_text") {
    // Skip references automatically, then simulate generation.
    await repo.updateConversationPhase(projectId, "skip_references");
    await appendAssistantPrompt(projectId, "skip_references");
    return generateConcepts(projectId);
  }

  const nextPhase = nextPhaseAfterUserReply(phase);
  if (!nextPhase) {
    const snapshot = await repo.getProject(projectId);
    if (!snapshot) throw new Error("Project not found");
    return snapshot;
  }

  if (nextPhase === "ask_revisions" || nextPhase === "revision_received") {
    await repo.setProjectStatus(projectId, "revision_requested");
  } else if (nextPhase === "ask_design") {
    await repo.setProjectStatus(projectId, "intake");
  }

  await repo.updateConversationPhase(projectId, nextPhase);
  await appendAssistantPrompt(projectId, nextPhase);

  const snapshot = await repo.getProject(projectId);
  if (!snapshot) throw new Error("Project not found");
  return snapshot;
}

export async function selectConcept(
  projectId: string,
  artworkVersionId: string,
): Promise<ProjectSnapshot> {
  const repo = getProjectRepository();
  const current = await repo.getProject(projectId);
  if (!current) throw new Error("Project not found");

  if (current.conversation.phase !== "concepts_ready") {
    throw new Error("Concepts are not ready for selection");
  }

  const exists = current.artworkVersions.some(
    (version) => version.id === artworkVersionId,
  );
  if (!exists) throw new Error("Concept not found");

  await repo.selectArtworkVersion(projectId, artworkVersionId);
  await repo.updateConversationPhase(projectId, "ask_revisions");
  await appendAssistantPrompt(projectId, "ask_revisions");

  const snapshot = await repo.getProject(projectId);
  if (!snapshot) throw new Error("Project not found");
  return snapshot;
}
