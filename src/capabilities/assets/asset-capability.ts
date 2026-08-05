/**
 * Asset management boundary — uploads, references, generated files.
 * No provider knowledge. Storage remains abstracted / stubbed in Sprint 2C.
 */

export type AssetKind =
  | "customer_upload"
  | "logo"
  | "reference_image"
  | "generated_artwork"
  | "svg"
  | "png"
  | "pdf";

export interface AssetRecord {
  id: string;
  designId: string;
  kind: AssetKind;
  storageKey?: string | null;
  contentType?: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface AssetCapability {
  listAssets(_designId: string): Promise<AssetRecord[]>;
  /** Future: register a stored asset. */
  registerAsset(_input: Omit<AssetRecord, "id" | "createdAt">): Promise<AssetRecord | null>;
}

export function createAssetCapability(): AssetCapability {
  return {
    async listAssets() {
      return [];
    },
    async registerAsset() {
      return null;
    },
  };
}
