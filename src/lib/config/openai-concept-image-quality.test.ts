import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import {
  DEFAULT_OPENAI_CONCEPT_IMAGE_QUALITY,
  resolveOpenAIConceptImageQuality,
} from "./openai-concept-image-quality";

describe("resolveOpenAIConceptImageQuality", () => {
  const original = process.env.OPENAI_CONCEPT_IMAGE_QUALITY;

  afterEach(() => {
    if (original === undefined) delete process.env.OPENAI_CONCEPT_IMAGE_QUALITY;
    else process.env.OPENAI_CONCEPT_IMAGE_QUALITY = original;
  });

  it("defaults to medium when unset or blank", () => {
    delete process.env.OPENAI_CONCEPT_IMAGE_QUALITY;
    assert.equal(resolveOpenAIConceptImageQuality(), "medium");
    assert.equal(DEFAULT_OPENAI_CONCEPT_IMAGE_QUALITY, "medium");
    assert.equal(resolveOpenAIConceptImageQuality("   "), "medium");
    assert.equal(resolveOpenAIConceptImageQuality(undefined), "medium");
  });

  it("accepts low, medium, and high (case-insensitive)", () => {
    assert.equal(resolveOpenAIConceptImageQuality("low"), "low");
    assert.equal(resolveOpenAIConceptImageQuality("MEDIUM"), "medium");
    assert.equal(resolveOpenAIConceptImageQuality(" High "), "high");
  });

  it("fails closed on auto and other invalid values — never silent fallback", () => {
    assert.throws(
      () => resolveOpenAIConceptImageQuality("auto"),
      /OPENAI_CONCEPT_IMAGE_QUALITY/,
    );
    assert.throws(
      () => resolveOpenAIConceptImageQuality("standard"),
      /Do not use auto/,
    );
  });
});
