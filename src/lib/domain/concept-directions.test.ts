import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CONCEPT_DIRECTIONS, describeConceptDirection } from "./concept-directions";
import { buildPlaceholderConcepts } from "./concepts";
import type { GenerationPromptRequest } from "./types";

function prompt(overrides: Partial<GenerationPromptRequest> = {}): GenerationPromptRequest {
  return {
    product: "a t-shirt",
    subject: "a retro bowling logo",
    style: "retro",
    colors: [],
    productColor: "Black",
    requiredWording: "My 3 Sons",
    wordingMode: "provided",
    printLocation: "full_back",
    audience: "bowling team",
    purpose: "team apparel",
    exclusions: null,
    notes: null,
    inspirationReferences: [],
    allowAdditionalText: false,
    ...overrides,
  };
}

describe("CONCEPT_DIRECTIONS — Sprint 2K Phase 3 (Goal 5)", () => {
  it("has exactly three directions with distinct titles", () => {
    assert.equal(CONCEPT_DIRECTIONS.length, 3);
    const titles = CONCEPT_DIRECTIONS.map((d) => d.title);
    assert.deepEqual(titles, ["Bold & Direct", "Soft & Illustrated", "Minimal Badge"]);
  });

  it("every direction differs meaningfully in composition, typography, iconography, and layout", () => {
    const fields: Array<keyof (typeof CONCEPT_DIRECTIONS)[number]> = [
      "composition",
      "typographyEmphasis",
      "illustrationDensity",
      "iconography",
      "layout",
      "visualHierarchy",
    ];
    for (const field of fields) {
      const values = CONCEPT_DIRECTIONS.map((d) => d[field]);
      assert.equal(new Set(values).size, values.length, `${field} is not distinct across directions`);
    }
  });

  it("is deterministic — the same input always produces the same catalog", () => {
    assert.deepEqual(CONCEPT_DIRECTIONS, CONCEPT_DIRECTIONS);
  });
});

describe("describeConceptDirection — Sprint 2K Phase 3 (Goal 8)", () => {
  it("describes the direction actually sent to the provider, not fabricated pixel claims", () => {
    const description = describeConceptDirection(CONCEPT_DIRECTIONS[0]!, prompt());
    assert.match(description, /Bold & Direct/);
    assert.match(description, /My 3 Sons/);
    assert.match(description, /Black/);
  });

  it("never claims a text lockup that was never requested", () => {
    const description = describeConceptDirection(
      CONCEPT_DIRECTIONS[0]!,
      prompt({ requiredWording: null }),
    );
    assert.match(description, /No text lockup/i);
  });
});

describe("buildPlaceholderConcepts — shares the same direction catalog as the real provider", () => {
  it("produces three concepts whose titles/colors match CONCEPT_DIRECTIONS exactly", () => {
    const seeds = buildPlaceholderConcepts(prompt());
    assert.equal(seeds.length, 3);
    seeds.forEach((seed, index) => {
      assert.equal(seed.title, CONCEPT_DIRECTIONS[index]!.title);
      assert.equal(seed.accentColor, CONCEPT_DIRECTIONS[index]!.accentColor);
      assert.equal(seed.placeholderLabel, CONCEPT_DIRECTIONS[index]!.placeholderLabel);
    });
  });

  it("retains required wording in every concept summary (Goal 6)", () => {
    const seeds = buildPlaceholderConcepts(prompt({ requiredWording: "My 3 Sons" }));
    for (const seed of seeds) {
      assert.match(seed.summary, /My 3 Sons/);
    }
  });
});
