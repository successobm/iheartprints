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
import { createNewWorkflowChosen } from "@/lib/domain/conversation";
import type { SeparationCheckStatus } from "./SeparationReviewPanel";

/**
 * Transient, client-only, and now UPLOAD-ONLY. Correction A removed the
 * `"create_new"` value: that branch is server state, recorded durably by
 * `beginCreateNewWorkflow` and read back through `isAtProjectStart`, so a
 * client enum value for it would be a second — and weaker — answer to a
 * question the server already answers.
 *
 * `"upload_existing"` stays transient on purpose: it matters only in the
 * window before a file exists, where nothing durable exists to remember,
 * and forgetting it on reload correctly returns the customer to the choice
 * rather than trapping them in a workflow they never committed to.
 */
export type WorkflowChoice = "undecided" | "upload_existing";

/**
 * LIVE PRODUCT BLOCKER #1: which customer-facing artwork path the upload
 * belongs to. Transient and client-only, mirroring `WorkflowChoice` exactly
 * — it matters only in the window before the answer becomes durable server
 * state (a `SignPreparation` existing, or `printPlacement` being set), and
 * forgetting it on reload correctly returns the customer to the question
 * rather than trapping them in a path they never confirmed.
 */
export type ArtworkTypeChoice = "undecided" | "dtf" | "sign";

export type UploadedArtworkStep =
  /** Offer both workflows. The only step that is ever shown before a choice. */
  | "choose_workflow"
  /** Waiting for the customer to pick a file. */
  | "upload"
  /** We have their artwork; ask what kind it is before asking anything specific to either path. */
  | "choose_artwork_type"
  /** We have their artwork; we still need to know what and where we're printing. */
  | "confirm_details"
  /** Sign path: the human-confirmed ordered width and height (Constitution §16A.2). */
  | "confirm_sign_size"
  /**
   * Sign path: the ordered size is durably recorded, and the customer may
   * now ask iHeartPrints to inspect the artwork ("Check my artwork"). No
   * plan exists yet — this is not the same as a step that has nothing left
   * to do; the next action is right here.
   */
  | "sign_context_saved"
  /**
   * LIVE PRODUCT BLOCKER #3: a plan (safe, needs-review, or blocked — all
   * three are valid, durable results) has been formulated for this exact
   * artwork and ordered size, and has NOT yet been authorized for THIS
   * exact plan (`authorization.matchesCurrentPlan === false`). For a
   * `needs_review` plan this is a genuine terminal customer state — only
   * an operator may authorize it (`sign-plan-authorization.ts`). For a
   * `ready` (auto_safe) plan, the customer's own authorization is
   * sufficient — LIVE PRODUCT BLOCKER #4's "Prepare artwork" action.
   */
  | "sign_plan_review"
  /**
   * LIVE PRODUCT BLOCKER #4: the customer has authorized THIS exact plan
   * (`authorization.matchesCurrentPlan === true`) — production-risk
   * consent is durably recorded. Actual execution (the provider-bounded
   * reconstruction, preservation verification, Fit-to-Production,
   * PrintValidation) is the internal operator's own "Prepare artwork"
   * action on `/internal/projects/[projectId]/sign-authorize` — this step
   * never duplicates that control surface; it only confirms the customer's
   * own part of the lifecycle is done.
   */
  | "sign_plan_authorized"
  /** Analysis is done and has something to say before we touch a pixel. */
  | "review_analysis"
  /** Original vs Prepared, awaiting an explicit approval. */
  | "compare"
  /** The customer approved the prepared artwork. */
  | "approved";

/**
 * The Signs authority's OWN durable signal, exactly mirroring how
 * `preparation.printPlacement` durably identifies the apparel path — never
 * a second, weaker copy of that fact. `null` means no `SignPreparation`
 * exists yet for this project.
 */
