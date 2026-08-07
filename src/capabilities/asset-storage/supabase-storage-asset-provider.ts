import type { SupabaseClient } from "@supabase/supabase-js";

import type {
  AssetStorageProvider,
  UploadAssetInput,
  UploadedAssetRef,
} from "./asset-storage-provider";
import { buildObjectKey } from "./asset-storage-provider";

/** Private bucket — see `supabase/migrations/20260805140000_background_generation_jobs.sql`. */
const BUCKET = "design-assets";

/**
 * Sprint 2H Part 2A: the real, production-safe storage backend. Uploads
 * image bytes to a private Supabase Storage bucket, creates a thumbnail
 * companion object, and returns only an opaque object-key reference —
 * never a signed URL, never raw bytes — for `AssetCapability` to persist.
 *
 * Access model:
 * - Server uses the service-role client, which intentionally bypasses
 *   Storage RLS (enforced at composition: `resolveAssetStorageProvider`
 *   refuses to construct this provider without `SUPABASE_SERVICE_ROLE_KEY`).
 * - The `design-assets` bucket is private (`public = false`) with no
 *   anon/authenticated `storage.objects` policies.
 * - Customer access is only via `createSignedUrl` — never `getPublicUrl`.
 */
export class SupabaseStorageAssetProvider implements AssetStorageProvider {
  readonly storageKey = "supabase_storage";

  constructor(private readonly client: SupabaseClient) {}

  async upload(input: UploadAssetInput): Promise<UploadedAssetRef> {
    const objectKey = buildObjectKey(input);
    const { error } = await this.client.storage
      .from(BUCKET)
      .upload(objectKey, input.bytes, {
        contentType: input.contentType,
        upsert: false,
      });
    if (error) throw error;
    return { objectKey };
  }

  async getSignedUrl(
    objectKey: string,
    expiresInSeconds: number,
  ): Promise<string> {
    const { data, error } = await this.client.storage
      .from(BUCKET)
      .createSignedUrl(objectKey, expiresInSeconds);
    if (error) throw error;
    if (!data?.signedUrl) {
      throw new Error("Supabase Storage did not return a signed URL");
    }
    return data.signedUrl;
  }

  async delete(objectKey: string): Promise<void> {
    const { error } = await this.client.storage.from(BUCKET).remove([objectKey]);
    if (error) throw error;
  }

  async download(objectKey: string): Promise<Buffer> {
    const { data, error } = await this.client.storage.from(BUCKET).download(objectKey);
    if (error) throw error;
    if (!data) throw new Error("Supabase Storage returned no data for download");
    const arrayBuffer = await data.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }
}
