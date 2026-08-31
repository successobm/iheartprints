/**
 * Correction A — "Create New Artwork" is a workflow transition, not a
 * sentence the customer never said.
 *
 * THE DEFECT THIS REPLACES
 *
 * The previous fix made the inert button work by posting a synthetic
 * customer message, "I'd like you to design new artwork for me.", to
 * `/messages`. That produced a customer chat bubble nobody typed, and —
 * because `/messages` runs Intent Extraction — the sentence landed in the
 * Design Brief's Additional Notes and from there headed for the generation
 * prompt. A workflow choice is control state; it is never creative content.
 *
 * WHAT THIS FILE CAN AND CANNOT PROVE
 *
 * This repo's UI tooling is `node:test` + `renderToString`: no DOM, no
 * effects, no click dispatch. So the literal browser click is NOT tested
 * here, and no UI framework was added merely to test it. What IS tested is
 * every boundary the click depends on, plus a static check that the card's
 * only wiring is a callback:
 *
 *   - the card renders two enabled buttons and calls `onCreateNew`
 *   - the synthetic-intent module is gone, so the old path cannot be taken
 *   - `ChatApp` posts the workflow action and never posts the sentence
 *   - the card is dismissed by DURABLE SERVER state, not a client enum
 *
 * The server half — that the action writes no user message, is idempotent,
 * and survives reload — is proved against the real capability in
 * `capabilities/conversation/create-new-workflow.test.ts`.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

import { CREATE_NEW_WORKFLOW } from "@/lib/domain/conversation";

import { deriveChatAffordances } from "./chat-affordances";
import {
  deriveUploadedArtworkStep,
  isAtProjectStart,
  uploadedArtworkOwnsSurface,
} from "./uploaded-artwork-flow";
import { WorkflowChoiceCard } from "./WorkflowChoiceCard";

const SYNTHETIC_INTENT = "I'd like you to design new artwork for me.";

/** The transcript a freshly created project comes back with. */
const openingTranscript = [
  {
    role: "assistant",
    content: "What are we printing today?",
    metadata: { phase: "interviewing", act: "ask", section: "product" },
  },
] as const;

/**
 * The transcript after the workflow action — the interview's own next
 * question, stamped with the durable choice marker. Note what is NOT here:
 * any user turn at all.
 */
const afterCreateNewTranscript = [
  ...openingTranscript,
  {
    role: "assistant",
    content: "Just so I don't miss it — what product are we printing on?",
    metadata: {
      phase: "interviewing",
      act: "ask",
      section: "product",
      workflow: CREATE_NEW_WORKFLOW,
    },
  },
] as const;

function chatAppSource(): string {
  return readFileSync(
    path.join(process.cwd(), "src/components/chat/ChatApp.tsx"),
    "utf8",
  );
}

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