export interface SignArtworkFlowState {
  specConfirmed: boolean;
  /**
   * LIVE PRODUCT BLOCKER #3: whether a plan has been durably formulated
   * (`SignPreparation.status === "planned"` — true for a SAFE or a
   * NEEDS-REVIEW result; a BLOCKED result is not separately durable this
   * phase, see `SignArtworkView.plan`'s doc in `conversation-service.ts`).
   */
  hasPlan: boolean;
  /**
   * LIVE PRODUCT BLOCKER #4: whether the CURRENT plan (identified by
   * `planKey`, never merely "a plan exists") has already been authorized —
   * mirrors `SignArtworkView.authorization` (`conversation-service.ts`)
   * exactly. A stale authorization bound to a SUPERSEDED plan (a re-plan
   * changed `planKey`) reads as `false` here, same discipline as every
   * other authorization check in this codebase — the customer is asked
   * again rather than an old consent silently covering a new plan.
   */
  authorization: { matchesCurrentPlan: boolean };
}

/**
 * LIVE PRODUCT BLOCKER #1 fix (Sign-upload-routes-to-garment): the single
 * source of truth for what "no committed choice yet" looks like for every
 * transient, client-only field this module reads (`WorkflowChoice`,
 * `ArtworkTypeChoice`) plus the closely related "take me back a step"
 * flag (`reconsideringUpload`, read by `ChatApp.tsx` alongside this
 * module's own output — see that file's own doc). A genuine page reload
 * gets these values for free (fresh `useState` initializers); a
 * same-session "Start Over" does NOT reinitialize the component, so
 * `ChatApp.tsx`'s `startOver()` must apply this explicitly before
 * bootstrapping the new project — otherwise a customer's answer from a
 * PRIOR project (e.g. `artworkTypeChoice: "dtf"`) silently carries into
 * the next, unrelated upload, skipping `choose_artwork_type` entirely and
 * landing on a garment-only step for artwork nobody ever classified as a
 * garment. Exported as one object (not three independent literals) so
 * there is exactly one place to update if a future phase adds another
 * transient field this same invariant should cover.
 */
export const FRESH_UPLOADED_ARTWORK_UI_STATE = {
  workflowChoice: "undecided" as WorkflowChoice,
  artworkTypeChoice: "undecided" as ArtworkTypeChoice,
  reconsideringUpload: false,
} as const;

export interface UploadedArtworkFlowInput {
  /** `null` for every Create New Artwork project. */
  preparation: ArtworkPreparationView | null;
  /** `null` until a Sign artwork type is chosen and the bridge into the Signs authority has completed. */
  signArtwork: SignArtworkFlowState | null;
  choice: WorkflowChoice;
  /** The transient artwork-type answer — read only before either durable signal above exists. */
  artworkTypeChoice: ArtworkTypeChoice;
  /**
   * True only at the very start of a project — no customer message, no
   * artwork. Offering the workflow choice later would interrupt an interview
   * already in progress.
   */
  atProjectStart: boolean;
}

/**
 * Whether the project is still at its very start — the window in which the
 * workflow choice is offered at all.
 *
 * Two things close that window, and BOTH are durable server state:
 *
 *   a customer reply       they started the interview by typing, so the
 *                          choice is moot.
 *   the Create New marker  Correction A. They pressed the button, and
 *                          `ConversationCapability.beginCreateNewWorkflow`
 *                          recorded it on the assistant turn it wrote
 *                          (`CREATE_NEW_WORKFLOW`).
 *
 * The marker is what makes the choice survive a reload. Before Correction A
 * the button posted a synthetic customer sentence, so the customer-reply
 * rule alone was enough to dismiss the card — at the cost of a fake chat
 * bubble that also reached the Design Brief. With the sentence gone, a
 * Create New project has NO customer turn until the product question is
 * answered, and reading only that rule would re-offer the card on every
 * reload as though the click had never happened.
 *
 * Still never a client enum: if the transition failed, no marker was
 * written, and the choice is correctly offered again.
 *
 * Lives here rather than inline in `ChatApp` so the rule the card depends on
 * is something tests can assert directly, in a repo whose test tooling has
 * no DOM to click with.
 */
export function isAtProjectStart(input: {
  messages: readonly { role: string; metadata?: Record<string, unknown> }[];
  artworkVersionCount: number;
}): boolean {
  if (input.artworkVersionCount > 0) return false;
  if (input.messages.some((message) => message.role === "user")) return false;
  return !createNewWorkflowChosen({
    messages: input.messages.map((message) => ({
      metadata: message.metadata ?? {},
    })),
  });
}

