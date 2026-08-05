import type {
  AssetStorageProvider,
  UploadAssetInput,
  UploadedAssetRef,
} from "./asset-storage-provider";

/**
 * Sprint 2H Part 2A: the original Sprint 2H Part 1 storage strategy,
 * formalized behind the `AssetStorageProvider` port. Embeds bytes directly
 * as a `data:...;base64,...` string — the "object key" and "signed URL"
 * are the same string, since there is nowhere external to point at.
 * Acceptable for local development, automated tests, placeholder concepts,
 * and architecture verification; never production-safe (see
 * `asset-storage-config.ts` — production requires a real object-storage
 * backend).
 */
export class DataUriAssetStorageProvider implements AssetStorageProvider {
  readonly storageKey = "data_uri";

  async upload(input: UploadAssetInput): Promise<UploadedAssetRef> {
    return {
      objectKey: `data:${input.contentType};base64,${input.bytes.toString("base64")}`,
    };
  }

  async getSignedUrl(objectKey: string): Promise<string> {
    // Already a self-contained, directly usable URI — nothing to sign.
    return objectKey;
  }

  async delete(): Promise<void> {
    // Nothing external to remove — the bytes only ever lived inline in
    // whatever already-deleted database row referenced them.
  }
}
