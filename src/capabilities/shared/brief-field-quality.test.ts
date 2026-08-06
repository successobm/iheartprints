import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  checkAudienceQuality,
  checkPreferredColorsQuality,
  checkPrintLocationQuality,
  checkProductQuality,
  checkRequiredWordingQuality,
} from "./brief-field-quality";

describe("brief-field-quality — product", () => {
  it("accepts a short product name", () => {
    assert.equal(checkProductQuality("Black t-shirts"), null);
  });

  it("rejects a product value containing multiple sentences", () => {
    const issue = checkProductQuality(
      "I need a t-shirt. It should be black and soft.",
    );
    assert.ok(issue);
    assert.equal(issue?.code, "product_multiple_sentences");
  });

  it("rejects an explanatory run-on even without a second sentence", () => {
    const issue = checkProductQuality(
      "create a design for my bowling team name My 3 Sons",
    );
    assert.ok(issue);
  });
});

describe("brief-field-quality — audience", () => {
  it("accepts a short audience description", () => {
    assert.equal(checkAudienceQuality("Bowling team"), null);
  });

  it("rejects audience text that reads as a design description", () => {
    const issue = checkAudienceQuality(
      "A retro bowling logo design inspired by an old sitcom",
    );
    assert.ok(issue);
    assert.equal(issue?.code, "audience_contains_design_description");
  });

  it("rejects audience text with multiple sentences", () => {
    const issue = checkAudienceQuality(
      "Our bowling team. We play on Tuesdays.",
    );
    assert.ok(issue);
  });
});

describe("brief-field-quality — required wording", () => {
  it("accepts short literal print text", () => {
    assert.equal(checkRequiredWordingQuality("My 3 Sons"), null);
  });

  it("rejects a bare negative answer standing in for literal text", () => {
    const issue = checkRequiredWordingQuality("no");
    assert.ok(issue);
    assert.equal(issue?.code, "required_wording_is_negative_answer");
  });

  it("rejects an explanatory paragraph", () => {
    const issue = checkRequiredWordingQuality(
      "This design should say a whole paragraph of text describing our entire camp mission statement and history. It needs to explain everything.",
    );
    assert.ok(issue);
  });

  it("rejects instructional language standing in for the literal text", () => {
    const issue = checkRequiredWordingQuality(
      "please make the logo say something cool",
    );
    assert.ok(issue);
    assert.equal(issue?.code, "required_wording_meta_language");
  });
});

describe("brief-field-quality — preferred colors", () => {
  it("accepts real color names", () => {
    assert.equal(checkPreferredColorsQuality(["Forest Green", "Cream"]), null);
  });

  it('rejects "no" masquerading as a color', () => {
    const issue = checkPreferredColorsQuality(["no"]);
    assert.ok(issue);
    assert.equal(issue?.code, "preferred_colors_is_negative_answer");
  });

  it('rejects "none" among otherwise-real colors too', () => {
    const issue = checkPreferredColorsQuality(["Gold", "none"]);
    assert.ok(issue);
  });
});

describe("brief-field-quality — print location", () => {
  it("accepts a known placement", () => {
    assert.equal(checkPrintLocationQuality("full_back"), null);
  });

  it("rejects an unrecognized/unrelated value", () => {
    const issue = checkPrintLocationQuality("somewhere on the sleeve I guess");
    assert.ok(issue);
    assert.equal(issue?.code, "print_location_unrecognized");
  });
});