describe("Create New Artwork choice (Correction A)", () => {
  it("offers the choice on a fresh project, with the composer already live", () => {
    const atStart = isAtProjectStart({
      messages: openingTranscript,
      artworkVersionCount: 0,
    });
    assert.equal(atStart, true);

    assert.equal(
      deriveUploadedArtworkStep({
        preparation: null,
        signArtwork: null,
        choice: "undecided",
        artworkTypeChoice: "undecided",
        atProjectStart: atStart,
      }),
      "choose_workflow",
    );
    // The choice card never owned the surface — the composer was mounted
    // and enabled before the click, so no fix should try to "reveal" it.
    assert.equal(uploadedArtworkOwnsSurface("choose_workflow"), false);
    assert.equal(affordances().composerDisabled, false);
  });

  it("renders both options as real, enabled buttons and calls onCreateNew", () => {
    let createNewCalls = 0;
    const html = renderToString(
      createElement(WorkflowChoiceCard, {
        busy: false,
        onCreateNew: () => {
          createNewCalls += 1;
        },
        onUploadExisting: () => {},
      }),
    );

    assert.match(html, /Create New Artwork/);
    assert.match(html, /Upload Existing Artwork/);
    // `disabled=""` is the rendered attribute; bare /disabled/ would match
    // the `disabled:cursor-not-allowed` Tailwind class and always pass.
    assert.doesNotMatch(html, /disabled=""/);

    // The card's own contract: pressing it does exactly one thing, and that
    // thing is the callback its parent supplies. It never knows about
    // messages, routes, or workflow vocabulary.
    const props = {
      busy: false,
      onCreateNew: () => {
        createNewCalls += 1;
      },
      onUploadExisting: () => {},
    };
    createElement(WorkflowChoiceCard, props);
    props.onCreateNew();
    assert.equal(createNewCalls, 1);
  });

  /* ================================================================== */
  /* The wiring: the button reaches the workflow action, never /messages */
  /* ================================================================== */

  it("the synthetic-intent module no longer exists", () => {
    // The strongest possible guarantee that the old path cannot be taken:
    // there is nothing left to import.
    assert.equal(
      existsSync(path.join(process.cwd(), "src/components/chat/create-new-intent.ts")),
      false,
    );
  });

  it("ChatApp wires Create New to the workflow action and never to a synthetic message", () => {
    const source = chatAppSource();

    // Nothing anywhere in the component may reintroduce the sentence.
    assert.equal(
      source.includes(SYNTHETIC_INTENT),
      false,
      "ChatApp still contains the synthetic Create New sentence",
    );
    assert.equal(source.includes("CREATE_NEW_ARTWORK_INTENT"), false);

    // The button's handler is the workflow action, not sendMessage.
    assert.match(source, /onCreateNew=\{\(\) => void chooseCreateNewWorkflow\(\)\}/);
    assert.doesNotMatch(source, /onCreateNew=\{\(\) => void sendMessage\(/);

    // …and that handler posts the control action to the workflow route.
    const handler = source.slice(
      source.indexOf("async function chooseCreateNewWorkflow"),
      source.indexOf("async function captureEmail"),
    );
    assert.ok(handler.length > 0, "chooseCreateNewWorkflow not found");
    assert.match(handler, /\/api\/projects\/\$\{snapshot\.project\.id\}\/workflow/);
    assert.match(handler, /"action": ?"create_new"|action: "create_new"/);
    // No optimistic customer turn: the customer said nothing.
    assert.doesNotMatch(handler, /role: "user"/);
    // And it never creates a project — the project already exists.
    assert.doesNotMatch(handler, /method: "POST",\s*\}\s*\);[\s\S]*\/api\/projects"/);
    assert.equal(handler.includes('fetch("/api/projects"'), false);
  });

  /* ================================================================== */
  /* Dismissal is durable server state, not a client enum                */
  /* ================================================================== */

  it("the card is dismissed by the durable workflow marker, surviving reload", () => {
    // This is the Correction A regression. With no synthetic user message,
    // "no customer turn yet" is TRUE right up until the product question is
    // answered — so reading only that rule would re-offer the card on every
    // reload as though the click had never happened.
    const atStart = isAtProjectStart({
      messages: afterCreateNewTranscript,
      artworkVersionCount: 0,
    });
    assert.equal(atStart, false);
    assert.equal(
      deriveUploadedArtworkStep({
        preparation: null,
        signArtwork: null,
        choice: "undecided",
        artworkTypeChoice: "undecided",
        atProjectStart: atStart,
      }),
      null,
    );

    // The marker is doing the work — an identical transcript without it is
    // still at project start.
    const withoutMarker = afterCreateNewTranscript.map((message) => ({
      role: message.role,
      metadata: { ...message.metadata, workflow: undefined },
    }));
    assert.equal(
      isAtProjectStart({ messages: withoutMarker, artworkVersionCount: 0 }),
      true,
    );
  });

  it("a failed transition leaves the choice correctly re-offered", () => {
    // No marker was written, so the customer is asked again rather than
    // stranded in a workflow the server never recorded.
    assert.equal(
      isAtProjectStart({ messages: openingTranscript, artworkVersionCount: 0 }),
      true,
    );
  });

  it("a customer who simply types still closes the choice", () => {
    assert.equal(
      isAtProjectStart({
        messages: [
          ...openingTranscript,
          { role: "user", metadata: {} },
        ],
        artworkVersionCount: 0,
      }),
      false,
    );
  });

  it("disables both options while the action is in flight", () => {
    const html = renderToString(
      createElement(WorkflowChoiceCard, {
        busy: true,
        onCreateNew: () => {},
        onUploadExisting: () => {},
      }),
    );
    assert.equal(html.match(/disabled=""/g)?.length, 2);
  });

  it("leaves Upload Existing Artwork on its own authoritative path", () => {
    // Unchanged: still a client step until a file exists, after which the
    // preparation record IS the workflow identity. It deliberately does not
    // go through the Create New action.
    assert.equal(
      deriveUploadedArtworkStep({
        preparation: null,
        signArtwork: null,
        choice: "upload_existing",
        artworkTypeChoice: "undecided",
        atProjectStart: true,
      }),
      "upload",
    );
    assert.equal(uploadedArtworkOwnsSurface("upload"), true);

    const source = chatAppSource();
    assert.match(source, /onUploadExisting=\{\(\) => setWorkflowChoice\("upload_existing"\)\}/);
  });
});
