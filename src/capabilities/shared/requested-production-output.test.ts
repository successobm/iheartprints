/**
 * Sprint A2 (corrected) — the deterministic requested-production-output
 * backstop.
 *
 * Every "must NOT detect" case below is a false positive the independent
 * audit found in the first A2 pass, which asked only "does an artifact word
 * appear in the brief text?" and would have refused to produce artwork for
 * all of them. They are the point of this suite: a customer whose sentence
 * merely CONTAINS "separations" or "DST" is, overwhelmingly, a customer who
 * wants an ordinary garment design.
 *
 * The asymmetry that shapes these expectations: a missed detection degrades
 * to the semantic layer and, failing that, to the Production PNG — the
 * status quo, correctable in conversation. A false detection silently
 * refuses paid work. So this module is tuned for precision, and the tests
 * hold it to that.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  detectRequestedProductionOutput,
  stripQuotedAndShoutedText,
} from "./requested-production-output";

function detects(message: string, expected: string) {
  assert.equal(
    detectRequestedProductionOutput(message),
    expected,
    `should detect ${expected} in: ${message}`,
  );
}

function detectsNothing(message: string) {
  assert.equal(
    detectRequestedProductionOutput(message),
    null,
    `must NOT read a production request into: ${message}`,
  );
}

describe("detectRequestedProductionOutput — real requests", () => {
  it("B: explicit separations requests", () => {
    detects("make the screen-print color separations", "screen_print_separations");
    detects("can you create color separations for these tees", "screen_print_separations");
    detects("separate this into screens", "screen_print_separations");
    detects("please prepare individual screen files", "screen_print_separations");
    detects("we need this press-ready for screen printing", "screen_print_separations");
    detects("give me vector separations for six screens", "screen_print_separations");
  });

  it("G/L: explicit embroidery digitization requests", () => {
    detects("digitize this for embroidery", "embroidery_digitization");
    detects("please digitize it", "embroidery_digitization");
    detects("create a DST", "embroidery_digitization");
    detects("can you make a machine embroidery file", "embroidery_digitization");
    detects("I need the stitch file for this", "embroidery_digitization");
  });

  it("J: explicit vector output requests", () => {
    detects("give me an SVG production file", "vector_output");
    detects("can you vectorize this", "vector_output");
    detects("I need a vector file", "vector_output");
    detects("please send the EPS", "vector_output");
  });

  it("explicit sublimation production preparation", () => {
    detects("prepare the sublimation transfer file", "sublimation_specific");
    detects("make this sublimation-ready", "sublimation_specific");
  });

  it("V: explicit per-screen output requests", () => {
    // Sprint A2 Correction 2 (Goal 14): unmistakable output requests the
    // noun-only patterns missed.
    detects("output each screen separately", "screen_print_separations");
    detects("make six screen files", "screen_print_separations");
    detects("can you give me one file per color", "screen_print_separations");
    detects("we need separate screen layers", "screen_print_separations");
  });

  it("retraction and affirmation resolve to the supported output", () => {
    // A customer must always be able to un-ask, even with the semantic layer
    // offline — otherwise one sentence strands their project permanently.
    detects("never mind the separations, just give me the PNG", "production_png");
    detects("forget the DST", "production_png");
    detects("actually just the PNG is fine", "production_png");
    detects("cancel the vector file", "production_png");
  });

  it("T: realistic retractions that the negation guard would otherwise swallow", () => {
    // Sprint A2 Correction 2 (Goal 13). Every one of these is a negative
    // sentence, so the negation disqualifier discards the clause — which is
    // right for "no separations needed" (never a request) but wrong here,
    // where the customer is actively withdrawing a request they already made.
    // Left unhandled, one sentence strands the project permanently.
    detects("don't digitize it after all", "production_png");
    detects("skip the vector file", "production_png");
    detects("I changed my mind, raster only", "production_png");
    detects("raster only please", "production_png");
    detects("don't vectorize it anymore", "production_png");
  });
});

describe("detectRequestedProductionOutput — filenames are possessions, not orders", () => {
  it("U: a reference file whose NAME contains action words is not a request", () => {
    // Sprint A2 Correction 2 (Goal 13): `create-a-dst.png` parses as an
    // imperative once punctuation is ignored. It is a file the customer HAS.
    detectsNothing("here is my reference file create-a-dst.png");
    detectsNothing("I attached make_separations_v2.ai for you to look at");
    detectsNothing("use vectorize-this.jpg as the starting point");
    detectsNothing("the file is called screen-files-final.png");
  });

  it("U: a real request in the same message still lands", () => {
    // The filename is stripped, not used to disqualify the whole message —
    // otherwise attaching a badly-named file would silence a genuine request.
    detects(
      "here's logo-vector-final.png, can you make the color separations",
      "screen_print_separations",
    );
  });
});

describe("detectRequestedProductionOutput — decoration context is never a request", () => {
  it("A/K/M/N: naming a decoration method says nothing about the artifact", () => {
    detectsNothing("this will be screen printed");
    detectsNothing("I need a screen printed t-shirt design");
    detectsNothing("I'm taking this to an embroidery shop");
    detectsNothing("I want this embroidered on a hoodie");
    detectsNothing("it might be embroidered later");
    detectsNothing("the shop says they're using DTF");
    detectsNothing("I'm using DTG");
    detectsNothing("we want a sublimated shirt");
    detectsNothing("make a left-chest logo for an embroidered polo");
    detectsNothing("design a logo for a screen printed T-shirt");
  });
});

describe("detectRequestedProductionOutput — audit-found false positives", () => {
  it("C/H: negation", () => {
    detectsNothing("no separations are needed");
    detectsNothing("do not make color separations");
    detectsNothing("don't digitize this");
    detectsNothing("we don't need a vector file");
    detectsNothing("just the shirt art, without any separations");
  });

  it("F: the customer already possesses the file", () => {
    detectsNothing("I already have the DST file");
    detectsNothing("we have the separations already");
    detectsNothing("this came from an embroidery file");
    detectsNothing("I have my own vector version");
  });

  it("I: the file is a reference or an input they are supplying", () => {
    detectsNothing("use this SVG only as a reference");
    detectsNothing("I uploaded an SVG logo");
    detectsNothing("here's my vector file to work from");
    detectsNothing("attached is the EPS for reference");
  });

  it("D: quoted and shouted text is artwork wording, not an instruction", () => {
    detectsNothing('the shirt should say "COLOR SEPARATIONS" across the front');
    detectsNothing("put DON'T DIGITIZE ME on the back");
    detectsNothing('we need a tee that reads "SEPARATIONS SINCE 1994"');
  });

  it("E: business and team names", () => {
    detectsNothing("we need shirts for Screen Print Separations LLC");
    detectsNothing("make a hoodie design for Digitize Co.");
    detectsNothing("the team is called the Vector Wolves, we need jerseys");
  });

  it("statements about the customer's own business are not orders to us", () => {
    detectsNothing("embroidery digitizing is our business");
    detectsNothing("we offer color separations to our clients");
  });

  it("empty and irrelevant input is silent", () => {
    detectsNothing("");
    detectsNothing("   ");
    assert.equal(detectRequestedProductionOutput(null), null);
    assert.equal(detectRequestedProductionOutput(undefined), null);
    detectsNothing("I want a red race car on a black t-shirt");
  });
});

describe("stripQuotedAndShoutedText", () => {
  it("removes quoted spans and multi-word ALL-CAPS runs", () => {
    assert.ok(!stripQuotedAndShoutedText('say "COLOR SEPARATIONS" here').includes("SEPARATIONS"));
    assert.ok(!stripQuotedAndShoutedText("put DONT DIGITIZE ME on it").includes("DIGITIZE"));
    // A single capitalized word is ordinary prose, not shouted wording.
    assert.ok(stripQuotedAndShoutedText("DTF please").includes("DTF"));
  });

  it("leaves ordinary sentences intact", () => {
    const text = "make the color separations for these tees";
    assert.equal(stripQuotedAndShoutedText(text), text);
  });
});
