import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CHAT_BLOCKED_PHASES } from "@/capabilities/shared/chat-input-policy";
import {
  deriveChatAffordances,
  type ChatAffordanceInput,
} from "./chat-affordances";

/**
 * Live Acceptance UX Pass: the customer-visible half of the "chat looks
 * stuck after a revision" failure. The lifecycle-state half lives in
 * `capabilities/conversation/post-revision-chat-state.test.ts`; these two
 * files meet at the phase name, which is why both assert it explicitly.
 */

/** A project sitting on a finished targeted revision, awaiting the customer. */
const AFTER_REVISION: ChatAffordanceInput = {
  phase: "ask_revisions",
  ready: true,
  busy: false,
  selectedArtworkVersionId: "artwork-revised",
  revisionPending: false,
  finalDirectionConfirmed: false,
  conceptsNeedUpdate: false,
  finalizationRequested: false,
};

describe("deriveChatAffordances", () => {
  it("H: after a revision completes, the composer is usable for another change", () => {
    const { composerDisabled } = deriveChatAffordances(AFTER_REVISION);
    assert.equal(composerDisabled, false);
  });

  it("I: after a revision completes, Use This Design is offered", () => {
    const { showUseThisDesign } = deriveChatAffordances(AFTER_REVISION);
    assert.equal(showUseThisDesign, true);
  });

  it("J: Prepare Print-Ready stays unavailable until the direction is explicitly confirmed", () => {
    assert.equal(
      deriveChatAffordances(AFTER_REVISION).canRequestFinalArtwork,
      false,
    );

    const confirmed = deriveChatAffordances({
      ...AFTER_REVISION,
      finalDirectionConfirmed: true,
    });
    assert.equal(confirmed.canRequestFinalArtwork, true);
    // ...and the two actions are never offered at the same time.
    assert.equal(confirmed.showUseThisDesign, false);
  });

  it("J: a revision still pending blocks BOTH confirmation and preparation", () => {
    const pending = deriveChatAffordances({
      ...AFTER_REVISION,
      revisionPending: true,
      finalDirectionConfirmed: true,
    });
    assert.equal(pending.showUseThisDesign, false);
    assert.equal(pending.canRequestFinalArtwork, false);
  });

  it("K: the composer stays disabled while generation is actually running", () => {
    const generating = deriveChatAffordances({
      ...AFTER_REVISION,
      phase: "generating",
    });
    assert.equal(generating.composerDisabled, true);
  });

  it("K: every blocked phase blocks the composer, and the revision loop never does", () => {
    for (const phase of CHAT_BLOCKED_PHASES) {
      assert.equal(
        deriveChatAffordances({ ...AFTER_REVISION, phase }).composerDisabled,
        true,
        `${phase} must block chat`,
      );
    }
    for (const phase of ["ask_revisions", "revision_received"] as const) {
      assert.equal(
        deriveChatAffordances({ ...AFTER_REVISION, phase }).composerDisabled,
        false,
        `${phase} must accept chat`,
      );
    }
  });

  it("blocks the composer before the first snapshot loads, and while a request is in flight", () => {
    assert.equal(
      deriveChatAffordances({ ...AFTER_REVISION, ready: false }).composerDisabled,
      true,
    );
    assert.equal(
      deriveChatAffordances({ ...AFTER_REVISION, phase: undefined }).composerDisabled,
      true,
    );
    assert.equal(
      deriveChatAffordances({ ...AFTER_REVISION, busy: true }).composerDisabled,
      true,
    );
  });

  it("keeps artwork surfaces visible across selection and the whole revision loop", () => {
    for (const phase of ["concepts_ready", "ask_revisions", "revision_received"] as const) {
      assert.equal(
        deriveChatAffordances({ ...AFTER_REVISION, phase }).showArtworkSurfaces,
        true,
      );
    }
    assert.equal(
      deriveChatAffordances({ ...AFTER_REVISION, phase: "interviewing" })
        .showArtworkSurfaces,
      false,
    );
  });

  it("never offers Use This Design for stale concepts or before anything is selected", () => {
    assert.equal(
      deriveChatAffordances({ ...AFTER_REVISION, conceptsNeedUpdate: true })
        .showUseThisDesign,
      false,
    );
    assert.equal(
      deriveChatAffordances({ ...AFTER_REVISION, selectedArtworkVersionId: null })
        .showUseThisDesign,
      false,
    );
  });

  it("retryable_failure keeps artwork surfaces and does not enter delivery mode", () => {
    const failed = deriveChatAffordances({
      ...AFTER_REVISION,
      finalDirectionConfirmed: true,
      finalizationRequested: true,
      finalizationStatus: "retryable_failure",
    });
    assert.equal(failed.showArtworkSurfaces, true);
    assert.equal(failed.showDeliveryCard, false);
    assert.equal(failed.showChangeSelection, false);
    assert.equal(failed.canRequestFinalArtwork, false);
  });

  it("I/J: print_ready delivery mode hides the composer and shows the delivery card", () => {
    const delivery = deriveChatAffordances({
      ...AFTER_REVISION,
      finalDirectionConfirmed: true,
      finalizationRequested: true,
      finalizationStatus: "print_ready",
      deliveryEditingReopened: false,
    });
    assert.equal(delivery.showDeliveryCard, true);
    assert.equal(delivery.hideComposer, true);
    assert.equal(delivery.composerDisabled, true);
    assert.equal(delivery.showArtworkSurfaces, false);
    assert.equal(delivery.showUseThisDesign, false);
    assert.equal(delivery.canRequestFinalArtwork, false);
  });

  it("K: Make Another Change reopens the revision composer without leaving print_ready", () => {
    const reopened = deriveChatAffordances({
      ...AFTER_REVISION,
      finalDirectionConfirmed: true,
      finalizationRequested: true,
      finalizationStatus: "print_ready",
      deliveryEditingReopened: true,
    });
    assert.equal(reopened.showDeliveryCard, false);
    assert.equal(reopened.hideComposer, false);
    assert.equal(reopened.composerDisabled, false);
  });

  it("L: merely being print_ready without reopen does not itself imply a server supersession", () => {
    // Affordance-only: delivery mode is a UI gate. Supersession still requires
    // an explicit revision submit through ConversationCapability.
    const delivery = deriveChatAffordances({
      ...AFTER_REVISION,
      finalizationStatus: "print_ready",
      finalDirectionConfirmed: true,
      finalizationRequested: true,
    });
    assert.equal(delivery.showDeliveryCard, true);
    assert.equal(delivery.hideComposer, true);
  });
});
