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
 * Constitutional rule: never display a field the interview did not actually
 * collect. The Sprint 1 script only gathers product, design description,
 * shirt color, and required wording — plus whatever the customer volunteers
 * via Edit/Continue (stored as additional notes). Audience, purpose,
 * references, production considerations, and print location are NOT asked by
 * the current script, so they are intentionally omitted rather than shown as
 * blank or invented placeholders.
 *
 * Sprint 2E: which fields are known is now read from BriefEvaluation's
 * per-section `known` flag (BriefEvaluationCapability is the single source
 * of truth for that determination) instead of duplicating each field's
 * presence check here. The rendered values and their inclusion rules are
 * unchanged — this only removes duplicated "is this field present" logic.
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
  ["requiredWording", "Required Wording"],
  ["colors", "Preferred Colors"],
  ["style", "Style"],
  ["additionalNotes", "Additional Notes"],
];

export function createDesignSummaryCapability(): DesignSummaryCapability {
  return {
    createSummary(brief, evaluation) {
      const known = knownSections(evaluation);
      const summary: DesignSummaryView = {};

      if (known.has("product") && brief.productSummary?.trim()) {
        summary.product = brief.productSummary.trim();
      }
      if (known.has("graphics") && brief.designDescription?.trim()) {
        summary.graphics = brief.designDescription.trim();
      }
      if (known.has("productColor") && brief.shirtColor?.trim()) {
        summary.productColor = brief.shirtColor.trim();
      }
      if (known.has("requiredWording") && brief.exactText !== null) {
        const trimmed = brief.exactText.trim();
        summary.requiredWording = trimmed.length > 0 ? trimmed : "None";
      }
      if (known.has("style") && brief.designStyle?.trim()) {
        summary.style = brief.designStyle.trim();
      }
      if (known.has("colors") && brief.preferredColors.length > 0) {
        summary.colors = brief.preferredColors.join(", ");
      }
      if (known.has("additionalNotes") && brief.additionalInstructions?.trim()) {
        summary.additionalNotes = brief.additionalInstructions.trim();
      }

      // Intentionally not populated by the current scripted interview:
      // audience, purpose, references, productionConsiderations, printLocation.
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

function knownSections(evaluation: BriefEvaluation): Set<BriefSectionKey> {
  return new Set(
    evaluation.sections
      .filter((section) => section.known)
      .map((section) => section.section),
  );
}
