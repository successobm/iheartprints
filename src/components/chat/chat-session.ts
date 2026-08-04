export const CHAT_PROJECT_STORAGE_KEY = "iheartprints.sprint1.projectId";

export type SessionBootstrapPlan =
  | { action: "restore"; projectId: string }
  | { action: "create" };

/**
 * Decides whether ChatApp should restore a persisted Sprint 1 project
 * or create a new conversation. Pure helper for stable session behavior.
 */
export function planSessionBootstrap(
  storedProjectId: string | null | undefined,
): SessionBootstrapPlan {
  const projectId = storedProjectId?.trim();
  if (projectId) {
    return { action: "restore", projectId };
  }
  return { action: "create" };
}
