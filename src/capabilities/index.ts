/**
 * Capability architecture entrypoint (Sprint 2C).
 *
 * Domain types remain in `@/lib/domain` for Sprint 1 compatibility.
 * Long-term domain evolution should flow through these capability boundaries.
 */

export { createCapabilityGraph, getCapabilityGraph } from "./composition";
export type { CapabilityGraph } from "./composition";

export type { ConversationCapability } from "./conversation";
export type { IntentExtractionCapability } from "./intent-extraction";
export type { DesignBriefCapability } from "./design-brief";
export type { BriefEvaluationCapability } from "./brief-evaluation";
export type { DesignIntelligenceCapability } from "./design-intelligence";
export type { InterviewIntelligenceCapability } from "./interview-intelligence";
export type { ProductIntelligenceCapability } from "./product-intelligence";
export type { DesignSummaryCapability } from "./design-summary";
export type { ConceptGenerationCapability } from "./concept-generation";
export type { PrintValidationCapability } from "./print-validation";
export type { RevisionCapability } from "./revision";
export type { PrintVaultCapability } from "./print-vault";
export type { AssetCapability } from "./assets";
export type { OwnershipCapability } from "./ownership";
export type { ConceptGenerationProvider } from "./providers";
