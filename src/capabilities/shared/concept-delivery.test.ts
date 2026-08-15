import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type {
  ArtworkKind,
  ArtworkVersion,
  ConversationMessage,
  ProjectStatus,
} from "@/lib/domain/types";

import {
  GENERATED_CONCEPT_KINDS,
  hasDeliveredGeneratedConcept,
  isGeneratedConcept,
} from "./concept-delivery";

/**
 * Sprint A4 Correction C — the pure half of "the free concept has been
 * delivered". The wired half (this condition feeding the acquisition state
 * machine) is proved in
 * `capabilities/acquisition/acquisition-concept-delivery.test.ts`.
 */

function artwork(kind: ArtworkKind, versionNumber = 1): ArtworkVersion {
  return {
    id: `artwork-${kind}-${versionNumber}`,
    projectId: "project-1",
    versionNumber,
    kind,
    title: "Concept",
    summary: "Concept",
    placeholderLabel: "A",
    accentColor: "#123456",
    isSelected: false,
    sourceArtworkVersionId: null,
    conceptDirectionKey: null,
    designBriefVersionId: "version-1",
    generationJobId: "job-1",
    providerKey: "local",
    primaryAssetId: null,
    thumbnailAssetId: null,
    customerRating: null,
    evaluationStatus: null,
    evaluation: null,
    evaluationEvaluatedAt: null,
    evaluationProviderKey: null,
    printValidationStatus: null,
    createdAt: "2026-08-15T00:00:00.000Z",
  };
}

function message(phase: string | null): ConversationMessage {
  return {
    id: `message-${phase ?? "none"}`,
    conversationId: "conversation-1",
    projectId: "project-1",
    role: "assistant",
    content: "…",
    metadata: phase === null ? {} : { phase },
    createdAt: "2026-08-15T00:00:00.000Z",
  };
}

const ANCHOR = [message("concepts_ready")];

function delivered(
  status: ProjectStatus,
  artworkVersions: ArtworkVersion[],
  messages: ConversationMessage[] = ANCHOR,
): boolean {
  return hasDeliveredGeneratedConcept({ status, artworkVersions, messages });
}

describe("Sprint A4 Correction C — what counts as a delivered free concept", () => {
  it("counts the kinds concept generation produces, and only those", () => {
    assert.deepEqual([...GENERATED_CONCEPT_KINDS], ["concept", "revision"]);
    assert.equal(isGeneratedConcept(artwork("concept")), true);
    assert.equal(isGeneratedConcept(artwork("revision")), true);
    assert.equal(isGeneratedConcept(artwork("prepared_upload")), false);
  });

  it("a generated concept, announced, on a settled project is delivered", () => {
    assert.equal(delivered("concepts_ready", [artwork("concept")]), true);
  });

  /* Matrix F / the live bug: rows exist before the project leaves generating. */
  it("is NOT delivered while the project is still generating, even with rows", () => {
    assert.equal(delivered("generating", [artwork("concept")]), false);
  });

  /* Matrix D + E: a prepared upload is the customer's own artwork. */
  it("is NOT delivered when the only artwork is a prepared upload", () => {
    assert.equal(delivered("concepts_ready", [artwork("prepared_upload")]), false);
    assert.equal(delivered("approved", [artwork("prepared_upload")]), false);
  });

  it("a prepared upload alongside a generated concept still delivers", () => {
    assert.equal(
      delivered("concepts_ready", [artwork("prepared_upload", 1), artwork("concept", 2)]),
      true,
    );
  });

  it("is NOT delivered before the concepts_ready anchor message is written", () => {
    // The real window: status has already flipped, the anchor message is the
    // last write of the sequence and has not landed yet.
    assert.equal(delivered("concepts_ready", [artwork("concept")], []), false);
    assert.equal(
      delivered("concepts_ready", [artwork("concept")], [message("generating")]),
      false,
    );
  });

  it("is NOT delivered with no artwork at all", () => {
    assert.equal(delivered("concepts_ready", []), false);
    assert.equal(delivered("failed", [], [message("generating")]), false);
  });

  it("stays delivered once the customer moves the project on", () => {
    // Continuing to work must never un-deliver a concept the customer has
    // already seen — this is why the rule is not `status === "concepts_ready"`.
    for (const status of [
      "revision_requested",
      "approved",
      "finalizing",
      "finalization_required",
      "print_ready",
    ] as ProjectStatus[]) {
      assert.equal(delivered(status, [artwork("concept")]), true, status);
    }
  });

  it("a revision-only project (regeneration history) still counts as delivered", () => {
    assert.equal(delivered("concepts_ready", [artwork("revision")]), true);
  });
});
