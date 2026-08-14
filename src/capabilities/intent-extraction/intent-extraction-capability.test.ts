import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createIntentExtractionCapability } from "./intent-extraction-capability";
import type { TShirtDesignBrief } from "@/lib/domain/types";

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

const capability = createIntentExtractionCapability();

function fieldsFrom(
  reply: string,
  opts: {
    brief?: TShirtDesignBrief;
    pendingSection?: Parameters<typeof capability.extract>[0]["pendingSection"];
  } = {},
) {
  const result = capability.extract({
    brief: opts.brief ?? brief(),
    phase: "interviewing",
    reply,
    pendingSection: opts.pendingSection ?? null,
  });
  return result.proposals[0]?.fields ?? {};
}

describe("IntentExtractionCapability — legacy scripted phases (unchanged)", () => {
  it("still maps ask_product to productSummary only", () => {
    const result = capability.extract({
      brief: brief(),
      phase: "ask_product",
      reply: "Camp shirts",
    });
    assert.equal(result.proposals[0]?.fields.productSummary, "Camp shirts");
    assert.equal(result.proposals[0]?.fields.shirtColor, undefined);
  });

  it("still treats 'none' as explicit empty required wording on ask_text", () => {
    const result = capability.extract({
      brief: brief(),
      phase: "ask_text",
      reply: "none",
    });
    assert.equal(result.proposals[0]?.fields.exactText, "");
  });

});

describe("IntentExtractionCapability — post-concept revision phases (adaptive, Sprint 2G Part 2)", () => {
  it("ask_revisions/revision_received now run the adaptive engine, not the legacy request_revision tag", () => {
    const result = capability.extract({
      brief: brief(),
      phase: "ask_revisions",
      reply: "Make the logo bigger",
    });
    // No dedicated field extractor matches "make the logo bigger" verbatim,
    // but it is not tagged with the old legacy-only intent...
    assert.notEqual(result.intents[0], "request_revision");
    // ...and (Sprint 2M Phase 2G, Goal 2) a post-selection design-change
    // imperative like this lands in `designDescription` — concept-relevant
    // — never silently in `additionalInstructions`, which is invisible to
    // concept-relevance/staleness/regeneration gating.
    assert.match(String(result.proposals[0]?.fields.designDescription), /bigger/i);
    assert.equal(result.proposals[0]?.fields.additionalInstructions, undefined);
  });

  it("extracts a structured correction from a revision reply, e.g. a color change", () => {
    const result = capability.extract({
      brief: brief(),
      phase: "revision_received",
      reply: "Actually, make the shirt navy instead.",
    });
    // Sprint 2K Phase 3 (Goal 2): color fields are normalized to a
    // canonical display form ("navy" → "Navy") at the point the Design
    // Brief field is written.
    assert.equal(result.proposals[0]?.fields.shirtColor, "Navy");
  });
});

describe("IntentExtractionCapability — adaptive multi-field extraction", () => {
  it("extracts product, product color, style, artwork colors, and graphics from one rich reply", () => {
    const reply =
      "I need black shirts for our bowling team called My 3 Sons. I want a vintage gold-and-white design with a bowling ball smashing pins.";
    const fields = fieldsFrom(reply);

    assert.match(String(fields.productSummary), /black shirts/i);
    assert.equal(fields.shirtColor, "Black");
    // The team's name is required wording, not part of the audience
    // description — "bowling team called My 3 Sons" must not absorb the
    // name into the audience field (Sprint 2K Phase 2).
    assert.equal(fields.audience, "bowling team");
    assert.equal(fields.exactText, "My 3 Sons");
    assert.match(String(fields.designStyle), /vintage/i);
    assert.ok(
      (fields.preferredColors ?? []).some((c) => c.toLowerCase() === "gold"),
    );
    assert.ok(
      (fields.preferredColors ?? []).some((c) => c.toLowerCase() === "white"),
    );
    assert.match(String(fields.designDescription), /bowling ball smashing pins/i);
  });

  it("does not confuse product color with artwork colors when both are present", () => {
    const fields = fieldsFrom("Navy hoodies with a red and gold logo.");
    assert.equal(fields.shirtColor?.toLowerCase(), "navy");
    assert.deepEqual(
      (fields.preferredColors ?? []).map((c) => c.toLowerCase()).sort(),
      ["gold", "red"],
    );
  });

  it("a color correction mentioning 'shirt' does not also overwrite the product description", () => {
    const fields = fieldsFrom("Actually, please make the shirt color forest green.");
    assert.equal(fields.shirtColor, "Forest Green");
    assert.equal(fields.productSummary, undefined);
  });

  it("a bare color answers productColor when that is the pending section", () => {
    const fields = fieldsFrom("Navy", { pendingSection: "productColor" });
    assert.equal(fields.shirtColor, "Navy");
  });

  it("a bare color list answers colors when that is the pending section", () => {
    const fields = fieldsFrom("forest green and cream", {
      pendingSection: "colors",
    });
    assert.deepEqual(
      (fields.preferredColors ?? []).map((c) => c.toLowerCase()),
      ["forest green", "cream"],
    );
  });
});

