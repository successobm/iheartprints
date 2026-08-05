/**
 * Shared capability contracts.
 * Provider-neutral, durable types used across capability boundaries.
 */

import type {
  ConversationPhase,
  TShirtDesignBrief,
} from "@/lib/domain/types";

/** Confidence for a Design Brief section (Sprint 2B). */
export type SectionConfidence =
  | "none"
  | "low"
  | "medium"
  | "high"
  | "confirmed";

export type BriefSectionKey =
  | "audience"
  | "purpose"
  | "style"
  | "graphics"
  | "colors"
  | "product"
  | "production"
  | "requiredWording"
  | "references"
  | "layoutPreference"
  | "exclusions"
  | "productColor"
  | "printLocation"
  | "additionalNotes";

/** Intent Extraction → Design Brief mutation proposals. */
export interface BriefPatchProposal {
  fields: Partial<
    Omit<TShirtDesignBrief, "id" | "projectId" | "createdAt" | "updatedAt">
  >;
  source: "intent_extraction";
  /** Optional machine rationale; never customer-facing prompt prose. */
  rationale?: string;
  /** Sprint 1 bridge: phase that produced this patch. */
  phase?: ConversationPhase;
}

export type DetectedIntent =
  | "provide_info"
  | "correct"
  | "defer"
  | "approve"
  | "reject_advice"
  | "select_concept"
  | "request_revision"
  | "unknown";

export interface IntentExtractionResult {
  intents: DetectedIntent[];
  proposals: BriefPatchProposal[];
}

export type InterviewReadiness =
  | "continue_interview"
  | "ready_to_summarize"
  | "ready_to_request_approval";

export interface BriefAmbiguity {
  section: BriefSectionKey | "general";
  message: string;
}

export interface BriefConflict {
  sections: BriefSectionKey[];
  message: string;
  severity: "info" | "warning" | "blocking";
}

export interface DesignRecommendation {
  kind:
    | "typography"
    | "contrast"
    | "layout"
    | "color"
    | "production"
    | "general";
  message: string;
  severity: "info" | "warning";
}

export interface SectionEvaluation {
  section: BriefSectionKey;
  present: boolean;
  confidence: SectionConfidence;
}

/** Design Intelligence output — evaluates, never asks or generates. */
export interface IntelligenceAssessment {
  sections: SectionEvaluation[];
  ambiguities: BriefAmbiguity[];
  conflicts: BriefConflict[];
  recommendations: DesignRecommendation[];
  readiness: InterviewReadiness;
  overallConfidence: SectionConfidence;
}

/**
 * Brief Evaluation (Sprint 2E) — the objective, deterministic evaluation
 * layer between the Design Brief and Design Intelligence. It answers only
 * "what do we objectively know about this design?" It never recommends
 * fixes, never asks questions, and never generates anything.
 */

/** Per-section objective evaluation. `confidence` is 0-100 and is orthogonal
 * to `known` — a section can be known with low confidence (vague wording). */
export interface BriefSectionEvaluation {
  section: BriefSectionKey;
  /** Customer has provided something for this section, however vague. */
  known: boolean;
  /** Convenience negation of `known`, kept explicit per the evaluation model. */
  missing: boolean;
  /** True when the section is not required for summary/approval readiness. */
  optional: boolean;
  /** True when this section being missing blocks summary/approval readiness. */
  blocking: boolean;
  /** True when known but phrased too vaguely to act on with confidence. */
  ambiguous: boolean;
  /** 0-100. 0 when missing. Independent of completeness. */
  confidence: number;
  /** Machine-facing rationale; never customer-facing prose. */
  reason: string;
}

export interface OverallBriefEvaluation {
  /** 0-100, share of all evaluation sections that are known. */
  completeness: number;
  /** 0-100, average confidence across known sections (0 if none known). */
  confidence: number;
  knownSectionCount: number;
  missingSectionCount: number;
  blockingSectionCount: number;
}

export interface SummaryReadiness {
  ready: boolean;
  reason: string;
}

export interface ApprovalReadiness {
  ready: boolean;
  blockingSections: BriefSectionKey[];
  reason: string;
}

/** Provider-neutral, deterministic evaluation of a working Design Brief. */
export interface BriefEvaluation {
  sections: BriefSectionEvaluation[];
  /** Known-but-vague sections, surfaced for convenience (subset of `sections`). */
  ambiguities: BriefAmbiguity[];
  /** Detected contradictions between sections. Reported only, never resolved here. */
  contradictions: BriefConflict[];
  overall: OverallBriefEvaluation;
  summaryReadiness: SummaryReadiness;
  approvalReadiness: ApprovalReadiness;
}

export type InterviewActType =
  | "ask"
  | "clarify"
  | "advise"
  | "summarize"
  | "request_approval"
  | "generate_concepts"
  | "acknowledge"
  | "await_customer";

/**
 * Interview Intelligence output — one primary act per turn.
 * Sprint 1 bridge field (`nextPhase`) preserves linear behavior. Concept
 * generation is never triggered directly by this act (Sprint 2D) — it only
 * happens after an explicit customer approval of the Design Summary.
 */
export interface InterviewAct {
  type: InterviewActType;
  /** Customer-facing assistant message, when applicable. */
  message?: string;
  /** Highest-value brief section this act targets, when applicable. */
  targetSection?: BriefSectionKey;
  /** Sprint 1: next conversation phase after this act. */
  nextPhase?: ConversationPhase;
}

export type OwnershipClass =
  | "customer_owned"
  | "licensed_to_customer"
  | "community_library"
  | "premium_marketplace"
  | "private_print_shop_library";

export type ProductionMethod =
  | "screen_print"
  | "dtf"
  | "dtg"
  | "embroidery"
  | "sublimation"
  | "signage"
  | "engraving"
  | "unknown";

export interface ProductionFinding {
  code: string;
  method?: ProductionMethod;
  severity: "info" | "warning" | "blocking";
  message: string;
  plainLanguage: string;
}

export interface DesignSummaryView {
  product?: string | null;
  audience?: string | null;
  purpose?: string | null;
  style?: string | null;
  graphics?: string | null;
  colors?: string | null;
  productColor?: string | null;
  printLocation?: string | null;
  requiredWording?: string | null;
  references?: string | null;
  productionConsiderations?: string | null;
  additionalNotes?: string | null;
}

export type ValidationSeverity = "info" | "warning" | "error";

export interface ValidationCheck {
  code: string;
  label: string;
  severity: ValidationSeverity;
  passed: boolean | null;
  message: string;
}

export interface ValidationReport {
  artworkId: string;
  designBriefVersionId?: string | null;
  checks: ValidationCheck[];
  overall: "pass" | "fail" | "needs_review" | "not_run";
}

export interface ConceptGenerationRequest {
  designId: string;
  /** Approved brief version id when versioning exists; working brief id until then. */
  designBriefId: string;
  conceptCount: number;
}

export interface GeneratedConceptDraft {
  versionNumber: number;
  title: string;
  summary: string;
  placeholderLabel: string;
  accentColor: string;
  kind: "concept";
}

export interface ConceptGenerationResult {
  jobId: string;
  concepts: GeneratedConceptDraft[];
  providerKey: "placeholder";
}
