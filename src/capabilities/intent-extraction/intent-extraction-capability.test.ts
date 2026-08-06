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
    // No structured field matches "make the logo bigger" — preserved as a
    // note rather than tagged with the old legacy-only intent.
    assert.notEqual(result.intents[0], "request_revision");
    assert.match(String(result.proposals[0]?.fields.additionalInstructions), /bigger/i);
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
