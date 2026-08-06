import { deriveRequiredWording } from "@/lib/domain/required-wording";
import { printPlacementLabel } from "@/lib/domain/print-placement";
import type { TShirtDesignBrief } from "@/lib/domain/types";
import type {
  BriefConflict,
  BriefEvaluation,
  BriefSectionEvaluation,
  BriefSectionKey,
  SectionRequirementTier,
  SectionResolution,
} from "@/capabilities/shared/contracts";
import {
  ALL_SECTIONS_IN_POLICY_ORDER,
  tierOf,
} from "@/capabilities/shared/interview-coverage-policy";
import {
  checkAudienceQuality,
  checkPreferredColorsQuality,
  checkPrintLocationQuality,
  checkProductQuality,
  checkRequiredWordingQuality,
} from "@/capabilities/shared/brief-field-quality";

/**
 * Brief Evaluation Engine (Sprint 2E, tiered policy Sprint 2F).
 *
 * The objective evaluation layer between the Design Brief and Design
 * Intelligence. It answers one question only: "what do we objectively know
 * about this design, and how has each part of it been resolved?" It never
 * recommends fixes, never asks questions, and never generates anything —
 * that judgment belongs to Design Intelligence, Interview Intelligence, and
 * Concept Generation respectively.
 *
 * Deterministic and provider-independent: the same brief always produces
 * the same evaluation. Consumes only `TShirtDesignBrief` data (including
 * its own `deferredSections` — an explicit customer decision that lives on
 * the brief, not the conversation) — no Conversation, no providers, no UI,
 * no persistence.
 */
export interface BriefEvaluationCapability {
  evaluate(brief: TShirtDesignBrief): BriefEvaluation;
}

export function createBriefEvaluationCapability(): BriefEvaluationCapability {
  return {
    evaluate(brief) {
      const deferredSet = new Set(brief.deferredSections);
      const sections = ALL_SECTIONS_IN_POLICY_ORDER.map((section) =>
        evaluateSection(brief, section, deferredSet),
      );
      const contradictions = detectContradictions(brief);

      const ambiguities = sections
        .filter((section) => section.known && section.ambiguous)
        .map((section) => ({
          section: section.section,
          message: section.reason,
        }));

      const knownSections = sections.filter((s) => s.resolution === "provided");
      const missingSections = sections.filter((s) => s.resolution === "unknown");
      const blockingSections = sections.filter((s) => s.blocking);

      const unresolvedRequired = sections.filter(
        (s) => s.tier === "required" && s.resolution === "unknown",
      );
      const unresolvedHighValue = sections.filter(
        (s) => s.tier === "high_value" && s.resolution === "unknown",
      );

      const completeness = Math.round(
        (sections.filter((s) => s.resolution !== "unknown").length /
          sections.length) *
          100,
      );
      const confidence = knownSections.length
        ? Math.round(
            knownSections.reduce((sum, s) => sum + s.confidence, 0) /
              knownSections.length,
          )
        : 0;

      const summaryReady =
        unresolvedRequired.length === 0 && unresolvedHighValue.length === 0;
      const blockingContradictions = contradictions.filter(
        (c) => c.severity === "blocking",
      );
      const approvalReady = summaryReady && blockingContradictions.length === 0;

      const unresolvedForSummary = [...unresolvedRequired, ...unresolvedHighValue];

      return {
        sections,
        ambiguities,
        contradictions,
        overall: {
          completeness,
          confidence,
          knownSectionCount: knownSections.length,
          missingSectionCount: missingSections.length,
          blockingSectionCount: blockingSections.length,
        },
        summaryReadiness: {
          ready: summaryReady,
          reason: summaryReady
            ? "All required and high-value sections are resolved (provided or explicitly deferred)."
            : `Still needed: ${unresolvedForSummary.map((s) => s.section).join(", ")}.`,
        },
        approvalReadiness: {
          ready: approvalReady,
          blockingSections: unresolvedRequired.map((s) => s.section),
          reason: !summaryReady
            ? `Still needed: ${unresolvedForSummary.map((s) => s.section).join(", ")}.`
            : blockingContradictions.length > 0
              ? `Unresolved contradictions: ${blockingContradictions
                  .map((c) => c.message)
                  .join(" ")}`
              : "All required sections are resolved and no blocking contradictions were found.",
        },
      };
    },
  };
}