describe("IntentExtractionCapability — required wording", () => {
  it("extracts quoted wording confidently", () => {
    const fields = fieldsFrom('The shirt should say "Strike First".');
    assert.equal(fields.exactText, "Strike First");
  });

  it("treats a bare 'none' reply as explicit no-wording only when pending", () => {
    const fields = fieldsFrom("none", { pendingSection: "requiredWording" });
    assert.equal(fields.exactText, "");
  });

  it("does not write exactText for an unrelated reply that happens to mention nothing about text", () => {
    const fields = fieldsFrom("Black hoodies for the crew.");
    assert.equal(fields.exactText, undefined);
  });

  it("a direct pending answer with no explicit cue is still recorded (Sprint 1 parity)", () => {
    const fields = fieldsFrom("Camp Wildwood 2026", {
      pendingSection: "requiredWording",
    });
    assert.equal(fields.exactText, "Camp Wildwood 2026");
  });
});

describe("IntentExtractionCapability — corrections", () => {
  it("'actually navy, not black' corrects the color without extracting the negated one", () => {
    const fields = fieldsFrom("Actually navy, not black.", {
      pendingSection: "productColor",
    });
    assert.equal(fields.shirtColor, "Navy");
  });

  it("'change the wording to Strike First' updates required wording", () => {
    const fields = fieldsFrom("Change the wording to Strike First.");
    assert.equal(fields.exactText, "Strike First");
  });

  it("'forget gold; use white and red' replaces colors with the new set only", () => {
    const fields = fieldsFrom("Forget gold; use white and red on the design.");
    const colors = (fields.preferredColors ?? []).map((c) => c.toLowerCase());
    assert.ok(colors.includes("white"));
    assert.ok(colors.includes("red"));
    assert.ok(!colors.includes("gold"));
  });

  it("tags corrections with the 'correct' intent", () => {
    const result = capability.extract({
      brief: brief(),
      phase: "interviewing",
      reply: "Actually, make the shirt navy.",
      pendingSection: "productColor",
    });
    assert.ok(result.intents.includes("correct"));
  });
});

describe("IntentExtractionCapability — exclusions", () => {
  it("extracts 'no cartoons' as an exclusion, not a color/wording negation", () => {
    const fields = fieldsFrom("No cartoons, please.");
    assert.match(String(fields.exclusions), /cartoons/i);
    assert.equal(fields.exactText, undefined);
  });
});

