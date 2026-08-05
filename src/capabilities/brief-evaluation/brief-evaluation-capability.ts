import type { TShirtDesignBrief } from "@/lib/domain/types";
import type {
  BriefConflict,
  BriefEvaluation,
  BriefSectionEvaluation,
  BriefSectionKey,
} from "@/capabilities/shared/contracts";

/**
 * Brief Evaluation Engine (Sprint 2E).
 *
 * The objective evaluation layer between the Design Brief and Design
 * Intelligence. It answers one question only: "what do we objectively know
 * about this design?"
 *
 * It does NOT recommend improvements, does NOT ask interview questions, and
 * does NOT generate concepts — that judgment belongs to Design Intelligence,
 * Interview Intelligence, and Concept Generation respectively.
 *
 * Deterministic and provider-independent: the same brief always produces the
 * same evaluation. Consumes only `TShirtDesignBrief` data — no Conversation,
 * no providers, no UI, no persistence.
 */
export interface BriefEvaluationCapability {
  evaluate(brief: TShirtDesignBrief): BriefEvaluation;
}

export function createBriefEvaluationCapability(): BriefEvaluationCapability {
  return {
    evaluate(brief) {
      const sections = SECTION_DEFINITIONS.map((definition) =>
        evaluateSection(brief, definition),
      );
      const contradictions = detectContradictions(brief);

      const ambiguities = sections
        .filter((section) => section.known && section.ambiguous)
        .map((section) => ({
          section: section.section,
          message: section.reason,
        }));

      const knownSections = sections.filter((section) => section.known);
      const missingSections = sections.filter((section) => section.missing);
      const blockingSections = sections.filter((section) => section.blocking);
      const blockingMissingSections = sections.filter(
        (section) => section.blocking && section.missing,
      );

      const completeness = Math.round(
        (knownSections.length / sections.length) * 100,
      );
      const confidence = knownSections.length
        ? Math.round(
            knownSections.reduce((sum, section) => sum + section.confidence, 0) /
              knownSections.length,
          )
        : 0;

      const summaryReady = blockingMissingSections.length === 0;
      const blockingContradictions = contradictions.filter(
        (contradiction) => contradiction.severity === "blocking",
      );
      const approvalReady = summaryReady && blockingContradictions.length === 0;

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
            ? "All required sections have been provided."
            : `Missing required information: ${blockingMissingSections
                .map((section) => section.section)
                .join(", ")}.`,
        },
        approvalReadiness: {
          ready: approvalReady,
          blockingSections: blockingMissingSections.map(
            (section) => section.section,
          ),
          reason: !summaryReady
            ? `Missing required information: ${blockingMissingSections
                .map((section) => section.section)
                .join(", ")}.`
            : blockingContradictions.length > 0
              ? `Unresolved contradictions: ${blockingContradictions
                  .map((contradiction) => contradiction.message)
                  .join(" ")}`
              : "All required sections are known and no blocking contradictions were found.",
        },
      };
    },
  };
}

/* ------------------------------------------------------------------ */
/* Section evaluation                                                  */
/* ------------------------------------------------------------------ */

interface SectionDefinition {
  section: BriefSectionKey;
  optional: boolean;
  /**
   * Extracts the raw customer-provided value for this section, or `null`
   * when the current Design Brief data model / scripted interview does not
   * yet gather it at all (structurally missing, independent of brief content).
   */
  getValue: (brief: TShirtDesignBrief) => string | null;
  /** Overrides the generic reason text when the section is missing. */
  missingReason?: string;
}

const NOT_YET_GATHERED_REASON =
  "Not yet asked by the current Design Interview.";

