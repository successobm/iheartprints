/**
 * Universal Raster Reconstruction Phase R4A-R (independent-review repair,
 * Blockers 2/7/8/9): exhaustive coverage of the pure server-side
 * completeness validator — the piece whose ABSENCE was the review's second
 * blocking finding. Every case here is a direct, malformed-payload-style
 * proof: "the server rejects this even though a well-behaved UI would
 * never send it."
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ArtworkFidelityProposedFacts } from "@/capabilities/artwork-fidelity-proposal";

import {
  ArtworkFidelityConfirmationValidationError,
  validateAndDeriveConfirmation,
} from "./artwork-fidelity-confirmation";

function facts(overrides: Partial<ArtworkFidelityProposedFacts> = {}): ArtworkFidelityProposedFacts {
  return {
    schemaVersion: "artwork-fidelity-proposal:v2",
    proposalStatus: "analyzed",
    wording: [
      { id: "w0", text: "BRIDGEWELL", readability: "readable", confidence: "high", visibleEvidence: "bold caps" },
      { id: "w1", text: null, readability: "partially_readable", confidence: "medium", visibleEvidence: "partial" },
      { id: "w2", text: null, readability: "cannot_read", confidence: "low", visibleEvidence: "" },
    ],
    protectedMarks: [
      { id: "m0", visualDescription: "letter R enclosed by a circle", classification: "R", confidence: "medium" },
    ],
    sanitizedProvider: { providerKey: "openai_artwork_fidelity_proposal", proposedAt: new Date().toISOString() },
    ...overrides,
  };
}

describe("validateAndDeriveConfirmation -- WORDING", () => {
  it("readable region resolved with the SAME proposed text succeeds", () => {
    const result = validateAndDeriveConfirmation(facts({ wording: [facts().wording[0]!] }), {
      wordingResolutions: [{ id: "w0", text: "BRIDGEWELL" }],
      markResolutions: [{ id: "m0", mark: "NONE" }],
    });
    assert.deepEqual(result.confirmedWording, ["BRIDGEWELL"]);
  });

  it("readable region resolved with CORRECTED text succeeds -- correction never has to match the proposal", () => {
    const result = validateAndDeriveConfirmation(facts({ wording: [facts().wording[0]!] }), {
      wordingResolutions: [{ id: "w0", text: "BRIDGEWALL CORP" }],
      markResolutions: [{ id: "m0", mark: "NONE" }],
    });
    assert.deepEqual(result.confirmedWording, ["BRIDGEWALL CORP"]);
  });

  it("readable region resolved with an explicit exclusion succeeds", () => {
    const result = validateAndDeriveConfirmation(facts({ wording: [facts().wording[0]!] }), {
      wordingResolutions: [{ id: "w0", excluded: true }],
      markResolutions: [{ id: "m0", mark: "NONE" }],
    });
    assert.deepEqual(result.confirmedWording, []);
  });

  it("readable region OMITTED entirely fails", () => {
    assert.throws(
      () =>
        validateAndDeriveConfirmation(facts({ wording: [facts().wording[0]!] }), {
          wordingResolutions: [],
          markResolutions: [{ id: "m0", mark: "NONE" }],
        }),
      ArtworkFidelityConfirmationValidationError,
    );
  });

  it("partially_readable region: customer-supplied wording succeeds", () => {
    const result = validateAndDeriveConfirmation(facts({ wording: [facts().wording[1]!] }), {
      wordingResolutions: [{ id: "w1", text: "REGENCY" }],
      markResolutions: [{ id: "m0", mark: "NONE" }],
    });
    assert.deepEqual(result.confirmedWording, ["REGENCY"]);
  });

  it("partially_readable region: explicit exclusion succeeds", () => {
    const result = validateAndDeriveConfirmation(facts({ wording: [facts().wording[1]!] }), {
      wordingResolutions: [{ id: "w1", excluded: true }],
      markResolutions: [{ id: "m0", mark: "NONE" }],
    });
    assert.deepEqual(result.confirmedWording, []);
  });

  it("partially_readable region OMITTED fails", () => {
    assert.throws(
      () =>
        validateAndDeriveConfirmation(facts({ wording: [facts().wording[1]!] }), {
          wordingResolutions: [],
          markResolutions: [{ id: "m0", mark: "NONE" }],
        }),
      ArtworkFidelityConfirmationValidationError,
    );
  });

  it("cannot_read region: customer-supplied wording succeeds", () => {
    const result = validateAndDeriveConfirmation(facts({ wording: [facts().wording[2]!] }), {
      wordingResolutions: [{ id: "w2", text: "SOME COMPANY" }],
      markResolutions: [{ id: "m0", mark: "NONE" }],
    });
    assert.deepEqual(result.confirmedWording, ["SOME COMPANY"]);
  });

  it("whitespace-only text fails", () => {
    assert.throws(
      () =>
        validateAndDeriveConfirmation(facts({ wording: [facts().wording[0]!] }), {
          wordingResolutions: [{ id: "w0", text: "   " }],
          markResolutions: [{ id: "m0", mark: "NONE" }],
        }),
      ArtworkFidelityConfirmationValidationError,
    );
  });

  it("blank text fails", () => {
    assert.throws(
      () =>
        validateAndDeriveConfirmation(facts({ wording: [facts().wording[0]!] }), {
          wordingResolutions: [{ id: "w0", text: "" }],
          markResolutions: [{ id: "m0", mark: "NONE" }],
        }),
      ArtworkFidelityConfirmationValidationError,
    );
  });

  it("both text AND excluded on the same resolution fails -- ambiguous", () => {
    assert.throws(
      () =>
        validateAndDeriveConfirmation(facts({ wording: [facts().wording[0]!] }), {
          wordingResolutions: [{ id: "w0", text: "BRIDGEWELL", excluded: true }],
          markResolutions: [{ id: "m0", mark: "NONE" }],
        }),
      ArtworkFidelityConfirmationValidationError,
    );
  });

  it("unknown region id fails -- an invented/extra region cannot be confirmed", () => {
    assert.throws(
      () =>
        validateAndDeriveConfirmation(facts({ wording: [facts().wording[0]!] }), {
          wordingResolutions: [
            { id: "w0", text: "BRIDGEWELL" },
            { id: "w99", text: "INVENTED REGION" },
          ],
          markResolutions: [{ id: "m0", mark: "NONE" }],
        }),
      ArtworkFidelityConfirmationValidationError,
    );
  });

  it("duplicate resolution for the same region id fails", () => {
    assert.throws(
      () =>
        validateAndDeriveConfirmation(facts({ wording: [facts().wording[0]!] }), {
          wordingResolutions: [
            { id: "w0", text: "BRIDGEWELL" },
            { id: "w0", text: "SOMETHING ELSE" },
          ],
          markResolutions: [{ id: "m0", mark: "NONE" }],
        }),
      ArtworkFidelityConfirmationValidationError,
    );
  });

  it("preserves exact customer capitalization and punctuation verbatim", () => {
    const result = validateAndDeriveConfirmation(facts({ wording: [facts().wording[0]!] }), {
      wordingResolutions: [{ id: "w0", text: "BridgeWell & Co., Ltd." }],
      markResolutions: [{ id: "m0", mark: "NONE" }],
    });
    assert.deepEqual(result.confirmedWording, ["BridgeWell & Co., Ltd."]);
  });

  it("multiple proposed regions all resolved together succeeds", () => {
    const result = validateAndDeriveConfirmation(facts(), {
      wordingResolutions: [
        { id: "w0", text: "BRIDGEWELL" },
        { id: "w1", excluded: true },
        { id: "w2", text: "SOME COMPANY" },
      ],
      markResolutions: [{ id: "m0", mark: "NONE" }],
    });
    assert.deepEqual(result.confirmedWording.sort(), ["BRIDGEWELL", "SOME COMPANY"]);
  });

  it("zero proposed wording regions requires zero resolutions -- vacuously complete", () => {
    const result = validateAndDeriveConfirmation(facts({ wording: [] }), {
      wordingResolutions: [],
      markResolutions: [{ id: "m0", mark: "NONE" }],
    });
    assert.deepEqual(result.confirmedWording, []);
  });
});

describe("validateAndDeriveConfirmation -- MARKS", () => {
  it("TM succeeds", () => {
    const result = validateAndDeriveConfirmation(facts({ wording: [] }), {
      wordingResolutions: [],
      markResolutions: [{ id: "m0", mark: "™" }],
    });
    assert.deepEqual(result.confirmedMarks, ["™"]);
  });

  it("R succeeds", () => {
    const result = validateAndDeriveConfirmation(facts({ wording: [] }), {
      wordingResolutions: [],
      markResolutions: [{ id: "m0", mark: "®" }],
    });
    assert.deepEqual(result.confirmedMarks, ["®"]);
  });

  it("C succeeds", () => {
    const result = validateAndDeriveConfirmation(facts({ wording: [] }), {
      wordingResolutions: [],
      markResolutions: [{ id: "m0", mark: "©" }],
    });
    assert.deepEqual(result.confirmedMarks, ["©"]);
  });

  it("explicit NONE succeeds and persists confirmedMarks=[]", () => {
    const result = validateAndDeriveConfirmation(facts({ wording: [] }), {
      wordingResolutions: [],
      markResolutions: [{ id: "m0", mark: "NONE" }],
    });
    assert.deepEqual(result.confirmedMarks, []);
  });

  it("missing mark resolution fails -- an omitted mark region blocks confirmation entirely", () => {
    assert.throws(
      () =>
        validateAndDeriveConfirmation(facts({ wording: [] }), {
          wordingResolutions: [],
          markResolutions: [],
        }),
      ArtworkFidelityConfirmationValidationError,
    );
  });

  it("NOT_SURE fails -- can never become authority, even submitted directly to the validator", () => {
    assert.throws(
      () =>
        validateAndDeriveConfirmation(facts({ wording: [] }), {
          wordingResolutions: [],
          markResolutions: [{ id: "m0", mark: "NOT_SURE" as never }],
        }),
      ArtworkFidelityConfirmationValidationError,
    );
  });

  it("an invalid/unrecognized token fails", () => {
    assert.throws(
      () =>
        validateAndDeriveConfirmation(facts({ wording: [] }), {
          wordingResolutions: [],
          markResolutions: [{ id: "m0", mark: "XX" as never }],
        }),
      ArtworkFidelityConfirmationValidationError,
    );
  });

  it("unknown mark region id fails", () => {
    assert.throws(
      () =>
        validateAndDeriveConfirmation(facts({ wording: [] }), {
          wordingResolutions: [],
          markResolutions: [{ id: "m99", mark: "NONE" }],
        }),
      ArtworkFidelityConfirmationValidationError,
    );
  });

  it("duplicate mark resolution for the same region fails", () => {
    assert.throws(
      () =>
        validateAndDeriveConfirmation(facts({ wording: [] }), {
          wordingResolutions: [],
          markResolutions: [
            { id: "m0", mark: "™" },
            { id: "m0", mark: "NONE" },
          ],
        }),
      ArtworkFidelityConfirmationValidationError,
    );
  });

  it("multiple proposed marks resolved to different symbols dedupes and preserves each distinct choice", () => {
    const result = validateAndDeriveConfirmation(
      facts({
        wording: [],
        protectedMarks: [
          { id: "m0", visualDescription: "a", classification: "R", confidence: "high" },
          { id: "m1", visualDescription: "b", classification: "TM", confidence: "high" },
        ],
      }),
      {
        wordingResolutions: [],
        markResolutions: [
          { id: "m0", mark: "®" },
          { id: "m1", mark: "®" },
        ],
      },
    );
    // Same symbol chosen for two distinct regions collapses to one
    // confirmed fact -- confirmedMarks is a SET, mirroring
    // `ArtworkFidelityCapability.confirmContract`'s own dedup discipline.
    assert.deepEqual(result.confirmedMarks, ["®"]);
  });
});

describe("validateAndDeriveConfirmation -- provider proposed zero marks never implies NONE on its own", () => {
  it("a proposal with zero raw mark regions still requires an explicit resolution once a catch-all region exists", () => {
    // This mirrors what `ArtworkFidelityProposalCapability` actually
    // persists (a synthesized catch-all `m0` whenever the provider found
    // zero mark regions) -- proving the VALIDATOR still requires an
    // explicit resolution for it, never defaulting silently.
    assert.throws(
      () =>
        validateAndDeriveConfirmation(
          facts({
            wording: [],
            protectedMarks: [{ id: "m0", visualDescription: "", classification: "cannot_determine", confidence: "low" }],
          }),
          { wordingResolutions: [], markResolutions: [] },
        ),
      ArtworkFidelityConfirmationValidationError,
    );
  });
});