describe("IntentExtractionCapability — deferrals", () => {
  it("'you choose' defers the pending deferrable section", () => {
    const result = capability.extract({
      brief: brief(),
      phase: "interviewing",
      reply: "You choose.",
      pendingSection: "style",
    });
    assert.deepEqual(result.proposals[0]?.fields.deferredSections, ["style"]);
    assert.deepEqual(result.intents, ["defer"]);
  });

  it("does not defer a required section", () => {
    const result = capability.extract({
      brief: brief(),
      phase: "interviewing",
      reply: "You choose.",
      pendingSection: "product",
    });
    assert.equal(result.proposals[0]?.fields.deferredSections, undefined);
  });

  it("a deferral phrase embedded in a longer, informative reply is not treated as a deferral", () => {
    const fields = fieldsFrom(
      "Whatever works, but it needs to say Camp Wildwood 2026 and be navy with gold text on a black hoodie.",
      { pendingSection: "style" },
    );
    assert.equal(fields.deferredSections, undefined);
  });
});

describe("IntentExtractionCapability — preserving uncertain content", () => {
  it("preserves an otherwise-unstructured substantive reply as a note instead of dropping it", () => {
    const fields = fieldsFrom(
      "We're still figuring out a few details but wanted to get started early.",
    );
    assert.match(String(fields.additionalInstructions), /still figuring out/i);
  });

  it("does not fabricate structured fields from a short, low-content reply with no pending section", () => {
    const fields = fieldsFrom("Hmm ok");
    assert.deepEqual(fields, {});
  });
});

describe("IntentExtractionCapability — Sprint 2K Phase 2 regression: bowling team opener", () => {
  it('"create a design for my bowling team name My 3 Sons" extracts audience and required wording without absorbing extra text; product stays unresolved', () => {
    const fields = fieldsFrom("create a design for my bowling team name My 3 Sons");
    assert.equal(fields.audience, "bowling team");
    assert.equal(fields.exactText, "My 3 Sons");
    // No product word was said — product must stay unresolved rather than
    // be filled with the whole opening sentence.
    assert.equal(fields.productSummary, undefined);
  });

  it("product extraction never absorbs an explanatory sentence when 'product' is the pending question", () => {
    const fields = fieldsFrom(
      "create a design for my bowling team name My 3 Sons",
      { pendingSection: "product" },
    );
    assert.equal(fields.productSummary, undefined);
    assert.equal(fields.exactText, "My 3 Sons");
  });

  it("audience extraction never absorbs an explanatory sentence when 'audience' is the pending question", () => {
    const fields = fieldsFrom(
      "I'm honestly not totally sure yet, we're still figuring out logistics and the final headcount",
      { pendingSection: "audience" },
    );
    assert.equal(fields.audience, undefined);
  });

  it("a short, direct pending answer still fills product/audience normally (no regression)", () => {
    // Sprint 2K Phase 3 (Goal 2): "T-shirts" normalizes to canonical "T-shirt".
    assert.equal(
      fieldsFrom("T-shirts", { pendingSection: "product" }).productSummary,
      "T-shirt",
    );
    assert.equal(
      fieldsFrom("Bowling team", { pendingSection: "audience" }).audience,
      "Bowling team",
    );
  });
});

describe("IntentExtractionCapability — Sprint 2K Phase 2: entity names as required wording", () => {
  const cases: Array<[string, string]> = [
    ["you forgot the team name is My 3 Sons", "My 3 Sons"],
    ["Actually the team name is My 3 Sons", "My 3 Sons"],
    ["Call it My 3 Sons", "My 3 Sons"],
    ["The logo should say My 3 Sons", "My 3 Sons"],
    ["Our company is My 3 Sons", "My 3 Sons"],
    ["Our event is My 3 Sons", "My 3 Sons"],
  ];

  for (const [reply, expected] of cases) {
    it(`"${reply}" updates required wording to "${expected}"`, () => {
      assert.equal(fieldsFrom(reply).exactText, expected);
    });
  }

  it("a correction replaces the previous required wording rather than appending to it", () => {
    const existingBrief = brief({ exactText: "Old Team Name" });
    const fields = fieldsFrom("Actually the team name is My 3 Sons", {
      brief: existingBrief,
    });
    assert.equal(fields.exactText, "My 3 Sons");
    assert.doesNotMatch(fields.exactText ?? "", /Old Team Name/);
  });

  it('"you forgot ..." is tagged as a correction', () => {
    const result = capability.extract({
      brief: brief(),
      phase: "interviewing",
      reply: "you forgot the team name is My 3 Sons",
      pendingSection: null,
    });
    assert.ok(result.intents.includes("correct"));
  });
});

