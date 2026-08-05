import { deriveRequiredWording } from "@/lib/domain/required-wording";
import { printPlacementLabel } from "@/lib/domain/print-placement";
import type { TShirtDesignBrief } from "@/lib/domain/types";
import type {
  BriefEvaluation,
  BriefSectionKey,
  DesignSummaryView,
} from "@/capabilities/shared/contracts";

/**
 * Sole owner of Design Summary creation/formatting (Sprint 2D).
 * Consumes the Design Brief and its Brief Evaluation. Nothing else creates
 * or formats summaries.
 *
 * Constitutional rule: never display a field the customer didn't actually
 * resolve. Sprint 2E/2F: "resolved" now includes explicit deferral, not
 * only a concrete value — BriefEvaluation's per-section `resolution` (not
 * ad hoc presence checks here) is the single source of truth for whether a
 * section shows up at all. A deferred section renders as a short,
 * customer-friendly note instead of the raw value it doesn't have.
 * Optional sections that were never resolved are omitted entirely — the
 * summary never shows a blank or invented placeholder.
 */
export interface DesignSummaryCapability {
  createSummary(
    brief: TShirtDesignBrief,
    evaluation: BriefEvaluation,
  ): DesignSummaryView;
  formatForCustomer(summary: DesignSummaryView): string;
}

const FIELD_LABELS: Array<[keyof DesignSummaryView, string]> = [
  ["product", "Product"],
  ["graphics", "Design Description"],
  ["productColor", "Product Color"],
  ["printLocation", "Print Location"],
  ["requiredWording", "Required Wording"],
  ["style", "Style"],
  ["colors", "Preferred Colors"],
  ["audience", "Audience"],
  ["purpose", "Purpose"],
  ["exclusions", "Exclusions"],
  ["additionalNotes", "Additional Notes"],
];

/**
 * Short, friendly copy for a section the customer explicitly deferred to
 * the designer's judgment. Never displayed for a required section — those
 * cannot be deferred (see InterviewCoveragePolicy), so this map only needs
 * entries for the deferrable high-value sections.
 */
const DEFERRED_COPY: Partial<Record<BriefSectionKey, string>> = {
  purpose: "Left to our designer's judgment",
  audience: "Left to our designer's judgment",
  style: "We'll choose a style that fits the rest of the brief",
  colors: "We'll choose colors that work well with the shirt",
  printLocation: "We'll choose the placement that works best",
};

export function createDesignSummaryCapability(): DesignSummaryCapability {
  return {
    createSummary(brief, evaluation) {
      const resolution = sectionResolutions(evaluation);
      const summary: DesignSummaryView = {};

      const setIfResolved = (
        section: BriefSectionKey,
        key: keyof DesignSummaryView,
        value: string | null | undefined,
      ) => {
        const state = resolution.get(section);
        if (state === "provided" && value?.trim()) {
          summary[key] = value.trim();
        } else if (state === "deferred_to_designer" && DEFERRED_COPY[section]) {
          summary[key] = DEFERRED_COPY[section];
        }
      };

      setIfResolved("product", "product", brief.productSummary);
      setIfResolved("graphics", "graphics", brief.designDescription);
      setIfResolved("productColor", "productColor", brief.shirtColor);
      setIfResolved(
        "printLocation",
        "printLocation",
        printPlacementLabel(brief.printPlacement),
      );
      setIfResolved("style", "style", brief.designStyle);
      setIfResolved(
        "colors",
        "colors",
        brief.preferredColors.length > 0 ? brief.preferredColors.join(", ") : null,
      );
      setIfResolved("audience", "audience", brief.audience);
      setIfResolved("purpose", "purpose", brief.purpose);
      setIfResolved("exclusions", "exclusions", brief.exclusions);
      setIfResolved(
        "additionalNotes",
        "additionalNotes",
        brief.additionalInstructions,
      );

      // Required wording keeps its own rule: "" is a resolved, deliberate
      // "None" answer, not blank content to filter out.
      if (resolution.get("requiredWording") === "provided") {
        const wording = deriveRequiredWording(brief);
        summary.requiredWording = wording.mode === "none" ? "None" : wording.text ?? "None";
      }

      // Intentionally never populated: references, production
      // considerations — not yet gathered by this workflow.
      return summary;
    },

    formatForCustomer(summary) {
      const knownRows = FIELD_LABELS.filter(([key]) =>
        Boolean(summary[key]?.toString().trim()),
      );

      const lines = [
        "Here's my understanding of your design so far:",
        "",
        ...knownRows.map(([key, label]) => `${label}: ${summary[key]}`),
        "",
        "Would you like to approve this, make an edit, or tell me more before we continue?",
      ];

      return lines.join("\n");
    },
  };
}

function sectionResolutions(
  evaluation: BriefEvaluation,
): Map<BriefSectionKey, BriefEvaluation["sections"][number]["resolution"]> {
  return new Map(evaluation.sections.map((s) => [s.section, s.resolution]));
}
