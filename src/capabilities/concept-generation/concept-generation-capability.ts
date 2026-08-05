import type { ProjectRepository } from "@/lib/db/repository";
import type { ProjectSnapshot } from "@/lib/domain/types";
import type { ConceptGenerationProvider } from "@/capabilities/providers";
import type { ConceptGenerationResult } from "@/capabilities/shared/contracts";

export interface ConceptGenerationCapability {
  /**
   * Provider-neutral generation entry point.
   *
   * Sprint 2D hard guard: `approvedVersionId` must reference an existing,
   * durable Design Brief version belonging to this project. This check lives
   * in the capability itself — not the UI or the route — so a direct API
   * call, a stale client, or an accidental orchestration call cannot bypass
   * the approval gate.
   */
  generatePlaceholders(
    designId: string,
    approvedVersionId: string,
  ): Promise<ProjectSnapshot>;
  /** Exposes provider identity for future tracing — not persisted yet. */
  describeProvider(): string;
}

export function createConceptGenerationCapability(
  repo: ProjectRepository,
  provider: ConceptGenerationProvider,
): ConceptGenerationCapability {
  return {
    describeProvider() {
      return provider.providerKey;
    },

    async generatePlaceholders(designId, approvedVersionId) {
      if (!approvedVersionId) {
        throw new Error(
          "Cannot generate concepts without an approved design brief",
        );
      }

      const approvedVersion =
        await repo.getDesignBriefVersionById(approvedVersionId);
      if (!approvedVersion || approvedVersion.projectId !== designId) {
        throw new Error(
          "Cannot generate concepts without an approved design brief",
        );
      }

      await repo.setProjectStatus(designId, "generating");
      await repo.updateConversationPhase(designId, "generating");
      await repo.addMessage(designId, {
        role: "assistant",
        content:
          "Design brief approved — generating three concept directions...",
        metadata: { phase: "generating" },
      });

      // Preserve Sprint 1 simulated latency for UX validation.
      await sleep(1400);

      const current = await repo.getProject(designId);
      if (!current) throw new Error("Project not found");

      if (current.artworkVersions.length === 0) {
        const result: ConceptGenerationResult = await provider.generate({
          designId,
          designBriefId: approvedVersion.id,
          conceptCount: 3,
        });

        await repo.addArtworkVersions(
          designId,
          result.concepts.map((concept) => ({
            versionNumber: concept.versionNumber,
            kind: concept.kind,
            title: concept.title,
            summary: concept.summary,
            placeholderLabel: concept.placeholderLabel,
            accentColor: concept.accentColor,
            designBriefVersionId: approvedVersion.id,
          })),
        );
      }

      await repo.setProjectStatus(designId, "concepts_ready");
      await repo.updateConversationPhase(designId, "concepts_ready");
      await repo.addMessage(designId, {
        role: "assistant",
        content:
          "Here are three concept directions. Pick the one that feels closest.",
        metadata: { phase: "concepts_ready" },
      });

      const snapshot = await repo.getProject(designId);
      if (!snapshot) throw new Error("Project not found");
      return snapshot;
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
