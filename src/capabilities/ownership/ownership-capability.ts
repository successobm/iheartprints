import type { OwnershipClass } from "@/capabilities/shared/contracts";

/**
 * Ownership and license classification contracts.
 * No licensing enforcement in Sprint 2C.
 */

export interface OwnershipRecord {
  designId: string;
  ownershipClass: OwnershipClass;
  privacy: "private" | "org" | "public";
}

export interface OwnershipCapability {
  getDefaultOwnership(): OwnershipClass;
  getOwnership(_designId: string): Promise<OwnershipRecord | null>;
  listOwnershipClasses(): OwnershipClass[];
}

export function createOwnershipCapability(): OwnershipCapability {
  return {
    getDefaultOwnership() {
      return "customer_owned";
    },
    async getOwnership() {
      return null;
    },
    listOwnershipClasses() {
      return [
        "customer_owned",
        "licensed_to_customer",
        "community_library",
        "premium_marketplace",
        "private_print_shop_library",
      ];
    },
  };
}