const SECTION_DEFINITIONS: SectionDefinition[] = [
  {
    section: "product",
    optional: false,
    getValue: (brief) => brief.productSummary,
  },
  {
    section: "graphics",
    optional: false,
    getValue: (brief) => brief.designDescription,
  },
  {
    section: "productColor",
    optional: false,
    getValue: (brief) => brief.shirtColor,
  },
  {
    section: "requiredWording",
    optional: false,
    // exactText === null means never answered; "" means the customer
    // explicitly said there is no required wording, which is still known.
    getValue: (brief) => brief.exactText,
  },
  {
    section: "style",
    optional: true,
    getValue: (brief) => brief.designStyle,
  },
  {
    section: "colors",
    optional: true,
    getValue: (brief) =>
      brief.preferredColors.length > 0
        ? brief.preferredColors.join(", ")
        : null,
  },
  {
    section: "additionalNotes",
    optional: true,
    getValue: (brief) => brief.additionalInstructions,
  },
  // The remaining sections have no backing field yet, or (printLocation) a
  // field that only ever holds an internal default the customer never
  // confirmed. They are always structurally missing today. Flagging them
  // this way (rather than reading a stale/default field) keeps the
  // evaluator honest about what the customer actually told us — the same
  // rule DesignSummaryCapability already documents for what it renders.
  {
    section: "audience",
    optional: true,
    getValue: () => null,
  },
  {
    section: "purpose",
    optional: true,
    getValue: () => null,
  },
  {
    section: "references",
    optional: true,
    getValue: () => null,
  },
  {
    section: "production",
    optional: true,
    getValue: () => null,
  },
  {
    section: "layoutPreference",
    optional: true,
    getValue: () => null,
  },
  {
    section: "exclusions",
    optional: true,
    getValue: () => null,
  },
  {
    section: "printLocation",
    optional: true,
    getValue: () => null,
    missingReason:
      "Not yet asked by the current Design Interview; an internal default placement is used but not customer-confirmed.",
  },
];

function evaluateSection(
  brief: TShirtDesignBrief,
  definition: SectionDefinition,
): BriefSectionEvaluation {
  const rawValue = definition.getValue(brief);

  if (rawValue === null) {
    return {
      section: definition.section,
      known: false,
      missing: true,
      optional: definition.optional,
      blocking: !definition.optional,
      ambiguous: false,
      confidence: 0,
      reason: definition.missingReason ?? NOT_YET_GATHERED_REASON,
    };
  }

  const trimmed = rawValue.trim();

  // requiredWording is special: "" is a valid, fully-confident answer
  // ("no required wording"), not an unanswered field.
  if (definition.section === "requiredWording" && trimmed.length === 0) {
    return {
      section: definition.section,
      known: true,
      missing: false,
      optional: definition.optional,
      blocking: !definition.optional,
      ambiguous: false,
      confidence: 100,
      reason: "Customer explicitly indicated no required wording.",
    };
  }

  if (trimmed.length === 0) {
    return {
      section: definition.section,
      known: false,
      missing: true,
      optional: definition.optional,
      blocking: !definition.optional,
      ambiguous: false,
      confidence: 0,
      reason: definition.missingReason ?? NOT_YET_GATHERED_REASON,
    };
  }

  const { confidence, ambiguous } = scoreConfidence(trimmed);

  return {
    section: definition.section,
    known: true,
    missing: false,
    optional: definition.optional,
    blocking: !definition.optional,
    ambiguous,
    confidence,
    reason: ambiguous
      ? `Customer said "${trimmed}" — known, but too vague to treat as high confidence.`
      : `Customer specified "${trimmed}".`,
  };
}

/* ------------------------------------------------------------------ */
/* Confidence scoring                                                  */
/* ------------------------------------------------------------------ */

/**
 * Deterministic confidence heuristic. Confidence is not the same axis as
 * completeness: a section can be fully "known" and still low-confidence
 * because the customer's phrasing is too vague to act on.
 *
 * This is intentionally a coarse two-tier model (vague vs. concrete) rather
 * than a graduated score — it is easy to reason about, easy to test, and
 * easy to extend later without changing the contract shape. A future sprint
 * may refine the scoring function; the `BriefEvaluation` shape does not need
 * to change to support that.
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

function scoreConfidence(trimmedValue: string): {
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
 * that judgment belongs to Design Intelligence.
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

  const clash = brief.preferredColors.find(
    (color) => color.trim().toLowerCase() === shirtColor,
  );
  if (!clash) return null;

  return {
    sections: ["colors", "productColor"],
    message: `Requested color "${clash}" matches the product color "${brief.shirtColor}", which may not be visible when printed.`,
    severity: "warning",
  };
}

function detectMinimalistWordingClash(
  brief: TShirtDesignBrief,
): BriefConflict | null {
  const style = brief.designStyle?.trim();
  const wording = brief.exactText?.trim();
  if (!style || !wording) return null;
  if (!MINIMALIST_STYLE_PATTERN.test(style)) return null;

  const wordCount = wording.split(/\s+/).filter(Boolean).length;
  const isLong =
    wordCount > LONG_WORDING_WORD_COUNT || /\bparagraph\b/i.test(wording);
  if (!isLong) return null;

  return {
    sections: ["style", "requiredWording"],
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
    message: `Style "${style}" reads as minimalist, but the design description ("${graphics}") reads as graphic-heavy.`,
    severity: "warning",
  };
}
