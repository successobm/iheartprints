import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { deriveExplicitInkRestriction } from "./explicit-ink-restriction";

describe("deriveExplicitInkRestriction — Phase 2C.3A", () => {
  it("returns null for Harley-style contrast guidance without ink bans", () => {
    assert.equal(
      deriveExplicitInkRestriction({
        designDescription:
          "A black 2005 Harley Road Glide with black leather and black helmet",
        additionalInstructions: "Use white so the design shows on the black shirt",
        exclusions: null,
      }),
      null,
    );
  });

  it("does not treat preferred-color wording as a restriction", () => {
    for (const text of [
      "white",
      "prefer white",
      "use white",
      "white would look better",
      "make it white so it shows on black",
      "black Harley on black shirt with white design",
      "white design on black shirt",
    ]) {
      assert.equal(
        deriveExplicitInkRestriction({
          designDescription: text,
          additionalInstructions: null,
          exclusions: null,
        }),
        null,
        `must not qualify: ${text}`,
      );
    }
  });

  it("detects WHITE INK ONLY / one-color white phrases", () => {
    const cases = [
      "ONE COLOR WHITE INK ONLY. DO NOT USE BLACK INK.",
      "white ink only please",
      "Use only white ink for the printed design",
      "only use white ink",
      "one-color white only",
    ];
    for (const text of cases) {
      const derived = deriveExplicitInkRestriction({
        designDescription: null,
        additionalInstructions: text,
        exclusions: null,
      });
      assert.ok(derived, `should detect: ${text}`);
      assert.equal(derived.kind, "white_ink_only");
      assert.equal(derived.sourceField, "additionalInstructions");
    }
  });

  it("detects NO BLACK INK / do not use black phrases", () => {
    const cases = [
      "NO BLACK INK",
      "do not use black ink",
      "don't use black",
      "do not print black",
      "no black ink allowed",
    ];
    for (const text of cases) {
      const derived = deriveExplicitInkRestriction({
        designDescription: null,
        additionalInstructions: null,
        exclusions: text,
      });
      assert.ok(derived, `should detect: ${text}`);
      assert.equal(derived.kind, "no_black_ink");
      assert.equal(derived.sourceField, "exclusions");
    }
  });

  it("prefers white_ink_only when both white-only and no-black language appear", () => {
    const derived = deriveExplicitInkRestriction({
      designDescription: null,
      additionalInstructions:
        "ONE COLOR WHITE INK ONLY. DO NOT USE BLACK INK.",
      exclusions: null,
    });
    assert.equal(derived?.kind, "white_ink_only");
  });

  it("can detect restriction language embedded in designDescription", () => {
    const derived = deriveExplicitInkRestriction({
      designDescription: "A motorcycle logo. White ink only.",
      additionalInstructions: null,
      exclusions: null,
    });
    assert.equal(derived?.kind, "white_ink_only");
    assert.equal(derived?.sourceField, "designDescription");
  });

  it("scans additionalInstructions before exclusions before description", () => {
    const derived = deriveExplicitInkRestriction({
      designDescription: "no black ink",
      additionalInstructions: "white ink only",
      exclusions: "do not use black ink",
    });
    assert.equal(derived?.sourceField, "additionalInstructions");
    assert.equal(derived?.kind, "white_ink_only");
  });
});
