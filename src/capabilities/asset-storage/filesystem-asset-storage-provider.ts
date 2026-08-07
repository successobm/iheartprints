import { promises as fs } from "fs";
import path from "path";

import type {
  AssetStorageProvider,
  UploadAssetInput,
  UploadedAssetRef,
} from "./asset-storage-provider";
import { buildObjectKey } from "./asset-storage-provider";
import { resolveAssetPath } from "./filesystem-paths";
import { signAssetToken } from "./signed-url-token";

const DEFAULT_SIGNED_URL_BASE = "/api/assets";

/**
 * Sprint 2H Part 2A: local-dev/test mirror of a real object-storage
 * backend. Writes bytes under `.data/assets/<objectKey>` using the exact
 * same bucket/path convention (`projects/{projectId}/concepts/{conceptId}/
 * <fileName>`) `SupabaseStorageAssetProvider` uses, and issues a real
 * expiring, signed URL (via `signed-url-token.ts`) rather than a raw
 * filesystem path — the same signed-URL contract the production backend
 * provides, without needing real cloud infrastructure to run tests.
 */
export class FilesystemAssetStorageProvider implements AssetStorageProvider {
  readonly storageKey = "filesystem";

  async upload(input: UploadAssetInput): Promise<UploadedAssetRef> {
    const objectKey = buildObjectKey(input);
    const filePath = resolveAssetPath(objectKey);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, input.bytes);
    return { objectKey };
  }

  async getSignedUrl(
    objectKey: string,
    expiresInSeconds: number,
  ): Promise<string> {
    const expiresAtMs = Date.now() + expiresInSeconds * 1000;
    const token = signAssetToken(objectKey, expiresAtMs);
    const encodedKey = objectKey
      .split("/")
      .map((segment) => encodeURIComponent(segment))
      .join("/");
    return `${DEFAULT_SIGNED_URL_BASE}/${encodedKey}?expires=${expiresAtMs}&token=${token}`;
  }

  async delete(objectKey: string): Promise<void> {
    const filePath = resolveAssetPath(objectKey);
    try {
      await fs.unlink(filePath);
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== "ENOENT") throw error;
    }
  }

  async download(objectKey: string): Promise<Buffer> {
    const filePath = resolveAssetPath(objectKey);
    return fs.readFile(filePath);
  }
}
