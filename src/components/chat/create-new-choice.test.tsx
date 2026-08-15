/**
 * Existing Artwork → Print Ready Phase 1, Create New correction.
 *
 * The live defect this pins down: clicking "Create New Artwork" dismissed
 * the card and did nothing else. The composer and the opening question were
 * ALREADY mounted and enabled before the click — `uploadedArtworkOwnsSurface`
 * is false for `choose_workflow` — so a client-only dismiss changed nothing
 * the customer could see, while typing the same intent worked normally.
 *
 * Every assertion below runs the real product functions the component
 * renders from, and the real card component, rather than restating the rule
 * in the test. This repo's tooling is `node:test` + `renderToString` with no
 * DOM, so the click itself cannot be dispatched here; what is pinned instead
 * is the mechanism that click relies on — that the card is dismissed by a
 * customer reply existing, and that the reply is a real conversation turn.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

import { deriveChatAffordances } from "./chat-affordances";
import { CREATE_NEW_ARTWORK_INTENT } from "./create-new-intent";
import {
  deriveUploadedArtworkStep,
  isAtProjectStart,
  uploadedArtworkOwnsSurface,
} from "./uploaded-artwork-flow";
import { WorkflowChoiceCard } from "./WorkflowChoiceCard";

/** The transcript a freshly created project comes back with. */
const openingTranscript = [
  { role: "assistant", content: "What are we printing today?" },
] as const;

/**
 * The transcript immediately after the button submits the intent — the
 * optimistic user turn `ChatApp.sendMessage` appends, then the interview's
 * reply from the refreshed snapshot.
 */
const afterCreateNewTranscript = [
  { role: "assistant", content: "What are we printing today?" },
  { role: "user", content: CREATE_NEW_ARTWORK_INTENT },
  { role: "assistant", content: "Great — what garment are we printing on?" },
] as const;

function affordances(overrides: { busy?: boolean } = {}) {
  return deriveChatAffordances({
    phase: "interviewing",
    ready: true,
    busy: overrides.busy ?? false,
    selectedArtworkVersionId: null,
    revisionPending: false,
    finalDirectionConfirmed: false,
    conceptsNeedUpdate: false,
    finalizationRequested: false,
    finalizationStatus: "not_requested",
    acquisitionUnavailable: false,
  });
}

describe("Create New Artwork choice", () => {
  it("offers the choice on a fresh project, with the composer already live", () => {
    const atStart = isAtProjectStart({
      messages: openingTranscript,
      artworkVersionCount: 0,
    });
    assert.equal(atStart, true);

    const step = deriveUploadedArtworkStep({
      preparation: null,
      choice: "undecided",
      atProjectStart: atStart,
    });
    assert.equal(step, "choose_workflow");

    // The heart of the misdiagnosis: the choice card never owned the
    // surface, so the composer was mounted and enabled BEFORE the click.
    // Any future fix that tries to "reveal" the composer is fixing a
    // problem that does not exist.
    assert.equal(uploadedArtworkOwnsSurface(step), false);
    assert.equal(affordances().composerDisabled, false);
    assert.equal(affordances().hideComposer, false);
  });

  it("renders both options as real buttons customers can press", () => {
    const html = renderToString(
      createElement(WorkflowChoiceCard, {
        busy: false,
        onCreateNew: () => {},
        onUploadExisting: () => {},
      }),
    );

    assert.match(html, /Create New Artwork/);
    assert.match(html, /Upload Existing Artwork/);
    // `disabled=""` is the rendered attribute. Matching bare /disabled/
    // would hit the `disabled:cursor-not-allowed` Tailwind class and pass
    // no matter what the button actually does.
    assert.doesNotMatch(html, /disabled=""/);
  });

  it("submits an intent the messages route will accept", () => {
    // `POST /api/projects/:id/messages` validates `content` as a trimmed
    // string of 1..4000 characters. A blank or oversized intent would make
    // the button fail with a 400 and look exactly like the original bug.
    assert.equal(typeof CREATE_NEW_ARTWORK_INTENT, "string");
    assert.equal(CREATE_NEW_ARTWORK_INTENT.trim(), CREATE_NEW_ARTWORK_INTENT);
    assert.ok(CREATE_NEW_ARTWORK_INTENT.length >= 1);
    assert.ok(CREATE_NEW_ARTWORK_INTENT.length <= 4000);
  });

  it("dismisses the card because the conversation moved, not because the client hid it", () => {
    // This is the regression that matters. The card must stop rendering as
    // a CONSEQUENCE of a customer turn existing in the transcript. A
    // client-only dismiss produces the live bug: card gone, nothing said.
    const atStart = isAtProjectStart({
      messages: afterCreateNewTranscript,
      artworkVersionCount: 0,
    });
    assert.equal(atStart, false);

    const step = deriveUploadedArtworkStep({
      preparation: null,
      choice: "undecided",
      atProjectStart: atStart,
    });
    assert.equal(step, null);

    // ...and the card is still offered while the transcript has no customer
    // turn, however the client enum happens to be set. This is the guard
    // against reverting to a client-only dismiss: the old `create_new`
    // choice value could hide the card with nothing sent, which is exactly
    // what made the button look broken.
    assert.equal(
      deriveUploadedArtworkStep({
        preparation: null,
        choice: "undecided",
        atProjectStart: isAtProjectStart({
          messages: openingTranscript,
          artworkVersionCount: 0,
        }),
      }),
      "choose_workflow",
    );
  });

  it("keeps the interview usable and the project intact after the choice", () => {
    const step = deriveUploadedArtworkStep({
      preparation: null,
      choice: "undecided",
      atProjectStart: false,
    });

    assert.equal(uploadedArtworkOwnsSurface(step), false);
    assert.equal(affordances().composerDisabled, false);
    assert.equal(affordances().hideComposer, false);

    // Create New never produces a preparation record, so it can never take
    // the uploaded-artwork branch no matter how far the interview runs.
    assert.equal(
      deriveUploadedArtworkStep({
        preparation: null,
        choice: "undecided",
        atProjectStart: false,
      }),
      null,
    );
  });

  it("disables both options while the intent is in flight", () => {
    // `busy={sending}` — without this the customer can submit the intent
    // twice before the first reply lands.
    const html = renderToString(
      createElement(WorkflowChoiceCard, {
        busy: true,
        onCreateNew: () => {},
        onUploadExisting: () => {},
      }),
    );

    assert.equal(html.match(/disabled=""/g)?.length, 2);
    assert.equal(affordances({ busy: true }).composerDisabled, true);
  });

  it("leaves Upload Existing Artwork on its own authoritative path", () => {
    // Unchanged by this correction: the other button is still a client step
    // until a file exists, after which the preparation record IS the
    // workflow identity.
    assert.equal(
      deriveUploadedArtworkStep({
        preparation: null,
        choice: "upload_existing",
        atProjectStart: true,
      }),
      "upload",
    );

    // And it still takes over the surface, hiding the creative flow.
    assert.equal(uploadedArtworkOwnsSurface("upload"), true);
  });
});