/**
 * Phase 16: complex-background → operator separation routing.
 *
 * `review_analysis` is reached for EVERY unprepared classification, not just
 * `NEEDS_REVIEW` (an artwork with a "Remove the Background" button still on
 * offer passes through here too, on its way to clicking it). Speculatively
 * mounting `SeparationReviewPanel` for those would add a pointless
 * round trip and could show an empty/loading panel underneath a still-
 * actionable prepare button. `NEEDS_REVIEW` (`customer.canPrepare === false`,
 * `customer.prepareActionLabel === null`) is the ONE classification that
 * previously reached this step with no action offered at all — reusing it as
 * the gate keeps this change scoped to exactly the artwork that was
 * genuinely stuck, and changes nothing for every other classification.
 */
export function needsAutomaticBackgroundReview(
  classification: ArtworkPreparationView["classification"],
): boolean {
  return classification === "NEEDS_REVIEW";
}

/**
 * Whether the automatic-preparation dead-end should be replaced by the
 * operator-assisted separation workspace, given what `SeparationReviewPanel`
 * itself has reported back (`onStateChange`) from its own, server-gated
 * fetch.
 *
 * Deliberately narrow: only the three states that mean "there is a real,
 * presentable review" route the operator in. `review_not_required` (zero
 * consequential regions — including a public/prospect project's 404, which
 * surfaces identically as `view: null`) and `cannot_safely_automate` (a
 * decision set that cannot be safely carried forward) both mean the
 * separation capability itself is saying operator review is not the right
 * continuation, so the existing conservative terminal state stands exactly
 * as it did before this phase — never invented past what the capability
 * actually proved. Phase 28G's `"checking"` (the fetch has not resolved
 * yet) and `"error"` (it resolved but failed outright) fall through the
 * same way `null` always did: neither is one of the three enumerated
 * states, so neither routes the operator in until the answer is actually
 * known — this function was never the place `CompareStep`'s own fail-
 * closed loading state lives (see that component instead).
 */
export function isRoutedToOperatorSeparationReview(
  classification: ArtworkPreparationView["classification"],
  separationState: SeparationCheckStatus | null,
): boolean {
  return (
    needsAutomaticBackgroundReview(classification) &&
    (separationState === "review_required" ||
      separationState === "review_in_progress" ||
      separationState === "review_complete")
  );
}

/**
 * The step to render, or `null` when the uploaded-artwork surface should not
 * appear at all — which is every existing Create New Artwork project, so the
 * existing flow is untouched by construction.
 */
export function deriveUploadedArtworkStep(
  input: UploadedArtworkFlowInput,
): UploadedArtworkStep | null {
  const { preparation, signArtwork } = input;

  if (!preparation) {
    if (input.choice === "upload_existing") return "upload";
    if (input.choice === "undecided" && input.atProjectStart) {
      return "choose_workflow";
    }
    return null;
  }

  if (preparation.approved) return "approved";
  if (preparation.hasPreparedArtwork) return "compare";

  // LIVE PRODUCT BLOCKER #1: a `SignPreparation` existing is the Sign
  // path's own durable signal, exactly like `printPlacement` is the DTF
  // path's — checked FIRST and independent of the transient
  // `artworkTypeChoice`, so a reload after the bridge has run never
  // re-asks "what are we printing" for a job already identified as a sign.
  if (signArtwork) {
    if (!signArtwork.specConfirmed) return "confirm_sign_size";
    if (!signArtwork.hasPlan) return "sign_context_saved";
    // LIVE PRODUCT BLOCKER #4: once the customer has authorized THIS exact
    // plan, stop re-offering the same "prepare artwork" action — durable,
    // never re-derived from a transient client flag (a re-plan changes
    // `planKey`, which makes `matchesCurrentPlan` false again on its own).
    return signArtwork.authorization.matchesCurrentPlan
      ? "sign_plan_authorized"
      : "sign_plan_review";
  }

  // Print location is what makes a print-size statement possible at all —
  // without it, the analysis has nothing honest to say about whether the
  // artwork is big enough (`preparation-copy.ts` stays silent rather than
  // guessing a placement). Before either durable signal exists, the
  // transient artwork-type choice decides which question comes next; no
  // choice yet means the routing question itself is the next step.
  if (!preparation.printPlacement) {
    if (input.artworkTypeChoice === "dtf") return "confirm_details";
    if (input.artworkTypeChoice === "sign") return "confirm_sign_size";
    return "choose_artwork_type";
  }
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
