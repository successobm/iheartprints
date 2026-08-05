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
  /**
   * Sprint 2F: stable identifier for the rule that produced this conflict
   * (e.g. "color_clash"). Lets downstream layers (Design Intelligence,
   * question phrasing) branch on a known rule instead of parsing `message`.
   * Unrecognized/absent codes must fall back gracefully to `message`.
   */
  code?: string;
}

export interface DesignRecommendation {
  /** Sprint 2F: stable id so an InterviewAct("advise") can reference it and track dismissal. */
  id: string;
  kind:
    | "typography"
    | "contrast"
    | "layout"
    | "color"
    | "production"
    | "general";
  message: string;
  severity: "info" | "warning";
  followUpSection?: BriefSectionKey;
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

/**
 * Sprint 2F: how much a section matters to this interview, per
 * `InterviewCoveragePolicy`.
 *   - "required"   — must be provided (or, for requiredWording, explicitly
 *                    none). Cannot be deferred. Blocks summary/approval.
 *   - "high_value" — materially affects concept quality; must be provided
 *                    or explicitly deferred before summary, but deferral is
 *                    always available.
 *   - "optional"   — never gates summary/approval either way.
 */
export type SectionRequirementTier = "required" | "high_value" | "optional";

/**
 * Sprint 2F: how a section actually got resolved, distinct from whether it
 * has a concrete value. A deferred section has no content but is not
 * "missing" in the sense of blocking further progress.
 */
export type SectionResolution =
  | "provided"
  | "deferred_to_designer"
  | "not_applicable"
  | "unknown";

/** Per-section objective evaluation. `confidence` is 0-100 and is orthogonal
 * to `known` — a section can be known with low confidence (vague wording). */
export interface BriefSectionEvaluation {
  section: BriefSectionKey;
  tier: SectionRequirementTier;
  resolution: SectionResolution;
  /** tier !== "required" — deferral is never allowed for required sections. */
  deferrable: boolean;
  /** resolution === "provided". Customer has given content, however vague. */
  known: boolean;
  /** resolution === "unknown". Nothing provided and nothing deferred either. */
  missing: boolean;
  /** tier === "optional". Kept alongside `tier` for simpler call sites. */
  optional: boolean;
  /** tier === "required". Kept alongside `tier` for simpler call sites. */
  blocking: boolean;
  /** True when provided but phrased too vaguely to act on with confidence. */
  ambiguous: boolean;
  /** 0-100. 0 when not provided. Independent of completeness. */
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

/**
 * Interview Intelligence output (Sprint 2F) — one primary act per turn,
 * derived from `BriefEvaluation` + `IntelligenceAssessment` rather than a
 * fixed phase ladder. Concept generation is never triggered by this act —
 * it only happens after an explicit customer approval of the Design Summary
 * (Sprint 2D gate, unchanged).
 */
export type InterviewAct =
  | { type: "ask"; section: BriefSectionKey; message: string }
  | { type: "clarify"; section: BriefSectionKey; message: string }
  | {
      type: "advise";
      findingId: string;
      message: string;
      followUpSection?: BriefSectionKey;
    }
  | { type: "summarize" }
  | { type: "await_customer" };

export type InterviewActType = InterviewAct["type"];

/**
 * Sprint 2F: recent conversation context Interview Intelligence needs to
 * avoid repeating itself, without inspecting the Design Brief or
 * Conversation directly.
 */
export interface InterviewContext {
  /** The section most recently asked/clarified, if any. */
  pendingSection: BriefSectionKey | null;
  /** How many times each section has been asked/clarified this session. */
  askCounts: Partial<Record<BriefSectionKey, number>>;
  /** DesignRecommendation ids already surfaced as an "advise" act. */
  dismissedAdvisories: string[];
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

/**
 * Sprint 2G Part 2: stable identifier for a Product Intelligence rule pack.
 * Lets Revision Intelligence say "these rule packs are affected" without
 * depending on ProductIntelligenceCapability itself — both it and
 * ProductIntelligenceCapability read the same dependency table from
 * `shared/product-rule-packs`.
 */
export type ProductionRulePackId =
  | "small_placement_long_wording"
  | "small_placement_dense_graphics"
  | "full_placement_wall_of_text";

/**
 * Revision Intelligence output (Sprint 2G Part 2) — the impact of a Design
 * Brief change (previous → updated), provider-neutral and free of UI/
 * implementation detail. Produced by comparing two brief snapshots only;
 * consumed by Product Intelligence (selective rule-pack routing), Design
 * Intelligence, Interview Intelligence, Design Summary, and Concept
 * Generation. Never mutates the brief and never decides *what* changed —
 * only what that change means downstream.
 */
export interface RevisionImpact {
  /** Brief sections whose value differs between the two snapshots (a section newly deferred or un-deferred also counts). */
  changedSections: BriefSectionKey[];
  /** Product Intelligence rule packs whose dependencies overlap `changedSections`. */
  affectedRulePacks: ProductionRulePackId[];
  /** Whether Brief Evaluation / Design Intelligence should recompute at all. */
  needsReevaluation: boolean;
  /** Whether a presented Design Summary (pre-approval) should be regenerated. */
  needsSummaryRefresh: boolean;
  /** Whether new Design Intelligence recommendations may now exist. */
  needsNewRecommendations: boolean;
  /** Whether already-generated concepts no longer represent the brief. */
  needsConceptRegeneration: boolean;
  /** True when nothing actually changed (e.g. a reply that restated the same value). */
  isNoOp: boolean;
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
  /** Sprint 2F. */
  exclusions?: string | null;
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
