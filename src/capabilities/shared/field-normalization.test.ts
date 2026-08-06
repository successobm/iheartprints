import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  capitalizeFirst,
  normalizeColorAnswer,
  normalizeProductAnswer,
  normalizeStyleAnswer,
} from "./field-normalization";

describe("field-normalization — Sprint 2K Phase 3 (Goal 2)", () => {
  describe("normalizeProductAnswer", () => {
    const cases: Array<[string, string]> = [
      ["tshirts", "T-shirt"],
      ["tshirt", "T-shirt"],
      ["t-shirts", "T-shirt"],
      ["Tshirts", "T-shirt"],
      ["TSHIRTS", "T-shirt"],
      ["tees", "T-shirt"],
      ["shirts", "T-shirt"],
      ["hoodies", "Hoodie"],
      ["sweatshirts", "Sweatshirt"],
      ["tank tops", "Tank top"],
      ["hats", "Hat"],
    ];

    for (const [input, expected] of cases) {
      it(`"${input}" → "${expected}"`, () => {
        assert.equal(normalizeProductAnswer(input), expected);
      });
    }

    it("Title Cases an unrecognized multi-word product phrase instead of dropping words", () => {
      assert.equal(normalizeProductAnswer("vintage crop tops"), "Vintage Crop Tops");
    });

    it("passes through empty input unchanged", () => {
      assert.equal(normalizeProductAnswer("   "), "");
    });

    it("leaves a sentence-shaped reply completely untouched (Sprint 1 parity)", () => {
      assert.equal(
        normalizeProductAnswer("A T-shirt for the school fair"),
        "A T-shirt for the school fair",
      );
    });
  });

  describe("normalizeColorAnswer", () => {
    it('"black" → "Black"', () => {
      assert.equal(normalizeColorAnswer("black"), "Black");
    });

    it('"heather grey" → "Heather Grey"', () => {
      assert.equal(normalizeColorAnswer("heather grey"), "Heather Grey");
    });

    it("already-capitalized input is unchanged", () => {
      assert.equal(normalizeColorAnswer("Navy"), "Navy");
    });
  });

  describe("capitalizeFirst", () => {
    it('"full back" → "Full back"', () => {
      assert.equal(capitalizeFirst("full back"), "Full back");
    });

    it("does not title-case every word", () => {
      assert.equal(capitalizeFirst("left chest"), "Left chest");
    });
  });

  describe("normalizeStyleAnswer", () => {
    it('"retro, hand-drawn" → "Retro, Hand-drawn"', () => {
      assert.equal(normalizeStyleAnswer("retro, hand-drawn"), "Retro, Hand-drawn");
    });
  });
});
