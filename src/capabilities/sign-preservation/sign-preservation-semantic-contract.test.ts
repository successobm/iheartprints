import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildCombinedVerificationAlgorithmVersion,
  deriveSemanticVerdict,
  SIGN_PRESERVATION_SEMANTIC_CATEGORIES,
  validateSemanticAnswers,
  type SignPreservationSemanticAnswer,
} from "./contracts";

/**
 * Signs Phase S4.2A: direct, isolated coverage of the pure closed-question
 * composition rule, structural answer validation, and combined verification
 * identity — deliberately separate from the capability-level integration
 * suite (`sign-preservation-capability.test.ts`), which exercises these
 * same functions through the real production pipeline instead.
 */

function allSame(): SignPreservationSemanticAnswer[] {
  return SIGN_PRESERVATION_SEMANTIC_CATEGORIES.map((category) => ({
    category,
    answer: "same" as const,
    reason: "unchanged",
    regionReference: null,
  }));
}

describe("deriveSemanticVerdict (Signs Phase S4.2A)", () => {
  it("all same -> preserved", () => {
    assert.equal(deriveSemanticVerdict(allSame()), "preserved");
  });

  it("one changed among otherwise-same -> changed, regardless of position", () => {
    const answers = allSame();
    answers[3] = { ...answers[3], answer: "changed" };
    assert.equal(deriveSemanticVerdict(answers), "changed");
  });

  it("changed takes priority over cannot_determine when both are present", () => {
    const answers = allSame();
    answers[0] = { ...answers[0], answer: "cannot_determine" };
    answers[1] = { ...answers[1], answer: "changed" };
    assert.equal(deriveSemanticVerdict(answers), "changed");
  });

  it("cannot_determine (no changed) -> unknown", () => {
    const answers = allSame();
    answers[2] = { ...answers[2], answer: "cannot_determine" };
    assert.equal(deriveSemanticVerdict(answers), "unknown");
  });

  it("mix of same and not_applicable, at least one same -> preserved", () => {
    const answers = allSame();
    answers[4] = { ...answers[4], answer: "not_applicable" };
    answers[5] = { ...answers[5], answer: "not_applicable" };
    assert.equal(deriveSemanticVerdict(answers), "preserved");
  });

  it("every category not_applicable -> unknown (never certifies an apparently-empty sign)", () => {
    const answers = SIGN_PRESERVATION_SEMANTIC_CATEGORIES.map((category) => ({
      category,
      answer: "not_applicable" as const,
      reason: "nothing of this category present",
      regionReference: null,
    }));
    assert.equal(deriveSemanticVerdict(answers), "unknown");
  });
});

describe("validateSemanticAnswers (Signs Phase S4.2A)", () => {
  it("exactly one well-formed answer per required category -> valid", () => {
    assert.equal(validateSemanticAnswers(allSame()), true);
  });

  it("missing a required category -> invalid", () => {
    assert.equal(validateSemanticAnswers(allSame().slice(0, -1)), false);
  });

  it("duplicate category -> invalid", () => {
    const answers = allSame();
    answers[1] = { ...answers[1], category: answers[0].category };
    assert.equal(validateSemanticAnswers(answers), false);
  });

  it("unrecognized answer value -> invalid", () => {
    const answers = allSame();
    // @ts-expect-error — deliberately invalid at the type level too, proving runtime validation doesn't merely trust the type.
    answers[0] = { ...answers[0], answer: "probably_fine" };
    assert.equal(validateSemanticAnswers(answers), false);
  });

  it("unrecognized category value -> invalid", () => {
    const answers = allSame();
    // @ts-expect-error — same reasoning as above.
    answers[0] = { ...answers[0], category: "not_a_real_category" };
    assert.equal(validateSemanticAnswers(answers), false);
  });

  it("null/undefined/non-array -> invalid", () => {
    assert.equal(validateSemanticAnswers(null), false);
    assert.equal(validateSemanticAnswers(undefined), false);
    // @ts-expect-error — deliberately wrong shape.
    assert.equal(validateSemanticAnswers("not an array"), false);
  });
});

describe("buildCombinedVerificationAlgorithmVersion (Signs Phase S4.2A)", () => {
  it("is deterministic — the same inputs always produce the same identity", () => {
    const a = buildCombinedVerificationAlgorithmVersion(
      "openai_sign_preservation_semantic",
      "gpt-5.6-sol",
      "sign-preservation-transport:file-id-v1",
    );
    const b = buildCombinedVerificationAlgorithmVersion(
      "openai_sign_preservation_semantic",
      "gpt-5.6-sol",
      "sign-preservation-transport:file-id-v1",
    );
    assert.equal(a, b);
  });

  it("a different provider key changes the identity", () => {
    const a = buildCombinedVerificationAlgorithmVersion(
      "openai_sign_preservation_semantic",
      "gpt-5.6-sol",
      "sign-preservation-transport:file-id-v1",
    );
    const b = buildCombinedVerificationAlgorithmVersion(
      "fake_sign_preservation_semantic_v1",
      "gpt-5.6-sol",
      "sign-preservation-transport:file-id-v1",
    );
    assert.notEqual(a, b);
  });

  it("a different model identity (a model/snapshot bump) changes the identity", () => {
    const a = buildCombinedVerificationAlgorithmVersion(
      "openai_sign_preservation_semantic",
      "gpt-5.6-sol",
      "sign-preservation-transport:file-id-v1",
    );
    const b = buildCombinedVerificationAlgorithmVersion(
      "openai_sign_preservation_semantic",
      "gpt-5.7-sol",
      "sign-preservation-transport:file-id-v1",
    );
    assert.notEqual(a, b);
  });

  it("never equals the deterministic-only S4.1 identity", () => {
    const combined = buildCombinedVerificationAlgorithmVersion(
      "fake_sign_preservation_semantic_v1",
      "fake-model-v1",
      "sign-preservation-transport:none",
    );
    assert.notEqual(combined, "sign-preservation-deterministic:v1");
  });

  it("Signs Phase S4.2B.2: the combined identity now encodes the bumped image-derivation version — old (v1) evidence can never be matched/reused under the new (v2) derivation behavior", () => {
    const combined = buildCombinedVerificationAlgorithmVersion(
      "openai_sign_preservation_semantic",
      "gpt-5.6-sol",
      "sign-preservation-transport:file-id-v1",
    );
    assert.ok(
      combined.includes("grid=sign-preservation-image-derivation:v2"),
      `expected the combined identity to include the bumped v2 grid component, got: ${combined}`,
    );
    assert.ok(
      !combined.includes("grid=sign-preservation-image-derivation:v1"),
      `combined identity must never carry the stale v1 grid component, got: ${combined}`,
    );
  });

  it("Signs Phase S4.2C.1: a different transport version alone changes the identity, even with identical provider/model", () => {
    const inline = buildCombinedVerificationAlgorithmVersion(
      "openai_sign_preservation_semantic",
      "gpt-5.6-sol",
      "sign-preservation-transport:inline-v1",
    );
    const fileId = buildCombinedVerificationAlgorithmVersion(
      "openai_sign_preservation_semantic",
      "gpt-5.6-sol",
      "sign-preservation-transport:file-id-v1",
    );
    assert.notEqual(inline, fileId);
    assert.ok(inline.includes("transport=sign-preservation-transport:inline-v1"));
    assert.ok(fileId.includes("transport=sign-preservation-transport:file-id-v1"));
  });
});
