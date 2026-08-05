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
    assert.equal(result.proposals[0]?.fields.shirtColor, "navy");
  });
});

describe("IntentExtractionCapability — adaptive multi-field extraction", () => {
  it("extracts product, product color, style, artwork colors, and graphics from one rich reply", () => {
    const reply =
      "I need black shirts for our bowling team called My 3 Sons. I want a vintage gold-and-white design with a bowling ball smashing pins.";
    const fields = fieldsFrom(reply);

    assert.match(String(fields.productSummary), /black shirts/i);
    assert.equal(fields.shirtColor, "black");
    assert.equal(fields.audience, "bowling team called My 3 Sons");
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
    assert.equal(fields.shirtColor, "forest green");
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
    assert.equal(fields.shirtColor, "navy");
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