describe("IntentExtractionCapability — Sprint 2L Phase 1C: entity-name clause-boundary fix", () => {
  /**
   * Root cause: a punctuation-free run-on message gives
   * `ENTITY_NAME_PATTERNS`'s `[^.,;!?\n]+` capture group nothing to stop
   * at, so it silently swallows an unrelated trailing clause into what
   * should have been just the entity's name — this is exactly what leaked
   * "My 3 Sons help me create a design for team t-shirts" into a
   * customer-facing question in the live acceptance test. General fix
   * (`boundEntityCapture` / `CLAUSE_BOUNDARY_PATTERN` in extraction.ts):
   * a small set of clause-continuation markers ("help", "and I", "we're",
   * "can you", ...) terminate the capture early, the same way a comma
   * would. Not entity-specific — the exact live opener is one case among
   * several unrelated domains below.
   */
  it('the exact live opener bounds required wording to exactly "My 3 Sons" — never the greedy run-on clause', () => {
    const fields = fieldsFrom(
      "I'm in a bowling league and our team is called My 3 Sons help me create a design for team t-shirts",
    );
    assert.equal(fields.exactText, "My 3 Sons");
    assert.notEqual(fields.exactText, "My 3 Sons help me create a design for team t-shirts");
  });

  const multiDomainCases: Array<[reply: string, expectedWording: string]> = [
    ["Our company is Rivera Plumbing and I need staff t-shirts.", "Rivera Plumbing"],
    ["Our school is Lincoln Elementary we're making fun run tees.", "Lincoln Elementary"],
    [
      "The event is Johnson Family Reunion 2026 can you make shirts for everyone?",
      "Johnson Family Reunion 2026",
    ],
    ["Our softball team is Bad News Bears and we need jerseys.", "Bad News Bears"],
  ];

  for (const [reply, expected] of multiDomainCases) {
    it(`"${reply}" bounds the entity name to exactly "${expected}"`, () => {
      const fields = fieldsFrom(reply);
      assert.equal(fields.exactText, expected);
    });
  }

  it('a legitimate name containing "and" survives intact — the boundary trim requires "and" + a pronoun, not bare "and"', () => {
    const fields = fieldsFrom("Our company is Smith and Sons.");
    assert.equal(fields.exactText, "Smith and Sons");
  });

  it('a bare, ambiguous entity mention stays ambiguous — "Make something cool for My 3 Sons" does not resolve required wording (regression)', () => {
    const fields = fieldsFrom("Make something cool for My 3 Sons.");
    assert.equal(fields.exactText, undefined);
  });
});

describe('IntentExtractionCapability — Sprint 2K Phase 2: "no" never becomes a preferred color', () => {
  it('a bare "no" answering a colors question defers the section instead of becoming a color', () => {
    const result = capability.extract({
      brief: brief(),
      phase: "interviewing",
      reply: "no",
      pendingSection: "colors",
    });
    assert.deepEqual(result.proposals[0]?.fields.deferredSections, ["colors"]);
    assert.equal(result.proposals[0]?.fields.preferredColors, undefined);
  });

  it('"nope" / "no thanks" also defer rather than becoming literal color text', () => {
    for (const reply of ["nope", "no thanks", "nah"]) {
      const result = capability.extract({
        brief: brief(),
        phase: "interviewing",
        reply,
        pendingSection: "colors",
      });
      assert.deepEqual(
        result.proposals[0]?.fields.deferredSections,
        ["colors"],
        reply,
      );
    }
  });

  it('a bare "no" answering the required-wording question resolves to explicit no-wording, not literal "no"', () => {
    const fields = fieldsFrom("no", { pendingSection: "requiredWording" });
    assert.equal(fields.exactText, "");
  });
});

