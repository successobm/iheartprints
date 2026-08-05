import type { TShirtDesignBrief } from "@/lib/domain/types";
import type { ProductionFinding } from "@/capabilities/shared/contracts";

/**
 * Reusable print knowledge. No UI, no generation, no brief mutation.
 */
export interface ProductIntelligenceCapability {
  evaluateBrief(brief: TShirtDesignBrief): ProductionFinding[];
  /** Future rule packs by method / product. */
  listSupportedMethods(): string[];
}

/**
 * Sprint 2C skeleton: returns no findings so interview behavior is unchanged.
 * Rules will be added in a later sprint without changing this interface.
 */
export function createProductIntelligenceCapability(): ProductIntelligenceCapability {
  return {
    evaluateBrief(_brief) {
      return [];
    },
    listSupportedMethods() {
      return [
        "screen_print",
        "dtf",
        "dtg",
        "embroidery",
        "sublimation",
        "signage",
        "engraving",
      ];
    },
  };
}