/* ------------------------------------------------------------------ */
/* Section evaluation                                                  */
/* ------------------------------------------------------------------ */

const NOT_YET_ASKED_REASON = "Not yet asked by the current Design Interview.";
const NO_DATA_MODEL_REASON =
  "Not yet gathered by the current Design Brief data model.";
const DEFERRED_REASON = "Customer explicitly left this to the designer's judgment.";

/** Sections with no backing TShirtDesignBrief field yet — always unresolved. */
const NO_FIELD_SECTIONS = new Set<BriefSectionKey>([
  "references",
  "production",
  "layoutPreference",
]);

const FREE_TEXT_GETTERS: Partial<
  Record<BriefSectionKey, (brief: TShirtDesignBrief) => string | null>
> = {
  product: (b) => b.productSummary,
  graphics: (b) => b.designDescription,
  productColor: (b) => b.shirtColor,
  style: (b) => b.designStyle,
  audience: (b) => b.audience,
  purpose: (b) => b.purpose,
  exclusions: (b) => b.exclusions,
  additionalNotes: (b) => b.additionalInstructions,
};

/**
 * Sprint 2K Phase 2 — Workstream B: deterministic, rule-based semantic
 * validation. A section with content that trips one of these checks is
 * evaluated as "unknown" (not "provided") — exactly the same bucket an
 * unanswered section falls into — so a corrupted field can never satisfy
 * summary/approval readiness or reach the customer-facing Design Summary.
 * Scoped to the sections Workstream B calls out explicitly; sections
 * without a checker here are unaffected.
 */
const QUALITY_CHECKERS: Partial<
  Record<BriefSectionKey, (value: string) => { reason: string } | null>
> = {
  product: checkProductQuality,
  audience: checkAudienceQuality,
};

function evaluateSection(
  brief: TShirtDesignBrief,
  section: BriefSectionKey,
  deferredSet: Set<string>,
): BriefSectionEvaluation {
  if (section === "requiredWording") {
    return evaluateRequiredWording(brief);
  }
  if (section === "printLocation") {
    return evaluatePrintLocation(brief, deferredSet);
  }
  if (section === "colors") {
    return evaluateColors(brief, deferredSet);
  }

  const tier = tierOf(section);
  const getValue = FREE_TEXT_GETTERS[section] ?? (() => null);
  const trimmed = getValue(brief)?.trim() ?? "";

  if (trimmed.length > 0) {
    const malformed = QUALITY_CHECKERS[section]?.(trimmed);
    if (malformed) {
      return build(section, tier, "unknown", { reason: malformed.reason });
    }

    const { confidence, ambiguous } = scoreConfidence(trimmed);
    return build(section, tier, "provided", {
      confidence,
      ambiguous,
      reason: ambiguous
        ? `Customer said "${trimmed}" — known, but too vague to treat as high confidence.`
        : `Customer specified "${trimmed}".`,
    });
  }

  if (tier !== "required" && deferredSet.has(section)) {
    return build(section, tier, "deferred_to_designer", { reason: DEFERRED_REASON });
  }

  return build(section, tier, "unknown", {
    reason: NO_FIELD_SECTIONS.has(section)
      ? NO_DATA_MODEL_REASON
      : tier === "required"
        ? "Required, but not yet provided."
        : NOT_YET_ASKED_REASON,
  });
}

function evaluateColors(
  brief: TShirtDesignBrief,
  deferredSet: Set<string>,
): BriefSectionEvaluation {
  const tier = tierOf("colors"); // "high_value"

  if (brief.preferredColors.length > 0) {
    const malformed = checkPreferredColorsQuality(brief.preferredColors);
    if (malformed) {
      return build("colors", tier, "unknown", { reason: malformed.reason });
    }

    const trimmed = brief.preferredColors.join(", ");
    const { confidence, ambiguous } = scoreConfidence(trimmed);
    return build("colors", tier, "provided", {
      confidence,
      ambiguous,
      reason: ambiguous
        ? `Customer said "${trimmed}" — known, but too vague to treat as high confidence.`
        : `Customer specified "${trimmed}".`,
    });
  }

  if (deferredSet.has("colors")) {
    return build("colors", tier, "deferred_to_designer", { reason: DEFERRED_REASON });
  }

  return build("colors", tier, "unknown", { reason: NOT_YET_ASKED_REASON });
}

