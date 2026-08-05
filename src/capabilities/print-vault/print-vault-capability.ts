/**
 * Future Print Vault contracts. No vault logic in Sprint 2C.
 */

export interface VaultAssetRef {
  vaultAssetId: string;
  designId: string;
  artworkId: string;
  designBriefId: string;
  parentDesignId?: string | null;
  variationType?: string | null;
}

export interface PrintVaultCapability {
  /** Future ingest of customer-approved artwork. */
  canIngest(_input: {
    designId: string;
    artworkId: string;
  }): boolean;
  listFamily(_designId: string): Promise<VaultAssetRef[]>;
}

export function createPrintVaultCapability(): PrintVaultCapability {
  return {
    canIngest() {
      return false;
    },
    async listFamily() {
      return [];
    },
  };
}