describe("IntentExtractionCapability — Sprint 2K Phase 3 (Goal 2): field-aware normalization", () => {
  it('"tshirts" normalizes to the canonical "T-shirt" product name', () => {
    const fields = fieldsFrom("tshirts", { pendingSection: "product" });
    assert.equal(fields.productSummary, "T-shirt");
  });

  it('a later purpose-shaped answer never overwrites an already-resolved Product (Goal 1)', () => {
    const withProduct = brief({ productSummary: "T-shirt" });
    const fields = fieldsFrom("bowling league team shirts", {
      brief: withProduct,
      pendingSection: "purpose",
    });
    // "shirts" appearing inside the purpose answer must not re-trigger
    // product extraction and must not overwrite the resolved product.
    assert.equal(fields.productSummary, undefined);
    assert.equal(fields.purpose, "bowling league team shirts");
  });

  it('"black" normalizes to "Black" when answering product color', () => {
    const fields = fieldsFrom("black", { pendingSection: "productColor" });
    assert.equal(fields.shirtColor, "Black");
  });

  it('"no preference" answering artwork colors defers rather than becoming a literal color', () => {
    const result = capability.extract({
      brief: brief(),
      phase: "interviewing",
      reply: "no preference",
      pendingSection: "colors",
    });
    assert.deepEqual(result.proposals[0]?.fields.deferredSections, ["colors"]);
    assert.equal(result.proposals[0]?.fields.preferredColors, undefined);
  });

  it('"full back" extracts to the full_back placement enum (normalized for display by Design Summary)', () => {
    const fields = fieldsFrom("full back", { pendingSection: "printLocation" });
    assert.equal(fields.printPlacement, "full_back");
  });

  it('"My 3 Sons" required wording is preserved exactly — never normalized/rewritten', () => {
    const fields = fieldsFrom("My 3 Sons", { pendingSection: "requiredWording" });
    assert.equal(fields.exactText, "My 3 Sons");
  });

  it('"Actually the team name is My 3 Sons" replaces previously captured required wording', () => {
    const existingBrief = brief({ exactText: "Some Other Name" });
    const fields = fieldsFrom("Actually the team name is My 3 Sons", {
      brief: existingBrief,
    });
    assert.equal(fields.exactText, "My 3 Sons");
  });
});

/**
 * Sprint 2M Phase 2G — Revision Lifecycle Audit, Goal 1: the required-
 * wording extractor must distinguish contextual entity description
 * ("GLORIOUS is the boat name") from literal required wording
 * ("GLORIOUS") using structural sentence-shape recognition, not a
 * per-domain noun blacklist — the reversed order of the existing
 * "our team is called X" family of patterns.
 */
describe("IntentExtractionCapability — Sprint 2M Phase 2G (Goal 1): reversed entity-naming shape", () => {
  const cases: Array<[string, string]> = [
    ["GLORIOUS is the boat name", "GLORIOUS"],
    ["Acme is the company name", "Acme"],
    ["Rockets is our team name", "Rockets"],
    ["Bella is the dog's name", "Bella"],
    ["Johnson Family Reunion is the event name", "Johnson Family Reunion"],
  ];

  for (const [reply, expected] of cases) {
    it(`"${reply}" resolves required wording to exactly "${expected}", never the whole sentence`, () => {
      const fields = fieldsFrom(reply);
      assert.equal(fields.exactText, expected);
    });
  }

  it('a self-referential subject ("the wording is the boat name...") is never captured as the entity', () => {
    const fields = fieldsFrom("the wording is the boat name and I don't like it.");
    assert.notEqual(fields.exactText, "the wording");
  });

  it("explicit exact wording remains exact when the customer truly means the full quoted phrase (Goal 1E)", () => {
    const fields = fieldsFrom(
      'The exact wording should be "Trust is the Name of the Game".',
    );
    assert.equal(fields.exactText, "Trust is the Name of the Game");
  });
});