function evaluateRequiredWording(brief: TShirtDesignBrief): BriefSectionEvaluation {
  const tier = tierOf("requiredWording"); // always "required"
  const wording = deriveRequiredWording(brief);

  if (wording.mode === "none") {
    return build("requiredWording", tier, "provided", {
      confidence: 100,
      ambiguous: false,
      reason: "Customer explicitly indicated no required wording.",
    });
  }

  if (wording.mode === "provided" && wording.text) {
    const malformed = checkRequiredWordingQuality(wording.text);
    if (malformed) {
      return build("requiredWording", tier, "unknown", { reason: malformed.reason });
    }

    const { confidence, ambiguous } = scoreConfidence(wording.text);
    return build("requiredWording", tier, "provided", {
      confidence,
      ambiguous,
      reason: ambiguous
        ? `Customer said "${wording.text}" — known, but too vague to treat as high confidence.`
        : `Customer specified "${wording.text}".`,
    });
  }

  // requiredWording is "required" tier — never deferrable.
  return build("requiredWording", tier, "unknown", {
    reason: 'Required, but not yet provided (or confirmed as "none").',
  });
}

function evaluatePrintLocation(
  brief: TShirtDesignBrief,
  deferredSet: Set<string>,
): BriefSectionEvaluation {
  const tier = tierOf("printLocation"); // "high_value"
  const label = printPlacementLabel(brief.printPlacement);

  if (label) {
    // Defense in depth: `printPlacement` is a closed enum at the type
    // level, so this can only trip on data that bypassed that guarantee
    // (e.g. legacy/untrusted persisted data) — see brief-field-quality.ts.
    const malformed = brief.printPlacement
      ? checkPrintLocationQuality(brief.printPlacement)
      : null;
    if (malformed) {
      return build("printLocation", tier, "unknown", { reason: malformed.reason });
    }

    return build("printLocation", tier, "provided", {
      confidence: 95,
      ambiguous: false,
      reason: `Customer specified "${label}".`,
    });
  }

  if (deferredSet.has("printLocation")) {
    return build("printLocation", tier, "deferred_to_designer", {
      reason: DEFERRED_REASON,
    });
  }

  return build("printLocation", tier, "unknown", { reason: NOT_YET_ASKED_REASON });
}

function build(
  section: BriefSectionKey,
  tier: SectionRequirementTier,
  resolution: SectionResolution,
  opts: { confidence?: number; ambiguous?: boolean; reason: string },
): BriefSectionEvaluation {
  return {
    section,
    tier,
    resolution,
    deferrable: tier !== "required",
    known: resolution === "provided",
    missing: resolution === "unknown",
    optional: tier === "optional",
    blocking: tier === "required",
    ambiguous: opts.ambiguous ?? false,
    confidence: opts.confidence ?? 0,
    reason: opts.reason,
  };
}

/* ------------------------------------------------------------------ */
/* Confidence scoring                                                  */
/* ------------------------------------------------------------------ */

/**
 * Deterministic confidence heuristic. Confidence is not the same axis as
 * completeness/resolution: a section can be fully "provided" and still
 * low-confidence because the customer's phrasing is too vague to act on.
 *
 * This is intentionally a coarse two-tier model (vague vs. concrete) rather
 * than a graduated score — it is easy to reason about, easy to test, and
 * easy to extend later without changing the contract shape.
 */
const AMBIGUOUS_PHRASES = [
  "i want something nice",
  "something nice",
  "i don't know",
  "i dont know",
  "not sure",
  "no idea",
  "whatever looks good",
  "whatever you think",
  "whatever you recommend",
  "make it cool",
  "make it modern",
  "make it pop",
  "make it nice",
  "up to you",
  "surprise me",
  "you decide",
  "you choose",
  "anything is fine",
  "anything works",
  "no preference",
];

