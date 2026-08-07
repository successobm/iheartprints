import { deriveRequiredWording } from "@/lib/domain/required-wording";
import { printPlacementLabel } from "@/lib/domain/print-placement";
import type { TShirtDesignBrief } from "@/lib/domain/types";
import { capitalizeFirst } from "@/capabilities/shared/field-normalization";
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

/**
 * Sprint 2K Phase 3 (Goal 3): section order and labels for the plain-text
 * chat rendering of the summary — reads like a concise creative brief a
 * designer would hand a customer, not a dump of database fields. Product /
 * color / print location are pulled out into their own compact header line
 * in `formatForCustomer` instead of appearing here; everything else keeps
 * its own labeled block. `requiredWording` gets the most explicit
 * treatment of any field — a spelling mistake there propagates directly
 * into artwork (Constitution §6.12).
 */
const FIELD_LABELS: Array<[keyof DesignSummaryView, string]> = [
  ["graphics", "Design direction"],
  ["requiredWording", "Required wording"],
  ["style", "Style"],
  ["colors", "Preferred colors"],
  ["audience", "Audience"],
  ["purpose", "Purpose"],
  ["exclusions", "Exclusions"],
  ["additionalNotes", "Additional notes"],
];

/** Product / color / print location — shown together as one compact header line. */
const HEADER_FIELDS: ReadonlyArray<keyof DesignSummaryView> = [
  "product",
  "productColor",
  "printLocation",
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
      // Sprint 2K Phase 3 (Goal 2): capitalized for display ("full back" →
      // "Full back") — the shared label stays lowercase because it's also
      // used mid-sentence elsewhere (Brief Evaluation reasons, Product
      // Intelligence advisories).
      const printLocationLabel = printPlacementLabel(brief.printPlacement);
      setIfProvided(
        "printLocation",
        "printLocation",
        printLocationLabel ? capitalizeFirst(printLocationLabel) : null,
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
      // Sprint 2K Phase 3 (Goal 3): read like a concise creative brief, not
      // a dump of "Label: value" database fields. Product / color / print
      // location collapse into one compact header line ("T-shirt · Black ·
      // Full back"); everything else gets its own short, labeled block.
      const headerLine = HEADER_FIELDS.map((key) => summary[key]?.toString().trim())
        .filter((value): value is string => Boolean(value))
        .join(" · ");

      const knownRows = FIELD_LABELS.filter(([key]) =>
        Boolean(summary[key]?.toString().trim()),
      );

      const lines = ["Design Brief"];
      if (headerLine) lines.push("", headerLine);

      for (const [key, label] of knownRows) {
        // Required wording is the one field where a spelling mistake
        // propagates directly into artwork (Constitution §6.12) — quoted
        // on its own line so it reads unmistakably as literal print text,
        // never paraphrased or blended into a sentence.
        const value =
          key === "requiredWording" && summary[key] !== "None"
            ? `"${summary[key]}"`
            : summary[key];
        lines.push("", `${label}:`, String(value));
      }

      if (deferredDecisions.length > 0) {
        lines.push(
          "",
          "Designer will determine:",
          ...deferredDecisions.map((decision) => `- ${decision.label}`),
        );
      }

      // Sprint 2L Phase 1B removed the "Continue" action from the Design
      // Summary UI (Approve / Edit only — see ARCHITECTURE.md §10b), but
      // left this hardcoded prose line still describing three options,
      // including a phantom "tell me more before we continue." Fixed
      // Sprint 2L Phase 1C: this line is the one place customer-facing
      // copy describes the approval-state actions, so it must always match
      // `DesignSummaryCard`'s actual two buttons.
      lines.push(
        "",
        "Review the design brief below. Approve it to create concepts, or edit anything you'd like to change.",
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
