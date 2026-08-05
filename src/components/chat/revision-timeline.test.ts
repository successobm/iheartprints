import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildRevisionTimeline } from "./revision-timeline";
import type { ConversationMessage } from "@/lib/domain/types";

function message(overrides: Partial<ConversationMessage> = {}): ConversationMessage {
  return {
    id: `m-${Math.random()}`,
    conversationId: "c1",
    projectId: "p1",
    role: "assistant",
    content: "...",
    metadata: {},
    createdAt: "2026-08-04T00:00:00.000Z",
    ...overrides,
  };
}

describe("buildRevisionTimeline", () => {
  it("always starts with 'Original Design', even with no messages", () => {
    const entries = buildRevisionTimeline([]);
    assert.deepEqual(
      entries.map((e) => e.label),
      ["Original Design"],
    );
  });

  it("ignores user messages and messages with no relevant metadata", () => {
    const entries = buildRevisionTimeline([
      message({ role: "user", content: "hi" }),
      message({ role: "assistant", metadata: { phase: "interviewing" } }),
    ]);
    assert.deepEqual(
      entries.map((e) => e.label),
      ["Original Design"],
    );
  });

  it("adds a 'Changed <Field>' entry for a single updated section, in order", () => {
    const entries = buildRevisionTimeline([
      message({ metadata: { updatedSections: ["productColor"] } }),
      message({ metadata: { updatedSections: ["requiredWording"] } }),
    ]);
    assert.deepEqual(
      entries.map((e) => e.label),
      ["Original Design", "Changed Product Color", "Changed Wording"],
    );
  });

  it("combines multiple sections updated in one turn into a single entry", () => {
    const entries = buildRevisionTimeline([
      message({ metadata: { updatedSections: ["productColor", "style"] } }),
    ]);
    assert.equal(entries.length, 2);
    assert.match(entries[1]!.label, /Product Color/);
    assert.match(entries[1]!.label, /Style/);
  });

  it("labels the first concepts_ready message 'Generated Concepts' and later ones 'Revised Concepts'", () => {
    const entries = buildRevisionTimeline([
      message({ metadata: { phase: "concepts_ready" } }),
      message({ metadata: { updatedSections: ["productColor"] } }),
      message({ metadata: { phase: "concepts_ready" } }),
    ]);
    assert.deepEqual(
      entries.map((e) => e.label),
      ["Original Design", "Generated Concepts", "Changed Product Color", "Revised Concepts"],
    );
  });

  it("adds an 'Undid Last Change' entry when a message is flagged as an undo", () => {
    const entries = buildRevisionTimeline([
      message({ metadata: { updatedSections: ["style"] } }),
      message({ content: "Done — I've undone the change to the style.", metadata: { undone: true } }),
    ]);
    assert.deepEqual(
      entries.map((e) => e.label),
      ["Original Design", "Changed Style", "Undid Last Change"],
    );
  });

  it("never exposes raw section keys or message IDs in a label", () => {
    const entries = buildRevisionTimeline([
      message({ metadata: { updatedSections: ["printLocation"] } }),
    ]);
    for (const entry of entries) {
      assert.doesNotMatch(entry.label, /printLocation|requiredWording|productColor/);
    }
  });
});
