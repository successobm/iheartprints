import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type {
  ArtworkFidelityProposalImageInput,
  ArtworkFidelityProposalProvider,
} from "@/capabilities/artwork-fidelity-proposal";
import type { ArtworkFidelityProposalResult } from "@/capabilities/artwork-fidelity-proposal";

import { createArtworkFidelityVerificationCapability } from "./artwork-fidelity-verification-capability";

/**
 * Phase R5 (Section Q/R of the task): proves the smallest v1
 * post-reconstruction verification authority — exact wording match ONLY,
 * marks always advisory. This is the file that specifically re-proves the
 * historical R1/R2 regressions never silently pass:
 *   PROVISIONS -> PRODUCTS must fail.
 *   A mark substitution must never be reported as an automatic pass (there
 *   is no automatic mark pass at all, structurally).
 */

function fakeProvider(result: ArtworkFidelityProposalResult): ArtworkFidelityProposalProvider {
  return {
    providerKey: "fake_artwork_fidelity_proposal",
    async propose(_input: ArtworkFidelityProposalImageInput) {
      return result;
    },
  };
}

function analyzed(
  wording: { text: string | null; readability?: "readable" | "partially_readable" | "cannot_read" }[],
  marks: ArtworkFidelityProposalResult["protectedMarks"] = [],
): ArtworkFidelityProposalResult {
  return {
    wording: wording.map((w) => ({
      text: w.text,
      readability: w.readability ?? "readable",
      confidence: "high",
      visibleEvidence: "",
    })),
    protectedMarks: marks,
    providerRequestId: "req-1",
    analyzed: true,
  };
}

describe("ArtworkFidelityVerificationCapability.verifyReconstructionWording", () => {
  it("exact wording match passes when every confirmed entry is found verbatim (allowing normalization-safe formatting)", async () => {
    const provider = fakeProvider(
      analyzed([{ text: "REGENCY" }, { text: "ESTABLISHED PROVISIONS" }]),
    );
    const capability = createArtworkFidelityVerificationCapability(provider);
    const result = await capability.verifyReconstructionWording(
      Buffer.from("candidate"),
      "image/png",
      ["REGENCY", "ESTABLISHED PROVISIONS"],
    );
    assert.equal(result.wordingVerified, true);
    assert.deepEqual(result.missingWording, []);
  });

  it("REGRESSION: PROVISIONS reconstructed as PRODUCTS fails -- never a fuzzy 'close enough' pass", async () => {
    const provider = fakeProvider(analyzed([{ text: "ESTABLISHED PRODUCTS" }]));
    const capability = createArtworkFidelityVerificationCapability(provider);
    const result = await capability.verifyReconstructionWording(
      Buffer.from("candidate"),
      "image/png",
      ["ESTABLISHED PROVISIONS"],
    );
    assert.equal(result.wordingVerified, false);
    assert.deepEqual(result.missingWording, ["ESTABLISHED PROVISIONS"]);
  });

  it("missing wording (confirmed text absent from the candidate entirely) fails", async () => {
    const provider = fakeProvider(analyzed([{ text: "REGENCY" }]));
    const capability = createArtworkFidelityVerificationCapability(provider);
    const result = await capability.verifyReconstructionWording(
      Buffer.from("candidate"),
      "image/png",
      ["REGENCY", "ESTABLISHED PROVISIONS"],
    );
    assert.equal(result.wordingVerified, false);
    assert.deepEqual(result.missingWording, ["ESTABLISHED PROVISIONS"]);
  });

  it("unreadable candidate wording (cannot_read) never silently satisfies a confirmed requirement", async () => {
    const provider = fakeProvider(analyzed([{ text: null, readability: "cannot_read" }]));
    const capability = createArtworkFidelityVerificationCapability(provider);
    const result = await capability.verifyReconstructionWording(
      Buffer.from("candidate"),
      "image/png",
      ["REGENCY"],
    );
    assert.equal(result.wordingVerified, false);
  });

  it("provider failure degrades to wordingVerified: null -- never confused with a genuine failed match", async () => {
    const provider: ArtworkFidelityProposalProvider = {
      providerKey: "failing",
      async propose() {
        throw new Error("network down");
      },
    };
    const capability = createArtworkFidelityVerificationCapability(provider);
    const result = await capability.verifyReconstructionWording(
      Buffer.from("candidate"),
      "image/png",
      ["REGENCY"],
    );
    assert.equal(result.wordingVerified, null);
    assert.equal(result.advisoryMarks, null);
  });

  it("a genuine analysis that found nothing (analyzed: false, e.g. placeholder) also degrades to null, never a false pass", async () => {
    const provider = fakeProvider({
      wording: [],
      protectedMarks: [],
      providerRequestId: null,
      analyzed: false,
    });
    const capability = createArtworkFidelityVerificationCapability(provider);
    const result = await capability.verifyReconstructionWording(
      Buffer.from("candidate"),
      "image/png",
      ["REGENCY"],
    );
    assert.equal(result.wordingVerified, null);
  });

  it("marks are ALWAYS advisory-only -- the result type carries no automatic mark-verified verdict, only raw classification evidence", async () => {
    const provider = fakeProvider(
      analyzed([{ text: "REGENCY" }], [
        { visualDescription: "circle with R", classification: "R", confidence: "high" },
      ]),
    );
    const capability = createArtworkFidelityVerificationCapability(provider);
    const result = await capability.verifyReconstructionWording(
      Buffer.from("candidate"),
      "image/png",
      ["REGENCY"],
    );
    assert.deepEqual(result.advisoryMarks, ["R"]);
    // The result shape has no field claiming marks were "verified" -- only
    // wordingVerified exists as a pass/fail signal, structurally proving
    // marks can never be automatically accepted through this capability.
    assert.equal(Object.hasOwn(result, "marksVerified"), false);
  });

  it("empty confirmed wording (customer confirmed no required text) trivially verifies true", async () => {
    const provider = fakeProvider(analyzed([]));
    const capability = createArtworkFidelityVerificationCapability(provider);
    const result = await capability.verifyReconstructionWording(
      Buffer.from("candidate"),
      "image/png",
      [],
    );
    assert.equal(result.wordingVerified, true);
  });
});
