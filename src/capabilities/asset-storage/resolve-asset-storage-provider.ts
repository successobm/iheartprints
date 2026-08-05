import {
  getAssetStorageMode,
  type AssetStorageMode,
} from "@/lib/config/asset-storage-config";
import { getSupabaseServiceClient } from "@/lib/db/supabase-client";
import type { AssetStorageProvider } from "./asset-storage-provider";
import { DataUriAssetStorageProvider } from "./data-uri-asset-storage-provider";
import { FilesystemAssetStorageProvider } from "./filesystem-asset-storage-provider";
import { SupabaseStorageAssetProvider } from "./supabase-storage-asset-provider";

/**
 * Sprint 2H Part 2A: `s3` is reserved by `asset-storage-config.ts`'s
 * contract but has no adapter yet. Rather than crashing composition or
 * silently writing to a different backend, `upload`/`getSignedUrl`/`delete`
 * all fail with a clear, non-secret error — the exact same "fail at the
 * moment of use, not at startup" shape `UnavailableConceptGenerationProvider`
 * already established for a misconfigured generation provider.
 */
class UnimplementedAssetStorageProvider implements AssetStorageProvider {
  constructor(readonly storageKey: AssetStorageMode) {}

  async upload(): Promise<never> {
    throw new Error(
      `Asset storage backend "${this.storageKey}" is not implemented yet. Configure ASSET_STORAGE_MODE=supabase_storage.`,
    );
  }

  async getSignedUrl(): Promise<never> {
    throw new Error(
      `Asset storage backend "${this.storageKey}" is not implemented yet.`,
    );
  }

  async delete(): Promise<never> {
    throw new Error(
      `Asset storage backend "${this.storageKey}" is not implemented yet.`,
    );
  }
}

/**
 * Turns an `AssetStorageMode` decision into an actual provider instance —
 * the composition-layer counterpart to `resolveConceptGenerationProvider`.
 * Accepts an explicit `mode` (default: the live environment) so it can be
 * unit-tested without mutating `process.env`.
 */
export function resolveAssetStorageProvider(
  mode: AssetStorageMode = getAssetStorageMode(),
): AssetStorageProvider {
  switch (mode) {
    case "supabase_storage": {
      // Private `design-assets` has no anon/authenticated storage policies.
      // Service-role is required because it intentionally bypasses Storage
      // RLS — that bypass is the server-only boundary; browsers never hold
      // this key and only ever receive short-lived signed URLs.
      if (!process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()) {
        throw new Error(
          'ASSET_STORAGE_MODE=supabase_storage requires SUPABASE_SERVICE_ROLE_KEY (service-role access to the private "design-assets" bucket).',
        );
      }
      return new SupabaseStorageAssetProvider(getSupabaseServiceClient());
    }
    case "filesystem":
      return new FilesystemAssetStorageProvider();
    case "s3":
      return new UnimplementedAssetStorageProvider("s3");
    case "data_uri":
    default:
      return new DataUriAssetStorageProvider();
  }
}
