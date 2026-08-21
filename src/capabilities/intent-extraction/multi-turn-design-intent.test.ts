import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  classifyDesignDescriptionUpdate,
  mergeDesignDescription,
} from "./design-description-merge";
import { createIntentExtractionCapability } from "./intent-extraction-capability";
import type { ConversationUnderstandingResult } from "@/capabilities/conversation-understanding";
import { analyzeDesignContent } from "@/lib/domain/design-content-contract";
import type { TShirtDesignBrief } from "@/lib/domain/types";

/**
 * Phase 1.1, Part A regressions — multi-turn design intent.
 *
 * These prove the DETERMINISTIC merge contract, which is the only thing an
 * automated test can honestly prove. Every `ConversationUnderstandingResult`
 * below is a hand-written fixture standing in for a provider response; no
 * network call is made and no claim is made about model behavior.
 *
 * The failure being regressed: `designDescription` had assignment semantics,
 * so turn 2 of a live Discovery Bay conversation deleted turn 1's location,
 * waterways, and real-area/aerial intent outright.
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
    garmentSizeClass: null,
    productionSizeConfirmedAt: null,
    productionSizeConfirmedWidthIn: null,
    productionSizeConfirmedMaxHeightIn: null,
    requestedProductionOutput: null,
    preferredColors: [],
    designStyle: null,
    additionalInstructions: null,
    audience: null,
    purpose: null,
    exclusions: null,
    deferredSections: [],
    createdAt: "2026-08-04T00:00:00.000Z",
    updatedAt: "2026-08-04T00:00:00.000Z",
    ...overrides,
  };
}

function graphicsUnderstanding(value: string): ConversationUnderstandingResult {
  return {
    proposedUpdates: [
      {
        section: "graphics",
        value,
        confidence: "explicit",
        evidence: value,
        isCorrection: false,
      },
    ],
    deferrals: [],
    ambiguities: [],
    customerIntent: "provide_info",
    answeredPendingSection: null,
  };
}

/**
 * Drives one customer turn through the real capability — Conversation
 * Understanding reconciliation, deterministic extraction, and the merge —
 * and returns the resulting `designDescription`.
 */
function turn(
  existingDescription: string | null,
  message: string,
  synthesis: string,
): string {
  const result = createIntentExtractionCapability().extract({
    brief: brief({ designDescription: existingDescription }),
    phase: "interviewing",
    reply: message,
    pendingSection: "graphics",
    understanding: graphicsUnderstanding(synthesis),
  });
  return result.proposals[0]?.fields.designDescription ?? "";
}

function assertRetains(description: string, required: string[]): void {
  for (const fragment of required) {
    assert.match(
      description,
      new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"),
      `design description lost "${fragment}": ${description}`,
    );
  }
}

function assertDropped(description: string, forbidden: string[]): void {
  for (const fragment of forbidden) {
    assert.doesNotMatch(
      description,
      new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"),
      `design description still carries superseded "${fragment}": ${description}`,
    );
  }
}

describe("A — a later turn ADDS to the design instead of replacing it", () => {
  it("keeps both turns' content", () => {
    const after = turn(
      "Discovery Bay California lighthouse and waterways",
      "also show homes and boats in the channel",
      "Homes and boats in the channel",
    );
    assertRetains(after, [
      "Discovery Bay",
      "lighthouse",
      "waterways",
      "homes",
      "boats",
      "channel",
    ]);
  });

  it("classifies a plain clarification as an addition", () => {
    assert.equal(
      classifyDesignDescriptionUpdate(
        "also show homes and boats in the channel",
        "Discovery Bay California lighthouse and waterways",
        "Homes and boats in the channel",
      ),
      "add",
    );
  });
});

describe("B — a secondary element is added without disturbing the first", () => {
  it("keeps the lighthouse on the left and the new marina on the right", () => {
    const after = turn(
      "Lighthouse on the left",
      "and add a marina on the right",
      "A marina on the right",
    );
    assertRetains(after, ["lighthouse", "left", "marina", "right"]);

    const statements = analyzeDesignContent(after)
      .compositionStatements.join(" | ")
      .toLowerCase();
    assert.match(statements, /lighthouse[^|]*\bleft\b/);
    assert.match(statements, /marina[^|]*\bright\b/);
  });
});