/**
 * Sprint 2M Phase 2G — Goal 2: correction/exclusion cues ("don't print X",
 * "X shouldn't appear", "remove X", "use the word Y", "I meant Y") must be
 * recognized as explicit correction/removal intent and update
 * requiredWording/exclusions directly rather than falling through to
 * additionalNotes.
 */
describe("IntentExtractionCapability — Sprint 2M Phase 2G (Goal 2): correction / exclusion cues", () => {
  it('"use the word GLORIOUS" resolves required wording to GLORIOUS', () => {
    const fields = fieldsFrom("it was me telling you to use the word GLORIOUS");
    assert.equal(fields.exactText, "GLORIOUS");
  });

  it("the live failing message: explanatory wording is excluded and GLORIOUS is kept as required wording", () => {
    const fields = fieldsFrom(
      "the wording is the boat name shouldn't appear on the design. it was me telling you to use the word GLORIOUS",
    );
    assert.equal(fields.exactText, "GLORIOUS");
    assert.match(String(fields.exclusions), /boat name/i);
  });

  it('"I meant GLORIOUS is the boat name, don\'t print \'is the boat name\'" updates required wording correctly (Goal 15F)', () => {
    const fields = fieldsFrom(
      "I meant GLORIOUS is the boat name, don't print 'is the boat name'",
    );
    assert.equal(fields.exactText, "GLORIOUS");
  });

  it('"shouldn\'t appear" produces an exclusion / removal intent (Goal 15G)', () => {
    const fields = fieldsFrom("The cartoon dog shouldn't appear on the design.");
    assert.match(String(fields.exclusions), /cartoon dog/i);
  });

  it('"don\'t print" produces an exclusion / removal intent (Goal 15G)', () => {
    const fields = fieldsFrom("Don't print the tagline underneath the logo.");
    assert.match(String(fields.exclusions), /tagline underneath the logo/i);
  });

  it('"remove" produces an exclusion / removal intent and is tagged as a correction (Goal 15G)', () => {
    const result = capability.extract({
      brief: brief(),
      phase: "interviewing",
      reply: "Remove the checkered flag from the design.",
    });
    assert.match(String(result.proposals[0]?.fields.exclusions), /checkered flag/i);
    assert.ok(result.intents.includes("correct"));
  });

  it("a removal cue never lets a quoted removal target masquerade as required wording", () => {
    const fields = fieldsFrom("Don't print \"Est. 2020\"; just use GLORIOUS.");
    assert.equal(fields.exactText, "GLORIOUS");
  });
});

/**
 * Live Acceptance Corrective Pass, Section 1/13: five natural-language
 * variants that all express the same semantic meaning (literal wording =
 * GLORIOUS, context = boat name), resolved through generic sentence-shape
 * recognition — never a per-phrase patch. The last block proves the same
 * generic recognition works for entirely different domains (dog, company,
 * person), demonstrating this is not a boat-specific fix.
 */
describe("IntentExtractionCapability — Live Acceptance Corrective Pass: semantic wording variants resolve to GLORIOUS", () => {
  const variants = [
    "GLORIOUS is the boat name",
    "GLORIOUS which is the name of the boat",
    "The boat is named GLORIOUS",
    "The name of the boat is GLORIOUS",
    "Use GLORIOUS — that's the boat's name",
  ];

  for (const reply of variants) {
    it(`"${reply}" resolves required wording to exactly "GLORIOUS"`, () => {
      const fields = fieldsFrom(reply);
      assert.equal(fields.exactText, "GLORIOUS");
    });
  }
});

describe("IntentExtractionCapability — Live Acceptance Corrective Pass (Section 13): generalizes beyond boats", () => {
  const cases: Array<[string, string]> = [
    ["RUFUS, that's my dog's name", "RUFUS"],
    ["Put ACME on it — that's the company name", "ACME"],
    ["Her name is Sofia, use SOFIA", "SOFIA"],
  ];

  for (const [reply, expected] of cases) {
    it(`"${reply}" resolves required wording to exactly "${expected}"`, () => {
      const fields = fieldsFrom(reply);
      assert.equal(fields.exactText, expected);
    });
  }
});

