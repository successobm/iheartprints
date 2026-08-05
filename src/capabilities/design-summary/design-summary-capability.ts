import { deriveRequiredWording } from "@/lib/domain/required-wording";
import { printPlacementLabel } from "@/lib/domain/print-placement";
import type { TShirtDesignBrief } from "@/lib/domain/types";
import type {
  BriefEvaluation,
  BriefSectionKey,
  DeferredDecisionView,
  DesignSummaryView,
} from "@/capabilities/shared/contracts";

/**
 * Sole owner of Design Summary creation/formatting (Sprint 2D).
 * Consumes the Design Brief and its Brief Evaluation. Nothing else creates
 * or formats summaries.
 *
 * Constitutional rule: never display a field the customer didn't actually
 * resolve. BriefEvaluation's per-section `resolution` (not ad hoc presence
 * checks here) is the single source of truth for whether a section shows
 * up at all.
 *
 * Sprint 2G Part 3: a deferred section is no longer folded into the
 * regular field list as friendly-but-blank-ish text — it gets its own
 * "Designer will determine" section (`listDeferredDecisions`), presented
 * as a completed decision, not missing information. The regular
 * `DesignSummaryView` now only ever contains sections the customer
 * actually gave content for.
 */
export interface DesignSummaryCapability {
  createSummary(
    brief: TShirtDesignBrief,
    evaluation: BriefEvaluation,
  ): DesignSummaryView;
  /** Sections explicitly deferred to the designer — a completed decision, not a gap. */
  listDeferredDecisions(evaluation: BriefEvaluation): DeferredDecisionView[];
  formatForCustomer(
    summary: DesignSummaryView,
    deferredDecisions?: DeferredDecisionView[],
  ): string;
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
 * Short noun phrases for the "Designer will determine" section — never a
 * full sentence, never phrased as absence ("no style set"), always framed
 * as a decision that will be made well on the customer's behalf.
 */
const DEFERRED_LABELS: Partial<Record<BriefSectionKey, string>> = {
  purpose: "The occasion or purpose",
  audience: "Who this is for",
  style: "The overall style",
  colors: "Best artwork colors",
  printLocation: "Final print placement",
};

export function createDesignSummaryCapability(): DesignSummaryCapability {
  return {
    createSummary(brief, evaluation) {
      const resolution = sectionResolutions(evaluation);
      const summary: DesignSummaryView = {};

      const setIfProvided = (
        section: BriefSectionKey,
        key: keyof DesignSummaryView,
        value: string | null | undefined,
      ) => {
        if (resolution.get(section) === "provided" && value?.trim()) {
          summary[key] = value.trim();
        }
      };

      setIfProvided("product", "product", brief.productSummary);
      setIfProvided("graphics", "graphics", brief.designDescription);
      setIfProvided("productColor", "productColor", brief.shirtColor);
      setIfProvided(
        "printLocation",
        "printLocation",
        printPlacementLabel(brief.printPlacement),
      );
      setIfProvided("style", "style", brief.designStyle);
      setIfProvided(
        "colors",
        "colors",
        brief.preferredColors.length > 0 ? brief.preferredColors.join(", ") : null,
      );
      setIfProvided("audience", "audience", brief.audience);
      setIfProvided("purpose", "purpose", brief.purpose);
      setIfProvided("exclusions", "exclusions", brief.exclusions);
      setIfProvided(
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

    listDeferredDecisions(evaluation) {
      return evaluation.sections
        .filter((section) => section.resolution === "deferred_to_designer")
        .map((section): DeferredDecisionView | null => {
          const label = DEFERRED_LABELS[section.section];
          return label ? { section: section.section, label } : null;
        })
        .filter((entry): entry is DeferredDecisionView => entry !== null);
    },

    formatForCustomer(summary, deferredDecisions = []) {
      const knownRows = FIELD_LABELS.filter(([key]) =>
        Boolean(summary[key]?.toString().trim()),
      );

      const lines = [
        "Here's my understanding of your design so far:",
        "",
        ...knownRows.map(([key, label]) => `${label}: ${summary[key]}`),
      ];

      if (deferredDecisions.length > 0) {
        lines.push(
          "",
          "Designer will determine:",
          ...deferredDecisions.map((decision) => `- ${decision.label}`),
        );
      }

      lines.push(
        "",
        "Would you like to approve this, make an edit, or tell me more before we continue?",
      );

      return lines.join("\n");
    },
  };
}

function sectionResolutions(
  evaluation: BriefEvaluation,
): Map<BriefSectionKey, BriefEvaluation["sections"][number]["resolution"]> {
  return new Map(evaluation.sections.map((s) => [s.section, s.resolution]));
}