describe("C — a refinement supersedes only the detail it contradicts", () => {
  it("leaves exactly ONE lighthouse requirement, on the right", () => {
    const after = turn(
      "Lighthouse on the left",
      "move the lighthouse to the right",
      "Lighthouse on the right",
    );
    assertRetains(after, ["lighthouse", "right"]);
    assertDropped(after, ["left"]);
  });

  it("classifies it as a refinement", () => {
    assert.equal(
      classifyDesignDescriptionUpdate(
        "move the lighthouse to the right",
        "Lighthouse on the left",
        "Lighthouse on the right",
      ),
      "refine",
    );
  });

  it("a change on a DIFFERENT attribute does not erase the position", () => {
    // "make the marina smaller" constrains size, not position — dropping
    // "on the right" here would be losing information the customer never
    // withdrew.
    const merged = mergeDesignDescription(
      "Marina on the right",
      "A smaller marina",
      "make the marina smaller",
    );
    assertRetains(merged, ["marina", "right", "smaller"]);
  });
});

describe("D — explicit replacement language supersedes prior content", () => {
  it("drops the lighthouse and keeps the marina scene", () => {
    const after = turn(
      "Lighthouse and waterways",
      "Actually forget the lighthouse; just make it a marina scene",
      "A marina scene",
    );
    assertRetains(after, ["marina"]);
    assertDropped(after, ["lighthouse"]);
  });

  it("classifies it as a replacement", () => {
    assert.equal(
      classifyDesignDescriptionUpdate(
        "Actually forget the lighthouse; just make it a marina scene",
        "Lighthouse and waterways",
        "A marina scene",
      ),
      "replace",
    );
  });

  it("'actually' alone never triggers a replacement", () => {
    assert.equal(
      classifyDesignDescriptionUpdate(
        "actually, also add some homes",
        "Lighthouse and waterways",
        "Homes",
      ),
      "add",
    );
  });
});

describe("E — real-world/aerial intent survives later turns, honestly", () => {
  const existing =
    "Discovery Bay California scene using the actual area layout and an aerial view of the real location";

  it("keeps the real-world request when a later turn adds content", () => {
    const after = turn(
      existing,
      "show the channel to the marina with homes and boats",
      "The channel leading to the marina with homes and boats",
    );
    assertRetains(after, [
      "Discovery Bay",
      "actual area",
      "aerial",
      "marina",
      "homes",
      "boats",
      "channel",
    ]);
    assert.equal(analyzeDesignContent(after).requestsRealWorldReference, true);
  });

  it("never records a claim that a lookup or research actually happened", () => {
    const after = turn(
      existing,
      "show the channel to the marina with homes and boats",
      "The channel leading to the marina with homes and boats",
    );
    // The brief may record what the customer WANTS; it must never assert
    // that iHeartPrints retrieved a map, aerial photo, or web result.
    for (const claim of [
      "looked up",
      "researched",
      "based on satellite",
      "retrieved",
      "we found",
      "according to the map",
    ]) {
      assert.doesNotMatch(after, new RegExp(claim, "i"));
    }
  });
});

describe("F — a simple two-turn design stays concise", () => {
  it("does not accumulate duplicated or padded phrasing", () => {
    const after = turn(
      "A red 1988 Toyota MR2",
      "make it an 80s style",
      "A red 1988 Toyota MR2 in an 80s style",
    );
    assert.equal(after, "A red 1988 Toyota MR2 in an 80s style.");
    // The subject appears exactly once — no "MR2; MR2" accumulation.
    assert.equal(after.toLowerCase().split("mr2").length - 1, 1);
  });

  it("never restates conversational instruction language in the brief", () => {
    const after = turn(
      "A red 1988 Toyota MR2",
      "make it an 80s style",
      "A red 1988 Toyota MR2 in an 80s style",
    );
    assert.doesNotMatch(after, /customer said|make it an 80s style, /i);
  });
});

describe("the merge never invents or loses content on degenerate input", () => {
  it("returns the incoming value when there is no prior description", () => {
    assert.equal(mergeDesignDescription(null, "A red race car", "a red race car"), "A red race car");
  });

  it("returns the existing value when this turn contributes nothing", () => {
    assert.equal(mergeDesignDescription("A red race car", "", "hmm"), "A red race car");
  });
});

describe("the deterministic path accumulates too (no Conversation Understanding provider)", () => {
  it("merges a second turn into the existing description", () => {
    const result = createIntentExtractionCapability().extract({
      brief: brief({ designDescription: "Lighthouse on the left" }),
      phase: "interviewing",
      reply: "also show a design with homes on the right",
      pendingSection: "graphics",
      understanding: null,
    });
    const after = result.proposals[0]?.fields.designDescription ?? "";
    assertRetains(after, ["lighthouse", "left", "homes", "right"]);
  });
});
