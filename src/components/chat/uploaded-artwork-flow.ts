/**
 * Existing Artwork → Print Ready Phase 1: "which step of the Upload Existing
 * Artwork flow is the customer on?", as a pure function of already-persisted
 * state plus one piece of transient client choice.
 *
 * Extracted from the panel component for the same reason
 * `chat-affordances.ts` was extracted from `ChatApp`: a step-selection bug is
 * otherwise only observable by running the app, and this repo's test tooling
 * is `node:test` + `renderToString` (no DOM, no effects).
 *
 * WORKFLOW IDENTITY lives here in one line: a project with a preparation IS a
 * `prepare_existing` project, durably and without any workflow enum column.
 * The customer's choice matters only in the window BEFORE they upload
 * anything, where nothing durable exists to remember — and where forgetting
 * it (a reload) correctly returns them to the choice rather than trapping
 * them in a workflow they never committed to.
 */

import type { ArtworkPreparationView } from "@/capabilities/artwork-preparation";

/** Transient, client-only. Never persisted — see this module's doc comment. */
export type WorkflowChoice = "undecided" | "create_new" | "upload_existing";

export type UploadedArtworkStep =
  /** Offer both workflows. The only step that is ever shown before a choice. */
  | "choose_workflow"
  /** Waiting for the customer to pick a file. */
  | "upload"
  /** We have their artwork; we still need to know what and where we're printing. */
  | "confirm_details"
  /** Analysis is done and has something to say before we touch a pixel. */
  | "review_analysis"
  /** Original vs Prepared, awaiting an explicit approval. */
  | "compare"
  /** The customer approved the prepared artwork. */
  | "approved";

export interface UploadedArtworkFlowInput {
  /** `null` for every Create New Artwork project. */
  preparation: ArtworkPreparationView | null;
  choice: WorkflowChoice;
  /**
   * True only at the very start of a project — no customer message, no
   * artwork. Offering the workflow choice later would interrupt an interview
   * already in progress.
   */
  atProjectStart: boolean;
}

/**
 * The step to render, or `null` when the uploaded-artwork surface should not
 * appear at all — which is every existing Create New Artwork project, so the
 * existing flow is untouched by construction.
 */
export function deriveUploadedArtworkStep(
  input: UploadedArtworkFlowInput,
): UploadedArtworkStep | null {
  const { preparation } = input;

  if (!preparation) {
    if (input.choice === "upload_existing") return "upload";
    if (input.choice === "undecided" && input.atProjectStart) {
      return "choose_workflow";
    }
    return null;
  }

  if (preparation.approved) return "approved";
  if (preparation.hasPreparedArtwork) return "compare";
  // Print location is what makes a print-size statement possible at all —
  // without it, the analysis has nothing honest to say about whether the
  // artwork is big enough (`preparation-copy.ts` stays silent rather than
  // guessing a placement).
  if (!preparation.printPlacement) return "confirm_details";
  return "review_analysis";
}

/**
 * Whether the uploaded-artwork workflow currently owns the surface. When it
 * does, the creative-flow surfaces (concept grid, design summary, revision
 * actions) are hidden: an uploaded-artwork customer already has their design
 * and must never be walked through a design description, three concept
 * directions, or a wording interview.
 */
export function uploadedArtworkOwnsSurface(
  step: UploadedArtworkStep | null,
): boolean {
  return step !== null && step !== "choose_workflow";
}
