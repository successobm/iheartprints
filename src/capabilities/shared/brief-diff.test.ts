import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { TShirtDesignBrief } from "@/lib/domain/types";

import { diffBriefSections, diffEstablishedBriefSections } from "./brief-diff";

/**
 * Live Acceptance Cleanup — the UPDATED badge.
 *
 * Live failure: during the initial interview, answering "Print Location"
 * for the FIRST time rendered `Full Front UPDATED` in the Design Summary.
 * Every field starts empty, so the first answer to every question read as an
 * update to a value that had never existed — which makes the badge
 * meaningless. "UPDATED" must mean "different from what you told me before".
 */

function brief(overrides: Partial<TShirtDesignBrief> = {}): TShirtDesignBrief {
  return {
    id: "brief-1",
    projectId: "project-1",
    customerName: null,
    projectName: null,
    productSummary: null,
    designDescription: null,
    exactText: null,
    shirtColor: null,
    printPlacement: null,
    intendedPrintWidthIn: null,
    preferredColors: [],
    designStyle: null,
    additionalInstructions: null,
    audience: null,
    purpose: null,
    exclusions: null,
    deferredSections: [],
    createdAt: "2026-08-09T00:00:00.000Z",
    updatedAt: "2026-08-09T00:00:00.000Z",
    ...overrides,
  };
}

describe("diffEstablishedBriefSections — what the customer CHANGED", () => {
  it("23: a first-time print placement answer is not marked UPDATED", () => {
    const before = brief({ printPlacement: null });
    const answered = brief({ printPlacement: "full_front" });

    // Revision Intelligence still sees a real change — a first answer
    // genuinely warrants re-evaluation and staleness analysis.
    assert.deepEqual(diffBriefSections(before, answered), ["printLocation"]);
    // The Design Summary badge does not.
    assert.deepEqual(diffEstablishedBriefSections(before, answered), []);
  });

  it("24: changing print placement later IS marked UPDATED", () => {
    const established = brief({ printPlacement: "full_front" });
    const changed = brief({ printPlacement: "full_back" });

    assert.deepEqual(diffEstablishedBriefSections(established, changed), [
      "printLocation",
    ]);
  });

  it("no newly resolved field is marked UPDATED, whatever it is", () => {
    const empty = brief();
    const filled = brief({
      productSummary: "a crewneck t-shirt",
      designDescription: "bowling pins and a ball",
      shirtColor: "Black",
      exactText: "MY 3 SONS",
      preferredColors: ["Red"],
      designStyle: "retro badge",
      printPlacement: "full_front",
      audience: "our team",
      purpose: "league night",
      exclusions: "no flames",
      additionalInstructions: "keep it simple",
    });

    assert.ok(
      diffBriefSections(empty, filled).length >= 10,
      "the brief really did change a lot",
    );
    assert.deepEqual(
      diffEstablishedBriefSections(empty, filled),
      [],
      "populating a field for the first time is never an update",
    );
  });

  it("every genuinely changed established field IS marked UPDATED", () => {
    const established = brief({
      productSummary: "a crewneck t-shirt",
      shirtColor: "Black",
      exactText: "MY 3 SONS",
      preferredColors: ["Red"],
      printPlacement: "full_front",
    });
    const changed = brief({
      productSummary: "a hoodie",
      shirtColor: "Navy",
      exactText: "MY THREE SONS",
      preferredColors: ["Blue"],
      printPlacement: "full_back",
    });

    assert.deepEqual(diffEstablishedBriefSections(established, changed).sort(), [
      "colors",
      "printLocation",
      "product",
      "productColor",
      "requiredWording",
    ]);
  });

  it("clearing an established field is a change, not a first-time answer", () => {
    const established = brief({ shirtColor: "Black" });
    const cleared = brief({ shirtColor: null });

    assert.deepEqual(diffEstablishedBriefSections(established, cleared), [
      "productColor",
    ]);
  });

  it("a whitespace-only prior value counts as never established", () => {
    const blank = brief({ designStyle: "   " });
    const answered = brief({ designStyle: "retro badge" });

    assert.deepEqual(diffEstablishedBriefSections(blank, answered), []);
  });

  it("deferring a section the customer had already answered is an update", () => {
    const answered = brief({ designStyle: "retro badge" });
    const deferred = brief({
      designStyle: "retro badge",
      deferredSections: ["style"],
    });

    assert.deepEqual(diffEstablishedBriefSections(answered, deferred), ["style"]);
  });

  it("deferring a section that was never answered is a first-time decision", () => {
    const empty = brief();
    const deferred = brief({ deferredSections: ["style"] });

    assert.deepEqual(diffBriefSections(empty, deferred), ["style"]);
    assert.deepEqual(diffEstablishedBriefSections(empty, deferred), []);
  });
});
