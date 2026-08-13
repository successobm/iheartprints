/**
 * Live Acceptance UX Pass: the customer-facing "what can I do right now"
 * rules, as a pure function of already-persisted state.
 *
 * These lived inline in `ChatApp` as three boolean chains, which made the
 * post-revision dead-end ("revised concept shown, but the composer is
 * greyed out and Use This Design never appears") invisible to every
 * automated test — the only way to observe it was to run the app. Pulling
 * them out changes no behavior; it just makes the state → affordance
 * mapping something tests can assert directly.
 */

import type { ConversationPhase } from "@/lib/domain/types";
import {
  isChatBlockedPhase,
  isRevisionLoopPhase,
} from "@/capabilities/shared/chat-input-policy";
import type { CustomerFinalizationStatus } from "@/lib/services/conversation-service";

export interface ChatAffordanceInput {
  /** `undefined` before the first snapshot has loaded. */
  phase: ConversationPhase | undefined;
  /** `isClient && !loading && snapshot !== null` — anything less is "not ready yet". */
  ready: boolean;
  /** A request this UI started is still in flight. */
  busy: boolean;
  selectedArtworkVersionId: string | null;
  revisionPending: boolean;
  finalDirectionConfirmed: boolean;
  conceptsNeedUpdate: boolean;
  finalizationRequested: boolean;
  /** Customer-safe finalization status from the snapshot. */
  finalizationStatus?: CustomerFinalizationStatus;
  /**
   * Client-only: the customer clicked "Make Another Change" after reaching
   * print-ready. Does not mutate server state by itself — revision
   * supersession still happens only when they submit a real change.
   */
  deliveryEditingReopened?: boolean;
}

export interface ChatAffordances {
  /** The composer is greyed out and refuses input. */
  composerDisabled: boolean;
  /** Hide the composer entirely (delivery mode). */
  hideComposer: boolean;
  /** "Use This Design" — the explicit end of the revision loop. */
  showUseThisDesign: boolean;
  /** "Prepare Print-Ready Artwork" is actionable, not merely visible. */
  canRequestFinalArtwork: boolean;
  /** Artwork surfaces (concept grid, status banner, finalize card) are meaningful. */
  showArtworkSurfaces: boolean;
  /** Primary delivery card for print-ready production artwork. */
  showDeliveryCard: boolean;
  /**
   * Live Acceptance Cleanup (Issue 2): "Change Selection" is offered. A
   * concept is selected and nothing that owns that selection is currently
   * running — the server refuses in exactly the same situations
   * (`ConversationCapability.unselectConcept`), so this only mirrors it.
   */
  showChangeSelection: boolean;
  /**
   * Live Acceptance Cleanup (Issue 3): "Show Me 3 New Concepts" is offered —
   * the middle option between picking one of these and Start Over. Shown
   * whenever concepts are visible and nothing is generating, including when
   * one is already selected (changing your mind about the whole batch is
   * exactly the case this exists for).
   */
  showExploreNewConcepts: boolean;
}

export function deriveChatAffordances(
  input: ChatAffordanceInput,
): ChatAffordances {
  const { phase } = input;
  const finalizationStatus = input.finalizationStatus ?? "not_requested";
  const deliveryEditingReopened = input.deliveryEditingReopened === true;
  const inDeliveryMode =
    finalizationStatus === "print_ready" && !deliveryEditingReopened;

  const composerDisabled =
    !input.ready ||
    input.busy ||
    phase === undefined ||
    isChatBlockedPhase(phase) ||
    inDeliveryMode;

  const inRevisionLoop = phase !== undefined && isRevisionLoopPhase(phase);
  const showArtworkSurfaces =
    input.ready &&
    !inDeliveryMode &&
    (inRevisionLoop || phase === "concepts_ready");

  // A concept is selected and stable (no revision pending) but not yet
  // explicitly confirmed — selection is never, by itself, approval.
  const showUseThisDesign =
    input.ready &&
    !inDeliveryMode &&
    inRevisionLoop &&
    input.selectedArtworkVersionId !== null &&
    !input.revisionPending &&
    !input.finalDirectionConfirmed &&
    !input.conceptsNeedUpdate;

  // Mutually exclusive with the above by construction: preparing print-
  // ready artwork requires the confirmation that hides Use This Design.
  // `FinalArtworkCapability` independently enforces every one of these
  // server-side; this is only the customer-facing reflection of it.
  const canRequestFinalArtwork =
    input.ready &&
    !inDeliveryMode &&
    input.selectedArtworkVersionId !== null &&
    !input.conceptsNeedUpdate &&
    !input.finalizationRequested &&
    !input.revisionPending &&
    input.finalDirectionConfirmed;

  // Live Acceptance Cleanup (Issue 2/3). Both gate on the same thing:
  // artwork surfaces are visible and no generation or finalization owns the
  // project right now. `generating` is covered by `showArtworkSurfaces`
  // (the phase leaves the revision loop), and both `finalizing` and
  // `print_ready` are covered by `finalizationRequested`/`inDeliveryMode`.
  const finalizationInProgress =
    finalizationStatus === "preparing" ||
    finalizationStatus === "retryable_failure" ||
    finalizationStatus === "print_ready";

  const showChangeSelection =
    showArtworkSurfaces &&
    input.selectedArtworkVersionId !== null &&
    !input.revisionPending &&
    !finalizationInProgress;

  const showExploreNewConcepts =
    showArtworkSurfaces && !input.revisionPending && !finalizationInProgress;

  return {
    composerDisabled,
    hideComposer: inDeliveryMode,
    showUseThisDesign,
    canRequestFinalArtwork,
    showArtworkSurfaces,
    showDeliveryCard: input.ready && inDeliveryMode,
    showChangeSelection,
    showExploreNewConcepts,
  };
}
