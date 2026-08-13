import type {
  AssetStorageProvider,
  UploadAssetInput,
  UploadedAssetRef,
} from "./asset-storage-provider";
import { buildObjectKey } from "./asset-storage-provider";

/**
 * Test / audit storage backend that mirrors Supabase Storage's
 * `upsert: false` collision semantics.
 *
 * The filesystem provider silently overwrites; the data-URI provider never
 * reuses keys. Both hide the live failure class where a deterministic
 * prepared-object path collides with an orphan. This provider rejects a
 * second upload to the same object key with the same customer-visible
 * message Supabase returns ("The resource already exists").
 *
 * Not for production composition — only for proving storage-identity
 * contracts in capability tests.
 */
export class StrictUniqueKeyAssetStorageProvider
  implements AssetStorageProvider
{
  readonly storageKey = "strict_unique_key";

  private readonly objects = new Map<
    string,
    { bytes: Buffer; contentType: string }
  >();

  /** Number of successful uploads (excludes rejected collisions). */
  uploadCount = 0;

  /** When true, the next `upload` throws before writing (then clears). */
  failNextUpload = false;

  /** Pre-seed an orphan / historical object without going through AssetCapability. */
  seed(objectKey: string, bytes: Buffer, contentType = "image/png"): void {
    if (this.objects.has(objectKey)) {
      throw new Error("The resource already exists");
    }
    this.objects.set(objectKey, {
      bytes: Buffer.from(bytes),
      contentType,
    });
  }

  has(objectKey: string): boolean {
    return this.objects.has(objectKey);
  }

  objectKeys(): string[] {
    return [...this.objects.keys()];
  }

  async upload(input: UploadAssetInput): Promise<UploadedAssetRef> {
    if (this.failNextUpload) {
      this.failNextUpload = false;
      throw new Error("Simulated storage upload failure");
    }

    const objectKey = buildObjectKey(input);
    if (this.objects.has(objectKey)) {
      // Match Supabase Storage's upsert:false customer-visible error text.
      throw new Error("The resource already exists");
    }

    this.objects.set(objectKey, {
      bytes: Buffer.from(input.bytes),
      contentType: input.contentType,
    });
    this.uploadCount += 1;
    return { objectKey };
  }

  async getSignedUrl(objectKey: string): Promise<string> {
    const stored = this.objects.get(objectKey);
    if (!stored) {
      throw new Error("Object not found");
    }
    return `data:${stored.contentType};base64,${stored.bytes.toString("base64")}`;
  }

  async delete(objectKey: string): Promise<void> {
    this.objects.delete(objectKey);
  }

  async download(objectKey: string): Promise<Buffer> {
    const stored = this.objects.get(objectKey);
    if (!stored) {
      throw new Error("Object not found");
    }
    return Buffer.from(stored.bytes);
  }
}