describe("IntentExtractionCapability — Live Acceptance Corrective Pass: canonical product extraction", () => {
  it('"lets create a t-shirt design" resolves product to the canonical "T-shirt", not the whole sentence', () => {
    const fields = fieldsFrom("lets create a t-shirt design");
    assert.equal(fields.productSummary, "T-shirt");
  });
});

describe("IntentExtractionCapability — Sprint 2M Phase 2G (Goal 2): post-selection design-change fallback", () => {
  it("an explicit design-change imperative lands in designDescription, never additionalInstructions, only in the revision loop", () => {
    const inRevision = capability.extract({
      brief: brief(),
      phase: "ask_revisions",
      reply: "Make the boat larger.",
    });
    assert.match(
      String(inRevision.proposals[0]?.fields.designDescription),
      /boat larger/i,
    );
    assert.equal(inRevision.proposals[0]?.fields.additionalInstructions, undefined);

    // Pre-approval (ordinary interview), the same reply still falls back to
    // additionalInstructions — the fallback is scoped to the revision loop.
    const preApproval = capability.extract({
      brief: brief(),
      phase: "interviewing",
      reply: "Make the boat larger.",
    });
    assert.match(
      String(preApproval.proposals[0]?.fields.additionalInstructions),
      /boat larger/i,
    );
  });
});

describe("IntentExtractionCapability — Live Acceptance Corrective Audit: color-role disambiguation (deterministic fallback layer)", () => {
  // These cover the deterministic extraction engine — the grounding/
  // fallback layer beneath Conversation Understanding, exercised the same
  // way regardless of which semantic-understanding provider is configured.
  // Not car-specific: the fix is a general proximity/attribution rule (see
  // `extractColors`/`extractGraphics` in extraction.ts), illustrated here
  // with the exact live-acceptance example rather than a fabricated one.

  it('a single subject color in a product+design clause is neither the garment color nor a palette preference ("...t-shirt design of my Red 1988 Toyota MR2")', () => {
    const fields = fieldsFrom("lets create a t-shirt design of my Red 1988 Toyota MR2");
    assert.match(String(fields.productSummary), /t-shirt/i);
    assert.notEqual(fields.shirtColor, "Red");
    // A later live acceptance showed the customer a Preferred Colors of
    // "Red" they had never asked for: the car's color describes the
    // SUBJECT, and belongs to the design description with the rest of the
    // car — not to the artwork's palette. See
    // `product-vs-design-subject.test.ts`.
    assert.deepEqual(fields.preferredColors ?? [], []);
    assert.match(String(fields.designDescription), /Red 1988 Toyota MR2/i);
  });

  it('a garment-color correction and the design subject\'s own color are both resolved correctly, and the design field is not the whole raw sentence ("no the color of the shirt is black the design is my 1988 Toyota MR2 which is Red")', () => {
    const fields = fieldsFrom(
      "no the color of the shirt is black the design is my 1988 Toyota MR2 which is Red",
      { pendingSection: "graphics" },
    );
    assert.equal(fields.shirtColor, "Black");
    assert.notEqual(fields.shirtColor, "Red");
    // The graphics/design field must capture just the design-relevant
    // portion (anchored at the "the design is" cue), never the whole raw
    // correction sentence verbatim — the garment-color clause that
    // precedes the cue must not leak into it.
    assert.ok(fields.designDescription, "expected designDescription to be set");
    assert.match(String(fields.designDescription), /1988 Toyota MR2/i);
    assert.doesNotMatch(String(fields.designDescription), /color of the shirt/i);
  });

  it('a multi-topic pending-"graphics" reply that resolves another field first is not blindly stored verbatim', () => {
    // No graphics cue phrase present at all — this exercises the
    // pending-section fallback's own quality gate (not extractGraphics).
    const fields = fieldsFrom("no the shirt should be black not what we said before", {
      pendingSection: "graphics",
    });
    assert.equal(fields.shirtColor, "Black");
    assert.equal(fields.designDescription, undefined);
  });
});