const AMBIGUOUS_SINGLE_WORDS = new Set([
  "nice",
  "good",
  "cool",
  "modern",
  "whatever",
  "anything",
  "fine",
  "ok",
  "okay",
  "something",
]);

export function scoreConfidence(trimmedValue: string): {
  confidence: number;
  ambiguous: boolean;
} {
  const normalized = trimmedValue.toLowerCase();

  if (AMBIGUOUS_PHRASES.some((phrase) => normalized.includes(phrase))) {
    return { confidence: 35, ambiguous: true };
  }

  if (AMBIGUOUS_SINGLE_WORDS.has(normalized)) {
    return { confidence: 35, ambiguous: true };
  }

  return { confidence: 90, ambiguous: false };
}

/* ------------------------------------------------------------------ */
/* Contradiction detection                                             */
/* ------------------------------------------------------------------ */

const MINIMALIST_STYLE_PATTERN = /\b(minimal|minimalist|simple|clean)\b/i;
const BUSY_GRAPHICS_PATTERN =
  /\b(covered|cluttered|busy|packed|full of|lots of|loaded with|many graphics)\b/i;
const LONG_WORDING_WORD_COUNT = 12;

/**
 * Reports contradictions between sections. Never proposes a resolution —
 * that judgment belongs to Design Intelligence. `code` lets downstream
 * layers branch on a known rule rather than parsing `message`.
 */
function detectContradictions(brief: TShirtDesignBrief): BriefConflict[] {
  const conflicts: BriefConflict[] = [];

  const colorClash = detectColorClash(brief);
  if (colorClash) conflicts.push(colorClash);

  const wordingClash = detectMinimalistWordingClash(brief);
  if (wordingClash) conflicts.push(wordingClash);

  const graphicsClash = detectMinimalistGraphicsClash(brief);
  if (graphicsClash) conflicts.push(graphicsClash);

  return conflicts;
}

function detectColorClash(brief: TShirtDesignBrief): BriefConflict | null {
  const shirtColor = brief.shirtColor?.trim().toLowerCase();
  if (!shirtColor || brief.preferredColors.length === 0) return null;

  const clashes = brief.preferredColors.filter(
    (color) => color.trim().toLowerCase() === shirtColor,
  );
  if (clashes.length === 0) return null;

  // Every requested artwork color matching the product color means the
  // design would be effectively invisible when printed — a real production
  // blocker, not just a style aside. A partial match is worth mentioning
  // but does not block approval on its own.
  const allColorsClash = clashes.length === brief.preferredColors.length;

  return {
    sections: ["colors", "productColor"],
    code: "color_clash",
    message: `Requested color "${clashes[0]}" matches the product color "${brief.shirtColor}", which may not be visible when printed.`,
    severity: allColorsClash ? "blocking" : "warning",
  };
}

function detectMinimalistWordingClash(
  brief: TShirtDesignBrief,
): BriefConflict | null {
  const style = brief.designStyle?.trim();
  const wording = deriveRequiredWording(brief).text;
  if (!style || !wording) return null;
  if (!MINIMALIST_STYLE_PATTERN.test(style)) return null;

  const wordCount = wording.split(/\s+/).filter(Boolean).length;
  const isLong =
    wordCount > LONG_WORDING_WORD_COUNT || /\bparagraph\b/i.test(wording);
  if (!isLong) return null;

  return {
    sections: ["style", "requiredWording"],
    code: "minimalist_wording_clash",
    message: `Style "${style}" reads as minimalist, but the required wording is long (${wordCount} words), which may conflict with a minimalist layout.`,
    severity: "warning",
  };
}

function detectMinimalistGraphicsClash(
  brief: TShirtDesignBrief,
): BriefConflict | null {
  const style = brief.designStyle?.trim();
  const graphics = brief.designDescription?.trim();
  if (!style || !graphics) return null;
  if (!MINIMALIST_STYLE_PATTERN.test(style)) return null;
  if (!BUSY_GRAPHICS_PATTERN.test(graphics)) return null;

  return {
    sections: ["style", "graphics"],
    code: "minimalist_graphics_clash",
    message: `Style "${style}" reads as minimalist, but the design description ("${graphics}") reads as graphic-heavy.`,
    severity: "warning",
  };
}
