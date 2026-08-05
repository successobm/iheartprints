/**
 * Asset management boundary — uploads, references, generated files.
 * Sprint 2H Part 1: backed by real repository persistence instead of a
 * no-op stub. Storage itself stays abstracted behind `AssetRecord.storageKey`
 * (an opaque reference) — this capability owns registering and listing
 * asset metadata, never the bytes' transport. Providers never write here
 * directly; only `ConceptGenerationCapability` calls `registerAsset`, after
 * a provider adapter has already returned its result.
 */

import type { ProjectRepository } from "@/lib/db/repository";
import type { AssetKind, AssetRecord } from "@/lib/domain/types";

export interface AssetCapability {
  listAssets(designId: string): Promise<AssetRecord[]>;
  registerAsset(
    designId: string,
    input: Omit<AssetRecord, "id" | "projectId" | "createdAt">,
  ): Promise<AssetRecord | null>;
}

export function createAssetCapability(
  repo: ProjectRepository,
): AssetCapability {
  return {
    async listAssets(designId) {
      return repo.listAssets(designId);
    },
    async registerAsset(designId, input) {
      return repo.createAsset(designId, input);
    },
  };
}

export type { AssetKind, AssetRecord };
