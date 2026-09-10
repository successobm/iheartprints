import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PNG } from "pngjs";

import { createArtworkFidelityProposalCapability } from "./artwork-fidelity-proposal-capability";
import type {
  ArtworkFidelityProposalImageInput,
  ArtworkFidelityProposalProvider,
} from "./artwork-fidelity-proposal-provider";
import type { ArtworkFidelityProposalResult } from "./contracts";
import { ARTWORK_FIDELITY_PROPOSAL_SCHEMA_VERSION } from "./contracts";

function solidPng(width = 40, height = 40): Buffer {
  const png = new PNG({ width, height });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = 10;
    png.data[i + 1] = 20;
    png.data[i + 2] = 30;
    png.data[i + 3] = 255;
  }
  return PNG.sync.write(png);
}

class FakeProvider implements ArtworkFidelityProposalProvider {
  readonly providerKey = "fake_provider";
  calls: ArtworkFidelityProposalImageInput[] = [];
  constructor(private readonly result: ArtworkFidelityProposalResult | (() => never)) {}
  async propose(input: ArtworkFidelityProposalImageInput): Promise<ArtworkFidelityProposalResult> {
    this.calls.push(input);
    if (typeof this.result === "function") return this.result();
    return this.result;
  }
}

describe("ArtworkFidelityProposalCapability", () => {
  it("wraps a successful provider result into a stamped proposedFacts payload", async () => {
    const provider = new FakeProvider({
      wording: [{ text: "BRIDGEWELL", readability: "readable", confidence: "high", visibleEvidence: "bold caps" }],
      protectedMarks: [{ visualDescription: "letter R enclosed by a circle", classification: "R", confidence: "medium" }],
      providerRequestId: "resp_123",
    });
    const capability = createArtworkFidelityProposalCapability(provider);

    const facts = await capability.proposeFacts({ bytes: solidPng(), contentType: "image/png" });

    assert.equal(facts.schemaVersion, ARTWORK_FIDELITY_PROPOSAL_SCHEMA_VERSION);
    assert.equal(facts.wording.length, 1);
    assert.equal(facts.wording[0]!.text, "BRIDGEWELL");
    assert.equal(facts.protectedMarks.length, 1);
    assert.equal(facts.protectedMarks[0]!.classification, "R");
    assert.equal(facts.sanitizedProvider.providerKey, "fake_provider");
    // Sanitized provider metadata carries no raw request id, no bytes, no credential.
    assert.equal(Object.keys(facts.sanitizedProvider).sort().join(","), "proposedAt,providerKey");
  });

  it("downscales before handing bytes to the provider", async () => {
    const provider = new FakeProvider({ wording: [], protectedMarks: [], providerRequestId: null });
    const capability = createArtworkFidelityProposalCapability(provider);

    await capability.proposeFacts({ bytes: solidPng(4000, 4000), contentType: "image/png" });

    assert.equal(provider.calls.length, 1);
    const sent = PNG.sync.read(provider.calls[0]!.bytes);
    assert.ok(Math.max(sent.width, sent.height) <= 1600);
  });

  it("NEVER throws for a provider failure -- degrades to an empty, still-safe proposal (advisory-only)", async () => {
    const provider = new FakeProvider(() => {
      throw new Error("network exploded");
    });
    const capability = createArtworkFidelityProposalCapability(provider);

    const facts = await capability.proposeFacts({ bytes: solidPng(), contentType: "image/png" });

    assert.deepEqual(facts.wording, []);
    assert.deepEqual(facts.protectedMarks, []);
    assert.equal(facts.schemaVersion, ARTWORK_FIDELITY_PROPOSAL_SCHEMA_VERSION);
  });

  it("degrades to an empty proposal for bytes that do not decode as a PNG, without calling the provider", async () => {
    const provider = new FakeProvider({ wording: [{ text: "should never be reached", readability: "readable", confidence: "high", visibleEvidence: "" }], protectedMarks: [], providerRequestId: null });
    const capability = createArtworkFidelityProposalCapability(provider);

    const facts = await capability.proposeFacts({ bytes: Buffer.from("not a png"), contentType: "image/png" });

    assert.deepEqual(facts.wording, []);
    assert.equal(provider.calls.length, 0);
  });
});
